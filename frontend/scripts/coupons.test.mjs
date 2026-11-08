// Run with: npm test (from frontend/). Coupon codes in api/_shop.mjs on PGlite (real PostgreSQL), including how they
// flow into cash and online orders.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { loadProducts } from '../../api/_catalog.mjs';
import { handlePayments, razorpayClient } from '../../api/_payments.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { couponSavings, handleShop } from '../../api/_shop.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
// A product between ₹1,000 and ₹3,000, so the minimums below are easy to cross or miss
const item = loadProducts().find((p) => p.stock >= 20 && p.price >= 1000 && p.price <= 3000);
const ADDRESS = { name: 'Asha', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };

async function addCoupon(code, fields = {}) {
  const c = { kind: 'percent', value: 10, min_order: 0, max_discount: null, starts_at: '2020-01-01', ends_at: null, public: true, active: true, description: `${code} offer`, ...fields };
  await db(
    `INSERT INTO coupons (code, description, kind, value, min_order, max_discount, starts_at, ends_at, public, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [code, c.description, c.kind, c.value, c.min_order, c.max_discount, c.starts_at, c.ends_at, c.public, c.active],
  );
}

async function shopper(email = 'asha@example.com') {
  const { body } = await handleAuth(
    { method: 'POST', rest: 'register', body: { name: 'Asha Rao', email, password: 'secret123' }, ip: '1.1.1.1' },
    { store: postgresStore(db), domainError: async () => null },
  );
  const authorization = `Bearer ${body.token}`;
  const shop = (method, path, payload) => handleShop({ method, segments: path.split('/'), body: payload, authorization, ip: '1.1.1.1' }, { db, rz: razorpayClient({}) });
  const address = (await shop('POST', 'addresses', ADDRESS)).body.id;
  return { shop, authorization, address };
}

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(() => pg.exec('TRUNCATE users, auth_rate_limits, coupons RESTART IDENTITY CASCADE'));

test('savings: percentages round down and respect their cap; flat amounts never exceed the order', () => {
  assert.equal(couponSavings({ kind: 'percent', value: '10', max_discount: null }, 1999), 199);
  assert.equal(couponSavings({ kind: 'percent', value: '50', max_discount: '300' }, 2000), 300);
  assert.equal(couponSavings({ kind: 'flat', value: '150', max_discount: null }, 1000), 150);
  assert.equal(couponSavings({ kind: 'flat', value: '500', max_discount: null }, 200), 200);
});

test('a valid coupon takes money off the total, and comes off again when removed', async () => {
  await addCoupon('FEST10', { kind: 'percent', value: 10, max_discount: 150 });
  const s = await shopper();
  await s.shop('POST', 'cart', { productId: item._id });
  const cart = (await s.shop('POST', 'cart/coupon', { code: ' fest10 ' })).body;
  const off = Math.min(Math.floor(item.price * 0.1), 150);
  assert.deepEqual([cart.coupon.code, cart.couponDiscount, cart.couponError], ['FEST10', off, null]);
  assert.equal(cart.total, item.price - off + cart.deliveryFee);
  assert.equal((await s.shop('GET', 'cart')).body.couponDiscount, off); // it stays on the cart
  const removed = (await s.shop('DELETE', 'cart/coupon')).body;
  assert.deepEqual([removed.coupon, removed.couponDiscount, removed.total], [null, 0, item.price + removed.deliveryFee]);
});

test('coupons that can’t be used are refused with a clear reason', async () => {
  await addCoupon('BIGSPEND', { min_order: item.price + 500 });
  await addCoupon('OLDDEAL', { ends_at: '2021-01-01' });
  await addCoupon('SOON', { starts_at: '2099-01-01' });
  await addCoupon('OFFNOW', { active: false });
  const s = await shopper();
  assert.equal((await s.shop('POST', 'cart/coupon', { code: 'BIGSPEND' })).status, 400); // empty cart
  await s.shop('POST', 'cart', { productId: item._id });
  const cases = { BIGSPEND: /Add items worth ₹500 more/, OLDDEAL: /expired/, SOON: /isn’t active yet/, OFFNOW: /no longer available/, NOPE99: /isn’t a valid coupon/, 'x!': /valid coupon code/ };
  for (const [code, reason] of Object.entries(cases)) {
    const { status, body } = await s.shop('POST', 'cart/coupon', { code });
    assert.ok([400, 404].includes(status), code);
    assert.match(body.error, reason, code);
  }
  assert.equal((await s.shop('GET', 'cart')).body.couponDiscount, 0);
});

test('a coupon stops applying if the cart drops below its minimum', async () => {
  await addCoupon('MIN1000', { kind: 'flat', value: 100, min_order: 1000 });
  const s = await shopper();
  await s.shop('POST', 'cart', { productId: item._id });
  assert.equal((await s.shop('POST', 'cart/coupon', { code: 'MIN1000' })).body.couponDiscount, 100);
  const cheap = loadProducts().find((p) => p.stock > 0 && p.price < 200);
  await s.shop('DELETE', `cart/${item._id}`);
  const cart = (await s.shop('POST', 'cart', { productId: cheap._id })).body;
  assert.equal(cart.couponDiscount, 0);
  assert.match(cart.couponError, /Add items worth/);
});

test('the order records the coupon, the customer can’t use it twice, and cancelling gives it back', async () => {
  await addCoupon('ONCE', { kind: 'flat', value: 100 });
  const s = await shopper();
  await s.shop('POST', 'cart', { productId: item._id });
  await s.shop('POST', 'cart/coupon', { code: 'ONCE' });
  const order = (await s.shop('POST', 'orders', { addressId: s.address, paymentMethod: 'cod' })).body;
  assert.deepEqual([order.coupon_code, order.coupon_discount], ['ONCE', 100]);
  assert.equal(order.total, item.price - 100 + order.delivery_fee);
  assert.equal((await s.shop('GET', 'cart')).body.coupon, null); // used up, so off the cart

  await s.shop('POST', 'cart', { productId: item._id });
  assert.match((await s.shop('POST', 'cart/coupon', { code: 'ONCE' })).body.error, /already used/);

  await s.shop('PATCH', `orders/${order.id}/cancel`);
  assert.equal((await s.shop('POST', 'cart/coupon', { code: 'ONCE' })).body.couponDiscount, 100);
});

test('a used coupon slipped into the cart can’t discount a second order', async () => {
  await addCoupon('ONCE', { kind: 'flat', value: 100 });
  const s = await shopper();
  await s.shop('POST', 'cart', { productId: item._id });
  await s.shop('POST', 'cart/coupon', { code: 'ONCE' });
  await s.shop('POST', 'orders', { addressId: s.address, paymentMethod: 'cod' });
  // Put it back directly, as a second tab or a stale request might
  const [{ id: userId }] = await db("SELECT id FROM users WHERE email = 'asha@example.com'");
  await db('INSERT INTO cart_coupons (user_id, code) VALUES ($1, $2)', [userId, 'ONCE']);
  await s.shop('POST', 'cart', { productId: item._id });
  const cart = (await s.shop('GET', 'cart')).body;
  assert.deepEqual([cart.couponDiscount, cart.couponError], [0, 'You’ve already used this coupon']);
  const second = await s.shop('POST', 'orders', { addressId: s.address, paymentMethod: 'cod' });
  assert.equal(second.status, 201);
  assert.deepEqual([second.body.coupon_code, second.body.coupon_discount], [null, 0]);
});

test('each customer gets their own use', async () => {
  await addCoupon('WELCOME', { kind: 'flat', value: 50 });
  for (const email of ['asha@example.com', 'ravi@example.com']) {
    const s = await shopper(email);
    await s.shop('POST', 'cart', { productId: item._id });
    await s.shop('POST', 'cart/coupon', { code: 'WELCOME' });
    assert.equal((await s.shop('POST', 'orders', { addressId: s.address, paymentMethod: 'cod' })).body.coupon_discount, 50);
  }
});

test('only public, current coupons are listed, marked if already used', async () => {
  await addCoupon('SHOWN', { min_order: 499, max_discount: 200 });
  await addCoupon('SECRET', { public: false });
  await addCoupon('GONE', { ends_at: '2021-01-01' });
  const s = await shopper();
  const list = (await s.shop('GET', 'cart/coupons')).body;
  assert.deepEqual(list.map((c) => [c.code, c.min_order, c.max_discount, c.used]), [['SHOWN', 499, 200, false]]);
  await s.shop('POST', 'cart', { productId: item._id });
  assert.equal((await s.shop('POST', 'cart/coupon', { code: 'SECRET' })).status, 200); // private codes still work
});

test('online payment charges the discounted total and records the coupon', async () => {
  await addCoupon('PAYNOW', { kind: 'flat', value: 200 });
  const ENV = { RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'test_secret' };
  const orders = new Map();
  const rz = Object.assign(razorpayClient(ENV), {
    createOrder: async (rupees) => {
      const o = { id: `order_${orders.size + 1}`, amount: Math.round(rupees * 100), currency: 'INR' };
      orders.set(o.id, o);
      return o;
    },
    fetchPayment: async (id) => ({ id, status: 'captured', method: 'paylater', amount: orders.get('order_1').amount }),
  });
  const s = await shopper();
  await s.shop('POST', 'cart', { productId: item._id });
  await s.shop('POST', 'cart/coupon', { code: 'PAYNOW' });
  const expected = (await s.shop('GET', 'cart')).body.total;
  const start = await handlePayments({ method: 'POST', rest: 'razorpay/order', body: { addressId: s.address }, authorization: s.authorization }, { db, rz });
  assert.equal(start.body.amount, expected * 100);
  const signature = createHmac('sha256', 'test_secret').update('order_1|pay_1').digest('hex');
  const done = await handlePayments({ method: 'POST', rest: 'razorpay/verify', body: { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: signature }, authorization: s.authorization }, { db, rz });
  const order = (await s.shop('GET', `orders/${done.body.orderId}`)).body;
  assert.deepEqual([order.payment_method, order.coupon_code, order.coupon_discount, order.total], ['paylater', 'PAYNOW', 200, expected]);
});
