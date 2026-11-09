// Run with: npm test (from frontend/, after `npm ci` in the repository root). Runs the shopping routes in api/_shop.mjs
// and the account SQL on PGlite, a real PostgreSQL engine, with the same schema the live database gets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { listProducts, loadProducts } from '../../api/_catalog.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { handleShop, isShopRoute } from '../../api/_shop.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
const domainError = async () => null;

const items = listProducts({ limit: 24 }).products ?? listProducts({ limit: 24 });
const inStock = items.filter((p) => p.stock >= 20);
const [cheap] = [...inStock].sort((a, b) => a.price - b.price);
const dear = [...inStock].sort((a, b) => b.price - a.price)[0];
const soldOut = loadProducts().find((p) => !p.stock);
const ADDRESS = { name: 'Asha Rao', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };

async function signUp(email = 'asha@example.com') {
  const { body } = await handleAuth(
    { method: 'POST', rest: 'register', body: { name: 'Asha Rao', email, password: 'secret123' }, ip: '1.1.1.1' },
    { store: postgresStore(db), domainError },
  );
  return { authorization: `Bearer ${body.token}`, id: body.user.id };
}

const call = (user, method, path, body) =>
  handleShop({ method, segments: path.split('/'), body, authorization: user?.authorization, ip: '1.1.1.1' }, { db });

async function addressId(user) {
  return (await call(user, 'POST', 'addresses', ADDRESS)).body.id;
}

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  pg = new PGlite();
  const schema = readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics');
  await pg.exec(schema);
  await pg.exec(STORE_SCHEMA);
});

beforeEach(() => pg.exec('TRUNCATE users, auth_rate_limits RESTART IDENTITY CASCADE'));

test('every shopping route needs a login', async () => {
  for (const [method, path] of [['GET', 'cart'], ['POST', 'cart'], ['GET', 'wishlist'], ['GET', 'addresses'], ['GET', 'orders'], ['POST', 'orders']]) {
    assert.equal((await call(null, method, path, {})).status, 401, path);
  }
});

test('the account SQL works: duplicate email, login count, profile and password', async () => {
  const store = postgresStore(db);
  const auth = (method, rest, body, authorization) => handleAuth({ method, rest, body, ip: '1.1.1.1', authorization }, { store, domainError });
  const user = await signUp();
  assert.equal((await auth('POST', 'register', { name: 'Asha', email: 'ASHA@example.com', password: 'secret123' })).status, 409);
  assert.equal((await auth('POST', 'login', { email: 'asha@example.com', password: 'secret123' })).status, 200);
  assert.equal((await auth('GET', 'me', null, user.authorization)).body.email, 'asha@example.com');
  const updated = await auth('PUT', 'me', { name: 'Asha R', phone: '9876543210' }, user.authorization);
  assert.deepEqual([updated.body.name, updated.body.phone], ['Asha R', '9876543210']);
  assert.equal((await auth('PUT', 'password', { currentPassword: 'secret123', newPassword: 'newsecret1' }, user.authorization)).status, 200);
  assert.equal((await auth('POST', 'login', { email: 'asha@example.com', password: 'newsecret1' })).status, 200);
});

test('the attempt counter really counts in the database and blocks past the limit', async () => {
  await signUp();
  const attempt = () => handleAuth({ method: 'POST', rest: 'login', body: { email: 'asha@example.com', password: 'wrongpass1' }, ip: '2.2.2.2' }, { store: postgresStore(db), domainError });
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await attempt()).status);
  assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
});

test('cart: add, merge, change, remove, with prices from the catalog', async () => {
  const user = await signUp();
  const added = await call(user, 'POST', 'cart', { productId: cheap._id, qty: 2, price: 1 });
  assert.equal(added.status, 201);
  assert.equal(added.body.items[0].price, cheap.price); // a price in the request is ignored
  assert.equal(added.body.items[0].subtotal, cheap.price * 2);
  assert.equal(added.body.discount, 0); // sample MRPs are not claimed as a discount
  const merged = await call(user, 'POST', 'cart', { productId: cheap._id, qty: 1 });
  assert.equal(merged.body.items.length, 1);
  assert.equal(merged.body.items[0].qty, 3);
  assert.equal((await call(user, 'PUT', `cart/${cheap._id}`, { qty: 99 })).body.items[0].qty, 10); // per-line maximum
  assert.equal((await call(user, 'POST', 'cart', { productId: cheap._id, qty: 5 })).body.items[0].qty, 10);
  assert.equal((await call(user, 'PUT', `cart/${cheap._id}`, { qty: 0 })).body.items.length, 0);
  await call(user, 'POST', 'cart', { productId: dear._id });
  assert.equal((await call(user, 'DELETE', `cart/${dear._id}`)).body.items.length, 0);
});

