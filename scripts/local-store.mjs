// The whole store API on your computer, on an in-memory PostgreSQL (PGlite) filled with demo data, for testing every
// flow without touching the live Neon database. Nothing is saved: restart it for a fresh store.
//
//   npm run local                                   (repository root; serves the API on http://127.0.0.1:5000)
//   cd frontend && VITE_STORE_MODE=store npm run dev (another terminal; open http://localhost:5173)
//
// Demo accounts (password secret123):
//   asha@example.com    customer: delivered orders to review or return, one on its way, a return, a complaint
//   ravi@example.com    customer with a few orders, so "bought together" and trending have data
//   seller@example.com  seller with their own listed product and an order to ship
//   owner@example.com   admin: returns, refunds, complaints and the store catalog in the Seller Hub
// Online payments stay off (no Razorpay keys) and photo uploads need Vercel Blob, so those two answer with their
// usual "not set up yet" messages.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore, useLocalDatabase } from '../api/_auth.mjs';
import { listProducts } from '../api/_catalog.mjs';
import { syncCatalogState } from '../api/_inventory.mjs';
import { recordView } from '../api/_recommend.mjs';
import { handleReviews } from '../api/_reviews.mjs';
import { STORE_SCHEMA } from '../api/_schema.mjs';
import { handleSeller, syncSellerProducts } from '../api/_seller.mjs';
import { handleShop } from '../api/_shop.mjs';
import { handleSupport } from '../api/_support.mjs';
import catalogHandler from '../api/catalog.mjs';

const PORT = Number(process.env.PORT) || 5000;
process.env.JWT_SECRET ||= 'local-store-only-'.padEnd(48, 'x');
process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64url'); // local only: bank refunds can be tried
delete process.env.RAZORPAY_KEY_ID; // never charge anything from a local store
delete process.env.RAZORPAY_KEY_SECRET;

