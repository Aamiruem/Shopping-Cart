// Accounts for the Vercel store: register, login, profile and password, on the same PostgreSQL `users` table as
// backend/app/routers/auth.py. Password hashes (bcrypt) and login tokens (HS256 JWT with id, email, role) match the
// FastAPI backend, so accounts and sessions carry over when the full store takes these routes.
//
// One-time codes (api/_otp.mjs): with an email provider configured, signup works like the backend's: the account is
// created, verified, only after the emailed code is confirmed. Without one, signup creates the account straight away
// with email_verified = FALSE. Passwordless login, password reset and phone verification need a configured channel.
import { createHash, randomBytes } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import { neon, Pool } from '@neondatabase/serverless';
import { STORE_SCHEMA } from './_schema.mjs';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { availableChannels, checkCode, otpReport, sendCode, sentResponse } from './_otp.mjs';

const BCRYPT_ROUNDS = 10;
const TOKEN_SECONDS = 7 * 24 * 60 * 60;
const RATE_WINDOW_SECONDS = 15 * 60;
const IP_LIMIT = 20; // same as the backend's auth_limiter
const EMAIL_LIMIT = 10; // stops password guessing against one account from many addresses
const PASSWORD_MIN = 8;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[6-9]\d{9}$/;
const OTP_IP_LIMIT = 8; // code requests per connection per 15 minutes, like the backend's otp_limiter
const VERIFY_IP_LIMIT = 20;

export class ApiError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// Input rules: keep in sync with backend/app/services/validation.py
const text = (value) => (typeof value === 'string' ? value : '');
export const normalizeEmail = (email) => text(email).trim().toLowerCase();

function emailError(email) {
  if (!email) return 'Please enter your email address';
  if (email.length > 254 || !EMAIL_RE.test(email) || email.includes('..')) return 'Please enter a valid email address';
  return null;
}

function nameError(name) {
  if (name.length < 2) return 'Please enter your full name';
  return name.length > 100 ? 'Name is too long' : null;
}

const phoneError = (phone) => (!phone || PHONE_RE.test(phone) ? null : 'Please enter a valid 10-digit mobile number starting with 6, 7, 8 or 9');

function passwordError(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (Buffer.byteLength(password) > 72) return 'Password must be at most 72 characters'; // bcrypt limit
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Password must contain at least one letter and one number';
  return null;
}

// Catches typos like "gmail.con". If DNS itself is unavailable the address is let through, as in the backend.
async function emailDomainError(email, lookup = resolveMx) {
  const domain = email.split('@')[1];
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000).unref());
    const records = await Promise.race([lookup(domain), timeout]);
    return records.length ? null : `“${domain}” can’t receive email. Please check the address.`;
  } catch (err) {
    return ['ENOTFOUND', 'ENODATA'].includes(err.code) ? `“${domain}” can’t receive email. Please check the address.` : null;
  }
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  // Never fall back to a default: a known secret would let anyone forge a login for any account
  if (!secret || secret.length < 32) throw new ApiError(503, 'Accounts are temporarily unavailable. Please try again later.');
  return secret;
}

// Three portals, three kinds of session: 'customer' (the store), 'seller' (Seller Hub) and 'admin' (the CRM, 12 hours,
// with `mfa: true` when an authenticator code was checked). The server decides what each portal's token may do:
// the CRM accepts only admin-portal sessions, the Seller Hub only seller- and admin-portal sessions.
export const PORTALS = ['customer', 'seller', 'admin'];
const ADMIN_TOKEN_SECONDS = 12 * 60 * 60;
export const createToken = (u, portal = 'customer', extra = {}) =>
  jwt.sign({ id: u.id, email: u.email, role: u.role, portal, ...extra }, jwtSecret(), { algorithm: 'HS256', expiresIn: portal === 'admin' ? ADMIN_TOKEN_SECONDS : TOKEN_SECONDS });
/** The portal a token was issued for. Tokens from before the portals existed are customer sessions. */
export const portalOf = (claims) => (PORTALS.includes(claims?.portal) ? claims.portal : 'customer');

/** The verified token's claims ({ id, email, role, iat, exp }); throws 401 for a missing, forged or expired token. */
export function tokenClaims(header) {
  if (!text(header).startsWith('Bearer ')) throw new ApiError(401, 'Login required');
  try {
    return jwt.verify(header.slice(7), jwtSecret(), { algorithms: ['HS256'] });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(401, 'Invalid or expired token');
  }
}

export const currentUserId = (header) => tokenClaims(header).id;

/**
 * Throws 401 when an admin deactivated the account or ended its sessions after this token was issued (CRM: Customers
 * and Team). Checked on /auth/me (every page load), on ordering, and on every CRM request.
 */
