// Stock and the admin's catalog edits, saved in PostgreSQL. The store's own products come from a read-only file
// (backend/app/data/products.json); the database adds what changes:
//   catalog_overrides  the admin's edits: price, MRP, stock, name, description, listed or hidden
//   stock_adjustments  stock taken by orders and put back by cancellations and returns
// Seller products keep their stock in seller_products.data, which orders update directly.
// Each function instance reloads this every 30 s (and straight after its own changes), like the seller products.
import { ApiError, query } from './_auth.mjs';
import { baseProduct, setCatalogState, storeCatalog } from './_catalog.mjs';

const SYNC_MS = 30_000;
const EDITABLE = ['price', 'mrp', 'stock', 'name', 'description', 'active'];
const MAX_PRICE = 1_000_000;
const MAX_STOCK = 100_000;

const fail = (message, status = 400) => {
  throw new ApiError(status, message);
};

let lastSync = 0;

/** Loads the edits, stock changes and review ratings into the catalog. On a database error the catalog keeps what it had. */
export async function syncCatalogState(db = query, now = Date.now(), force = false) {
  if (!force && now - lastSync < SYNC_MS) return;
  lastSync = now;
  try {
    const [edits, stock, reviews] = await Promise.all([
      db('SELECT product_id, data FROM catalog_overrides', []),
      db('SELECT product_id, delta FROM stock_adjustments WHERE delta <> 0', []),
      db('SELECT product_id, ROUND(AVG(rating)::numeric, 1)::float AS average, COUNT(*)::int AS count FROM product_reviews GROUP BY product_id', []),
    ]);
    setCatalogState({
      overrides: new Map(edits.map((r) => [r.product_id, r.data])),
      deltas: new Map(stock.map((r) => [r.product_id, r.delta])),
      reviews: new Map(reviews.map((r) => [r.product_id, { average: r.average, count: r.count }])),
    });
  } catch (err) {
    console.error('catalog state unavailable', err.message);
    lastSync = now - SYNC_MS + 5000; // try again in 5 s
  }
}

/**
 * SQL for createOrder: takes the ordered quantities off stock, in the same statement as the order, given a `taken`
 * CTE of (product_id, qty) and a `placed` CTE that has a row only if the order was created.
 */
export const TAKE_STOCK_SQL = `
  , stock_store AS (
    INSERT INTO stock_adjustments (product_id, delta)
    SELECT taken.product_id, -SUM(taken.qty)::int FROM taken
     WHERE EXISTS (SELECT 1 FROM placed) AND NOT EXISTS (SELECT 1 FROM seller_products sp WHERE sp.id = taken.product_id)
     GROUP BY taken.product_id
    ON CONFLICT (product_id) DO UPDATE SET delta = stock_adjustments.delta + EXCLUDED.delta, updated_at = NOW()
  ), stock_seller AS (
    UPDATE seller_products sp
       SET data = jsonb_set(sp.data, '{stock}', to_jsonb(GREATEST(COALESCE((sp.data->>'stock')::int, 0) - taken.qty, 0)))
      FROM taken
     WHERE sp.id = taken.product_id AND EXISTS (SELECT 1 FROM placed)
  )`;

/** Puts an order's items back in stock (a cancelled order, or a returned one once the item is back). */
export async function restockOrder(db, orderId) {
  await db(
    `WITH lines AS (
       SELECT product_id, SUM(qty)::int AS qty FROM order_items WHERE order_id = $1 GROUP BY product_id
     ), store AS (
       INSERT INTO stock_adjustments (product_id, delta)
       SELECT product_id, qty FROM lines WHERE NOT EXISTS (SELECT 1 FROM seller_products sp WHERE sp.id = lines.product_id)
       ON CONFLICT (product_id) DO UPDATE SET delta = stock_adjustments.delta + EXCLUDED.delta, updated_at = NOW()
     )
     UPDATE seller_products sp
        SET data = jsonb_set(sp.data, '{stock}', to_jsonb(COALESCE((sp.data->>'stock')::int, 0) + lines.qty))
       FROM lines WHERE sp.id = lines.product_id`,
    [orderId],
  );
  await syncCatalogState(db, Date.now(), true);
}

