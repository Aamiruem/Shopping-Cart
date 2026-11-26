// Run with: npm test (from frontend/). The Seller Hub in api/_seller.mjs and the photo upload in api/seller-upload.mjs,
// on PGlite (real PostgreSQL) with the same schema the live database gets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createToken, handleAuth, postgresStore } from '../../api/_auth.mjs';
import { getProduct, listProducts } from '../../api/_catalog.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { decrypt, encrypt, handleSeller, syncSellerProducts, validateProduct } from '../../api/_seller.mjs';
import { handleShop } from '../../api/_shop.mjs';
import { handleUpload } from '../../api/seller-upload.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
const PHOTO = 'https://example.public.blob.vercel-storage.com/products/1/photo.jpg';
const PRODUCT = { name: 'Handloom Cotton Kurta', description: 'Soft cotton, hand woven', category: 'fashion', brand: 'Saanjh', price: 1299, mrp: 1599, stock: 25, images: [PHOTO], audience: 'men', sizes: ['M', 'L', 'M'], tags: ['Ethnic', 'ethnic', 'Cotton'] };
let clock = Date.now();
const sync = () => syncSellerProducts(db, (clock += 60_000)); // always past the 30 s refresh window

async function account(email, password = 'secret123') {
  const { body } = await handleAuth(
    { method: 'POST', rest: 'register', body: { name: email.split('@')[0], email, password }, ip: '1.1.1.1' },
    { store: postgresStore(db), domainError: async () => null },
  );
  // Seller Hub sessions come from the seller portal (/seller/login)
  let authorization = `Bearer ${createToken(body.user, 'seller')}`;
  const seller = (method, path, payload, params) => handleSeller({ method, rest: path.split('/'), body: payload, params, authorization }, { db });
  const shop = (method, path, payload) => handleShop({ method, segments: path.split('/'), body: payload, authorization, ip: '1.1.1.1' }, { db });
  return {
    id: body.user.id,
    seller,
    shop,
    get authorization() {
      return authorization;
    },
    // Applies, then an admin approves (what CRM → Sellers does), so the account can sell
    async becomeSeller(storeName) {
      const result = await seller('POST', 'register', { storeName });
      if (result.status === 201) {
        await db("UPDATE sellers SET status = 'approved' WHERE user_id = $1", [body.user.id]);
        await db("UPDATE users SET role = 'seller' WHERE id = $1 AND role <> 'admin'", [body.user.id]);
      }
      return result;
    },
  };
}

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(async () => {
  await pg.exec('TRUNCATE users, auth_rate_limits, seller_products RESTART IDENTITY CASCADE');
  await sync();
});

test('becoming a seller: an application an admin must approve; store name rules, one store per account', async () => {
  const asha = await account('asha@example.com');
  assert.equal((await asha.seller('POST', 'register', { storeName: 'ab' })).status, 400);
  assert.equal((await asha.seller('POST', 'register', { storeName: 'Asha Crafts', gstin: 'NOTAGSTIN' })).status, 400);
  assert.equal((await asha.seller('POST', 'register', { storeName: 'Asha Crafts', pan: 'BAD' })).status, 400);
  const applied = await asha.seller('POST', 'register', { storeName: 'Asha Crafts', pan: 'ABCDE1234F' });
  assert.equal(applied.status, 201);
  assert.equal(applied.body.status, 'pending');
  assert.match(applied.body.seller_code, /^ARV-SEL-\d{4}-\d{6}$/);
  // Nothing to sell with until it is approved
  assert.match((await asha.seller('POST', 'products', PRODUCT)).body.error, /being reviewed/);
  assert.equal((await db("SELECT role FROM users WHERE email = 'asha@example.com'"))[0].role, 'customer');
  assert.equal((await asha.seller('POST', 'register', { storeName: 'Another Store' })).status, 409);
  await db("UPDATE sellers SET status = 'approved' WHERE user_id = $1", [asha.id]);
  await db("UPDATE users SET role = 'seller' WHERE id = $1", [asha.id]);
  assert.equal((await asha.seller('POST', 'products', PRODUCT)).status, 201);
  // A customer-portal session can't use the hub at all
  assert.equal((await handleSeller({ method: 'GET', rest: ['products'], authorization: `Bearer ${createToken({ id: asha.id, email: 'asha@example.com', role: 'seller' })}` }, { db })).status, 401);
  const ravi = await account('ravi@example.com');
  assert.match((await ravi.seller('POST', 'register', { storeName: 'asha crafts' })).body.error, /taken/);
});

