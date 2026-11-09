// Run with: npm test (from frontend/). Stock and catalog edits (api/_inventory.mjs), reviews (api/_reviews.mjs),
// recommendations from demand (api/_recommend.mjs) and how card payments are recorded, on PGlite (real PostgreSQL).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { getProduct, listProducts, setCatalogState } from '../../api/_catalog.mjs';
import { forgetDemand } from '../../api/_demand.mjs';
import { syncCatalogState } from '../../api/_inventory.mjs';
import { methodOf } from '../../api/_payments.mjs';
import { forYou, recordView, similar, together, trending } from '../../api/_recommend.mjs';
import { handleReviews, isReviewRoute, publicName } from '../../api/_reviews.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { handleSeller } from '../../api/_seller.mjs';
import { handleShop } from '../../api/_shop.mjs';
import { handleUpload } from '../../api/seller-upload.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
const rz = { configured: true, refund: async () => {} };
const ADDRESS = { name: 'Asha Rao', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };
const PHOTO = 'https://abc123.public.blob.vercel-storage.com/reviews/1/photo-x1.jpg';
const all = () => listProducts({ limit: 200 });
// Two products from different categories, both well stocked
const pick = () => {
  const list = all().filter((p) => p.stock >= 20);
  const first = list[0];
  return [first, list.find((p) => p.category !== first.category)];
};

async function person(email, role = 'customer') {
  const { body } = await handleAuth(
    { method: 'POST', rest: 'register', body: { name: 'Asha Rao', email, password: 'secret123' }, ip: '1.1.1.1' },
    { store: postgresStore(db), domainError: async () => null },
  );
  if (role !== 'customer') await db('UPDATE users SET role = $1 WHERE id = $2', [role, body.user.id]);
  const authorization = `Bearer ${body.token}`;
  return {
    id: body.user.id,
    authorization,
    shop: (method, path, payload) => handleShop({ method, segments: path.split('/'), body: payload, authorization, ip: '1.1.1.1' }, { db, rz }),
    seller: (method, path, payload, params) => handleSeller({ method, rest: path.split('/'), body: payload, params, authorization }, { db, rz }),
    reviews: (method, path, payload, params) => handleReviews({ method, rest: path.split('/'), body: payload, params, authorization }, { db }),
  };
}

async function buy(shopper, products, qty = 1) {
  const addressId = (await shopper.shop('POST', 'addresses', ADDRESS)).body.id;
  for (const p of products) await shopper.shop('POST', 'cart', { productId: p._id, qty });
  const placed = await shopper.shop('POST', 'orders', { addressId, paymentMethod: 'cod' });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  return placed.body.id;
}

const deliver = (orderId) => db("UPDATE order_items SET fulfilment = 'delivered', fulfilled_at = NOW() WHERE order_id = $1", [orderId]);

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(async () => {
  await pg.exec('TRUNCATE users, auth_rate_limits, seller_products, catalog_overrides, stock_adjustments, product_views RESTART IDENTITY CASCADE');
  setCatalogState({ overrides: new Map(), deltas: new Map(), reviews: new Map() });
  forgetDemand();
});

test('orders take stock, cancelling puts it back, and the catalog shows it at once', async () => {
  const [a] = pick();
  const start = getProduct(a._id).stock;
  const asha = await person('asha@example.com');
  const orderId = await buy(asha, [a], 3);
  assert.equal(getProduct(a._id).stock, start - 3);
  assert.deepEqual(await db('SELECT delta FROM stock_adjustments WHERE product_id = $1', [a._id]), [{ delta: -3 }]);
  await asha.shop('PATCH', `orders/${orderId}/cancel`);
  assert.equal(getProduct(a._id).stock, start);
});

test('a returned item goes back on the shelf once it is picked up', async () => {
  const [a] = pick();
  const start = getProduct(a._id).stock;
  const asha = await person('asha@example.com');
  const admin = await person('owner@example.com', 'admin');
  const orderId = await buy(asha, [a]);
  await deliver(orderId);
  await asha.shop('POST', `orders/${orderId}/return`, { reasonCode: 'damaged', refundTo: 'upi', upi: 'asha@okhdfcbank' });
  await admin.seller('PATCH', `returns/${orderId}`, { action: 'approve' });
  assert.equal(getProduct(a._id).stock, start - 1);
  await admin.seller('PATCH', `returns/${orderId}`, { action: 'receive' });
  assert.equal(getProduct(a._id).stock, start);
});

test('sold out means no more orders', async () => {
  const [a] = pick();
  const admin = await person('owner@example.com', 'admin');
  await admin.seller('PATCH', `catalog/${a._id}`, { stock: 2 });
  const asha = await person('asha@example.com');
  await buy(asha, [a], 2);
  assert.equal(getProduct(a._id).stock, 0);
  const ravi = await person('ravi@example.com');
  assert.equal((await ravi.shop('POST', 'cart', { productId: a._id })).status, 409);
});