export function assertSessionValid(user, claims) {
  if (user.disabled_at) throw new ApiError(401, 'This account has been deactivated. Please contact customer care.');
  if (user.sessions_revoked_at && claims?.iat && claims.iat * 1000 < new Date(user.sessions_revoked_at).getTime() - 999) {
    throw new ApiError(401, 'Your session has ended. Please log in again.');
  }
}

// Same fields as public_user in the backend. Never includes the password hash.
async function publicUser(u, store) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    customerId: u.customer_code ?? null, // ARV-CUS-2026-000001: the number to quote; the internal id stays internal
    emailVerified: u.email_verified,
    phoneVerified: u.phone_verified ?? false,
    hasPassword: Boolean(u.password_hash),
    googleLinked: Boolean(u.google_id),
    storeName: ['seller', 'admin'].includes(u.role) ? await store.storeName(u.id) : null,
    seller: await sellerInfo(store.db, u.id), // { status, sellerId } once they applied to sell
    mfaEnabled: Boolean(u.mfa_secret),
    // CRM access (role and permissions) decides whether "CRM Dashboard" shows in the More menu. The server checks
    // permissions again on every CRM request; this is only for the menu.
    crm: await crmAccess(store.db, u),
    createdAt: u.created_at,
  };
}

async function sellerInfo(db, userId) {
  if (!db) return null;
  try {
    const [s] = await db('SELECT status, seller_code FROM sellers WHERE user_id = $1', [userId]);
    return s ? { status: s.status, sellerId: s.seller_code } : null;
  } catch {
    return null;
  }
}

async function crmAccess(db, u) {
  try {
    const { accessFor } = await import('./_crm_core.mjs');
    const access = await accessFor(db, u);
    return access && { role: access.role, roleName: access.roleName, permissions: [...access.permissions] };
  } catch (err) {
    console.error('crm access check failed', err.message); // e.g. CRM tables not created yet: no CRM, login still works
    return u.role === 'admin' ? { role: 'super_admin', roleName: 'Super Admin', permissions: [] } : null;
  }
}

export const session = async (u, store, portal = 'customer', extra = {}) => ({ token: createToken(u, portal, extra), user: { ...(await publicUser(u, store)), portal } });

export async function limit(store, key, max, message = 'Too many login attempts. Please try again in 15 minutes.') {
  const digest = createHash('sha256').update(key).digest('hex'); // the table never holds a raw IP or email
  const { hits, retryAfter } = await store.hit(digest, RATE_WINDOW_SECONDS);
  if (hits > max) throw new ApiError(429, message, { 'Retry-After': String(retryAfter) });
}

async function register(body, ctx) {
  const name = text(body.name).trim();
  const email = normalizeEmail(body.email);
  const phone = text(body.phone).trim() || null;
  await limit(ctx.store, `register:${ctx.ip}`, IP_LIMIT);
  const error = nameError(name) || emailError(email) || phoneError(phone) || passwordError(body.password) || (await ctx.domainError(email));
  if (error) throw new ApiError(400, error);
  const hash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
  if (availableChannels(ctx.env).email) {
    // Step 1 of 2: email a code; the account is created only when it comes back (POST register/verify)
    await emailFree(ctx, email);
    await limit(ctx.store, `otp:${ctx.ip}`, OTP_IP_LIMIT, 'Too many code requests. Please try again in 15 minutes.');
    const sent = await sendCode(ctx.store.db, { purpose: 'signup', target: email, channel: 'email', payload: { name, phone, password_hash: hash } }, ctx.otp);
    return { status: 202, body: { verify: 'email', ...sent } };
  }
  const user = await ctx.store.create({ name, email, phone, passwordHash: hash });
  if (!user) throw new ApiError(409, 'An account with this email already exists. Please log in.');
  await welcome(ctx.store.db, user);
  return { status: 201, body: await session(user, ctx.store) };
}

// The welcome email (CRM → Settings → Notifications). Never blocks or fails a signup.
async function welcome(db, user) {
  try {
    const { notify } = await import('./_messaging.mjs');
    await notify(db, 'welcome', { userId: user.id });
  } catch (err) {
    console.error('welcome notification skipped', err.message);
  }
}

async function emailFree(ctx, email) {
  const existing = await ctx.store.findByEmail(email);
  if (existing) {
    throw new ApiError(409, existing.google_id ? 'This email is registered with Google. Please use “Continue with Google”.' : 'An account with this email already exists. Please log in.');
  }
}

