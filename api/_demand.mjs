// The festive home page: which festival or season it is in India, its collections, and what shoppers want right now.
//
// Demand ranking: every product gets a score from real shopper activity in the database (orders count most, then cart
// adds, wishlist saves and product page views), with older activity fading (half-life about 5 days). Until there's enough activity the
// catalog's popularity carries the ranking, then real demand takes over as it grows.
//
// Every collection is a real catalog filter, so its "Under ₹X" headline is true and its link shows exactly those products.
import { readFileSync } from 'node:fs';
import { listProducts, loadProducts } from './_catalog.mjs';

// Festivals and seasons are in backend/app/data/seasons.json, shared with the FastAPI backend (services/festive.py).
// Add festivals there (dates are India time). Outside them, the season of the year is used.
const SEASON_DATA = JSON.parse(readFileSync(new URL('../backend/app/data/seasons.json', import.meta.url), 'utf8'));
export const FESTIVALS = SEASON_DATA.festivals;
const SEASONS = SEASON_DATA.seasons;

const PRICE_CAPS = [299, 499, 699, 999, 1499, 1999, 2999, 4999, 9999];
const MIN_IN_COLLECTION = 4;
const DECAY_SECONDS = 7 * 24 * 60 * 60; // exp(-age / 7 days): half-life of about 5 days

/** Today in India as YYYY-MM-DD and its month. */
export function indiaDate(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return { day, month: Number(day.slice(5, 7)) };
}

export function currentSeason(now = new Date()) {
  const { day, month } = indiaDate(now);
  const festival = FESTIVALS.find((f) => f.from <= day && day <= f.to);
  if (festival) return { ...festival, kind: 'festival', endsOn: festival.to };
  return { ...SEASONS.find((s) => s.months.includes(month)), kind: 'season', endsOn: null };
}

const DEMAND_TTL_MS = 5 * 60 * 1000;
let cachedDemand = null;

/** Forgets the cached scores (tests, or right after a burst of activity that should show at once). */
export const forgetDemand = () => {
  cachedDemand = null;
};

/** demandScores, kept for 5 minutes per function instance: the ranking moves with demand without a query per page. */
export async function currentDemand(db, now = Date.now()) {
  if (cachedDemand && now - cachedDemand.at < DEMAND_TTL_MS) return cachedDemand.scores;
  const scores = await demandScores(db);
  cachedDemand = { at: now, scores };
  return scores;
}

/** Demand score per product id from the last 60 days of orders, cart adds, wishlist saves and page views. */
export async function demandScores(db) {
  const rows = await db(
    `SELECT product_id, SUM(weight * EXP(-EXTRACT(EPOCH FROM NOW() - at) / $1))::float AS score
       FROM (
         SELECT oi.product_id, oi.qty * 5.0 AS weight, o.created_at AS at
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.status NOT IN ('cancelled', 'returned') AND o.created_at > NOW() - INTERVAL '60 days'
         UNION ALL
         SELECT product_id, qty * 2.0, added_at FROM cart_items WHERE added_at > NOW() - INTERVAL '60 days'
         UNION ALL
         SELECT product_id, 1.0, added_at FROM wishlist_items WHERE added_at > NOW() - INTERVAL '60 days'
         UNION ALL
         SELECT product_id, 0.5, at FROM product_views WHERE at > NOW() - INTERVAL '60 days'
       ) activity
      GROUP BY product_id`,
    [DECAY_SECONDS],
  );
  return new Map(rows.map((r) => [r.product_id, r.score]));
}

// Popularity from the catalog, 0..1 (log scale, so a few huge counts don't dominate)
function popularityOf(products) {
  const most = Math.log1p(Math.max(1, ...products.map((p) => p.ratingCount || 0)));
  return (p) => Math.log1p(p.ratingCount || 0) / most;
}

/**
 * Ranks products by demand. The weight on real activity grows with how much there is (none -> popularity only;
 * 50+ weighted actions -> 80% demand), so a handful of clicks can't swing the whole page.
 */
export function rankByDemand(products, demand) {
  const popularity = popularityOf(loadProducts());
  const top = Math.max(0, ...demand.values());
  const total = [...demand.values()].reduce((sum, v) => sum + v, 0);
  const trust = Math.min(0.8, total / 50 * 0.8);
  const score = (p) => (top ? (demand.get(p._id) || 0) / top : 0) * trust + popularity(p) * (1 - trust);
  return products
    .filter((p) => (p.stock ?? 0) > 0)
    .map((p) => ({ p, s: score(p) }))
    .sort((a, b) => b.s - a.s)
    .map(({ p }) => p);
}

const toQuery = (params) => new URLSearchParams(params).toString();

function collection(def, demand) {
  const all = listProducts({ ...def.params, limit: 200 }).filter((p) => (p.stock ?? 0) > 0);
  if (all.length < MIN_IN_COLLECTION) return null;
  // The lowest round price that still has a real choice of products under it
  const cap = PRICE_CAPS.find((c) => all.filter((p) => p.price <= c).length >= MIN_IN_COLLECTION) ?? null;
  const items = rankByDemand(cap ? all.filter((p) => p.price <= cap) : all, demand);
  return {
    id: def.id,
    title: def.title,
    under: cap,
    count: items.length,
    to: `/products?${toQuery({ ...def.params, ...(cap ? { maxPrice: cap } : {}), sort: 'popularity' })}`,
    images: items.slice(0, 4).map((p) => ({ src: p.image, alt: p.name })),
  };
}

/** Everything the festive home section needs. Never fails: without the database it ranks by popularity. */
export async function festiveStore(db, now = new Date()) {
  let demand = new Map();
  let signal = 'demand';
  try {
    demand = await currentDemand(db);
  } catch (err) {
    console.error('demand scores unavailable', err.message);
    signal = 'popularity';
  }
  if (!demand.size) signal = 'popularity';
  const season = currentSeason(now);
  const collections = season.collections.map((c) => collection(c, demand)).filter(Boolean);
  const inSeason = new Set(collections.flatMap((c) => listProducts({ ...season.collections.find((d) => d.id === c.id).params, limit: 200 }).map((p) => p._id)));
  const trending = rankByDemand(loadProducts().filter((p) => inSeason.has(p._id)), demand).slice(0, 14);
  const { collections: _defs, months: _months, from: _from, to: _to, ...about } = season;
  return { season: about, collections, trending, signal };
}