// ---------- The admin's catalog editor (Seller Hub → Store catalog) ----------
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** Checks an edit; returns only the fields given. Stock is the new count on the shelf. */
export function validateEdit(body, current) {
  const edit = {};
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  if (body.price !== undefined) {
    const price = num(body.price);
    if (!(price > 0 && price <= MAX_PRICE)) fail('Price must be between ₹1 and ₹10,00,000');
    edit.price = Math.round(price * 100) / 100;
  }
  if (body.mrp !== undefined) {
    const mrp = num(body.mrp);
    if (mrp !== null && !(mrp > 0 && mrp <= MAX_PRICE)) fail('MRP must be between ₹1 and ₹10,00,000');
    edit.mrp = mrp === null ? null : Math.round(mrp * 100) / 100;
  }
  const price = edit.price ?? current.price;
  const mrp = edit.mrp === undefined ? current.mrp : edit.mrp;
  if (mrp !== null && mrp !== undefined && mrp < price) fail('MRP can’t be lower than the price');
  if (body.stock !== undefined) {
    const stock = num(body.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > MAX_STOCK) fail('Stock must be a whole number from 0 to 1,00,000');
    edit.stock = stock;
  }
  if (body.name !== undefined) {
    const name = text(body.name);
    if (name.length < 3 || name.length > 200) fail('Name must be 3 to 200 characters');
    edit.name = name;
  }
  if (body.description !== undefined) {
    const description = text(body.description);
    if (description.length > 5000) fail('Description can be up to 5,000 characters');
    edit.description = description;
  }
  if (body.active !== undefined) edit.active = Boolean(body.active);
  if (!Object.keys(edit).length) fail(`Nothing to change. Editable: ${EDITABLE.join(', ')}`);
  return edit;
}

export async function listCatalog({ params = {} }) {
  const q = text(params.q).toLowerCase();
  const limit = Math.max(1, Math.min(Number(params.limit) || 50, 200));
  const skip = Math.max(0, Math.trunc(Number(params.skip)) || 0);
  let items = storeCatalog().filter(
    (p) =>
      (!q || `${p.name} ${p.brand} ${p._id}`.toLowerCase().includes(q)) &&
      (!params.category || p.category === params.category) &&
      (params.status !== 'hidden' || !p.active) &&
      (params.status !== 'low_stock' || p.stock < 10) &&
      (params.status !== 'edited' || p.edited.length),
  );
  const total = items.length;
  items = items.slice(skip, skip + limit).map((p) => ({
    _id: p._id, name: p.name, brand: p.brand, category: p.category, image: p.image, price: p.price, mrp: p.mrp ?? null,
    stock: p.stock, active: p.active, description: p.description, edited: p.edited, reviewRating: p.reviewRating ?? null, reviewCount: p.reviewCount ?? 0,
  }));
  return { body: { total, items } };
}

export async function updateCatalogProduct({ db, userId, id, body }) {
  const base = baseProduct(String(id));
  if (!base) fail('Product not found', 404);
  const [row] = await db('SELECT data FROM catalog_overrides WHERE product_id = $1', [base._id]);
  const current = { ...base, ...(row?.data || {}) };
  const edit = validateEdit(body, current);
  const data = { ...(row?.data || {}), ...edit };
  // A new stock count replaces what orders took so far
  await db(
    `WITH saved AS (
       INSERT INTO catalog_overrides (product_id, data, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (product_id) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING product_id
     )
     DELETE FROM stock_adjustments WHERE product_id = $1 AND $4::boolean AND EXISTS (SELECT 1 FROM saved)`,
    [base._id, JSON.stringify(data), userId, edit.stock !== undefined],
  );
  await syncCatalogState(db, Date.now(), true);
  return { body: storeCatalog().find((p) => p._id === base._id) };
}

/** Undoes every edit: the product is as in the file again (stock sold since then still counts). */
export async function resetCatalogProduct({ db, id }) {
  const base = baseProduct(String(id));
  if (!base) fail('Product not found', 404);
  await db('DELETE FROM catalog_overrides WHERE product_id = $1', [base._id]);
  await syncCatalogState(db, Date.now(), true);
  return { body: storeCatalog().find((p) => p._id === base._id) };
}