const pg = new PGlite();
await pg.exec(readFileSync(new URL('../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
await pg.exec(STORE_SCHEMA);
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
useLocalDatabase(db);
const rz = { configured: false, refund: async () => {} };

// ---------- Demo data ----------
const store = postgresStore(db);
async function account(name, email, role = 'customer') {
  const { body } = await handleAuth({ method: 'POST', rest: 'register', body: { name, email, password: 'secret123', phone: '9876543210' }, ip: 'local' }, { store, domainError: async () => null });
  if (role !== 'customer') await db('UPDATE users SET role = $1 WHERE id = $2', [role, body.user.id]);
  const authorization = `Bearer ${body.token}`;
  return {
    id: body.user.id,
    shop: (method, path, payload) => handleShop({ method, segments: path.split('/'), body: payload, authorization, ip: `seed-${email}` }, { db, rz }),
    seller: (method, path, payload) => handleSeller({ method, rest: path.split('/'), body: payload, authorization }, { db, rz }),
    support: (method, path, payload) => handleSupport({ method, rest: path.split('/'), body: payload, authorization }, { db }),
    review: (productId, payload) => handleReviews({ method: 'POST', rest: [productId, 'reviews'], body: payload, authorization }, { db }),
  };
}

async function order(who, products, { delivered = false, shipped = false, daysAgo = 2 } = {}) {
  const [address] = await db('SELECT id FROM addresses WHERE user_id = $1', [who.id]);
  for (const p of products) await who.shop('POST', 'cart', { productId: p._id, qty: 1 });
  const placed = await who.shop('POST', 'orders', { addressId: address.id, paymentMethod: 'cod' });
  if (placed.status !== 201) throw new Error(`demo order failed: ${placed.body.error}`);
  const id = placed.body.id;
  await db("UPDATE orders SET created_at = NOW() - make_interval(days => $2) WHERE id = $1", [id, daysAgo]);
  if (shipped || delivered) await db("UPDATE order_items SET fulfilment = 'shipped', courier = 'Delhivery', tracking_number = $2 WHERE order_id = $1", [id, `DL${100000 + id}`]);
  if (delivered) await db("UPDATE order_items SET fulfilment = 'delivered', fulfilled_at = NOW() - interval '1 day' WHERE order_id = $1", [id]);
  return id;
}

const asha = await account('Asha Rao', 'asha@example.com');
const ravi = await account('Ravi Kumar', 'ravi@example.com');
const seller = await account('Meera Textiles', 'seller@example.com', 'seller');
const owner = await account('Store Owner', 'owner@example.com', 'admin');
for (const who of [asha, ravi]) {
  await who.shop('POST', 'addresses', { name: who === asha ? 'Asha Rao' : 'Ravi Kumar', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' });
}
await db("INSERT INTO sellers (user_id, store_name) VALUES ($1, 'Meera Textiles') ON CONFLICT DO NOTHING", [seller.id]);
const listed = await seller.seller('POST', 'products', {
  name: 'Handloom Cotton Kurta (demo)', description: 'A demo seller listing for testing: soft hand-woven cotton.', category: 'fashion', brand: 'Meera',
  price: 1299, mrp: 1599, stock: 25, images: ['/catalog/002cff2c3902d3ea.jpg'], audience: 'men', sizes: ['M', 'L', 'XL'],
});
await syncSellerProducts(db, Date.now() + 60_000);

const pool = listProducts({ limit: 200 }).filter((p) => p.stock >= 20);
const byCategory = (c) => pool.filter((p) => p.category === c);
const [phone, earbuds] = [byCategory('mobiles')[0] || pool[0], byCategory('electronics')[0] || pool[1]];
const [shirt, shoes] = byCategory('fashion').slice(0, 2);
const [cream] = byCategory('beauty');

const reviewable = await order(asha, [phone, earbuds], { delivered: true, daysAgo: 5 });
const returnable = await order(asha, [shirt], { delivered: true, daysAgo: 3 });
await order(asha, [shoes], { shipped: true, daysAgo: 1 });
const returned = await order(asha, [cream], { delivered: true, daysAgo: 4 });
await asha.shop('POST', `orders/${returned}/return`, { reasonCode: 'damaged', details: 'The seal was broken (demo)', refundTo: 'upi', upi: 'asha@okhdfcbank' });
await owner.seller('PATCH', `returns/${returned}`, { action: 'approve' });
await asha.review(phone._id, { rating: 5, title: 'Demo review: great value', body: 'Fast delivery and works well. (Local demo data, not a real customer.)' });
for (const p of [phone, earbuds]) await order(ravi, [p, cream], { delivered: true, daysAgo: 6 });
await ravi.review(earbuds._id, { rating: 3, title: 'Demo review: okay', body: 'Sound is fine, battery could be better. (Local demo data.)' });
if (listed.status === 201) await order(ravi, [listed.body], { daysAgo: 0 });
for (const p of byCategory('fashion').slice(0, 6)) await recordView(db, { productId: p._id, userId: asha.id });
const ticket = await asha.support('POST', 'tickets', { subject: 'Where is my parcel?', message: 'My shoes were shipped yesterday but tracking has not moved (demo).' });
await owner.support('POST', `tickets/${ticket.body.id}/messages`, { message: 'Thanks for waiting, the courier says it arrives tomorrow.' });
await syncCatalogState(db, Date.now(), true);

// ---------- A small stand-in for Vercel's request handling ----------
function vercelRequest(req, url, raw) {
  const params = Object.fromEntries(url.searchParams);
  const path = url.pathname.replace(/^\/api\/?/, '');
  req.query = { ...params, path };
  Object.defineProperty(req, 'body', {
    get() {
      if (!raw) throw new Error('empty body');
      return JSON.parse(raw); // throws on malformed JSON, like Vercel
    },
  });
  return req;
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (!url.pathname.startsWith('/api/')) {
        res.statusCode = 404;
        return res.end();
      }
      if (['/api/uploads', '/api/seller/uploads'].includes(url.pathname)) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Photo uploads need Vercel Blob, so they work on the deployed store only.' }));
      }
      await catalogHandler(vercelRequest(req, url, raw), res);
    } catch (err) {
      console.error(err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'local store error' }));
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Local store API on http://127.0.0.1:${PORT} (in memory: restart for fresh demo data)`);
  console.log('Now run:  cd frontend && VITE_STORE_MODE=store npm run dev   then open http://localhost:5173');
  console.log(`Demo logins (password secret123): asha@example.com, ravi@example.com, seller@example.com, owner@example.com`);
  console.log(`Try: order #${reviewable} (review it), order #${returnable} (return it), the Seller Hub as owner@example.com`);
});