test('customers can’t use the hub', async () => {
  const shopper = await account('shopper@example.com');
  for (const [method, path] of [['GET', 'products'], ['POST', 'products'], ['GET', 'orders'], ['GET', 'earnings'], ['GET', 'profile']]) {
    assert.equal((await shopper.seller(method, path, PRODUCT)).status, 403, path);
  }
});

test('product rules match the backend', () => {
  const ok = validateProduct(PRODUCT);
  assert.deepEqual([ok.image, ok.sizes, ok.tags, ok.featured], [PHOTO, ['M', 'L'], ['ethnic', 'cotton'], false]);
  const bad = [
    { name: 'x' }, { category: 'cars' }, { price: 0 }, { price: 'abc' }, { mrp: 999 }, { stock: 1.5 }, { stock: -1 },
    { images: ['javascript:alert(1)'] }, { images: ['http://insecure.example/a.jpg'] }, { images360: [PHOTO, PHOTO] }, { audience: 'kids' },
    { images: Array(9).fill(PHOTO) }, { description: 'x'.repeat(5001) }, { ageGroups: ['10-12'] },
  ];
  for (const change of bad) assert.throws(() => validateProduct({ ...PRODUCT, ...change }), /./, JSON.stringify(change).slice(0, 60));
  assert.equal(validateProduct({ ...PRODUCT, featured: true }).featured, false); // sellers can't feature themselves
  assert.equal(validateProduct({ ...PRODUCT, featured: true }, { admin: true }).featured, true);
});

test('a listed product joins the store; unlisting or deleting takes it out', async () => {
  const asha = await account('asha@example.com');
  await asha.becomeSeller('Asha Crafts');
  const created = await asha.seller('POST', 'products', PRODUCT);
  assert.equal(created.status, 201);
  assert.match(created.body._id, /^[0-9a-f]{24}$/);
  await sync();
  const live = getProduct(created.body._id);
  assert.deepEqual([live.name, live.seller, live.sellerId, live.discount], ['Handloom Cotton Kurta', 'Asha Crafts', asha.id, 19]);
  assert.ok(listProducts({ q: 'handloom' }).some((p) => p._id === created.body._id));

  await asha.seller('PATCH', `products/${created.body._id}`, { active: false });
  await sync();
  assert.equal(getProduct(created.body._id), null);
  assert.equal((await asha.seller('GET', 'products', null, { status: 'inactive' })).body.length, 1);

  await asha.seller('POST', 'products/bulk', { ids: [created.body._id], action: 'list' });
  await sync();
  assert.ok(getProduct(created.body._id));
  assert.equal((await asha.seller('DELETE', `products/${created.body._id}`)).status, 204);
  await sync();
  assert.equal(getProduct(created.body._id), null);
});

test('sellers manage only their own products; admins manage all', async () => {
  const asha = await account('asha@example.com');
  await asha.becomeSeller('Asha Crafts');
  const ravi = await account('ravi@example.com');
  await ravi.becomeSeller('Ravi Electronics');
  const { body: kurta } = await asha.seller('POST', 'products', PRODUCT);
  assert.equal((await ravi.seller('PUT', `products/${kurta._id}`, { ...PRODUCT, price: 1 })).status, 403);
  assert.equal((await ravi.seller('DELETE', `products/${kurta._id}`)).status, 403);
  assert.equal((await ravi.seller('GET', 'products')).body.length, 0);
  assert.equal((await ravi.seller('GET', 'products/nothex')).status, 404);

  const owner = await account('owner@example.com');
  await db("UPDATE users SET role = 'admin' WHERE email = 'owner@example.com'");
  assert.equal((await owner.seller('GET', 'products')).body.length, 1);
  const edited = await owner.seller('PATCH', `products/${kurta._id}`, { price: 1199 });
  assert.equal(edited.body.price, 1199);
  assert.equal(edited.body.sellerId, asha.id); // still Asha's product
});