test('the admin edits the store catalog; customers and sellers can’t', async () => {
  const [a] = pick();
  const admin = await person('owner@example.com', 'admin');
  const seller = await person('seller@example.com', 'seller');
  assert.equal((await seller.seller('PATCH', `catalog/${a._id}`, { price: 1 })).status, 403);
  assert.equal((await seller.seller('GET', 'catalog')).status, 403);

  assert.match((await admin.seller('PATCH', `catalog/${a._id}`, {})).body.error, /Nothing to change/);
  assert.match((await admin.seller('PATCH', `catalog/${a._id}`, { price: 0 })).body.error, /Price/);
  assert.match((await admin.seller('PATCH', `catalog/${a._id}`, { price: 500, mrp: 400 })).body.error, /MRP/);
  assert.match((await admin.seller('PATCH', `catalog/${a._id}`, { stock: 1.5 })).body.error, /whole number/);
  assert.equal((await admin.seller('PATCH', 'catalog/notaproduct', { price: 10 })).status, 404);

  const edited = await admin.seller('PATCH', `catalog/${a._id}`, { price: 499, mrp: 999, name: 'Renamed product', stock: 40 });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.price, edited.body.mrp, edited.body.name, edited.body.stock, edited.body.discount], [499, 999, 'Renamed product', 40, 50]);
  assert.equal(getProduct(a._id).price, 499); // shoppers see it, and checkout charges it

  await admin.seller('PATCH', `catalog/${a._id}`, { active: false });
  assert.equal(getProduct(a._id), null); // hidden from the store
  assert.equal((await admin.seller('GET', 'catalog', null, { status: 'hidden' })).body.items[0]._id, a._id);

  const undone = await admin.seller('DELETE', `catalog/${a._id}`);
  assert.deepEqual([undone.body.price, undone.body.active, undone.body.edited], [a.price, true, []]);
});

test('edits survive a fresh function instance: they live in the database', async () => {
  const [a] = pick();
  const admin = await person('owner@example.com', 'admin');
  await admin.seller('PATCH', `catalog/${a._id}`, { price: 777 });
  setCatalogState({ overrides: new Map(), deltas: new Map(), reviews: new Map() }); // a cold start
  assert.equal(getProduct(a._id).price, a.price);
  await syncCatalogState(db, Date.now(), true);
  assert.equal(getProduct(a._id).price, 777);
});

test('reviews: verified buyers only, one each, with photos, and the average reaches the catalog', async () => {
  const [a] = pick();
  const asha = await person('asha@example.com');
  const ravi = await person('ravi@example.com');
  const orderId = await buy(asha, [a]);
  assert.equal((await asha.reviews('POST', `${a._id}/reviews`, { rating: 5 })).status, 403); // not delivered yet
  await deliver(orderId);
  assert.equal((await asha.reviews('GET', `${a._id}/reviews`)).body.canReview, true);
  assert.equal((await ravi.reviews('GET', `${a._id}/reviews`)).body.canReview, false);
  assert.equal((await ravi.reviews('POST', `${a._id}/reviews`, { rating: 1 })).status, 403);
  assert.match((await asha.reviews('POST', `${a._id}/reviews`, { rating: 6 })).body.error, /1 to 5/);
  assert.match((await asha.reviews('POST', `${a._id}/reviews`, { rating: 5, photos: ['https://evil.example/x.jpg'] })).body.error, /Add photos/);

  const saved = await asha.reviews('POST', `${a._id}/reviews`, { rating: 4, title: 'Good', body: 'Works well', photos: [PHOTO] });
  assert.equal(saved.status, 201);
  await asha.reviews('POST', `${a._id}/reviews`, { rating: 2, title: 'Changed my mind', body: 'Stopped working', photos: [] }); // replaces
  const list = (await ravi.reviews('GET', `${a._id}/reviews`)).body;
  assert.deepEqual([list.count, list.average, list.histogram[2], list.items[0].author, list.items[0].mine], [1, 2, 1, 'Asha R.', false]);
  assert.equal(getProduct(a._id).reviewRating, 2);

  const anonymous = await handleReviews({ method: 'GET', rest: [a._id, 'reviews'] }, { db });
  assert.deepEqual([anonymous.status, anonymous.body.canReview], [200, false]);
  assert.equal((await asha.reviews('DELETE', `${a._id}/reviews/mine`)).status, 204);
  assert.equal((await ravi.reviews('GET', `${a._id}/reviews`)).body.count, 0);
});