async function resendSignup(body, ctx) {
  const email = normalizeEmail(body.email);
  if (emailError(email)) throw new ApiError(400, 'Please enter a valid email address');
  await limit(ctx.store, `otp:${ctx.ip}`, OTP_IP_LIMIT, 'Too many code requests. Please try again in 15 minutes.');
  const [pending] = await ctx.store.db(
    "SELECT payload FROM verification_codes WHERE purpose = 'signup' AND target = $1 AND payload IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    [email],
  );
  if (!pending) throw new ApiError(404, 'Please start signing up again');
  await emailFree(ctx, email);
  const payload = typeof pending.payload === 'string' ? JSON.parse(pending.payload) : pending.payload;
  return { body: { verify: 'email', ...(await sendCode(ctx.store.db, { purpose: 'signup', target: email, channel: 'email', payload }, ctx.otp)) } };
}

async function verifySignup(body, ctx) {
  const email = normalizeEmail(body.email);
  await limit(ctx.store, `verify:${ctx.ip}`, VERIFY_IP_LIMIT, 'Too many attempts. Please try again in 15 minutes.');
  const row = await checkCode(ctx.store.db, { purpose: 'signup', target: email, code: body.code }, ctx.otp);
  const data = row.payload || {};
  await emailFree(ctx, email);
  const user = await ctx.store.create({ name: data.name, email, phone: data.phone ?? null, passwordHash: data.password_hash, emailVerified: true });
  if (!user) throw new ApiError(409, 'An account with this email already exists. Please log in.');
  await welcome(ctx.store.db, user);
  return { status: 201, body: await session(user, ctx.store) };
}

// ---------- Codes for an existing account: passwordless login and password reset ----------
/** Email, or an Indian mobile number in any common form ("+91 98765 43210"). */
function loginTarget(identifier) {
  const raw = text(identifier).trim();
  if (raw.includes('@')) {
    const email = normalizeEmail(raw);
    const error = emailError(email);
    if (error) throw new ApiError(400, error);
    return { target: email, isEmail: true };
  }
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (!digits || phoneError(digits)) throw new ApiError(400, phoneError(digits) || 'Please enter your email address or mobile number');
  return { target: digits, isEmail: false };
}

// Mobile codes only go to numbers the owner has verified: a number typed at signup proves nothing
async function accountFor(ctx, { target, isEmail }) {
  if (isEmail) return ctx.store.findByEmail(target);
  const [user] = await ctx.store.db('SELECT * FROM users WHERE phone = $1 AND phone_verified ORDER BY id LIMIT 1', [target]);
  return user ?? null;
}

const CHANNEL_LABEL = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

/** Step 1 of passwordless login or password reset. The reply is the same whether or not the account exists. */
async function sendAccountCode(purpose, body, ctx) {
  const who = loginTarget(body.identifier);
  const channel = who.isEmail ? 'email' : ['sms', 'whatsapp'].includes(body.channel) ? body.channel : 'sms';
  if (!availableChannels(ctx.env)[channel]) {
    throw new ApiError(503, `${CHANNEL_LABEL[channel]} codes aren’t available right now. Please choose another way.`);
  }
  await limit(ctx.store, `otp:${ctx.ip}`, OTP_IP_LIMIT, 'Too many code requests. Please try again in 15 minutes.');
  const user = await accountFor(ctx, who);
  if (!user) return { body: sentResponse(who.target, channel, ctx.env) }; // nothing sent, and nothing revealed
  return { body: await sendCode(ctx.store.db, { purpose, target: who.target, channel, userId: user.id }, ctx.otp) };
}