test('quick edits, bulk stock and duplicates', async () => {
  const asha = await account('asha@example.com');
  await asha.becomeSeller('Asha Crafts');
  const { body: kurta } = await asha.seller('POST', 'products', PRODUCT);
  assert.equal((await asha.seller('PATCH', `products/${kurta._id}`, { mrp: 100 })).status, 400); // below price
  assert.equal((await asha.seller('POST', 'products/bulk', { ids: [kurta._id], action: 'stock' })).status, 400);
  await asha.seller('POST', 'products/bulk', { ids: [kurta._id], action: 'stock', stock: 3 });
  assert.equal((await asha.seller('GET', 'products', null, { status: 'low_stock' })).body[0].stock, 3);
  const copy = (await asha.seller('POST', `products/${kurta._id}/duplicate`)).body;
  assert.deepEqual([copy.name, copy.active, copy.price], ['Handloom Cotton Kurta (copy)', false, 1299]);
  assert.equal((await asha.seller('GET', 'products', null, { q: 'copy' })).body.length, 1);
});

test('an order for a seller’s product reaches that seller, who ships it; the shopper sees the timeline', async () => {
  const asha = await account('asha@example.com');
  await asha.becomeSeller('Asha Crafts');
  const ravi = await account('ravi@example.com');
  await ravi.becomeSeller('Ravi Electronics');
  const { body: kurta } = await asha.seller('POST', 'products', PRODUCT);
  await sync();

  const buyer = await account('buyer@example.com');
  const address = (await buyer.shop('POST', 'addresses', { name: 'Buyer', phone: '9876543210', line1: '1 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' })).body.id;
  await buyer.shop('POST', 'cart', { productId: kurta._id, qty: 2, size: 'M' });
  const order = (await buyer.shop('POST', 'orders', { addressId: address, paymentMethod: 'cod' })).body;

  const mine = (await asha.seller('GET', 'orders')).body;
  assert.deepEqual(mine.map((o) => [o.id, o.amount, o.fulfilment, o.customer]), [[order.id, 2598, 'pending', 'Buyer']]);
  assert.equal((await ravi.seller('GET', 'orders')).body.length, 0);
  assert.equal((await ravi.seller('PATCH', `orders/${order.id}`, { fulfilment: 'packed' })).status, 404);

  await asha.seller('PATCH', `orders/${order.id}`, { fulfilment: 'packed' });
  await asha.seller('PATCH', `orders/${order.id}`, { fulfilment: 'shipped', courier: 'Delhivery', trackingNumber: 'DL123' });
  const seen = (await buyer.shop('GET', `orders/${order.id}`)).body;
  assert.deepEqual(seen.events.map((e) => e.note), ['Order placed', 'Packed', 'Shipped by Delhivery, tracking number DL123']);
  assert.deepEqual([seen.items[0].fulfilment, seen.items[0].tracking_number], ['shipped', 'DL123']);
  assert.equal((await buyer.shop('PATCH', `orders/${order.id}/cancel`)).status, 400); // shipped: too late to cancel

  const money = (await asha.seller('GET', 'earnings')).body;
  assert.deepEqual([money.totals.gross, money.totals.orders, money.byMethod[0].method], [2598, 1, 'cod']);
});

test('a cancelled order can’t be moved forward', async () => {
  const asha = await account('asha@example.com');
  await asha.becomeSeller('Asha Crafts');
  const { body: kurta } = await asha.seller('POST', 'products', PRODUCT);
  await sync();
  const buyer = await account('buyer@example.com');
  const address = (await buyer.shop('POST', 'addresses', { name: 'Buyer', phone: '9876543210', line1: '1 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' })).body.id;
  await buyer.shop('POST', 'cart', { productId: kurta._id, size: 'M' });
  const order = (await buyer.shop('POST', 'orders', { addressId: address, paymentMethod: 'cod' })).body;
  await buyer.shop('PATCH', `orders/${order.id}/cancel`);
  assert.match((await asha.seller('PATCH', `orders/${order.id}`, { fulfilment: 'packed' })).body.error, /cancelled/);
});

