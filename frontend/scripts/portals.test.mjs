// Run with: npm test (from frontend/). Separate customer, seller and admin portals; admin MFA; seller applications,
// approval, suspension and settlements; OTP retries, delivery confirmation and diagnostics; test/live payments.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { listProducts } from '../../api/_catalog.mjs';
import { handleCrm } from '../../api/_crm.mjs';
import { currentStep, totp } from '../../api/_mfa.mjs';
import { sendCode, checkCode, otpDiagnostics } from '../../api/_otp.mjs';
import { paymentsConfig } from '../../api/_payment-config.mjs';
import { razorpayClient } from '../../api/_payments.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { handleSeller, syncSellerProducts } from '../../api/_seller.mjs';
import { handleShop } from '../../api/_shop.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
let n = 0;
const store = () => postgresStore(db);
const auth = (rest, body, extra = {}) => handleAuth({ method: 'POST', rest, body, ip: `5.5.5.${++n}`, ...extra }, { store: store(), domainError: async () => null, env: { JWT_SECRET: process.env.JWT_SECRET } });
const me = (token) => handleAuth({ method: 'GET', rest: 'me', authorization: `Bearer ${token}`, ip: 'x' }, { store: store() });
const crm = (token, method, path, body, params) => handleCrm({ method, rest: path.split('/').filter(Boolean), body, params, authorization: `Bearer ${token}`, ip: `6.6.6.${++n}` }, { db });
const hub = (token, method, path, body) => handleSeller({ method, rest: path.split('/'), body, authorization: `Bearer ${token}` }, { db });
const PHOTO = 'https://abc.public.blob.vercel-storage.com/x.jpg';

