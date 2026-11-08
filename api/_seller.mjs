// The Seller Hub on the Vercel store: becoming a seller, store settings and payouts, product listings, order fulfilment
// and earnings. Port of backend/app/routers/seller.py on PostgreSQL; the backend keeps products in MongoDB, here they
// live in `seller_products` (one JSON document per product, in the catalog's shape) and join the catalog within 30 s.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ApiError, currentUserId, postgresStore, query, safely, session } from './_auth.mjs';
import { setSellerProducts } from './_catalog.mjs';

const CATEGORIES = ['mobiles', 'electronics', 'fashion', 'accessories', 'beauty', 'home', 'kitchen', 'sports', 'grocery'];
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const UPI_RE = /^[\w.-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;
const PHONE_RE = /^[6-9]\d{9}$/;
const MEDIA_URL = /^(https:\/\/\S+|\/catalog\/[\w.-]+)$/; // uploaded photos are https links to the Blob store
const PRODUCT_ID = /^[0-9a-f]{24}$/;
const FULFILMENT = ['pending', 'packed', 'shipped', 'delivered'];
const AGE_GROUPS = ['18-25', '26-35', '36-50', '50+'];
const SYNC_MS = 30_000;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const fail = (message, status = 400) => {
  throw new ApiError(status, message);
};

// ---------- Bank details: Fernet, the same encryption as the Python backend (services/crypto.py) ----------
function fernetKeys() {
  const raw = Buffer.from(process.env.DATA_ENCRYPTION_KEY || '', 'base64url');
  return raw.length === 32 ? { sign: raw.subarray(0, 16), enc: raw.subarray(16) } : null;
}

export function encrypt(plain) {
  const keys = fernetKeys();
  if (!keys) fail('Bank payouts can’t be saved yet: the store’s encryption key isn’t set. Use a UPI ID for now.', 503);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', keys.enc, iv);
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const body = Buffer.concat([Buffer.from([0x80]), time, iv, cipher.update(plain, 'utf8'), cipher.final()]);
  const token = Buffer.concat([body, createHmac('sha256', keys.sign).update(body).digest()]);
  return token.toString('base64').replace(/\+/g, '-').replace(/\//g, '_'); // url-safe with padding, like Python
}

export function decrypt(token) {
  const keys = fernetKeys();
  if (!token || !keys) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < 57 || raw[0] !== 0x80) return null;
  const body = raw.subarray(0, -32);
  const expected = createHmac('sha256', keys.sign).update(body).digest();
  if (!timingSafeEqual(expected, raw.subarray(-32))) return null;
  const decipher = createDecipheriv('aes-128-cbc', keys.enc, body.subarray(9, 25));
  return Buffer.concat([decipher.update(body.subarray(25)), decipher.final()]).toString('utf8');
}

// ---------- Who may use the hub ----------
async function sellerRole(db, userId) {
  const [row] = await db('SELECT role FROM users WHERE id = $1', [userId]);
  if (!row) fail('Account not found', 401);
  if (!['seller', 'admin'].includes(row.role)) fail('Seller account required', 403);
  return row.role;
}

// ---------- Becoming a seller, profile and payouts ----------
async function register({ db, userId, body }) {
  const store = text(body.storeName);
  const gstin = text(body.gstin).toUpperCase() || null;
  const phone = text(body.phone) || null;
  if (store.length < 3 || store.length > 120) fail('Store name must be 3–120 characters');
  if (gstin && !GSTIN_RE.test(gstin)) fail('Please enter a valid 15-character GSTIN, e.g. 29ABCDE1234F1Z5');
  if (phone && !PHONE_RE.test(phone)) fail('Please enter a valid 10-digit mobile number starting with 6, 7, 8 or 9');
  if ((await db('SELECT 1 FROM sellers WHERE user_id = $1', [userId])).length) fail('You are already registered as a seller', 409);
  if ((await db('SELECT 1 FROM sellers WHERE lower(store_name) = lower($1)', [store])).length) fail('That store name is taken. Please choose another.', 409);
  const [user] = await db(
    `WITH store AS (INSERT INTO sellers (user_id, store_name, gstin, phone) VALUES ($1, $2, $3, $4) RETURNING user_id)
     UPDATE users SET role = CASE WHEN role = 'admin' THEN role ELSE 'seller' END WHERE id = (SELECT user_id FROM store) RETURNING *`,
    [userId, store, gstin, phone],
  );
  // A new token: the role is inside it
  return { body: await session(user, postgresStore(db)) };
}

const mask = (last4) => (last4 ? `••••${last4}` : null);
function publicProfile(row) {
  const { bank_account_number: number, bank_account_last4: last4, ...rest } = row;
  return { ...rest, bank_account_number: mask(last4 || (decrypt(number) || '').slice(-4) || null) };
}

async function getProfile({ db, userId }) {
  const [row] = await db('SELECT * FROM sellers WHERE user_id = $1', [userId]);
  return { body: row ? publicProfile(row) : { user_id: userId, store_name: 'Arvixa (admin)', gstin: null } };
}

async function updateProfile({ db, userId, body }) {
  const [current] = await db('SELECT * FROM sellers WHERE user_id = $1', [userId]);
  if (!current) fail('Create your store first', 404);
  const store = text(body.storeName);
  const description = text(body.description);
  const logo = text(body.logo);
  const gstin = text(body.gstin).toUpperCase() || null;
  const phone = text(body.phone) || null;
  const upi = text(body.payoutUpi) || null;
  const ifsc = text(body.bankIfsc).toUpperCase() || null;
  const accountName = text(body.bankAccountName) || null;
  const saved = decrypt(current.bank_account_number);
  let number = text(body.bankAccountNumber).replace(/\s/g, '');
  number = !number || number.includes('•') ? saved : number;

  if (store.length < 3 || store.length > 120) fail('Store name must be 3–120 characters');
  if (description.length > 1000) fail('Description is too long');
  if (logo && (!MEDIA_URL.test(logo) || logo.length > 1000)) fail('Logo must be an uploaded image or an https link');
  if (gstin && !GSTIN_RE.test(gstin)) fail('Please enter a valid 15-character GSTIN, e.g. 29ABCDE1234F1Z5');
  if (phone && !PHONE_RE.test(phone)) fail('Please enter a valid 10-digit mobile number starting with 6, 7, 8 or 9');
  if (upi && !UPI_RE.test(upi)) fail('Please enter a valid UPI ID, e.g. yourstore@okhdfcbank');
  if (number && !ACCOUNT_RE.test(number)) fail('Bank account number must be 9 to 18 digits');
  if (ifsc && !IFSC_RE.test(ifsc)) fail('Please enter a valid 11-character IFSC code, e.g. HDFC0001234');
  if (number && !ifsc) fail('Add the IFSC code of your bank branch');
  if (accountName && accountName.length > 120) fail('Account holder name is too long');

  // Where money goes is sensitive: changing it needs the account password
  const payoutChanged = upi !== current.payout_upi || accountName !== current.bank_account_name || (number || null) !== (saved || null) || ifsc !== current.bank_ifsc;
  if (payoutChanged) {
    const [account] = await db('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!account?.password_hash || !(await bcrypt.compare(text(body.currentPassword), account.password_hash))) {
      fail('Enter your account password to change payout details', 403);
    }
  }
  if (store.toLowerCase() !== current.store_name.toLowerCase()
    && (await db('SELECT 1 FROM sellers WHERE lower(store_name) = lower($1) AND user_id <> $2', [store, userId])).length) {
    fail('That store name is taken. Please choose another.', 409);
  }
  const encrypted = number && number !== saved ? encrypt(number) : current.bank_account_number;
  const [row] = await db(
    `UPDATE sellers SET store_name = $2, description = $3, logo = $4, gstin = $5, phone = $6, payout_upi = $7,
            bank_account_name = $8, bank_account_number = $9, bank_ifsc = $10, bank_account_last4 = $11, updated_at = NOW()
      WHERE user_id = $1 RETURNING *`,
    [userId, store, description || null, logo || null, gstin, phone, upi, accountName, number ? encrypted : null, ifsc, number ? number.slice(-4) : null],
  );
  return { body: publicProfile(row) };
}

// ---------- Products ----------
const list = (value, max, clean = (v) => v) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('Lists must be arrays');
  if (value.length > max) fail(`At most ${max} items allowed`);
  return value.map((v) => clean(text(v))).filter(Boolean);
};
const unique = (values) => [...new Set(values)];
const number = (value, label, { min = 0, max = 10_000_000, integer = false, optional = false } = {}) => {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) fail(`${label} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max.toLocaleString('en-IN')}`);
  return n;
};
const mediaList = (value, max, label) => {
  const urls = list(value, max);
  if (urls.some((u) => !MEDIA_URL.test(u) || u.length > 1000)) fail(`${label} must be uploaded photos or https links`);
  return urls;
};

