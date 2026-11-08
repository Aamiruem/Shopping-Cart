// Shopping for the Vercel store: cart, wishlist, saved addresses and orders, in PostgreSQL. Online payment is in
// _payments.mjs. Response
// shapes mirror backend/app/routers/{cart,wishlist,addresses,orders}.py, so the storefront runs unchanged on either API.
// Addresses and orders use the backend's own tables; the backend keeps carts and wishlists in MongoDB, so those two
// tables exist only here (see _schema.mjs).
//
// Prices always come from the catalog on this server, never from the request. The catalog is a read-only file, so
// stock is checked at checkout but doesn't go down as orders are placed.
import { getProduct } from './_catalog.mjs';
import { ApiError, currentUserId, limit, postgresStore, query, safely } from './_auth.mjs';
import { razorpayClient, refundPaidOrder } from './_payments.mjs';

const MAX_QTY = 10;
const MAX_CART_LINES = 50;
const MAX_WISHLIST = 200;
const MAX_ADDRESSES = 20;
const FREE_DELIVERY_ABOVE = 499;
const DELIVERY_FEE = 40;
const ORDER_LIMIT = 10; // orders per user every 15 minutes: cash orders cost nothing to place, so spam must be capped
const ID_RE = /^\d{1,9}$/;
const PHONE_RE = /^[6-9]\d{9}$/;
const PINCODE_RE = /^\d{6}$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const clampQty = (qty, stock) => Math.max(1, Math.min(Math.trunc(Number(qty)) || 1, MAX_QTY, stock));

async function loadCart(db, userId) {
  const rows = await db('SELECT product_id, qty FROM cart_items WHERE user_id = $1 ORDER BY added_at, product_id', [userId]);
  return rows.map((r) => ({ product: getProduct(r.product_id), qty: r.qty })).filter((line) => line.product);
}

// mrp equals the price: the catalog's MRPs are samples, so no discount is claimed
function summarize(lines) {
  const items = lines.map(({ product: p, qty }) => ({
    lineId: p._id,
    productId: p._id,
    size: null,
    color: null,
    name: p.name,
    brand: p.brand ?? '',
    image: p.image ?? null,
    category: p.category ?? null,
    sellerId: null,
    price: p.price,
    mrp: p.price,
    stock: p.stock ?? 0,
    qty,
    subtotal: p.price * qty,
  }));
  const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
  const deliveryFee = !items.length || subtotal >= FREE_DELIVERY_ABOVE ? 0 : DELIVERY_FEE;
  return { items, totalMrp: subtotal, discount: 0, subtotal, deliveryFee, total: subtotal + deliveryFee };
}

const cartResponse = async (db, userId) => summarize(await loadCart(db, userId));

function product(id) {
  const found = getProduct(text(id));
  if (!found) throw new ApiError(404, 'Product not found');
  return found;
}

async function addToCart({ db, userId, body }) {
  const item = product(body.productId);
  if ((item.stock ?? 0) < 1) throw new ApiError(409, `${item.name} is out of stock`);
  const [{ lines }] = await db('SELECT count(*)::int AS lines FROM cart_items WHERE user_id = $1', [userId]);
  if (lines >= MAX_CART_LINES) throw new ApiError(400, 'Your cart is full');
  const most = Math.min(MAX_QTY, item.stock);
  await db(
    `INSERT INTO cart_items (user_id, product_id, qty) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id) DO UPDATE SET qty = LEAST(cart_items.qty + EXCLUDED.qty, $4)`,
    [userId, item._id, clampQty(body.qty ?? 1, item.stock), most],
  );
  return { status: 201, body: await cartResponse(db, userId) };
}

