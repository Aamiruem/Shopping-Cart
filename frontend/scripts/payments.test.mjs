// Run with: npm test (from frontend/). The Razorpay flow in api/_payments.mjs on PGlite (real PostgreSQL), with
// Razorpay's servers replaced by a stand-in. Signatures are made exactly as Razorpay makes them.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { loadProducts } from '../../api/_catalog.mjs';
import { paymentsConfig } from '../../api/_payment-config.mjs';
import { handlePayments, handleWebhook, razorpayClient } from '../../api/_payments.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { handleShop } from '../../api/_shop.mjs';

const ENV = { RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'test_secret', RAZORPAY_WEBHOOK_SECRET: 'hook_secret' };
const sign = (secret, message) => createHmac('sha256', secret).update(message).digest('hex');
const product = loadProducts().find((p) => p.stock >= 20 && p.price >= 499);
const other = loadProducts().find((p) => p.stock >= 20 && p._id !== product._id);

let pg;
let rz;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;

// Razorpay's servers: orders, payments the shopper "makes", captures and refunds
function fakeRazorpay() {
  const real = razorpayClient(ENV);
  const state = { orders: new Map(), payments: new Map(), captured: [], refunded: [], next: 1 };
  return Object.assign(real, {
    state,
    createOrder: async (rupees) => {
      const order = { id: `order_${state.next++}`, amount: Math.round(rupees * 100), currency: 'INR' };
      state.orders.set(order.id, order);
      return order;
    },
    fetchPayment: async (id) => state.payments.get(id),
    capture: async (id) => {
      state.captured.push(id);
      state.payments.get(id).status = 'captured';
    },
    refund: async (id) => state.refunded.push(id),
  });
}

// What Razorpay Checkout hands the browser after a payment
function pay(orderId, { status = 'captured', method = 'upi', amount } = {}) {
  const id = `pay_${rz.state.next++}`;
  rz.state.payments.set(id, { id, order_id: orderId, status, method, amount: amount ?? rz.state.orders.get(orderId).amount });
  return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: sign(ENV.RAZORPAY_KEY_SECRET, `${orderId}|${id}`) };
}

async function shopper(email = 'asha@example.com') {
  const { body } = await handleAuth(
    { method: 'POST', rest: 'register', body: { name: 'Asha Rao', email, password: 'secret123' }, ip: '1.1.1.1' },
    { store: postgresStore(db), domainError: async () => null },
  );
  const authorization = `Bearer ${body.token}`;
  const shop = (method, path, payload) => handleShop({ method, segments: path.split('/'), body: payload, authorization, ip: '1.1.1.1' }, { db, rz });
  const payments = (method, rest, payload) => handlePayments({ method, rest, body: payload, authorization }, { db, rz });
  const address = (await shop('POST', 'addresses', { name: 'Asha', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' })).body.id;
  await shop('POST', 'cart', { productId: product._id, qty: 2 });
  return { shop, payments, address };
}

const ordersCount = async () => (await db('SELECT count(*)::int AS n FROM orders'))[0].n;
const paymentRow = async (orderId) => (await db('SELECT * FROM payments WHERE provider_order_id = $1', [orderId]))[0];

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(async () => {
  await pg.exec('TRUNCATE users, auth_rate_limits RESTART IDENTITY CASCADE');
  rz = fakeRazorpay();
});

test('online payment is offered only when both keys are set, and the secret is never shown', () => {
  assert.equal(paymentsConfig({}).enabled, false);
  assert.equal(paymentsConfig({ RAZORPAY_KEY_ID: 'rzp_test_key' }).enabled, false);
  const on = paymentsConfig(ENV);
  assert.deepEqual([on.enabled, on.keyId, on.methods], [true, 'rzp_test_key', ['upi', 'card', 'netbanking', 'emi', 'paylater', 'wallet']]);
  assert.ok(!JSON.stringify(on).includes('test_secret'));
});

test('without keys, starting a payment says to use cash on delivery', async () => {
  const s = await shopper();
  const result = await handlePayments({ method: 'POST', rest: 'razorpay/order', body: { addressId: s.address }, authorization: (await s.shop('GET', 'cart')).status && undefined }, { db, rz: razorpayClient({}) });
  assert.equal(result.status, 401); // and logged-out callers are refused first
  const keyless = await handlePayments(
    { method: 'POST', rest: 'razorpay/order', body: { addressId: s.address }, authorization: `Bearer ${(await handleAuth({ method: 'POST', rest: 'login', body: { email: 'asha@example.com', password: 'secret123' }, ip: '1.1.1.1' }, { store: postgresStore(db) })).body.token}` },
    { db, rz: razorpayClient({}) },
  );
  assert.equal(keyless.status, 503);
});

test('pay by UPI: the order is created only after the signature checks out', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  assert.equal(start.status, 200);
  assert.equal(start.body.amount, product.price * 2 * 100); // paise, from the server's prices
  assert.equal(start.body.keyId, 'rzp_test_key');
  assert.equal(await ordersCount(), 0); // nothing until the money is confirmed

  const verified = await s.payments('POST', 'razorpay/verify', pay(start.body.orderId, { method: 'upi' }));
  assert.equal(verified.status, 200);
  assert.equal(verified.body.method, 'upi');
  const order = (await s.shop('GET', `orders/${verified.body.orderId}`)).body;
  assert.deepEqual([order.payment_method, order.payment_status, order.total], ['upi', 'paid', product.price * 2]);
  assert.equal((await s.shop('GET', 'cart')).body.items.length, 0);
  assert.equal((await paymentRow(start.body.orderId)).status, 'paid');
});

test('every Razorpay method is recorded on the order', async () => {
  for (const [method, recorded] of [['netbanking', 'netbanking'], ['card', 'card'], ['wallet', 'wallet'], ['emi', 'emi'], ['cardless_emi', 'emi'], ['paylater', 'paylater'], ['something_new', 'online']]) {
    await pg.exec('TRUNCATE users, auth_rate_limits RESTART IDENTITY CASCADE');
    const s = await shopper();
    const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
    const verified = await s.payments('POST', 'razorpay/verify', pay(start.body.orderId, { method }));
    assert.equal((await s.shop('GET', `orders/${verified.body.orderId}`)).body.payment_method, recorded);
  }
});

test('a forged signature places no order', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  const forged = { ...pay(start.body.orderId), razorpay_signature: sign('wrong', 'x') };
  assert.equal((await s.payments('POST', 'razorpay/verify', forged)).status, 400);
  assert.equal(await ordersCount(), 0);
  assert.equal((await paymentRow(start.body.orderId)).status, 'failed');
});

test('submitting the same payment twice gives one order', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  const proof = pay(start.body.orderId);
  const first = await s.payments('POST', 'razorpay/verify', proof);
  const again = await s.payments('POST', 'razorpay/verify', proof);
  assert.equal(again.body.orderId, first.body.orderId);
  assert.equal(await ordersCount(), 1);
});

