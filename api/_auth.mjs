// Accounts for the Vercel store: register, login, profile and password, on the same PostgreSQL `users` table as
// backend/app/routers/auth.py. Password hashes (bcrypt) and login tokens (HS256 JWT with id, email, role) match the
// FastAPI backend, so accounts and sessions carry over when the full store takes these routes.
//
// There is no email service yet, so signup skips the backend's emailed code and accounts stay email_verified = FALSE.
import { createHash } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const BCRYPT_ROUNDS = 10;
const TOKEN_SECONDS = 7 * 24 * 60 * 60;
const RATE_WINDOW_SECONDS = 15 * 60;
const IP_LIMIT = 20; // same as the backend's auth_limiter
const EMAIL_LIMIT = 10; // stops password guessing against one account from many addresses
const PASSWORD_MIN = 8;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[6-9]\d{9}$/;

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

export const createToken = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret(), { algorithm: 'HS256', expiresIn: TOKEN_SECONDS });

export function currentUserId(header) {
  if (!text(header).startsWith('Bearer ')) throw new ApiError(401, 'Login required');
  try {
    return jwt.verify(header.slice(7), jwtSecret(), { algorithms: ['HS256'] }).id;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(401, 'Invalid or expired token');
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
    emailVerified: u.email_verified,
    phoneVerified: u.phone_verified ?? false,
    hasPassword: Boolean(u.password_hash),
    googleLinked: Boolean(u.google_id),
    storeName: ['seller', 'admin'].includes(u.role) ? await store.storeName(u.id) : null,
    createdAt: u.created_at,
  };
}

const session = async (u, store) => ({ token: createToken(u), user: await publicUser(u, store) });

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
  const user = await ctx.store.create({ name, email, phone, passwordHash: hash });
  if (!user) throw new ApiError(409, 'An account with this email already exists. Please log in.');
  return { status: 201, body: await session(user, ctx.store) };
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
  await ctx.store.touchLogin(user.id);
  return { body: await session(user, ctx.store) };
}

async function signedInUser(ctx) {
  const user = await ctx.store.findById(currentUserId(ctx.authorization));
  if (!user) throw new ApiError(404, 'User not found');
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
  return { body: await publicUser(updated, ctx.store) };
}

const ROUTES = {
  'POST register': register,
  'POST login': login,
  'GET me': async (_, ctx) => ({ body: await publicUser(await signedInUser(ctx), ctx.store) }),
  'PUT me': updateProfile,
  'PUT password': changePassword,
};

/** The routes above; anything else (one-time codes, Google, phone) needs a service this deployment doesn't have. */
export const isAuthRoute = (method, rest) => `${method} ${rest}` in ROUTES;

/** Runs a route: expected errors become their status and message, anything else a plain 500 with no details. */
export async function safely(route) {
  try {
    jwtSecret(); // before any write: a signup must not create an account it can't then sign in
    const { status = 200, body } = await route();
    return { status, body, headers: {} };
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, body: { error: err.message }, headers: err.headers };
    console.error('store API error', err);
    return { status: 500, body: { error: 'Something went wrong. Please try again.' }, headers: {} };
  }
}

export function handleAuth({ method, rest, body, ip, authorization }, { store = postgresStore(), domainError = emailDomainError } = {}) {
  return safely(() => ROUTES[`${method} ${rest}`](body ?? {}, { store, ip, authorization, domainError }));
}

let client;
export const query = (statement, params = []) => (client ??= neon(process.env.DATABASE_URL)).query(statement, params);

export function postgresStore(db = query) {
  const one = async (statement, params) => (await db(statement, params))[0] ?? null;
  return {
    findByEmail: (email) => one('SELECT * FROM users WHERE email = $1', [email]),
    findById: (id) => one('SELECT * FROM users WHERE id = $1', [id]),
    create: ({ name, email, phone, passwordHash }) =>
      one(
        `INSERT INTO users (name, email, phone, password_hash, last_login) VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (email) DO NOTHING RETURNING *`,
        [name, email, phone, passwordHash],
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