/** A product from the seller's form, checked like backend/app/schemas/product.py. */
export function validateProduct(body, { admin = false, featured = false } = {}) {
  const name = text(body.name);
  if (name.length < 2 || name.length > 200) fail('Name must be 2–200 characters');
  const description = text(body.description);
  if (description.length > 5000) fail('Description is too long (5,000 characters at most)');
  if (!CATEGORIES.includes(body.category)) fail(`Category must be one of: ${CATEGORIES.join(', ')}`);
  const price = number(body.price, 'Price', { min: 1 });
  const mrp = number(body.mrp, 'MRP', { min: 1, optional: true });
  if (mrp !== null && mrp < price) fail('MRP cannot be lower than the selling price');
  const stock = number(body.stock ?? 0, 'Stock', { max: 1_000_000, integer: true });
  const images = mediaList(body.images, 8, 'Photos');
  const image = text(body.image) || images[0] || '';
  if (image && !MEDIA_URL.test(image)) fail('The main photo must be an uploaded photo or an https link');
  const images360 = mediaList(body.images360, 72, '360° frames');
  if (images360.length > 0 && images360.length < 4) fail('A 360° view needs at least 4 frames');
  if (!['', 'women', 'men', 'unisex'].includes(body.audience ?? '')) fail('Audience must be women, men or unisex');
  const ageGroups = list(body.ageGroups, 4);
  if (ageGroups.some((a) => !AGE_GROUPS.includes(a))) fail('Unknown age group');
  const short = (value, max, label) => {
    const v = text(value);
    if (v.length > max) fail(`${label} is too long`);
    return v;
  };
  return {
    name,
    description,
    category: body.category,
    subCategory: short(body.subCategory, 60, 'Sub-category'),
    brand: short(body.brand, 80, 'Brand'),
    tags: unique(list(body.tags, 20, (t) => t.toLowerCase())).slice(0, 20),
    price,
    mrp,
    stock,
    image,
    images: images.length ? images : image ? [image] : [],
    images360,
    audience: body.audience ?? '',
    videos: mediaList(body.videos, 4, 'Videos'),
    audio: text(body.audio) && MEDIA_URL.test(text(body.audio)) ? text(body.audio) : '',
    unit: short(body.unit, 40, 'Pack size'),
    sizes: unique(list(body.sizes, 20, (s) => s.slice(0, 20))),
    colors: unique(list(body.colors, 20, (s) => s.slice(0, 20))),
    ageGroups,
    material: short(body.material, 80, 'Material'),
    fit: short(body.fit, 40, 'Fit'),
    active: body.active !== false,
    featured: admin ? Boolean(body.featured) : featured, // only admins choose featured
  };
}