async function updateCart({ db, userId, id, body }) {
  const item = getProduct(id);
  if (!item || Number(body.qty) < 1) {
    await db('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [userId, id]);
  } else {
    await db('UPDATE cart_items SET qty = $1 WHERE user_id = $2 AND product_id = $3', [clampQty(body.qty, item.stock), userId, id]);
  }
  return { body: await cartResponse(db, userId) };
}

async function removeFromCart({ db, userId, id }) {
  await db('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [userId, id]);
  return { body: await cartResponse(db, userId) };
}

async function wishlistResponse(db, userId) {
  const rows = await db('SELECT product_id FROM wishlist_items WHERE user_id = $1 ORDER BY added_at, product_id', [userId]);
  return rows.map((r) => getProduct(r.product_id)).filter(Boolean);
}

async function addToWishlist({ db, userId, id }) {
  const item = product(id);
  const [{ saved }] = await db('SELECT count(*)::int AS saved FROM wishlist_items WHERE user_id = $1', [userId]);
  if (saved >= MAX_WISHLIST) throw new ApiError(400, 'Your wishlist is full');
  await db('INSERT INTO wishlist_items (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, item._id]);
  return { status: 201, body: await wishlistResponse(db, userId) };
}

async function removeFromWishlist({ db, userId, id }) {
  await db('DELETE FROM wishlist_items WHERE user_id = $1 AND product_id = $2', [userId, id]);
  return { body: await wishlistResponse(db, userId) };
}

function addressError(a) {
  for (const [field, label, max] of [['name', 'Name', 100], ['phone', 'Phone', 20], ['line1', 'Address', 500], ['city', 'City', 100], ['state', 'State', 100], ['pincode', 'Pincode', 10]]) {
    if (!a[field]) return `${label} is required`;
    if (a[field].length > max) return `${label} is too long`;
  }
  if (!PHONE_RE.test(a.phone)) return 'Please enter a valid 10-digit mobile number';
  return PINCODE_RE.test(a.pincode) ? null : 'Please enter a valid 6-digit pincode';
}

async function addAddress({ db, userId, body }) {
  const a = Object.fromEntries(['name', 'phone', 'line1', 'city', 'state', 'pincode'].map((field) => [field, text(body[field])]));
  const error = addressError(a);
  if (error) throw new ApiError(400, error);
  const [{ saved }] = await db('SELECT count(*)::int AS saved FROM addresses WHERE user_id = $1', [userId]);
  if (saved >= MAX_ADDRESSES) throw new ApiError(400, 'You have saved the maximum number of addresses');
  const [created] = await db(
    `INSERT INTO addresses (user_id, name, phone, line1, city, state, pincode, type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, a.name, a.phone, a.line1, a.city, a.state, a.pincode, body.type === 'work' ? 'work' : 'home'],
  );
  return { status: 201, body: created };
}

const ORDERS_SQL = `
  SELECT o.*, COALESCE(json_agg(oi.* ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items,
         (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status
    FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
   WHERE o.user_id = $1`;

// PostgreSQL drivers return NUMERIC as text; the storefront does arithmetic on these
const orderJson = (o) => ({ ...o, total: Number(o.total), delivery_fee: Number(o.delivery_fee) });

/** The shopper's saved address as the one line stored on the order. */
export async function resolveAddress(db, userId, addressId) {
  if (!ID_RE.test(String(addressId ?? ''))) throw new ApiError(400, 'Shipping address is required');
  const [a] = await db('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [Number(addressId), userId]);
  if (!a) throw new ApiError(404, 'Address not found');
  return `${a.name}, ${a.line1}, ${a.city}, ${a.state} - ${a.pincode}. Phone: ${a.phone}`;
}

/** The cart and its price breakdown, after checking it isn't empty and everything is in stock. */
export async function checkoutSummary(db, userId) {
  const lines = await loadCart(db, userId);
  const summary = summarize(lines);
  if (!summary.items.length) throw new ApiError(400, 'Your cart is empty');
  for (const { product: p, qty } of lines) {
    if ((p.stock ?? 0) < qty) throw new ApiError(409, `Only ${p.stock ?? 0} left of ${p.name}`);
  }
  return { lines, summary };
}

async function placeOrder({ db, userId, body, store, ip }) {
  if (text(body.paymentMethod) !== 'cod') throw new ApiError(400, 'Please pay online with UPI, net banking or a card, or choose cash on delivery.');
  const address = await resolveAddress(db, userId, body.addressId);
  await limit(store, `order:${userId}`, ORDER_LIMIT, 'You’ve placed a lot of orders just now. Please try again in 15 minutes.');
  await limit(store, `order-ip:${ip}`, ORDER_LIMIT * 3, 'Too many orders from this connection. Please try again in 15 minutes.');
  const { summary } = await checkoutSummary(db, userId);
  const order = await createOrder(db, { userId, address, method: 'cod', summary });
  if (!order) throw new ApiError(400, 'Your cart is empty');
  return { status: 201, body: { ...order, items: summary.items } };
}

/**
 * Writes the order from the cart in one statement, so all of it happens or none of it does. Emptying the cart comes
 * first and the order exists only if that removed something: a double-clicked "Place order" finds the cart already
 * gone and creates nothing (returns null).
 */
export async function createOrder(db, { userId, address, method, summary }) {
  const details = summary.items.map((i) => ({ product_id: i.productId, name: i.name, price: i.price, image: i.image, category: i.category }));
  const [order] = await db(
    `WITH taken AS (
       DELETE FROM cart_items WHERE user_id = $1 RETURNING product_id, qty
     ), placed AS (
       INSERT INTO orders (user_id, total, address, payment_method, delivery_fee)
       SELECT $1::int, $2::numeric, $3::text, $6::text, $4::numeric WHERE EXISTS (SELECT 1 FROM taken)
       RETURNING *
     ), lines AS (
       INSERT INTO order_items (order_id, product_id, name, price, qty, image, category)
       SELECT placed.id, x.product_id, x.name, x.price, taken.qty, x.image, x.category
         FROM placed
        CROSS JOIN jsonb_to_recordset($5::jsonb) AS x(product_id text, name text, price numeric, image text, category text)
         JOIN taken ON taken.product_id = x.product_id
     ), timeline AS (
       INSERT INTO order_events (order_id, status, note) SELECT id, 'placed', 'Order placed' FROM placed
     )
     SELECT * FROM placed`,
    [userId, summary.total, address, summary.deliveryFee, JSON.stringify(details), method],
  );
  return order ? orderJson(order) : null;
}

async function listOrders({ db, userId }) {
  return { body: (await db(`${ORDERS_SQL} GROUP BY o.id ORDER BY o.created_at DESC, o.id DESC`, [userId])).map(orderJson) };
}

async function getOrder({ db, userId, id }) {
  const [order] = ID_RE.test(id) ? await db(`${ORDERS_SQL} AND o.id = $2 GROUP BY o.id`, [userId, Number(id)]) : [];
  if (!order) throw new ApiError(404, 'Order not found');
  const events = await db('SELECT status, note, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at, id', [order.id]);
  return { body: { ...orderJson(order), events, return: null } };
}

async function cancelOrder({ db, userId, id, rz }) {
  const [order] = ID_RE.test(id)
    ? await db(
        `WITH cancelled AS (
           UPDATE orders SET status = 'cancelled'
            WHERE id = $1 AND user_id = $2 AND status = 'placed'
              AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = $1 AND fulfilment IN ('shipped', 'delivered'))
           RETURNING *
         ), timeline AS (
           INSERT INTO order_events (order_id, status, note) SELECT id, 'cancelled', 'Cancelled by you' FROM cancelled
         )
         SELECT * FROM cancelled`,
        [Number(id), userId],
      )
    : [];
  if (!order) throw new ApiError(400, 'This order cannot be cancelled');
  // Paid online: the money goes back to the UPI app, bank or card it came from
  return { body: { ...orderJson(order), refund: await refundPaidOrder(db, order.id, rz) } };
}

// area, then method plus "id" / "id/action" when the path has them
const ROUTES = {
  cart: {
    GET: async ({ db, userId }) => ({ body: await cartResponse(db, userId) }),
    POST: addToCart,
    'PUT id': updateCart,
    'DELETE id': removeFromCart,
  },
  wishlist: {
    GET: async ({ db, userId }) => ({ body: await wishlistResponse(db, userId) }),
    'POST id': addToWishlist,
    'DELETE id': removeFromWishlist,
  },
  addresses: {
    GET: async ({ db, userId }) => ({ body: await db('SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [userId]) }),
    POST: addAddress,
    'DELETE id': async ({ db, userId, id }) => {
      if (ID_RE.test(id)) await db('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [Number(id), userId]);
      return { status: 204, body: null };
    },
  },
  orders: {
    GET: listOrders,
    POST: placeOrder,
    'GET id': getOrder,
    'PATCH id/cancel': cancelOrder,
  },
};

const ownKey = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

function findRoute(method, [area, id, action, ...extra]) {
  const routes = ownKey(ROUTES, area ?? '');
  if (!routes || extra.length) return undefined;
  return ownKey(routes, [method, id && 'id', action].filter(Boolean).join(' ').replace('id ', 'id/'));
}

export const isShopRoute = (method, segments) => Boolean(findRoute(method, segments));

export function handleShop({ method, segments, body, authorization, ip }, { db = query, rz = razorpayClient() } = {}) {
  return safely(async () => {
    const userId = currentUserId(authorization);
    return findRoute(method, segments)({ db, userId, id: segments[1], body: body ?? {}, store: postgresStore(db), ip, rz });
  });
}