test('store settings: payout changes need the password, and bank numbers are stored encrypted', async () => {
  const asha = await account('asha@example.com');
  await asha.becomeSeller('Asha Crafts');
  const base = { storeName: 'Asha Crafts', description: 'Hand-made in Jaipur', logo: PHOTO };
  assert.equal((await asha.seller('PUT', 'profile', base)).status, 200);
  assert.equal((await asha.seller('PUT', 'profile', { ...base, logo: 'javascript:x' })).status, 400);
  const bank = { ...base, bankAccountName: 'Asha Rao', bankAccountNumber: '123456789012', bankIfsc: 'HDFC0001234', payoutUpi: 'asha@okhdfcbank' };
  assert.equal((await asha.seller('PUT', 'profile', bank)).status, 403);
  assert.equal((await asha.seller('PUT', 'profile', { ...bank, currentPassword: 'wrong' })).status, 403);
  const saved = await asha.seller('PUT', 'profile', { ...bank, currentPassword: 'secret123' });
  assert.equal(saved.body.bank_account_number, '••••9012');
  const [row] = await db('SELECT bank_account_number FROM sellers');
  assert.ok(!row.bank_account_number.includes('123456789012'));
  assert.equal(decrypt(row.bank_account_number), '123456789012');
  // Sending the masked number back keeps the saved one, without asking for the password again
  assert.equal((await asha.seller('PUT', 'profile', { ...bank, bankAccountNumber: '••••9012', description: 'New text' })).status, 200);
  assert.equal((await asha.seller('GET', 'earnings')).body.payout.bank, '••••9012 · HDFC0001234');
});

test('encryption is tamper-evident and round-trips', () => {
  const token = encrypt('987654321');
  assert.equal(decrypt(token), '987654321');
  const tampered = Buffer.from(token, 'base64url');
  tampered[30] ^= 1;
  assert.equal(decrypt(tampered.toString('base64url')), null);
});

test('photo uploads: sellers only, real images only, up to 4 MB', async () => {
  const shopper = await account('shopper@example.com');
  const asha = await account('asha@example.com');
  await asha.becomeSeller('Asha Crafts');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
  const file = (bytes, type) => new File([bytes], 'photo', { type });
  const stored = [];
  const store = async (path, bytes, type) => {
    stored.push([path, bytes.length, type]);
    return `https://example.public.blob.vercel-storage.com/${path}`;
  };
  const upload = (who, kind, f) => handleUpload({ authorization: who.authorization, kind, file: f }, { db, store });

  assert.equal((await upload(shopper, 'image', file(jpeg, 'image/jpeg'))).status, 403);
  assert.equal((await upload(asha, 'video', file(jpeg, 'video/mp4'))).status, 400);
  assert.equal((await upload(asha, 'image', file(Buffer.from('<script>'), 'image/jpeg'))).status, 400); // not really a JPEG
  assert.equal((await upload(asha, 'image', file(Buffer.alloc(4 * 1024 * 1024 + 1), 'image/png'))).status, 413);
  const ok = await upload(asha, 'image', file(jpeg, 'image/jpeg'));
  assert.equal(ok.status, 201);
  assert.match(ok.body.url, /products\/\d+\/photo\.jpg$/);
  assert.deepEqual(stored.map((s) => s[2]), ['image/jpeg']);
});