async function verifyAccountCode(purpose, body, ctx) {
  const who = loginTarget(body.identifier);
  await limit(ctx.store, `verify:${ctx.ip}`, VERIFY_IP_LIMIT, 'Too many attempts. Please try again in 15 minutes.');
  const row = await checkCode(ctx.store.db, { purpose, target: who.target, code: body.code }, ctx.otp);
  const [account] = await ctx.store.db('SELECT disabled_at FROM users WHERE id = $1', [row.user_id]);
  if (account) assertSessionValid(account);
  const [user] = await ctx.store.db(
    `UPDATE users SET last_login = NOW()${who.isEmail ? ', email_verified = TRUE' : ''} WHERE id = $1 RETURNING *`, // the code proves the email
    [row.user_id],
  );
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

async function otpLoginVerify(body, ctx) {
  return { body: await session(await verifyAccountCode('login', body, ctx), ctx.store) };
}

async function resetPassword(body, ctx) {
  const error = passwordError(body.password);
  if (error) throw new ApiError(400, error);
  const user = await verifyAccountCode('reset', body, ctx);
  const updated = await ctx.store.updatePassword(user.id, await bcrypt.hash(body.password, BCRYPT_ROUNDS));
  return { body: await session(updated, ctx.store) }; // signed in with the new password
}

// ---------- Verifying a mobile number (signed in) ----------
async function phoneOtp(body, ctx) {
  const user = await signedInUser(ctx);
  const phone = text(body.phone).trim();
  const error = phone ? phoneError(phone) : 'Please enter your mobile number';
  if (error) throw new ApiError(400, error);
  const channel = body.channel === 'whatsapp' ? 'whatsapp' : 'sms';
  const [taken] = await ctx.store.db('SELECT 1 FROM users WHERE phone = $1 AND phone_verified AND id <> $2', [phone, user.id]);
  if (taken) throw new ApiError(409, 'This mobile number is already verified on another account');
  await limit(ctx.store, `otp:${ctx.ip}`, OTP_IP_LIMIT, 'Too many code requests. Please try again in 15 minutes.');
  return { body: await sendCode(ctx.store.db, { purpose: 'phone', target: phone, channel, userId: user.id }, ctx.otp) };
}

async function phoneVerify(body, ctx) {
  const user = await signedInUser(ctx);
  const phone = text(body.phone).trim();
  await limit(ctx.store, `verify:${ctx.ip}`, VERIFY_IP_LIMIT, 'Too many attempts. Please try again in 15 minutes.');
  const row = await checkCode(ctx.store.db, { purpose: 'phone', target: phone, code: body.code }, ctx.otp);
  if (row.user_id !== user.id) throw new ApiError(400, 'This code was sent for another account');
  const [updated] = await ctx.store.db('UPDATE users SET phone = $1, phone_verified = TRUE WHERE id = $2 RETURNING *', [phone, user.id]);
  return { body: await publicUser(updated, ctx.store) };
}

// ---------- Mobile-first sign-in (the welcome popup) ----------
// 1. phone/start: a code goes to the number (SMS, or WhatsApp when set up), whether or not an account uses it: the
//    reply never reveals that. 2. phone/login: a correct code signs in the account that verified this number, or
//    returns a short-lived signup token proving the number was verified. 3. phone/complete: with that token, name and
//    email create the account, its number already verified. One code proves one number once.
const SIGNUP_TOKEN_SECONDS = 15 * 60;

// The same three steps also work with an email address (the one-field login popup): the code goes by email, a
// correct code signs in the account with that email (and marks it verified) or returns a signup token for it.
async function mobileStart(body, ctx) {
  const who = loginTarget(body.identifier ?? body.phone);
  const channel = who.isEmail ? 'email' : body.channel === 'whatsapp' ? 'whatsapp' : 'sms';
  if (!availableChannels(ctx.env)[channel]) throw new ApiError(503, `${CHANNEL_LABEL[channel]} codes aren’t available right now. Please use your password instead.`);
  await limit(ctx.store, `otp:${ctx.ip}`, OTP_IP_LIMIT, 'Too many code requests. Please try again in 15 minutes.');
  return { body: await sendCode(ctx.store.db, { purpose: 'mobile', target: who.target, channel }, ctx.otp) };
}

async function mobileLogin(body, ctx) {
  const who = loginTarget(body.identifier ?? body.phone);
  await limit(ctx.store, `verify:${ctx.ip}`, VERIFY_IP_LIMIT, 'Too many attempts. Please try again in 15 minutes.');
  await checkCode(ctx.store.db, { purpose: 'mobile', target: who.target, code: body.code }, ctx.otp);
  const user = await accountFor(ctx, who);
  if (user) {
    assertSessionValid({ disabled_at: user.disabled_at });
    // Like the password login: the store admin uses the admin portal (with MFA when it's on)
    if (user.role === 'admin') throw new ApiError(403, 'This account signs in through the admin portal.');
    const [signedIn] = await ctx.store.db(
      `UPDATE users SET last_login = NOW()${who.isEmail ? ', email_verified = TRUE' : ''} WHERE id = $1 RETURNING *`, // the code proves the address
      [user.id],
    );
    return { body: await session(signedIn, ctx.store) };
  }
  const claims = who.isEmail ? { email: who.target, purpose: 'email-signup' } : { phone: who.target, purpose: 'phone-signup' };
  const signupToken = jwt.sign(claims, jwtSecret(), { algorithm: 'HS256', expiresIn: SIGNUP_TOKEN_SECONDS });
  return { body: { needsProfile: true, ...(who.isEmail ? { email: who.target } : { phone: who.target }), signupToken } };
}

// A new account from a verified email: just a name (a mobile number is optional and stays unverified)
async function emailComplete(claims, body, ctx) {
  const name = text(body.name).trim();
  const phone = text(body.phone).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '') || null;
  await limit(ctx.store, `register:${ctx.ip}`, IP_LIMIT);
  const error = nameError(name) || emailError(claims.email) || phoneError(phone);
  if (error) throw new ApiError(400, error);
  await emailFree(ctx, claims.email);
  const user = await ctx.store.create({ name, email: claims.email, phone, passwordHash: null, emailVerified: true });
  if (!user) throw new ApiError(409, 'An account with this email already exists. Please log in.');
  await welcome(ctx.store.db, user);
  return { status: 201, body: await session(user, ctx.store) };
}