async function customer(email, name = 'Asha Rao') {
  const r = await auth('register', { name, email, password: 'secret123', phone: '9876543210' });
  return r.body;
}

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE users, auth_rate_limits, sellers, seller_products, seller_settlements, crm_staff, crm_sessions, crm_audit_log, crm_settings,
                 verification_codes, otp_delivery_logs RESTART IDENTITY CASCADE`);
});

test('three portals: the store admin only through /admin/login, the CRM only with admin-portal sessions', async () => {
  const asha = await customer('asha@example.com');
  assert.equal(asha.user.portal, 'customer');
  const owner = await customer('owner@example.com', 'Store Owner');
  await db("UPDATE users SET role = 'admin' WHERE email = 'owner@example.com'");
  // The admin can't use the customer login, and their old customer session can't open the CRM
  assert.equal((await auth('login', { email: 'owner@example.com', password: 'secret123' })).status, 403);
  assert.equal((await crm(owner.token, 'GET', 'dashboard')).status, 401);
  // A customer gets nothing from the admin portal, with the same answer as a wrong password
  const notStaff = await auth('admin/login', { email: 'asha@example.com', password: 'secret123' });
  const wrong = await auth('admin/login', { email: 'owner@example.com', password: 'nope1234' });
  assert.deepEqual([notStaff.status, notStaff.body.error], [401, wrong.body.error]);
  const admin = await auth('admin/login', { email: 'owner@example.com', password: 'secret123' });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.user.portal, 'admin');
  assert.equal((await crm(admin.body.token, 'GET', 'dashboard')).status, 200);
  assert.equal((await me(admin.body.token)).body.portal, 'admin');
  // A CRM team member (a customer account with a CRM role) signs in at the admin portal too
  await db("INSERT INTO crm_staff (user_id, role_key) VALUES ($1, 'analyst')", [asha.user.id]);
  assert.equal((await crm(asha.token, 'GET', 'reports/sales')).status, 401, 'not with a store session');
  const staff = await auth('admin/login', { email: 'asha@example.com', password: 'secret123' });
  assert.equal((await crm(staff.body.token, 'GET', 'reports/sales')).status, 200);
  const logins = await db("SELECT action FROM crm_audit_log WHERE action LIKE 'admin.login%' ORDER BY id");
  assert.ok(logins.some((l) => l.action === 'admin.login') && logins.some((l) => l.action === 'admin.login_failed'));
});

test('admin MFA: set up with an authenticator, then every admin sign-in needs a fresh code', async () => {
  await customer('owner@example.com', 'Store Owner');
  await db("UPDATE users SET role = 'admin' WHERE email = 'owner@example.com'");
  const first = (await auth('admin/login', { email: 'owner@example.com', password: 'secret123' })).body.token;
  const setup = await crm(first, 'POST', 'mfa/setup');
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal((await crm(first, 'POST', 'mfa/enable', { code: '000000' })).status, 400);
  const enabled = await crm(first, 'POST', 'mfa/enable', { code: totp(setup.body.secret, currentStep()) });
  assert.equal(enabled.body.enabled, true);
  assert.equal((await crm(first, 'GET', 'dashboard')).status, 401, 'turning MFA on ends the old sessions');
  const [stored] = await db("SELECT mfa_secret FROM users WHERE email = 'owner@example.com'");
  assert.ok(!stored.mfa_secret.includes(setup.body.secret), 'the secret is stored encrypted');
  // Password alone isn't enough any more
  const step1 = await auth('admin/login', { email: 'owner@example.com', password: 'secret123' });
  assert.deepEqual([step1.body.mfaRequired, step1.body.token], [true, undefined]);
  const next = totp(setup.body.secret, currentStep() + 1); // the next 30-second code (the current one was used to enable)
  const ok = await auth('admin/login', { email: 'owner@example.com', password: 'secret123', code: next });
  assert.equal(ok.status, 200);
  assert.equal((await crm(ok.body.token, 'GET', 'dashboard')).status, 200);
  assert.equal((await auth('admin/login', { email: 'owner@example.com', password: 'secret123', code: next })).status, 401, 'a code works once');
});

test('the store can require MFA: an account without it can only set it up', async () => {
  await customer('owner@example.com', 'Store Owner');
  await db("UPDATE users SET role = 'admin' WHERE email = 'owner@example.com'");
  await db(`INSERT INTO crm_settings (key, value) VALUES ('security', '{"requireMfa": true}')`);
  const token = (await auth('admin/login', { email: 'owner@example.com', password: 'secret123' })).body.token;
  assert.equal((await crm(token, 'GET', 'customers')).status, 403);
  assert.equal((await crm(token, 'GET', 'me')).status, 200);
  assert.equal((await crm(token, 'POST', 'mfa/setup')).status, 200);
});

test('sellers apply, verify, get reviewed and approved; only then can they sell, and suspension stops them', async () => {
  const signup = await auth('seller/register', { name: 'Meera Textiles', email: 'meera@example.com', password: 'secret123', phone: '9123456789' });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.portal, 'seller');
  const t = signup.body.token;
  assert.equal((await hub(t, 'GET', 'products')).status, 403, 'no application yet');
  const applied = await hub(t, 'POST', 'register', { storeName: 'Meera Textiles', pan: 'ABCDE1234F', gstin: '29ABCDE1234F1Z5', businessType: 'proprietorship', businessAddress: '1 Weavers Lane, Bengaluru' });
  assert.equal(applied.status, 201);
  assert.deepEqual(applied.body.missing, ['Verify your email or mobile number (Account → Profile)']);
  assert.match((await hub(t, 'POST', 'products', { name: 'Kurta' })).body.error, /being reviewed/);
  // A customer-portal session never reaches the hub, even for the same person
  const asCustomer = await auth('login', { email: 'meera@example.com', password: 'secret123' });
  assert.equal((await hub(asCustomer.body.token, 'GET', 'application')).status, 401);

  await customer('owner@example.com', 'Store Owner');
  await db("UPDATE users SET role = 'admin' WHERE email = 'owner@example.com'");
  const admin = (await auth('admin/login', { email: 'owner@example.com', password: 'secret123' })).body.token;
  const [{ id }] = await db("SELECT user_id AS id FROM sellers");
  const checks = { identity: true, pan: true, bank: true, gst: true };
  assert.equal((await crm(admin, 'POST', `sellers/${id}/review`, { action: 'approve', checks })).status, 409, 'contact not verified yet');
  await db('UPDATE users SET phone_verified = TRUE WHERE id = $1', [id]);
  assert.equal((await crm(admin, 'POST', `sellers/${id}/review`, { action: 'approve', checks: { identity: true } })).status, 400, 'every check');
  const approved = await crm(admin, 'POST', `sellers/${id}/review`, { action: 'approve', checks });
  assert.equal(approved.body.status, 'approved');
  assert.match(approved.body.seller_code, /^ARV-SEL-\d{4}-\d{6}$/);

  // Now they can list a product, but it isn't public until a product verification
  const made = await hub(t, 'POST', 'products', { name: 'Handloom Cotton Kurta', description: 'Soft cotton', category: 'fashion', brand: 'Meera', price: 1299, mrp: 1599, stock: 5, images: [PHOTO], audience: 'men' });
  assert.equal(made.status, 201);
  await syncSellerProducts(db, Date.now() + 120_000);
  await db(`INSERT INTO crm_settings (key, value) VALUES ('catalog', '{"requireVerification": true}')`);
  const { syncCatalogState } = await import('../../api/_inventory.mjs');
  await syncCatalogState(db, Date.now(), true);
  assert.equal(listProducts({ q: 'Handloom Cotton Kurta' }).length, 0, 'a pending seller product is never shown');
  await db("UPDATE seller_products SET data = jsonb_set(data, '{status}', '\"available\"')");
  await syncSellerProducts(db, Date.now() + 240_000);
  assert.equal(listProducts({ q: 'Handloom Cotton Kurta' }).length, 1);

  // Suspension: out of the hub at once, products off sale
  assert.equal((await crm(admin, 'POST', `sellers/${id}/review`, { action: 'suspend' })).status, 400, 'needs a reason');
  await crm(admin, 'POST', `sellers/${id}/review`, { action: 'suspend', note: 'Customer complaints under review' });
  assert.ok([401, 403].includes((await hub(t, 'GET', 'products')).status), 'suspended: refused at once');
  await syncSellerProducts(db, Date.now() + 400_000); // this test moved the catalog clock ahead earlier
  assert.equal(listProducts({ q: 'Handloom Cotton Kurta' }).length, 0);
  const fresh = (await auth('seller/login', { email: 'meera@example.com', password: 'secret123' })).body.token;
  assert.match((await hub(fresh, 'GET', 'products')).body.error, /suspended/);
  // Customers can't see seller management
  const asha = await customer('asha@example.com');
  assert.equal((await crm(asha.token, 'GET', 'sellers')).status, 403);
});

test('settlements: delivered, unsettled lines once, commission at the seller’s rate, paid with a UTR', async () => {
  const s = await auth('seller/register', { name: 'Meera Textiles', email: 'meera@example.com', password: 'secret123', phone: '9123456789' });
  await db("INSERT INTO sellers (user_id, store_name, status, commission_rate) VALUES ($1, 'Meera', 'approved', 12.5)", [s.body.user.id]);
  await db("UPDATE users SET role = 'seller' WHERE id = $1", [s.body.user.id]);
  const buyer = await customer('asha@example.com');
  const [o] = await db(`INSERT INTO orders (user_id, total, address, status) VALUES ($1, 2000, 'x', 'placed') RETURNING id`, [buyer.user.id]);
  await db(`INSERT INTO order_items (order_id, product_id, name, price, qty, seller_id, fulfilment, fulfilled_at) VALUES ($1, 'p1', 'Kurta', 1000, 2, $2, 'delivered', NOW())`, [o.id, s.body.user.id]);
  await customer('owner@example.com', 'Store Owner');
  await db("UPDATE users SET role = 'admin' WHERE email = 'owner@example.com'");
  const admin = (await auth('admin/login', { email: 'owner@example.com', password: 'secret123' })).body.token;
  const today = new Date().toISOString().slice(0, 10);
  const made = await crm(admin, 'POST', `sellers/${s.body.user.id}/settlements`, { from: today, to: today });
  assert.equal(made.status, 201);
  assert.deepEqual([Number(made.body.gross), Number(made.body.commission), Number(made.body.net), made.body.lines], [2000, 250, 1750, 1]);
  assert.equal((await crm(admin, 'POST', `sellers/${s.body.user.id}/settlements`, { from: today, to: today })).status, 409, 'each line once');
  assert.equal((await crm(admin, 'POST', `settlements/${made.body.id}/paid`, { reference: 'x' })).status, 400);
  assert.equal((await crm(admin, 'POST', `settlements/${made.body.id}/paid`, { reference: 'UTR20261126001' })).body.status, 'paid');
  const mine = await hub(s.body.token, 'GET', 'settlements');
  assert.equal(mine.body.length, 1);
});

test('OTP: transient provider errors are retried once, permanent ones not; typing the code in confirms delivery', async () => {
  const env = { JWT_SECRET: process.env.JWT_SECRET, RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.in' };
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('resend 503: {"message":"unavailable"}');
    return { provider: 'resend', ref: 'em_1' };
  };
  const sent = await sendCode(db, { purpose: 'test', target: 'owner@example.com', channel: 'email' }, { env, send: async (args) => flaky(args) });
  assert.equal(calls, 2);
  assert.ok(sent.sentTo && !sent.devCode);
  let [log] = await db('SELECT status, attempts, provider_code FROM otp_delivery_logs');
  assert.deepEqual([log.status, log.attempts, log.provider_code], ['accepted', 2, '2xx']);
  const permanent = async () => {
    throw new Error('resend 422: {"message":"invalid from"}');
  };
  await db("UPDATE verification_codes SET created_at = NOW() - INTERVAL '2 minutes'");
  await assert.rejects(sendCode(db, { purpose: 'test', target: 'other@example.com', channel: 'email' }, { env, send: permanent }), /couldn’t send/);
  [log] = await db("SELECT status, attempts, provider_code FROM otp_delivery_logs WHERE target_masked LIKE 'o***%' ORDER BY id DESC LIMIT 1");
  assert.deepEqual([log.status, log.attempts, log.provider_code], ['failed', 1, '422']);

  // Correct code entered → that delivery is confirmed
  const codeOf = async () => {
    let captured;
    await db("UPDATE verification_codes SET created_at = NOW() - INTERVAL '2 minutes'");
    await sendCode(db, { purpose: 'test', target: 'third@example.com', channel: 'email' }, { env, send: async ({ code }) => ((captured = code), { provider: 'resend', ref: 'em_3' }) });
    return captured;
  };
  await checkCode(db, { purpose: 'test', target: 'third@example.com', code: await codeOf() }, { env });
  const [third] = await db("SELECT status, delivered_at FROM otp_delivery_logs WHERE provider_ref = 'em_3'");
  assert.equal(third.status, 'delivered');
  const d = await otpDiagnostics(db, env);
  assert.equal(d.channels.email.state, 'working');
  assert.equal(d.channels.sms.state, 'not_configured');
  assert.ok(d.channels.sms.missing.length > 0);
  assert.equal(d.funnel.delivered, 1);
  assert.ok(!JSON.stringify(d).includes('owner@example.com'), 'addresses stay masked');
});

test('admin test OTP goes only to the admin’s own verified address; customers can’t reach diagnostics', async () => {
  await customer('owner@example.com', 'Store Owner');
  await db("UPDATE users SET role = 'admin', phone_verified = FALSE WHERE email = 'owner@example.com'");
  const admin = (await auth('admin/login', { email: 'owner@example.com', password: 'secret123' })).body.token;
  assert.equal((await crm(admin, 'POST', 'otp/test', { channel: 'sms' })).status, 409, 'own verified number only');
  assert.equal((await crm(admin, 'POST', 'otp/test', { channel: 'email' })).status, 503, 'no provider: not pretended');
  assert.equal((await crm(admin, 'GET', 'otp')).body.channels.email.state, 'not_configured');
  const asha = await customer('asha@example.com');
  assert.equal((await crm(asha.token, 'GET', 'otp')).status, 403);
});

test('payments run in test mode unless live is chosen on purpose, and the key must match the mode', () => {
  const keys = { RAZORPAY_KEY_SECRET: 's' };
  assert.equal(paymentsConfig({ ...keys, RAZORPAY_KEY_ID: 'rzp_test_abc' }).mode, 'test');
  assert.equal(paymentsConfig({ ...keys, RAZORPAY_KEY_ID: 'rzp_live_abc' }).enabled, false, 'a live key without PAYMENTS_MODE=live stays off');
  assert.equal(paymentsConfig({ ...keys, RAZORPAY_KEY_ID: 'rzp_live_abc', PAYMENTS_MODE: 'live' }).mode, 'live');
  assert.equal(paymentsConfig({ ...keys, RAZORPAY_KEY_ID: 'rzp_test_abc', PAYMENTS_MODE: 'live' }).enabled, false);
  assert.equal(razorpayClient({ ...keys, RAZORPAY_KEY_ID: 'rzp_live_abc' }).modeMismatch, true);
});

test('customers never get seller or admin powers from the store login or a new account', async () => {
  const r = await auth('register', { name: 'Sneaky', email: 'sneaky@example.com', password: 'secret123', role: 'admin', portal: 'admin' });
  assert.deepEqual([r.body.user.role, r.body.user.portal], ['customer', 'customer']);
  assert.equal((await crm(r.body.token, 'GET', 'customers')).status, 403);
  assert.equal((await hub(r.body.token, 'GET', 'products')).status, 401);
  assert.equal((await handleShop({ method: 'GET', segments: ['cart'], authorization: `Bearer ${r.body.token}`, ip: 'x' }, { db })).status, 200);
});