const productJson = (row) => ({ ...row.data, _id: row.id, id: row.id, sellerId: row.seller_id, seller: row.store_name ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });

async function ownedProduct(db, id, userId, role) {
  if (!PRODUCT_ID.test(String(id))) fail('Product not found', 404);
  const [row] = await db('SELECT p.*, s.store_name FROM seller_products p LEFT JOIN sellers s ON s.user_id = p.seller_id WHERE p.id = $1', [id]);
  if (!row) fail('Product not found', 404);
  if (role !== 'admin' && row.seller_id !== userId) fail('You can only manage your own products', 403);
  return row;
}

async function saveProduct(db, id, sellerId, data) {
  const [row] = await db(
    `INSERT INTO seller_products (id, seller_id, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING *, (SELECT store_name FROM sellers WHERE user_id = $2) AS store_name`,
    [id, sellerId, JSON.stringify(data)],
  );
  lastSync = 0; // this instance shows the change at once; others within 30 s
  return productJson(row);
}

async function myProducts({ db, userId, role, params }) {
  const where = role === 'admin' ? ['TRUE'] : ['p.seller_id = $1'];
  const args = role === 'admin' ? [] : [userId];
  const q = text(params.q);
  if (q) {
    args.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(p.data->>'name' ILIKE $${args.length} OR p.data->>'brand' ILIKE $${args.length} OR p.data->>'category' ILIKE $${args.length})`);
  }
  if (params.status === 'active') where.push("(p.data->>'active')::boolean IS NOT FALSE");
  if (params.status === 'inactive') where.push("(p.data->>'active')::boolean IS FALSE");
  if (params.status === 'low_stock') where.push("(p.data->>'stock')::int < 10");
  const rows = await db(
    `SELECT p.*, s.store_name FROM seller_products p LEFT JOIN sellers s ON s.user_id = p.seller_id
      WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC, p.id DESC LIMIT 500`,
    args,
  );
  return { body: rows.map(productJson) };
}

async function createProduct({ db, userId, role, body }) {
  const data = { ...validateProduct(body, { admin: role === 'admin' }), rating: 0, ratingCount: 0 };
  return { status: 201, body: await saveProduct(db, randomBytes(12).toString('hex'), userId, data) };
}

async function updateProduct({ db, userId, role, id, body }) {
  const row = await ownedProduct(db, id, userId, role);
  const data = { ...row.data, ...validateProduct(body, { admin: role === 'admin', featured: Boolean(row.data.featured) }) };
  return { body: await saveProduct(db, row.id, row.seller_id, data) };
}

function quickChanges(row, body) {
  const changes = {};
  if (body.price !== undefined && body.price !== null) changes.price = number(body.price, 'Price', { min: 1 });
  if (body.mrp !== undefined && body.mrp !== null) changes.mrp = number(body.mrp, 'MRP', { min: 1 });
  if (body.stock !== undefined && body.stock !== null) changes.stock = number(body.stock, 'Stock', { max: 1_000_000, integer: true });
  if (typeof body.active === 'boolean') changes.active = body.active;
  const price = changes.price ?? row.data.price;
  const mrp = changes.mrp ?? row.data.mrp;
  if (mrp !== null && mrp !== undefined && mrp < price) fail('MRP cannot be lower than the selling price');
  return changes;
}

async function patchProduct({ db, userId, role, id, body }) {
  const row = await ownedProduct(db, id, userId, role);
  return { body: await saveProduct(db, row.id, row.seller_id, { ...row.data, ...quickChanges(row, body) }) };
}

async function removeProduct(db, row) {
  // Gone from carts and wishlists too, so shoppers don't see a dead item
  await db(
    `WITH gone AS (DELETE FROM seller_products WHERE id = $1 RETURNING id),
          carts AS (DELETE FROM cart_items WHERE product_id = $1),
          wishes AS (DELETE FROM wishlist_items WHERE product_id = $1)
     SELECT count(*) FROM gone`,
    [row.id],
  );
  lastSync = 0;
}

async function deleteProduct({ db, userId, role, id }) {
  await removeProduct(db, await ownedProduct(db, id, userId, role));
  return { status: 204, body: null };
}

async function bulkProducts({ db, userId, role, body }) {
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
  if (!ids.length || ids.length > 200) fail('Choose between 1 and 200 products');
  if (!['list', 'unlist', 'delete', 'stock'].includes(body.action)) fail('Unknown action');
  if (body.action === 'stock' && (body.stock === undefined || body.stock === null || body.stock === '')) fail('Enter the new stock quantity');
  for (const id of ids) {
    const row = await ownedProduct(db, id, userId, role);
    if (body.action === 'delete') await removeProduct(db, row);
    else {
      const changes = body.action === 'stock' ? { stock: body.stock } : { active: body.action === 'list' };
      await saveProduct(db, row.id, row.seller_id, { ...row.data, ...quickChanges(row, changes) });
    }
  }
  return { body: { updated: ids.length, action: body.action } };
}

async function duplicateProduct({ db, userId, role, id }) {
  const row = await ownedProduct(db, id, userId, role);
  const copy = { ...row.data, name: `${row.data.name} (copy)`.slice(0, 200), active: false, rating: 0, ratingCount: 0, featured: false };
  return { status: 201, body: await saveProduct(db, randomBytes(12).toString('hex'), role === 'admin' ? row.seller_id : userId, copy) };
}

// ---------- Orders with the seller's products, and earnings ----------
async function myOrders({ db, userId, role, params }) {
  const args = role === 'admin' ? [] : [userId];
  const where = role === 'admin' ? [] : ['oi.seller_id = $1'];
  if (['placed', 'cancelled'].includes(params.status)) {
    args.push(params.status);
    where.push(`o.status = $${args.length}`);
  }
  if (FULFILMENT.includes(params.fulfilment)) {
    args.push(params.fulfilment);
    where.push(`oi.fulfilment = $${args.length}`);
  }
  args.push(Math.max(1, Math.min(Number(params.limit) || 100, 500)));
  const rows = await db(
    `SELECT o.id, o.created_at, o.status, o.payment_method, o.user_id AS customer_id,
            split_part(o.address, ',', 1) AS customer, o.address,
            json_agg(json_build_object('productId', oi.product_id, 'name', oi.name, 'image', oi.image, 'price', oi.price,
                                       'qty', oi.qty, 'fulfilment', oi.fulfilment, 'options', oi.options) ORDER BY oi.id) AS items,
            SUM(oi.price * oi.qty)::float AS amount,
            MIN(array_position(ARRAY['pending','packed','shipped','delivered'], oi.fulfilment::text)) AS step,
            (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY o.id ORDER BY o.created_at DESC LIMIT $${args.length}`,
    args,
  );
  // An order is as far along as its least-advanced line from this seller
  return { body: rows.map(({ step, ...r }) => ({ ...r, fulfilment: FULFILMENT[(step || 1) - 1] })) };
}

async function updateFulfilment({ db, userId, role, id, body }) {
  if (!/^\d{1,9}$/.test(String(id))) fail('Order not found', 404);
  if (!FULFILMENT.includes(body.fulfilment)) fail('Unknown fulfilment step');
  const courier = text(body.courier).slice(0, 60) || null;
  const tracking = text(body.trackingNumber).slice(0, 60) || null;
  const [order] = await db('SELECT status FROM orders WHERE id = $1', [Number(id)]);
  if (!order) fail('Order not found', 404);
  if (order.status !== 'placed') fail(`This order was ${order.status}`);
  const note = body.fulfilment === 'shipped' && (courier || tracking)
    ? `Shipped by ${courier || 'courier'}${tracking ? `, tracking number ${tracking}` : ''}`
    : body.fulfilment[0].toUpperCase() + body.fulfilment.slice(1);
  const rows = await db(
    `WITH moved AS (
       UPDATE order_items
          SET fulfilment = $2::varchar,
              fulfilled_at = CASE WHEN $2::varchar = 'delivered' THEN NOW() ELSE fulfilled_at END,
              courier = COALESCE($3, courier),
              tracking_number = COALESCE($4, tracking_number)
        WHERE order_id = $1 AND ($5::int IS NULL OR seller_id = $5)
        RETURNING id
     ), timeline AS (
       INSERT INTO order_events (order_id, status, note) SELECT $1, $2, $6 WHERE EXISTS (SELECT 1 FROM moved)
     )
     SELECT count(*)::int AS lines FROM moved`,
    [Number(id), body.fulfilment, courier, tracking, role === 'admin' ? null : userId, note],
  );
  if (!rows[0].lines) fail('This order has none of your products', 404);
  return { body: { orderId: Number(id), fulfilment: body.fulfilment, lines: rows[0].lines } };
}

async function earnings({ db, userId, role }) {
  const owner = role === 'admin' ? 'TRUE' : 'oi.seller_id = $1';
  const args = role === 'admin' ? [] : [userId];
  const [totals] = await db(
    `SELECT COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed'), 0)::float AS gross,
            COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed' AND oi.fulfilment = 'delivered'), 0)::float AS delivered,
            COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed' AND oi.fulfilment <> 'delivered'), 0)::float AS in_progress,
            COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'cancelled'), 0)::float AS cancelled,
            COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed' AND o.created_at > NOW() - INTERVAL '30 days'), 0)::float AS last30,
            COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'placed')::int AS orders
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${owner}`,
    args,
  );
  const byMethod = await db(
    `SELECT o.payment_method AS method, SUM(oi.price * oi.qty)::float AS amount, COUNT(DISTINCT o.id)::int AS orders
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${owner} AND o.status = 'placed' GROUP BY 1 ORDER BY 2 DESC`,
    args,
  );
  const recent = await db(
    `SELECT p.id, p.order_id, p.method, p.status, p.provider_payment_id, p.created_at, SUM(oi.price * oi.qty)::float AS amount
       FROM payments p JOIN order_items oi ON oi.order_id = p.order_id
      WHERE ${owner} GROUP BY p.id ORDER BY p.created_at DESC LIMIT 25`,
    args,
  );
  const [payout] = await db('SELECT payout_upi, bank_account_number, bank_account_last4, bank_ifsc FROM sellers WHERE user_id = $1', [userId]);
  const last4 = payout?.bank_account_last4 || (decrypt(payout?.bank_account_number) || '').slice(-4);
  return {
    body: { totals, byMethod, recentPayments: recent, payout: { upi: payout?.payout_upi ?? null, bank: last4 ? `${mask(last4)} · ${payout.bank_ifsc}` : null } },
  };
}

// ---------- Seller products in the public catalog ----------
let lastSync = 0;

/** Loads listed seller products into the catalog at most every 30 s; on a database error the catalog keeps what it had. */
export async function syncSellerProducts(db = query, now = Date.now()) {
  if (now - lastSync < SYNC_MS) return;
  lastSync = now;
  try {
    const rows = await db(
      `SELECT p.*, s.store_name FROM seller_products p LEFT JOIN sellers s ON s.user_id = p.seller_id
        WHERE (p.data->>'active')::boolean IS NOT FALSE ORDER BY p.created_at`,
      [],
    );
    setSellerProducts(rows.map(productJson));
  } catch (err) {
    console.error('seller products unavailable', err.message);
    lastSync = now - SYNC_MS + 5000; // try again in 5 s
  }
}

// ---------- Routes ----------
const ROUTES = {
  'POST register': register,
  'GET profile': getProfile,
  'PUT profile': updateProfile,
  'GET products': myProducts,
  'POST products': createProduct,
  'POST products/bulk': bulkProducts,
  'GET products/:id': async ({ db, userId, role, id }) => ({ body: productJson(await ownedProduct(db, id, userId, role)) }),
  'PUT products/:id': updateProduct,
  'PATCH products/:id': patchProduct,
  'DELETE products/:id': deleteProduct,
  'POST products/:id/duplicate': duplicateProduct,
  'GET orders': myOrders,
  'PATCH orders/:id': updateFulfilment,
  'GET earnings': earnings,
};

function findRoute(method, rest) {
  const [first, second, third, ...extra] = rest;
  if (extra.length) return null;
  if (first === 'products' && second === 'bulk' && !third) return { key: `${method} products/bulk` };
  const key = [first, second && ':id', third].filter(Boolean).join('/');
  return Object.hasOwn(ROUTES, `${method} ${key}`) ? { key: `${method} ${key}`, id: second } : null;
}

export const isSellerRoute = (method, rest) => Boolean(findRoute(method, rest));

export function handleSeller({ method, rest, body, params = {}, authorization }, { db = query } = {}) {
  return safely(async () => {
    const userId = currentUserId(authorization);
    const { key, id } = findRoute(method, rest);
    const role = key === 'POST register' ? null : await sellerRole(db, userId);
    return ROUTES[key]({ db, userId, role, id, body: body ?? {}, params });
  });
}