async function mobileComplete(body, ctx) {
  let claims;
  try {
    claims = jwt.verify(text(body.signupToken), jwtSecret(), { algorithms: ['HS256'] });
  } catch {
    throw new ApiError(400, 'Your verification expired. Please request a new code.');
  }
  if (claims.purpose === 'email-signup') return emailComplete(claims, body, ctx);
  if (claims.purpose !== 'phone-signup' || !PHONE_RE.test(claims.phone ?? '')) throw new ApiError(400, 'Please request a new code.');
  const name = text(body.name).trim();
  const email = normalizeEmail(body.email);
  await limit(ctx.store, `register:${ctx.ip}`, IP_LIMIT);
  const error = nameError(name) || emailError(email) || (await ctx.domainError(email));
  if (error) throw new ApiError(400, error);
  const [taken] = await ctx.store.db('SELECT 1 FROM users WHERE phone = $1 AND phone_verified', [claims.phone]);
  if (taken) throw new ApiError(409, 'This mobile number already has an account. Request a new code to log in.');
  await emailFree(ctx, email);
  const [user] = await ctx.store.db(
    `INSERT INTO users (name, email, phone, phone_verified, password_hash, last_login) VALUES ($1, $2, $3, TRUE, NULL, NOW())
     ON CONFLICT (email) DO NOTHING RETURNING *`,
    [name, email, claims.phone],
  );
  if (!user) throw new ApiError(409, 'An account with this email already exists. Please log in with your email.');
  await welcome(ctx.store.db, user);
  return { status: 201, body: await session(user, ctx.store) };
}

async function otpStatus(_, ctx) {
  const user = await signedInUser(ctx);
  if (user.role !== 'admin') throw new ApiError(403, 'Only the store admin can see this');
  return { body: await otpReport(ctx.store.db, ctx.env) };
}

async function login(body, ctx) {
  const email = normalizeEmail(body.email);
  const password = text(body.password);
  if (emailError(email) || !password) throw new ApiError(400, 'Please enter your email and password');
  await limit(ctx.store, `login:${ctx.ip}`, IP_LIMIT);
  await limit(ctx.store, `login-email:${email}`, EMAIL_LIMIT);
  const user = await ctx.store.findByEmail(email);
  if (user && !user.password_hash) throw new ApiError(400, 'This account uses Google sign-in. Please use “Continue with Google”.');
  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw new ApiError(401, 'Invalid email or password');
  assertSessionValid({ disabled_at: user.disabled_at }); // only after the password: never reveals the state to a guesser
  // The store admin's account is privileged: it signs in only through the admin portal (with MFA when enabled)
  if (user.role === 'admin') throw new ApiError(403, 'This account signs in through the admin portal.');
  await ctx.store.touchLogin(user.id);
  return { body: await session(user, ctx.store) };
}

// ---------- Admin portal: /admin/login (never linked from the store) ----------
// Only the store admin and active CRM team members. Password, then an authenticator code when MFA is on. Accounts are
// provisioned by an admin (CRM → Team); there is no public admin sign-up.
async function adminLogin(body, ctx) {
  const email = normalizeEmail(body.email);
  const password = text(body.password);
  if (emailError(email) || !password) throw new ApiError(400, 'Please enter your email and password');
  await limit(ctx.store, `admin-login:${ctx.ip}`, 10, 'Too many sign-in attempts. Please try again in 15 minutes.');
  await limit(ctx.store, `admin-login-email:${email}`, 6, 'Too many sign-in attempts. Please try again in 15 minutes.');
  const user = await ctx.store.findByEmail(email);
  const ok = user?.password_hash && (await bcrypt.compare(password, user.password_hash));
  const { accessFor, audit } = await import('./_crm_core.mjs');
  const access = ok && !user.disabled_at ? await accessFor(ctx.store.db, user) : null;
  if (!access) {
    // One answer for a wrong password, a customer account or no account at all
    if (user) await audit(ctx.store.db, { id: user.id, name: user.name, ip: ctx.ip }, 'admin.login_failed', 'user', user.id, {}).catch(() => {});
    throw new ApiError(401, 'Invalid credentials for the admin portal');
  }
  let mfa = false;
  if (user.mfa_secret) {
    if (!body.code) return { body: { mfaRequired: true } };
    const { verifyUserCode } = await import('./_mfa.mjs');
    if (!(await verifyUserCode(ctx.store.db, user, body.code))) {
      await audit(ctx.store.db, { id: user.id, name: user.name, ip: ctx.ip }, 'admin.mfa_failed', 'user', user.id, {}).catch(() => {});
      throw new ApiError(401, 'That authenticator code is not correct or was already used');
    }
    mfa = true;
  }
  await ctx.store.touchLogin(user.id);
  await audit(ctx.store.db, { id: user.id, name: user.name, ip: ctx.ip }, 'admin.login', 'user', user.id, { mfa }).catch(() => {});
  return { body: await session(user, ctx.store, 'admin', { mfa }) };
}