test('dashboard overview: each seller sees only their own sales and stock; the admin sees the store and its leads', async () => {
  const asha = await account('asha@example.com');
  await asha.becomeSeller('Asha Crafts');
  const ravi = await account('ravi@example.com');
  await ravi.becomeSeller('Ravi Electronics');
  const { body: kurta } = await asha.seller('POST', 'products', PRODUCT);
  await asha.seller('POST', 'products', { ...PRODUCT, name: 'Handloom Silk Kurta', stock: 4 });
  await asha.seller('POST', 'products', { ...PRODUCT, name: 'Handloom Linen Kurta', stock: 0 });
  await ravi.seller('POST', 'products', { ...PRODUCT, name: 'Ravi Kurta', stock: 50 });
  await sync();

  const empty = (await asha.seller('GET', 'overview')).body;
  assert.deepEqual([empty.kpis.revenue, empty.kpis.orders, empty.daily.length], [0, 0, 30]); // zeros, not made-up numbers

  const buyer = await account('buyer@example.com');
  const address = (await buyer.shop('POST', 'addresses', { name: 'Buyer', phone: '9876543210', line1: '1 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' })).body.id;
  await buyer.shop('POST', 'cart', { productId: kurta._id, qty: 2, size: 'M' });
  const order = (await buyer.shop('POST', 'orders', { addressId: address, paymentMethod: 'cod' })).body;
  await asha.seller('PATCH', `orders/${order.id}`, { fulfilment: 'packed' });

  const mine = (await asha.seller('GET', 'overview')).body;
  assert.equal(mine.scope, 'seller');
  assert.deepEqual([mine.kpis.revenue, mine.kpis.orders, mine.kpis.ordersToday, mine.kpis.customers, mine.kpis.averageOrder], [2598, 1, 1, 1, 2598]);
  assert.equal(mine.daily.at(-1).revenue, 2598);
  assert.deepEqual(mine.fulfilment.map((f) => f.orders), [0, 1, 0, 0]);
  assert.deepEqual([mine.stock.total, mine.stock.inStock, mine.stock.low, mine.stock.out], [3, 1, 1, 1]);
  assert.deepEqual(mine.stock.alerts.map((a) => a.stock), [0, 4]);
  assert.deepEqual([mine.recent[0].id, mine.recent[0].amount, mine.top[0].units], [order.id, 2598, 2]);
  assert.ok(mine.activity.some((e) => e.note === 'Packed'));
  assert.equal(mine.leads, null, 'leads are for the admin');

  const theirs = (await ravi.seller('GET', 'overview')).body;
  assert.deepEqual([theirs.kpis.revenue, theirs.recent.length, theirs.activity.length, theirs.stock.total], [0, 0, 0, 1]);

  const owner = await account('owner@example.com');
  await db("UPDATE users SET role = 'admin' WHERE email = 'owner@example.com'");
  await db("INSERT INTO leads (source, kind, email, intent, consent_at, status) VALUES ('quote', 'quote', 'a@b.co', 'high', NOW(), 'new'), ('contact', 'product_enquiry', 'c@d.co', 'low', NOW(), 'won')");
  const store = (await owner.seller('GET', 'overview')).body;
  assert.equal(store.scope, 'store');
  assert.equal(store.kpis.revenue, 2598);
  assert.ok(store.stock.total > 700, 'the whole catalog');
  assert.deepEqual(store.leads.stages.map((s) => s.count), [1, 0, 0, 0, 0, 1, 0]);
  assert.equal(store.leads.stages[0].hot, 1);

  assert.equal((await buyer.seller('GET', 'overview')).status, 403);
});