test('cart: refuses unknown and sold-out products', async () => {
  const user = await signUp();
  assert.equal((await call(user, 'POST', 'cart', { productId: 'nope' })).status, 404);
  assert.equal((await call(user, 'POST', 'cart', {})).status, 404);
  if (soldOut) assert.equal((await call(user, 'POST', 'cart', { productId: soldOut._id })).status, 409);
});

test('delivery is free from ₹499, otherwise ₹40', async () => {
  const user = await signUp();
  const small = await call(user, 'POST', 'cart', { productId: cheap._id });
  if (cheap.price < 499) assert.equal(small.body.deliveryFee, 40);
  const large = await call(user, 'POST', 'cart', { productId: dear._id });
  assert.ok(dear.price >= 499);
  assert.equal(large.body.deliveryFee, 0);
  assert.equal(large.body.total, cheap.price + dear.price);
});

test('wishlist: saves once, keeps order, removes', async () => {
  const user = await signUp();
  await call(user, 'POST', `wishlist/${cheap._id}`);
  await call(user, 'POST', `wishlist/${cheap._id}`);
  const list = await call(user, 'POST', `wishlist/${dear._id}`);
  assert.deepEqual(list.body.map((p) => p._id), [cheap._id, dear._id]);
  assert.equal((await call(user, 'POST', 'wishlist/nope')).status, 404);
  assert.equal((await call(user, 'DELETE', `wishlist/${cheap._id}`)).body.length, 1);
});

test('addresses: validated, and private to their owner', async () => {
  const asha = await signUp();
  const ravi = await signUp('ravi@example.com');
  assert.equal((await call(asha, 'POST', 'addresses', { ...ADDRESS, phone: '123' })).status, 400);
  assert.equal((await call(asha, 'POST', 'addresses', { ...ADDRESS, pincode: 'abc' })).status, 400);
  assert.equal((await call(asha, 'POST', 'addresses', { ...ADDRESS, city: '' })).status, 400);
  assert.equal((await call(asha, 'POST', 'addresses', { ...ADDRESS, name: 'x'.repeat(101) })).status, 400);
  const id = await addressId(asha);
  assert.equal((await call(ravi, 'GET', 'addresses')).body.length, 0);
  await call(ravi, 'DELETE', `addresses/${id}`);
  assert.equal((await call(asha, 'GET', 'addresses')).body.length, 1);
  assert.equal((await call(asha, 'DELETE', `addresses/${id}`)).status, 204);
  assert.equal((await call(asha, 'GET', 'addresses')).body.length, 0);
});

test('checkout: places a cash order, with its items and timeline, and empties the cart', async () => {
  const user = await signUp();
  await call(user, 'POST', 'cart', { productId: dear._id, qty: 2 });
  const placed = await call(user, 'POST', 'orders', { addressId: await addressId(user), paymentMethod: 'cod' });
  assert.equal(placed.status, 201);
  assert.strictEqual(placed.body.total, dear.price * 2);
  assert.equal(placed.body.payment_method, 'cod');
  assert.equal((await call(user, 'GET', 'cart')).body.items.length, 0);

  const order = (await call(user, 'GET', `orders/${placed.body.id}`)).body;
  assert.equal(order.status, 'placed');
  assert.strictEqual(order.total, dear.price * 2);
  assert.match(order.address, /12 MG Road, Bengaluru, Karnataka - 560001\. Phone: 9876543210/);
  assert.deepEqual(order.items.map((i) => [i.product_id, Number(i.price), i.qty, i.fulfilment]), [[dear._id, dear.price, 2, 'pending']]);
  assert.deepEqual(order.events.map((e) => e.status), ['placed']);
  assert.equal(order.return, null);
  assert.equal((await call(user, 'GET', 'orders')).body.length, 1);
});

