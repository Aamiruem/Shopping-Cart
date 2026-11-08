// The festive home page: which festival or season it is in India, its collections, and what shoppers want right now.
//
// Demand ranking: every product gets a score from real shopper activity in the database (orders count most, then cart
// adds, then wishlist saves), with older activity fading (half-life about 5 days). Until there's enough activity the
// catalog's popularity carries the ranking, then real demand takes over as it grows.
//
// Every collection is a real catalog filter, so its "Under ₹X" headline is true and its link shows exactly those products.
import { listProducts, loadProducts } from './_catalog.mjs';

// Add festivals here (dates are India time). Outside them, the season of the year is used.
export const FESTIVALS = [
  {
    id: 'diwali-2026',
    name: 'Diwali',
    greeting: 'Happy Diwali',
    tagline: 'Lights, décor, festive wear, sweets and gifts for the festival of lights',
    theme: 'diwali',
    from: '2026-10-25',
    to: '2026-11-15',
    collections: [
      { id: 'decor', title: 'Home & décor', params: { category: 'home' } },
      { id: 'ethnic', title: 'Festive ethnic wear', params: { q: 'ethnic' } },
      { id: 'sweets', title: 'Dry fruits & treats', params: { category: 'grocery', subCategory: 'dry-fruits-health' } },
      { id: 'fragrances', title: 'Fragrances to gift', params: { category: 'beauty', subCategory: 'fragrances' } },
      { id: 'watches', title: 'Watches to gift', params: { q: 'watches' } },
    ],
  },
  {
    id: 'christmas-2026',
    name: 'Christmas & New Year',
    greeting: 'Season’s greetings',
    tagline: 'Warm wear, party looks, treats and gifts to close the year',
    theme: 'christmas',
    from: '2026-12-15',
    to: '2027-01-02',
    collections: [
      { id: 'winterwear', title: 'Winter wear', params: { q: 'winterwear' } },
      { id: 'treats', title: 'Snacks & treats', params: { category: 'grocery', subCategory: 'snacks' } },
      { id: 'fragrances', title: 'Fragrances to gift', params: { category: 'beauty', subCategory: 'fragrances' } },
      { id: 'audio', title: 'Music & audio', params: { category: 'electronics', subCategory: 'audio' } },
      { id: 'decor', title: 'Home & décor', params: { category: 'home' } },
    ],
  },
];

// By month (1-12), when no festival is on
const SEASONS = [
  {
    id: 'winter',
    months: [11, 12, 1, 2],
    name: 'Winter',
    greeting: 'Winter store',
    tagline: 'Stay warm: jackets, sweaters, skin care and hot drinks',
    theme: 'winter',
    collections: [
      { id: 'winterwear', title: 'Winter wear', params: { q: 'winterwear' } },
      { id: 'skin', title: 'Winter skin care', params: { category: 'beauty', subCategory: 'skin-care' } },
      { id: 'drinks', title: 'Tea, coffee & drinks', params: { category: 'grocery', subCategory: 'tea-coffee-drinks' } },
      { id: 'home', title: 'Home essentials', params: { category: 'home' } },
    ],
  },
  {
    id: 'summer',
    months: [3, 4, 5, 6],
    name: 'Summer',
    greeting: 'Summer store',
    tagline: 'Keep cool: light clothing, sunglasses, skin care and cold drinks',
    theme: 'summer',
    collections: [
      { id: 'sunglasses', title: 'Sunglasses', params: { category: 'accessories', subCategory: 'sunglasses' } },
      { id: 'tshirts', title: 'T-shirts', params: { category: 'fashion', subCategory: 'mens-tshirts' } },
      { id: 'skin', title: 'Sun & skin care', params: { category: 'beauty', subCategory: 'skin-care' } },
      { id: 'drinks', title: 'Drinks', params: { category: 'grocery', subCategory: 'tea-coffee-drinks' } },
    ],
  },
  {
    id: 'monsoon',
    months: [7, 8, 9, 10],
    name: 'Monsoon',
    greeting: 'Monsoon store',
    tagline: 'Rainy-day footwear, snacks, hot drinks and home comforts',
    theme: 'monsoon',
    collections: [
      { id: 'footwear', title: 'Footwear', params: { category: 'fashion', subCategory: 'footwear' } },
      { id: 'snacks', title: 'Snacks', params: { category: 'grocery', subCategory: 'snacks' } },
      { id: 'drinks', title: 'Tea & coffee', params: { category: 'grocery', subCategory: 'tea-coffee-drinks' } },
      { id: 'home', title: 'Home essentials', params: { category: 'home' } },
    ],
  },
];

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

/** Demand score per product id from the last 60 days of orders, cart adds and wishlist saves. */
export async function demandScores(db) {
  const rows = await db(
    `SELECT product_id, SUM(weight * EXP(-EXTRACT(EPOCH FROM NOW() - at) / $1))::float AS score
       FROM (
         SELECT oi.product_id, oi.qty * 5.0 AS weight, o.created_at AS at
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.status <> 'cancelled' AND o.created_at > NOW() - INTERVAL '60 days'
         UNION ALL
         SELECT product_id, qty * 2.0, added_at FROM cart_items WHERE added_at > NOW() - INTERVAL '60 days'
         UNION ALL
         SELECT product_id, 1.0, added_at FROM wishlist_items WHERE added_at > NOW() - INTERVAL '60 days'
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
    demand = await demandScores(db);
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