test('sizes and colours: one cart line per size and colour, recorded on the order; stock is shared', async () => {
  // Running the schema again is harmless, and the cart key covers size and colour
  await pg.exec(STORE_SCHEMA);
  const [{ cols }] = await db(`SELECT array_length(conkey, 1) AS cols FROM pg_constraint WHERE conrelid = 'cart_items'::regclass AND contype = 'p'`);
  assert.equal(cols, 4);

  const asha = await account('asha@example.com');
  await asha.becomeSeller('Asha Crafts');
  const NAVY = 'https://example.public.blob.vercel-storage.com/products/1/navy.jpg';
  const bad = await asha.seller('POST', 'products', { ...PRODUCT, colors: ['Navy'], colorImages: { Navy: 'https://elsewhere.example/x.jpg' } });
  assert.match(bad.body.error, /one of this product’s photos/);
  assert.match((await asha.seller('POST', 'products', { ...PRODUCT, colors: ['Navy'], colorHex: { Navy: 'blue' } })).body.error, /colour code/);
  const { body: kurta } = await asha.seller('POST', 'products', {
    ...PRODUCT, stock: 3, images: [PHOTO, NAVY], sizes: ['S', 'M', 'L', 'm'], colors: ['Maroon', 'Navy'],
    colorHex: { Navy: '#1F2A44', Maroon: '#7a1f2b', Teal: '#008080' }, colorImages: { Navy: NAVY },
  });
  assert.deepEqual([kurta.sizes, kurta.colors, kurta.colorHex, kurta.colorImages], [['S', 'M', 'L'], ['Maroon', 'Navy'], { Navy: '#1f2a44', Maroon: '#7a1f2b' }, { Navy: NAVY }]);
  await sync();

  const buyer = await account('buyer@example.com');
  assert.match((await buyer.shop('POST', 'cart', { productId: kurta._id })).body.error, /select a size/);
  assert.match((await buyer.shop('POST', 'cart', { productId: kurta._id, size: 'XXL' })).body.error, /XXL is not available/);
  assert.match((await buyer.shop('POST', 'cart', { productId: kurta._id, size: 'M', color: 'Pink' })).body.error, /Pink is not available/);
  await buyer.shop('POST', 'cart', { productId: kurta._id, size: 'm', color: 'navy' }); // case doesn't matter
  await buyer.shop('POST', 'cart', { productId: kurta._id, size: 'M', color: 'Navy' });
  let cart = (await buyer.shop('POST', 'cart', { productId: kurta._id, size: 'L' })).body; // first colour by default
  assert.deepEqual(cart.items.map((i) => [i.lineId, i.size, i.color, i.qty, i.image]), [
    [`${kurta._id}~M~Navy`, 'M', 'Navy', 2, NAVY],
    [`${kurta._id}~L~Maroon`, 'L', 'Maroon', 1, PHOTO],
  ]);

  cart = (await buyer.shop('PUT', `cart/${kurta._id}~L~Maroon`, { qty: 2 })).body;
  assert.deepEqual(cart.items.map((i) => i.qty), [2, 2]);
  const address = (await buyer.shop('POST', 'addresses', { name: 'Buyer', phone: '9876543210', line1: '1 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' })).body.id;
  // 4 wanted across two sizes, 3 in stock: the check adds the sizes up
  assert.match((await buyer.shop('POST', 'orders', { addressId: address, paymentMethod: 'cod' })).body.error, /Only 3 left/);
  await buyer.shop('DELETE', `cart/${kurta._id}~L~Maroon`);
  await buyer.shop('POST', 'cart', { productId: kurta._id, size: 'S', color: 'Maroon' });
  const order = (await buyer.shop('POST', 'orders', { addressId: address, paymentMethod: 'cod' })).body;
  assert.equal(order.total, 3 * PRODUCT.price);

  const seen = (await buyer.shop('GET', `orders/${order.id}`)).body;
  assert.deepEqual(seen.items.map((i) => [i.qty, i.options]), [[2, { size: 'M', color: 'Navy' }], [1, { size: 'S', color: 'Maroon' }]]);
  assert.deepEqual((await asha.seller('GET', 'orders')).body[0].items.map((i) => i.options), [{ size: 'M', color: 'Navy' }, { size: 'S', color: 'Maroon' }]);
  assert.equal((await asha.seller('GET', `products/${kurta._id}`)).body.stock, 0, 'both sizes came off the one stock count');

  // A product without options still works by its plain id
  const { body: plain } = await asha.seller('POST', 'products', { ...PRODUCT, name: 'Cotton Tote Bag', sizes: [], colors: [] });
  await sync();
  cart = (await buyer.shop('POST', 'cart', { productId: plain._id, size: 'M' })).body;
  assert.deepEqual(cart.items.map((i) => [i.lineId, i.size, i.color]), [[plain._id, null, null]]);
  assert.equal((await buyer.shop('DELETE', `cart/${plain._id}`)).body.items.length, 0);
});