test('checkout: refuses an empty cart, online payment and someone else’s address', async () => {
  const asha = await signUp();
  const ravi = await signUp('ravi@example.com');
  const raviAddress = await addressId(ravi);
  assert.equal((await call(asha, 'POST', 'orders', { addressId: await addressId(asha), paymentMethod: 'cod' })).status, 400);
  await call(asha, 'POST', 'cart', { productId: cheap._id });
  assert.equal((await call(asha, 'POST', 'orders', { addressId: raviAddress, paymentMethod: 'cod' })).status, 404);
  assert.equal((await call(asha, 'POST', 'orders', { addressId: raviAddress, paymentMethod: 'upi' })).status, 400);
  assert.equal((await call(asha, 'POST', 'orders', { paymentMethod: 'cod' })).status, 400);
  assert.equal((await call(asha, 'GET', 'orders')).body.length, 0);
});

test('checkout: a double-clicked Place order creates one order', async () => {
  const user = await signUp();
  await call(user, 'POST', 'cart', { productId: dear._id });
  const request = { addressId: await addressId(user), paymentMethod: 'cod' };
  const results = await Promise.all([call(user, 'POST', 'orders', request), call(user, 'POST', 'orders', request)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
  assert.equal((await call(user, 'GET', 'orders')).body.length, 1);
});

test('checkout: orders are limited, so nobody can flood the store', async () => {
  const user = await signUp();
  const address = await addressId(user);
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    await call(user, 'POST', 'cart', { productId: cheap._id });
    statuses.push((await call(user, 'POST', 'orders', { addressId: address, paymentMethod: 'cod' })).status);
  }
  assert.deepEqual(statuses, [...Array(10).fill(201), 429]);
});

test('orders are private, and can be cancelled once by their owner', async () => {
  const asha = await signUp();
  const ravi = await signUp('ravi@example.com');
  await call(asha, 'POST', 'cart', { productId: dear._id });
  const { body: order } = await call(asha, 'POST', 'orders', { addressId: await addressId(asha), paymentMethod: 'cod' });
  assert.equal((await call(ravi, 'GET', `orders/${order.id}`)).status, 404);
  assert.equal((await call(ravi, 'PATCH', `orders/${order.id}/cancel`)).status, 400);
  assert.equal((await call(asha, 'GET', `orders/${order.id}`)).body.status, 'placed');

  assert.equal((await call(asha, 'PATCH', `orders/${order.id}/cancel`)).body.status, 'cancelled');
  assert.equal((await call(asha, 'PATCH', `orders/${order.id}/cancel`)).status, 400);
  assert.deepEqual((await call(asha, 'GET', `orders/${order.id}`)).body.events.map((e) => e.status), ['placed', 'cancelled']);
});

test('a shipped order cannot be cancelled', async () => {
  const user = await signUp();
  await call(user, 'POST', 'cart', { productId: dear._id });
  const { body: order } = await call(user, 'POST', 'orders', { addressId: await addressId(user), paymentMethod: 'cod' });
  await db("UPDATE order_items SET fulfilment = 'shipped' WHERE order_id = $1", [order.id]);
  assert.equal((await call(user, 'PATCH', `orders/${order.id}/cancel`)).status, 400);
});

test('odd ids are a clean 404 or 400, never a database error', async () => {
  const user = await signUp();
  assert.equal((await call(user, 'GET', 'orders/abc')).status, 404);
  assert.equal((await call(user, 'GET', 'orders/99999999999999999999')).status, 404);
  assert.equal((await call(user, 'PATCH', "orders/1'--/cancel")).status, 400);
  assert.equal((await call(user, 'DELETE', 'addresses/abc')).status, 204);
});

test('only the listed routes are served', () => {
  for (const [method, path] of [['POST', 'cart/abc'], ['DELETE', 'orders/1'], ['GET', 'orders/1/cancel'], ['PUT', 'orders/1/return'], ['GET', 'constructor'], ['GET', 'cart/a/b/c']]) {
    assert.equal(isShopRoute(method, path.split('/')), false, path);
  }
  assert.equal(isShopRoute('PATCH', ['orders', '1', 'cancel']), true);
  assert.equal(isShopRoute('GET', ['cart']), true);
});