// ---------- Seller portal: /seller/login and /seller/register ----------
// A separate sign-in for selling. Anyone may apply; only an admin's approval lets them sell (api/_seller.mjs).
async function sellerLogin(body, ctx) {
  const email = normalizeEmail(body.email);
  const password = text(body.password);
  if (emailError(email) || !password) throw new ApiError(400, 'Please enter your email and password');
  await limit(ctx.store, `login:${ctx.ip}`, IP_LIMIT);
  await limit(ctx.store, `login-email:${email}`, EMAIL_LIMIT);
  const user = await ctx.store.findByEmail(email);
  if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) throw new ApiError(401, 'Invalid email or password');
  assertSessionValid({ disabled_at: user.disabled_at });
  if (user.role === 'admin') throw new ApiError(403, 'This account signs in through the admin portal.');
  await ctx.store.touchLogin(user.id);
  return { body: await session(user, ctx.store, 'seller') };
}

async function sellerSignup(body, ctx) {
  const name = text(body.name).trim();
  const email = normalizeEmail(body.email);
  const phone = text(body.phone).trim() || null;
  await limit(ctx.store, `register:${ctx.ip}`, IP_LIMIT);
  const error = nameError(name) || emailError(email) || (phone ? phoneError(phone) : 'Please enter your mobile number') || passwordError(body.password) || (await ctx.domainError(email));
  if (error) throw new ApiError(400, error);
  await emailFree(ctx, email);
  const user = await ctx.store.create({ name, email, phone, passwordHash: await bcrypt.hash(body.password, BCRYPT_ROUNDS) });
  if (!user) throw new ApiError(409, 'An account with this email already exists. Please sign in.');
  return { status: 201, body: await session(user, ctx.store, 'seller') };
}

async function signedInUser(ctx) {
  const claims = tokenClaims(ctx.authorization);
  const user = await ctx.store.findById(claims.id);
  if (!user) throw new ApiError(404, 'User not found');
  assertSessionValid(user, claims);
  return user;
}

async function updateProfile(body, ctx) {
  const id = currentUserId(ctx.authorization);
  const name = text(body.name).trim();
  const phone = text(body.phone).trim() || null;
  const error = nameError(name) || phoneError(phone);
  if (error) throw new ApiError(400, error);
  const user = await ctx.store.updateProfile(id, { name, phone });
  if (!user) throw new ApiError(404, 'User not found');
  return { body: await publicUser(user, ctx.store) };
}

async function changePassword(body, ctx) {
  const user = await signedInUser(ctx);
  await limit(ctx.store, `password:${ctx.ip}`, IP_LIMIT);
  const error = passwordError(body.newPassword);
  if (error) throw new ApiError(400, error);
  if (user.password_hash && !(await bcrypt.compare(text(body.currentPassword), user.password_hash))) {
    throw new ApiError(400, 'Current password is incorrect');
  }
  const updated = await ctx.store.updatePassword(user.id, await bcrypt.hash(body.newPassword, BCRYPT_ROUNDS));
  await auditAdmin(ctx, user, 'admin.password_changed', {});
  return { body: await publicUser(updated, ctx.store) };
}