test('review photos: only buyers with a delivered order can upload them', async () => {
  const [a] = pick();
  const asha = await person('asha@example.com');
  const file = { type: 'image/png', size: 100, arrayBuffer: async () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]) };
  const store = async (path) => `https://abc123.public.blob.vercel-storage.com/${path}`;
  assert.equal((await handleUpload({ authorization: asha.authorization, kind: 'review', file }, { db, store })).status, 403);
  await deliver(await buy(asha, [a]));
  const uploaded = await handleUpload({ authorization: asha.authorization, kind: 'review', file }, { db, store });
  assert.equal(uploaded.status, 201);
  assert.match(uploaded.body.url, /\/reviews\/\d+\/photo\.png$/);
  assert.equal((await handleUpload({ authorization: asha.authorization, kind: 'image', file }, { db, store })).status, 403); // still not a seller
});

test('trending follows demand: views and orders move a product up', async () => {
  const before = (await trending(db, { k: 200 })).items.map((p) => p._id);
  const target = getProduct(before.at(-1)); // the least popular product in stock
  const asha = await person('asha@example.com');
  for (let i = 0; i < 12; i += 1) await buy(await person(`buyer${i}@example.com`), [target]);
  await recordView(db, { productId: target._id, userId: asha.id });
  forgetDemand();
  const after = await trending(db, { k: 5 });
  assert.equal(after.strategy, 'trending');
  assert.equal(after.items[0]._id, target._id);
});

test('for you: from the shopper’s own interests, never what they already bought', async () => {
  const [a, b] = pick();
  const fresh = await forYou(db, { visitor: 'visitor-123456' });
  assert.equal(fresh.strategy, 'trending'); // nothing known yet

  const asha = await person('asha@example.com');
  await buy(asha, [a]);
  for (const p of all().filter((p) => p.category === b.category).slice(0, 3)) await recordView(db, { productId: p._id, userId: asha.id });
  const mine = await forYou(db, { userId: asha.id, k: 12 });
  assert.equal(mine.strategy, 'personal');
  assert.ok(!mine.items.some((p) => p._id === a._id));
  const categories = new Set(mine.items.slice(0, 8).map((p) => p.category));
  assert.ok(categories.has(a.category) && categories.has(b.category), [...categories].join());
  assert.ok(mine.items.filter((p) => p.category === b.category).length <= 6); // spread out, not one category
});

test('a visitor’s views follow them when they sign in', async () => {
  const [, b] = pick();
  await recordView(db, { productId: b._id, visitor: 'visitor-abcdef12' });
  const asha = await person('asha@example.com');
  await recordView(db, { productId: b._id, userId: asha.id, visitor: 'visitor-abcdef12' });
  const [row] = await db("SELECT user_id FROM product_views WHERE visitor = 'visitor-abcdef12'");
  assert.equal(row.user_id, asha.id);
  assert.equal(await recordView(db, { productId: 'nope', visitor: 'visitor-abcdef12' }), false);
  assert.equal(await recordView(db, { productId: b._id, visitor: 'bad id!' }), false);
});

test('together: bought in the same orders first, then similar products', async () => {
  const [a, b] = pick();
  const first = await together(db, a._id, 6);
  assert.equal(first.strategy, 'similar');
  assert.ok(first.items.every((p) => p.category === a.category && p._id !== a._id));
  await buy(await person('asha@example.com'), [a, b]);
  const next = await together(db, a._id, 6);
  assert.deepEqual([next.strategy, next.items[0]._id, next.items.length], ['bought_together', b._id, 6]);
  assert.ok((await similar(db, a._id, 4)).every((p) => p.category === a.category));
});

test('card payments are recorded as credit or debit', () => {
  assert.equal(methodOf({ method: 'card', card: { type: 'credit' } }), 'credit_card');
  assert.equal(methodOf({ method: 'card', card: { type: 'debit' } }), 'debit_card');
  assert.equal(methodOf({ method: 'card' }), 'card');
  assert.equal(methodOf({ method: 'cardless_emi' }), 'emi');
  assert.equal(methodOf({ method: 'paylater' }), 'paylater');
  assert.equal(methodOf({ method: 'something_new' }), 'online');
});

test('review helpers and routes', () => {
  assert.equal(publicName('Asha Rao Kumar'), 'Asha K.');
  assert.equal(publicName(''), 'Shopper');
  assert.ok(isReviewRoute('GET', ['abc', 'reviews']));
  assert.ok(isReviewRoute('DELETE', ['abc', 'reviews', 'mine']));
  assert.equal(isReviewRoute('PUT', ['abc', 'reviews']), false);
  assert.equal(isReviewRoute('GET', ['abc', 'other']), false);
});
