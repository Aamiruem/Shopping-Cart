// Recommendations on the Vercel store, from what shoppers actually do. Rankings move with demand on their own: every
// signal fades with time, so what's wanted this week rises and last month's favourites sink.
//
//   trending   demand across the store: orders, cart adds, wishlist saves and page views (api/_demand.mjs)
//   for you    what this shopper ordered, saved and looked at: their categories, sub-categories, brands and price
//              range, mixed with demand. Things they already bought or have in the cart are left out.
//   together   bought in the same orders as this product, then viewed by the same shoppers, then similar products
//   similar    same category, closest in sub-category, brand, price and tags, weighted by demand
// With no activity yet, every list falls back to catalog popularity, so a new store still has sensible rails.
import { currentDemand, rankByDemand } from './_demand.mjs';
import { getProduct, loadProducts } from './_catalog.mjs';

const DAY = 24 * 60 * 60;
const VISITOR_RE = /^[a-zA-Z0-9-]{8,40}$/;
const PER_CATEGORY = 4; // the "for you" rail shows at most this many from one category in a row

const inStock = (p) => (p.stock ?? 0) > 0;

async function demandOrNothing(db) {
  try {
    return await currentDemand(db);
  } catch (err) {
    console.error('demand unavailable', err.message);
    return new Map(); // popularity only
  }
}

/** Demand as 0..1 by rank, so one viral product doesn't flatten everything else. */
function demandRank(products, demand) {
  const ranked = rankByDemand(products, demand);
  const n = Math.max(1, ranked.length - 1);
  return new Map(ranked.map((p, i) => [p._id, 1 - i / n]));
}

export async function trending(db, { k = 12, category } = {}) {
  const demand = await demandOrNothing(db);
  const pool = loadProducts().filter((p) => inStock(p) && (!category || p.category === category));
  return { strategy: demand.size ? 'trending' : 'popular', items: rankByDemand(pool, demand).slice(0, k) };
}

// ---------- Similar products ----------
function closeness(a, b) {
  const tags = (p) => new Set((p.tags || []).map((t) => String(t).toLowerCase()));
  const [x, y] = [tags(a), tags(b)];
  const shared = [...x].filter((t) => y.has(t)).length;
  const jaccard = x.size + y.size ? shared / (x.size + y.size - shared) : 0;
  const price = a.price > 0 && b.price > 0 ? Math.max(0, 1 - Math.abs(Math.log(a.price / b.price)) / Math.log(3)) : 0;
  return (a.subCategory && a.subCategory === b.subCategory ? 0.4 : 0) + (a.brand && a.brand === b.brand ? 0.15 : 0) + price * 0.25 + jaccard * 0.1;
}