// Moves a signed-in account to a new email address (its sign-in name). The current password is required, so a
// session left open on someone else's screen can't take the account over. The new address counts as unverified.
// Answers with a fresh session: the token carries the email.
async function changeEmail(body, ctx) {
  const user = await signedInUser(ctx);
  await limit(ctx.store, `email-change:${ctx.ip}`, IP_LIMIT);
  const email = normalizeEmail(body.newEmail);
  const error = emailError(email);
  if (error) throw new ApiError(400, error);
  if (!user.password_hash) throw new ApiError(400, 'This account signs in with Google. Set a password first, then change the email.');
  if (!(await bcrypt.compare(text(body.currentPassword), user.password_hash))) throw new ApiError(400, 'Current password is incorrect');
  if (email === user.email) throw new ApiError(400, 'That is already your email address');
  const domainError = await ctx.domainError(email);
  if (domainError) throw new ApiError(400, domainError);
  if (await ctx.store.findByEmail(email)) throw new ApiError(409, 'Another account already uses this email');
  const updated = await ctx.store.updateEmail(user.id, email).catch((err) => {
    if (err?.code === '23505') throw new ApiError(409, 'Another account already uses this email'); // taken meanwhile
    throw err;
  });
  if (!updated) throw new ApiError(404, 'User not found');
  await auditAdmin(ctx, user, 'admin.email_changed', { from: user.email, to: email });
  const claims = tokenClaims(ctx.authorization);
  return { body: await session(updated, ctx.store, portalOf(claims), claims.mfa === undefined ? {} : { mfa: claims.mfa }) };
}

// Changes to a store-team account's sign-in go into the CRM audit log
async function auditAdmin(ctx, user, action, details) {
  if (portalOf(tokenClaims(ctx.authorization)) !== 'admin') return;
  const { audit } = await import('./_crm_core.mjs');
  await audit(ctx.store.db, { id: user.id, name: user.name, ip: ctx.ip }, action, 'user', user.id, details).catch(() => {});
}

const ROUTES = {
  'POST register': register,
  'POST login': login,
  'POST admin/login': adminLogin,
  'POST seller/login': sellerLogin,
  'POST seller/register': sellerSignup,
  'GET me': async (_, ctx) => ({ body: { ...(await publicUser(await signedInUser(ctx), ctx.store)), portal: portalOf(tokenClaims(ctx.authorization)) } }),
  'PUT me': updateProfile,
  'PUT password': changePassword,
  'PUT email': changeEmail,
  // One-time codes: which channels work, signup, passwordless login, password reset, phone numbers, admin report
  'GET otp/channels': async (_, ctx) => ({ body: availableChannels(ctx.env) }),
  'POST register/resend': resendSignup,
  'POST register/verify': verifySignup,
  'POST otp': (body, ctx) => sendAccountCode('login', body, ctx),
  'POST otp/verify': otpLoginVerify,
  'POST password/forgot': (body, ctx) => sendAccountCode('reset', body, ctx),
  'POST password/reset': resetPassword,
  'POST phone/otp': phoneOtp,
  'POST phone/verify': phoneVerify,
  'POST mobile/start': mobileStart,
  'POST mobile/login': mobileLogin,
  'POST mobile/complete': mobileComplete,
  'GET otp/status': otpStatus,
};

/** The routes above; Google sign-in needs the full backend. */
export const isAuthRoute = (method, rest) => `${method} ${rest}` in ROUTES;

/** Runs a route: expected errors become their status and message, anything else a plain 500 with no details. */
export async function safely(route) {
  try {
    jwtSecret(); // before any write: a signup must not create an account it can't then sign in
    const { status = 200, body } = await route();
    return { status, body, headers: {} };
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, body: { error: err.message }, headers: err.headers };
    // The reference ties what the user sees to this line in the Vercel logs, without showing them any details
    const ref = randomBytes(4).toString('hex');
    console.error(`store API error [ref ${ref}]`, err);
    return { status: 500, body: { error: `Something went wrong. Please try again. (ref ${ref})`, ref }, headers: {} };
  }
}

// `env` and `send` (the code delivery function) are for tests; the live store uses process.env and the real providers
export function handleAuth({ method, rest, body, ip, authorization }, { store = postgresStore(), domainError = emailDomainError, env = process.env, send } = {}) {
  const otp = { env, ...(send ? { send } : {}) };
  return safely(() => ROUTES[`${method} ${rest}`](body ?? {}, { store, ip, authorization, domainError, env, otp }));
}

let client;
let localDb = null; // scripts/local-store.mjs runs the store on an in-memory PostgreSQL instead of Neon

/** For local testing only: send every query to `db` (statement, params) => rows. */
export const useLocalDatabase = (db) => {
  localDb = db;
};

// The live database updates itself: a deploy whose STORE_SCHEMA differs from the version recorded in store_meta applies
// it before its first query, so code never runs against a database missing its columns (deploying without
// `npm run db:setup` used to break sign-in, cart and seller applications). STORE_SCHEMA is safe to re-run: it only
// adds what is missing. Each server instance checks once (one small query); the update itself runs once, under a lock.
export const STORE_SCHEMA_VERSION = createHash('sha256').update(STORE_SCHEMA).digest('hex').slice(0, 16);
let schemaReady = null;

