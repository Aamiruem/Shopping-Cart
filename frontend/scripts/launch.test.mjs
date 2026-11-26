// Run with: npm test (from frontend/). Public-launch rules on PGlite (a real PostgreSQL engine): only verified products
// are shown or sold, customer and order numbers, mobile sign-up, courier checks and tracking, and privacy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { getProduct, listProducts, loadProducts, storeCatalog } from '../../api/_catalog.mjs';
import { handleCrm } from '../../api/_crm.mjs';
import { handleProviderWebhook } from '../../api/_crm_webhooks.mjs';
import { syncCatalogState } from '../../api/_inventory.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { handleShop } from '../../api/_shop.mjs';
import { assertDeliverable, parseAddress, serviceability } from '../../api/_shipping.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
let n = 0;
const ENV = () => ({ JWT_SECRET: process.env.JWT_SECRET, OTP_DEV_CODES: '1' });
const auth = (rest, body, extra = {}) => handleAuth({ method: 'POST', rest, body, ip: `2.2.2.${++n}`, ...extra }, { store: postgresStore(db), domainError: async () => null, env: ENV() });

async function person(email, role = 'customer') {
  const { body } = await handleAuth({ method: 'POST', rest: 'register', body: { name: email.split('@')[0], email, password: 'secret123', phone: '9876543210' }, ip: `2.2.2.${++n}` },
    { store: postgresStore(db), domainError: async () => null, env: { JWT_SECRET: process.env.JWT_SECRET } });
  if (role !== 'customer') await db('UPDATE users SET role = $1 WHERE id = $2', [role, body.user.id]);
  const authorization = `Bearer ${body.token}`;
  return {
    id: body.user.id, user: body.user, authorization,
    shop: (method, path, payload) => handleShop({ method, segments: path.split('/'), body: payload, authorization, ip: `3.3.3.${n}` }, { db, rz: { configured: false } }),
    crm: (method, path, payload, params) => handleCrm({ method, rest: path.split('/').filter(Boolean), body: payload, params, authorization, ip: `4.4.4.${n}` }, { db }),
  };
}
async function withAddress(who) {
  await who.shop('POST', 'addresses', { name: 'Test Person', phone: '9876543210', line1: '1 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' });
  return (await db('SELECT id FROM addresses WHERE user_id = $1', [who.id]))[0].id;
}
const ALL_CHECKS = { name: true, description: true, images: true, supplier: true, price: true, inventory: true, condition: true, specifications: true, warranty: true, shipping: true, returns: true, authenticity: true };
const requireVerification = async (on) => {
  await db(`INSERT INTO crm_settings (key, value) VALUES ('catalog', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ requireVerification: on })]);
  await syncCatalogState(db, Date.now(), true);
};

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(async () => {
  await pg.exec(`TRUNCATE users, auth_rate_limits, leads, crm_staff, crm_sessions, crm_audit_log, crm_settings, catalog_overrides, stock_adjustments,
                 product_verifications, verification_codes, shipments RESTART IDENTITY CASCADE`);
  await requireVerification(false);
});

test('with verification required, nothing unverified is listed, shown or sold, and checkout checks again', async () => {
  const sample = storeCatalog().find((p) => p.stock >= 20 && !p.sizes?.length);
  await requireVerification(true);
  assert.equal(loadProducts().length, 0, 'an unverified catalog lists nothing');
  assert.equal(getProduct(sample._id), null, 'not even by direct link');
  assert.equal(listProducts({ q: sample.name }).length, 0);
  const owner = await person('owner@example.com', 'admin');
  const asha = await person('asha@example.com');
  assert.equal((await asha.shop('POST', 'cart', { productId: sample._id, qty: 1 })).status, 404);

  // Approval needs the whole checklist, the supplier, the evidence and the condition
  assert.equal((await owner.crm('POST', `catalog/${sample._id}/status`, { status: 'available' })).status, 409);
  await owner.crm('POST', `catalog/${sample._id}/verification`, { checks: ALL_CHECKS, supplier: 'Acme Distributors', evidence: 'Invoice INV-2026-118 dated 20 Nov, stock counted on site', condition: 'new' });
  const ok = await owner.crm('POST', `catalog/${sample._id}/status`, { status: 'available' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(getProduct(sample._id).purchasable, true);
  assert.deepEqual(loadProducts().map((p) => p._id), [sample._id]);

  // In the cart, then withdrawn: checkout refuses it
  assert.equal((await asha.shop('POST', 'cart', { productId: sample._id, qty: 1 })).status, 201);
  const addressId = await withAddress(asha);
  await owner.crm('POST', `catalog/${sample._id}/status`, { status: 'coming_soon' });
  assert.equal(getProduct(sample._id).purchasable, false);
  assert.equal(listProducts({ availability: 'coming_soon' }).length, 1);
  assert.equal(loadProducts().length, 0, 'coming soon is its own section');
  const placed = await asha.shop('POST', 'orders', { addressId, paymentMethod: 'cod' });
  assert.equal(placed.status, 409);
  assert.equal((await db('SELECT count(*)::int AS n FROM orders'))[0].n, 0);
  assert.equal((await asha.shop('POST', 'cart', { productId: sample._id, qty: 1 })).status, 409);

  // Out of stock, discontinued: visible by link, never purchasable
  await owner.crm('POST', `catalog/${sample._id}/status`, { status: 'discontinued' });
  assert.equal(getProduct(sample._id).availability, 'discontinued');
  assert.equal(loadProducts().length, 0);
  assert.equal((await owner.crm('PUT', 'catalog/settings', { requireVerification: false })).status, 409, 'can’t be switched off');
  const audit = await db("SELECT action FROM crm_audit_log WHERE entity = 'product' ORDER BY id");
  assert.deepEqual(audit.map((a) => a.action), ['product.verification', 'product.available', 'product.coming_soon', 'product.discontinued']);
  // A customer can't reach the catalog tools
  assert.equal((await asha.crm('GET', 'catalog')).status, 403);
});

test('customer and order numbers come from sequences: unique, formatted, never the internal id', async () => {
  const a = await person('arun@example.com');
  const b = await person('bina@example.com');
  const year = new Date().getFullYear();
  assert.match(a.user.customerId, new RegExp(`^ARV-CUS-${year}-\\d{6}$`));
  assert.notEqual(a.user.customerId, b.user.customerId);
  const [p1, p2] = listProducts({ limit: 200 }).filter((p) => p.stock >= 30 && !p.sizes?.length);
  const addA = await withAddress(a);
  const addB = await withAddress(b);
  await a.shop('POST', 'cart', { productId: p1._id, qty: 1 });
  await b.shop('POST', 'cart', { productId: p2._id, qty: 1 });
  // Two checkouts at the same moment
  const [x, y] = await Promise.all([a.shop('POST', 'orders', { addressId: addA, paymentMethod: 'cod' }), b.shop('POST', 'orders', { addressId: addB, paymentMethod: 'cod' })]);
  assert.equal(x.status, 201);
  assert.equal(y.status, 201);
  assert.match(x.body.order_number, new RegExp(`^ARV-ORD-${year}-\\d{6}$`));
  assert.notEqual(x.body.order_number, y.body.order_number);
  const mine = await a.shop('GET', `orders/${x.body.id}`);
  assert.equal(mine.body.order_number, x.body.order_number);
});

test('customers see only their own orders; a browser-supplied id changes nothing', async () => {
  const a = await person('arun@example.com');
  const b = await person('bina@example.com');
  const [p] = listProducts({ limit: 200 }).filter((q) => q.stock >= 30 && !q.sizes?.length);
  const addressId = await withAddress(a);
  await a.shop('POST', 'cart', { productId: p._id, qty: 1 });
  const order = (await a.shop('POST', 'orders', { addressId, paymentMethod: 'cod' })).body;
  assert.equal((await b.shop('GET', `orders/${order.id}`)).status, 404);
  assert.equal((await b.shop('PATCH', `orders/${order.id}/cancel`)).status, 400);
  assert.equal((await b.shop('POST', 'orders', { addressId, paymentMethod: 'cod' })).status, 404, 'someone else’s address');
  assert.equal((await handleShop({ method: 'GET', segments: ['orders'], ip: 'x' }, { db })).status, 401);
  // Payment status can't be set from the browser: there is no route for it
  assert.equal((await handleShop({ method: 'PATCH', segments: ['orders', String(order.id)], body: { status: 'paid' }, authorization: a.authorization, ip: 'x' }, { db })).status, 404);
});

test('mobile sign-in: one code proves one number once, then signs in or creates the account', async () => {
  const sent = await auth('mobile/start', { phone: '+91 91234 56789', channel: 'sms' });
  assert.equal(sent.status, 200);
  assert.ok(sent.body.devCode && !JSON.stringify(sent.body).includes('code_hash'));
  const wrong = await auth('mobile/login', { phone: '9123456789', code: sent.body.devCode === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  const first = await auth('mobile/login', { phone: '9123456789', code: sent.body.devCode });
  assert.equal(first.body.needsProfile, true);
  assert.equal((await auth('mobile/login', { phone: '9123456789', code: sent.body.devCode })).status, 400, 'used once');
  const made = await auth('mobile/complete', { signupToken: first.body.signupToken, name: 'Meena Iyer', email: 'meena@example.com' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.user.phoneVerified, true);
  assert.match(made.body.user.customerId, /^ARV-CUS-/);
  assert.equal((await auth('mobile/complete', { signupToken: first.body.signupToken, name: 'Again', email: 'other@example.com' })).status, 409, 'one account per number');
  // Next time the same number signs straight in
  await db("UPDATE verification_codes SET created_at = NOW() - INTERVAL '2 minutes'");
  const again = await auth('mobile/start', { phone: '9123456789' });
  const login = await auth('mobile/login', { phone: '9123456789', code: again.body.devCode });
  assert.equal(login.body.user.email, 'meena@example.com');
  // A number typed (not verified) on someone else's account is never linked to it
  await person('typed@example.com'); // registered with 9876543210, unverified
  const s3 = await auth('mobile/start', { phone: '9876543210' });
  const l3 = await auth('mobile/login', { phone: '9876543210', code: s3.body.devCode });
  assert.equal(l3.body.needsProfile, true);
  // Without a provider (production, no dev codes) the channel is unavailable, not faked
  const prod = await handleAuth({ method: 'POST', rest: 'mobile/start', body: { phone: '9123456780' }, ip: '9.9.9.9' }, { store: postgresStore(db), env: { JWT_SECRET: process.env.JWT_SECRET, NODE_ENV: 'production', OTP_DEV_CODES: '1' } });
  assert.equal(prod.status, 503);
});

test('courier: no claims without a connection; real answers when connected; tracking events count once', async () => {
  assert.deepEqual(await serviceability('411001', {}, { env: {} }), { checked: false, provider: null });
  const env = { SHIPROCKET_EMAIL: 'api@x.in', SHIPROCKET_PASSWORD: 'p', SHIPROCKET_PICKUP_POSTCODE: '560001' };
  const fake = (couriers) => async (url) => {
    if (String(url).includes('/auth/login')) return new Response(JSON.stringify({ token: 't' }), { status: 200 });
    return new Response(JSON.stringify({ data: { available_courier_companies: couriers } }), { status: couriers.length ? 200 : 404 });
  };
  const yes = await serviceability('411001', { cod: true }, { env, fetchImpl: fake([{ courier_name: 'Delhivery', rate: 62, estimated_delivery_days: '3', etd: 'Nov 30, 2026' }]) });
  assert.deepEqual([yes.serviceable, yes.days, yes.cheapestRate], [true, { min: 3, max: 3 }, 62]);
  await assert.rejects(assertDeliverable('A, 1 Road, Leh, Ladakh - 194101. Phone: 9876543210', { cod: true }, { env, fetchImpl: fake([]) }), /cash-on-delivery/);
  assert.deepEqual(parseAddress('Asha Rao, 12 MG Road, Bengaluru, Karnataka - 560001. Phone: 9876543210'), { name: 'Asha Rao', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210' });

  // Tracking webhook: token checked, each event once, delivered marks the order delivered
  const a = await person('arun@example.com');
  const [p] = listProducts({ limit: 200 }).filter((q) => q.stock >= 30 && !q.sizes?.length);
  const addressId = await withAddress(a);
  await a.shop('POST', 'cart', { productId: p._id, qty: 1 });
  const order = (await a.shop('POST', 'orders', { addressId, paymentMethod: 'cod' })).body;
  await db("INSERT INTO shipments (order_id, provider, awb, courier, status) VALUES ($1, 'shiprocket', 'AWB123', 'Delhivery', 'awb_assigned')", [order.id]);
  const hook = (body, token = 'tok') => handleProviderWebhook('courier', { method: 'POST', url: 'u', headers: { 'x-api-key': token }, raw: JSON.stringify(body) }, { db, env: { SHIPROCKET_WEBHOOK_TOKEN: 'tok' } });
  assert.equal((await hook({ awb: 'AWB123', current_status: 'IN TRANSIT' }, 'nope')).status, 401);
  const transit = { awb: 'AWB123', current_status: 'IN TRANSIT', current_status_id: 18, current_timestamp: '2026-11-26 10:00:00', scans: [{ location: 'Pune Hub' }] };
  await hook(transit);
  assert.equal((await hook(transit)).body.duplicate, true);
  await hook({ awb: 'AWB123', current_status: 'DELIVERED', current_status_id: 7, current_timestamp: '2026-11-27 12:00:00' });
  const events = await db('SELECT status FROM order_events WHERE order_id = $1 ORDER BY id', [order.id]);
  assert.deepEqual(events.map((e) => e.status), ['placed', 'in_transit', 'delivered']);
  const [line] = await db('SELECT fulfilment FROM order_items WHERE order_id = $1', [order.id]);
  assert.equal(line.fulfilment, 'delivered');
  assert.equal((await hook({ awb: 'NOT-OURS', current_status: 'DELIVERED' })).body.ignored, 'unknown AWB');
});