test('a payment the bank only authorised is captured before the order', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  const proof = pay(start.body.orderId, { status: 'authorized' });
  assert.equal((await s.payments('POST', 'razorpay/verify', proof)).status, 200);
  assert.deepEqual(rz.state.captured, [proof.razorpay_payment_id]);
});

test('if the cart changed while paying, the money is refunded and no order is made', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  await s.shop('POST', 'cart', { productId: other._id }); // a second tab adds something
  const proof = pay(start.body.orderId);
  const result = await s.payments('POST', 'razorpay/verify', proof);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /refunded/);
  assert.deepEqual(rz.state.refunded, [proof.razorpay_payment_id]);
  assert.equal(await ordersCount(), 0);
  assert.equal((await paymentRow(start.body.orderId)).status, 'refunded');
});

test('an unfinished payment places nothing and can be retried', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  assert.equal((await s.payments('POST', 'razorpay/verify', pay(start.body.orderId, { status: 'failed' }))).status, 402);
  assert.equal(await ordersCount(), 0);
  assert.equal((await s.payments('POST', 'razorpay/verify', pay(start.body.orderId))).status, 200);
});

test('nobody can confirm another shopper’s payment', async () => {
  const asha = await shopper();
  const ravi = await shopper('ravi@example.com');
  const start = await asha.payments('POST', 'razorpay/order', { addressId: asha.address });
  assert.equal((await ravi.payments('POST', 'razorpay/verify', pay(start.body.orderId))).status, 404);
});

test('cancelling a paid order refunds it; cash orders need no refund', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  const proof = pay(start.body.orderId);
  const { body } = await s.payments('POST', 'razorpay/verify', proof);
  const cancelled = await s.shop('PATCH', `orders/${body.orderId}/cancel`);
  assert.deepEqual([cancelled.body.status, cancelled.body.refund], ['cancelled', 'refunded']);
  assert.deepEqual(rz.state.refunded, [proof.razorpay_payment_id]);

  await s.shop('POST', 'cart', { productId: product._id });
  const cash = await s.shop('POST', 'orders', { addressId: s.address, paymentMethod: 'cod' });
  assert.equal((await s.shop('PATCH', `orders/${cash.body.id}/cancel`)).body.refund, null);
});

test('payment history lists the shopper’s attempts', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  await s.payments('POST', 'razorpay/verify', pay(start.body.orderId, { method: 'card' }));
  const { body } = await s.payments('GET', 'mine');
  assert.deepEqual(body.map((p) => [p.method, p.status, p.amount]), [['card', 'paid', product.price * 2]]);
});

test('webhook: a payment whose tab was closed still becomes one order, and forged calls are refused', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  const proof = pay(start.body.orderId);
  const entity = rz.state.payments.get(proof.razorpay_payment_id);
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity } } });

  assert.equal((await handleWebhook(raw, sign('wrong', raw), { db, rz })).status, 400);
  assert.equal(await ordersCount(), 0);
  assert.equal((await handleWebhook(raw, sign(ENV.RAZORPAY_WEBHOOK_SECRET, raw), { db, rz })).status, 200);
  assert.equal((await handleWebhook(raw, sign(ENV.RAZORPAY_WEBHOOK_SECRET, raw), { db, rz })).status, 200); // Razorpay retries
  assert.equal(await ordersCount(), 1);
  assert.equal((await paymentRow(start.body.orderId)).status, 'paid');
  // The shopper's browser arriving late gets the same order
  assert.equal((await s.payments('POST', 'razorpay/verify', proof)).status, 200);
  assert.equal(await ordersCount(), 1);
});

test('webhook: failures and refunds update the payment', async () => {
  const s = await shopper();
  const start = await s.payments('POST', 'razorpay/order', { addressId: s.address });
  const failed = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { order_id: start.body.orderId, error_description: 'Bank declined' } } } });
  await handleWebhook(failed, sign(ENV.RAZORPAY_WEBHOOK_SECRET, failed), { db, rz });
  assert.deepEqual([(await paymentRow(start.body.orderId)).status, (await paymentRow(start.body.orderId)).error], ['failed', 'Bank declined']);

  const proof = pay(start.body.orderId);
  await s.payments('POST', 'razorpay/verify', proof);
  const refunded = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { payment_id: proof.razorpay_payment_id } } } });
  await handleWebhook(refunded, sign(ENV.RAZORPAY_WEBHOOK_SECRET, refunded), { db, rz });
  assert.equal((await paymentRow(start.body.orderId)).status, 'refunded');
});