// `check` runs one statement over HTTP; `open` starts a real session (the lock and the multi-statement script need one)
function neonSchemaDb(url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL) {
  return {
    check: (statement) => neon(url).query(statement),
    open: async () => {
      const pool = new Pool({ connectionString: url });
      const session = await pool.connect();
      return {
        query: async (statement, params) => (await session.query(statement, params)).rows,
        close: async () => {
          session.release();
          await pool.end().catch(() => {});
        },
      };
    },
  };
}

const RECORDED = "SELECT value FROM store_meta WHERE key = 'store_schema'";
const recordedVersion = (run) => Promise.resolve().then(() => run(RECORDED)).then((rows) => rows[0]?.value ?? null, () => null);

/** Brings the database up to this deploy's STORE_SCHEMA. Returns 'current' or 'updated'. */
export async function ensureStoreSchema({ check, open } = neonSchemaDb()) {
  if ((await recordedVersion(check)) === STORE_SCHEMA_VERSION) return 'current';
  const db = await open();
  try {
    await db.query('SELECT pg_advisory_lock(7310231)'); // another instance may be updating right now: wait for it
    await db.query('CREATE TABLE IF NOT EXISTS store_meta (key VARCHAR(40) PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    if ((await recordedVersion(db.query)) === STORE_SCHEMA_VERSION) return 'current';
    await db.query(STORE_SCHEMA);
    await db.query(
      `INSERT INTO store_meta (key, value) VALUES ('store_schema', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [STORE_SCHEMA_VERSION],
    );
    console.log(`store schema updated to ${STORE_SCHEMA_VERSION}`);
    return 'updated';
  } finally {
    await db.query('SELECT pg_advisory_unlock(7310231)').catch(() => {});
    await db.close();
  }
}

async function liveQuery(statement, params) {
  // A failed update is retried by the next request rather than remembered
  await (schemaReady ??= ensureStoreSchema().catch((err) => {
    schemaReady = null;
    throw err;
  }));
  return (client ??= neon(process.env.DATABASE_URL)).query(statement, params);
}

export const query = (statement, params = []) => (localDb ? localDb(statement, params) : liveQuery(statement, params));

export function postgresStore(db = query) {
  const one = async (statement, params) => (await db(statement, params))[0] ?? null;
  return {
    findByEmail: (email) => one('SELECT * FROM users WHERE email = $1', [email]),
    findById: (id) => one('SELECT * FROM users WHERE id = $1', [id]),
    db,
    create: ({ name, email, phone, passwordHash, emailVerified = false }) =>
      one(
        `INSERT INTO users (name, email, phone, password_hash, email_verified, last_login) VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (email) DO NOTHING RETURNING *`,
        [name, email, phone, passwordHash, emailVerified],
      ),
    touchLogin: (id) => one('UPDATE users SET last_login = NOW() WHERE id = $1', [id]),
    updateProfile: (id, { name, phone }) =>
      one(
        `UPDATE users SET name = $1, phone = $2::varchar,
                phone_verified = CASE WHEN phone IS DISTINCT FROM $2::varchar THEN FALSE ELSE phone_verified END
          WHERE id = $3 RETURNING *`,
        [name, phone, id],
      ),
    updatePassword: (id, hash) => one('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *', [hash, id]),
    updateEmail: (id, email) => one('UPDATE users SET email = $1, email_verified = FALSE WHERE id = $2 RETURNING *', [email, id]),
    storeName: async (id) => (await one('SELECT store_name FROM sellers WHERE user_id = $1', [id]))?.store_name ?? null,
    async hit(key, seconds) {
      if (Math.random() < 0.01) await one('DELETE FROM auth_rate_limits WHERE reset_at < NOW()', []); // keeps the table small
      const row = await one(
        `INSERT INTO auth_rate_limits (key, hits, reset_at) VALUES ($1, 1, NOW() + make_interval(secs => $2))
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN auth_rate_limits.reset_at <= NOW() THEN 1 ELSE auth_rate_limits.hits + 1 END,
           reset_at = CASE WHEN auth_rate_limits.reset_at <= NOW() THEN EXCLUDED.reset_at ELSE auth_rate_limits.reset_at END
         RETURNING hits, CEIL(EXTRACT(EPOCH FROM reset_at - NOW()))::int AS retry_after`,
        [key, seconds],
      );
      return { hits: row.hits, retryAfter: row.retry_after };
    },
  };
}