export function similarTo(product, demand, k = 8, exclude = new Set()) {
  const pool = loadProducts().filter((p) => p._id !== product._id && inStock(p) && p.category === product.category && !exclude.has(p._id));
  const wanted = demandRank(pool, demand);
  return pool
    .map((p) => ({ p, s: closeness(product, p) + 0.2 * (wanted.get(p._id) || 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(({ p }) => p);
}

export async function similar(db, id, k = 8) {
  const product = getProduct(id);
  if (!product) return [];
  return similarTo(product, await demandOrNothing(db), k);
}

// ---------- Bought / viewed together ----------
export async function together(db, id, k = 6) {
  const product = getProduct(id);
  if (!product) return { strategy: 'similar', items: [] };
  const rows = await db(
    `SELECT other AS product_id, SUM(w)::float AS score, bool_or(bought) AS bought
       FROM (
         SELECT b.product_id AS other, 3.0 AS w, TRUE AS bought
           FROM order_items a JOIN order_items b ON b.order_id = a.order_id AND b.product_id <> a.product_id
           JOIN orders o ON o.id = a.order_id
          WHERE a.product_id = $1 AND o.status <> 'cancelled' AND o.created_at > NOW() - INTERVAL '180 days'
         UNION ALL
         SELECT b.product_id, 1.0, FALSE
           FROM product_views a JOIN product_views b ON b.visitor = a.visitor AND b.product_id <> a.product_id
          WHERE a.product_id = $1 AND a.at > NOW() - INTERVAL '60 days' AND b.at > NOW() - INTERVAL '60 days'
       ) pairs
      GROUP BY other ORDER BY score DESC LIMIT 40`,
    [id],
  ).catch(() => []);
  const found = rows.map((r) => ({ p: getProduct(r.product_id), bought: r.bought })).filter(({ p }) => p && inStock(p));
  const items = found.slice(0, k).map(({ p }) => p);
  const strategy = found.some((f) => f.bought) ? 'bought_together' : found.length ? 'similar_shoppers' : 'similar';
  if (items.length < k) {
    const have = new Set(items.map((p) => p._id));
    items.push(...similarTo(product, await demandOrNothing(db), k - items.length, have));
  }
  return { strategy, items };
}

// ---------- For you ----------
/** How much this shopper (or visitor) cares about each product they touched, fading over a month. */
async function interests(db, { userId, visitor }) {
  if (!userId && !visitor) return [];
  return db(
    `SELECT product_id, SUM(w * EXP(-EXTRACT(EPOCH FROM NOW() - at) / $3))::float AS weight, bool_or(owned) AS owned
       FROM (
         SELECT oi.product_id, 3.0 AS w, o.created_at AS at, TRUE AS owned
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.user_id = $1 AND o.status <> 'cancelled'
         UNION ALL SELECT product_id, 2.0, added_at, TRUE FROM cart_items WHERE user_id = $1
         UNION ALL SELECT product_id, 2.0, added_at, FALSE FROM wishlist_items WHERE user_id = $1
         UNION ALL SELECT product_id, 1.0, at, FALSE FROM product_views
                    WHERE (user_id = $1 OR visitor = $2) AND at > NOW() - INTERVAL '90 days'
       ) touched
      GROUP BY product_id`,
    [userId ?? -1, visitor ?? '', 30 * DAY],
  );
}

/** Spreads the list so one category can't fill the whole rail. */
function diversify(ranked, k) {
  const out = [];
  const perCategory = new Map();
  const rest = [];
  for (const p of ranked) {
    const n = perCategory.get(p.category) || 0;
    if (n < PER_CATEGORY) {
      out.push(p);
      perCategory.set(p.category, n + 1);
    } else rest.push(p);
    if (out.length === k) return out;
  }
  return [...out, ...rest].slice(0, k);
}

export async function forYou(db, { userId = null, visitor = null, k = 12 } = {}) {
  const who = { userId, visitor: VISITOR_RE.test(visitor || '') ? visitor : null };
  const [touched, demand] = await Promise.all([interests(db, who).catch(() => []), demandOrNothing(db)]);
  const seen = touched.map((t) => ({ ...t, p: getProduct(t.product_id) })).filter((t) => t.p);
  if (!seen.length) {
    const { items } = await trending(db, { k });
    return { strategy: 'trending', items };
  }
  const add = (map, key, w) => key && map.set(key, (map.get(key) || 0) + w);
  const [categories, subs, brands] = [new Map(), new Map(), new Map()];
  let priceSum = 0;
  let weightSum = 0;
  seen.forEach(({ p, weight }) => {
    add(categories, p.category, weight);
    add(subs, p.subCategory, weight);
    add(brands, p.brand, weight);
    priceSum += Math.log(Math.max(1, p.price)) * weight;
    weightSum += weight;
  });
  const norm = (map) => {
    const top = Math.max(...map.values(), 0) || 1;
    return (key) => (map.get(key) || 0) / top;
  };
  const [cat, sub, brand] = [norm(categories), norm(subs), norm(brands)];
  const usualPrice = priceSum / weightSum; // log scale
  const skip = new Set(seen.filter((t) => t.owned).map((t) => t.product_id));
  const pool = loadProducts().filter((p) => inStock(p) && !skip.has(p._id));
  const wanted = demandRank(pool, demand);
  const score = (p) =>
    0.4 * cat(p.category) + 0.2 * sub(p.subCategory) + 0.1 * brand(p.brand) +
    0.1 * Math.max(0, 1 - Math.abs(Math.log(Math.max(1, p.price)) - usualPrice) / Math.log(4)) +
    0.2 * (wanted.get(p._id) || 0);
  const ranked = pool.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s).map(({ p }) => p);
  return { strategy: 'personal', items: diversify(ranked, k) };
}

// ---------- Signals ----------
/** A product page view: one per visitor per product per day counts. */
export async function recordView(db, { productId, userId = null, visitor = null }) {
  if (!getProduct(productId)) return false;
  const who = userId ? `u${userId}` : VISITOR_RE.test(visitor || '') ? visitor : null;
  if (!who) return false;
  await db(
    'INSERT INTO product_views (product_id, visitor, user_id) VALUES ($1, $2, $3) ON CONFLICT (visitor, product_id, day) DO UPDATE SET at = NOW()',
    [productId, who, userId],
  );
  // A visitor who signs in later keeps their history
  if (userId && VISITOR_RE.test(visitor || '')) {
    await db('UPDATE product_views SET user_id = $1 WHERE visitor = $2 AND user_id IS NULL', [userId, visitor]);
  }
  return true;
}
