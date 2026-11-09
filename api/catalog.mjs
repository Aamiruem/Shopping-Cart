// Store API for the Vercel deployment: every /api/* request lands here (see vercel.json). Catalog reads come from
// products.json, accounts from _auth.mjs and shopping from _shop.mjs. Anything the full API alone can do answers 503
// with a friendly message, which the storefront shows as-is.
import { categories, facets, getProduct, listProducts, popular, similar, subcategories } from './_catalog.mjs';
import { paymentsConfig } from './_payment-config.mjs';

const OPENING_SOON = 'This part of Arvixa Store is opening soon.';
const SHOP_AREAS = new Set(['cart', 'wishlist', 'addresses', 'orders', 'support']);

const send = (res, status, body, cacheable = false) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // A minute at the edge: new seller listings and stock changes show up quickly
  res.setHeader('Cache-Control', cacheable ? 'public, s-maxage=60, stale-while-revalidate=600' : 'no-store');
  res.end(body === null ? undefined : JSON.stringify(body));
};

const count = (value, fallback, max = 24) => Math.max(1, Math.min(Number(value) || fallback, max));

export function route(path, params = {}) {
  const [area, first, second] = path.split('/').filter(Boolean);
  if (area === 'health') return { body: { ok: true, mode: 'preview' } };
  if (area === 'auth' && first === 'config') return { body: { googleClientId: null } };
  if (area === 'products') {
    if (!first) return { body: listProducts(params) };
    if (first === 'categories') return { body: categories() };
    if (first === 'subcategories') return { body: subcategories(params.category) };
    if (first === 'facets') return { body: facets(params) };
    if (second) return { status: 503, body: { error: OPENING_SOON } }; // reviews need a database
    const product = getProduct(first);
    return product ? { body: product } : { status: 404, body: { error: 'Product not found' } };
  }
  if (area === 'recommendations') {
    if (first === 'for-you') return { body: { strategy: 'trending', items: popular(count(params.k, 12)) } };
    if (first === 'trending') return { body: popular(count(params.k, 12)) };
    if (first === 'together' && second) return { body: { strategy: 'similar_shoppers', items: similar(second, count(params.k, 6, 12)) } };
  }
  if (area === 'ai' && first === 'recommend' && second) return { body: similar(second, count(params.k, 4)) };
  if (area === 'payments' && first === 'config') return { body: paymentsConfig() }; // online payment once Razorpay keys are set
  return { status: 503, body: { error: OPENING_SOON } };
}

// Account, shopping and support routes. Loaded on demand: catalog requests stay fast and need none of their dependencies.
async function personal(req, res, area, rest, params) {
  const auth = area === 'auth' ? await import('./_auth.mjs') : null;
  const pay = area === 'payments' ? await import('./_payments.mjs') : null;
  const support = area === 'support' ? await import('./_support.mjs') : null;
  const shop = auth || pay || support ? null : await import('./_shop.mjs');
  const segments = [area, ...rest];
  const known = auth
    ? auth.isAuthRoute(req.method, rest.join('/'))
    : pay
      ? pay.isPaymentRoute(req.method, rest.join('/'))
      : support
        ? support.isSupportRoute(req.method, rest)
        : shop.isShopRoute(req.method, segments);
  if (!known) return false;
  let body;
  try {
    body = req.body; // Vercel parses JSON on first read and throws on malformed or empty input
  } catch {
    body = undefined; // the routes treat this as missing fields
  }
  const request = {
    method: req.method,
    body,
    authorization: req.headers.authorization,
    ip: req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown',
  };
  const result = await (auth
    ? auth.handleAuth({ ...request, rest: rest.join('/') })
    : pay
      ? pay.handlePayments({ ...request, rest: rest.join('/') })
      : support
        ? support.handleSupport({ ...request, rest, params })
        : shop.handleShop({ ...request, segments }));
  Object.entries(result.headers).forEach(([key, value]) => res.setHeader(key, value));
  send(res, result.status, result.body); // never cached: these answers are personal
  return true;
}

const bodyOf = (req) => {
  try {
    return req.body; // Vercel parses JSON on first read and throws on malformed or empty input
  } catch {
    return undefined;
  }
};

// A signed-in shopper, or null: recommendations work without a login, they just aren't personal
async function optionalUser(authorization) {
  if (!authorization) return null;
  const { currentUserId } = await import('./_auth.mjs');
  try {
    return currentUserId(authorization);
  } catch {
    return null;
  }
}

// Recommendations from real demand (api/_recommend.mjs) and the product-view signal behind them. null: not one of these.
async function recommendations(req, area, rest, params) {
  const [first, second, ...extra] = rest;
  if (extra.length) return null;
  const rec = await import('./_recommend.mjs');
  const { query } = await import('./_auth.mjs');
  if (req.method === 'GET' && area === 'recommendations') {
    if (first === 'trending' && !second) return { body: (await rec.trending(query, { k: count(params.k, 12), category: params.category })).items, cacheable: true };
    if (first === 'together' && second) return { body: await rec.together(query, second, count(params.k, 6, 12)), cacheable: true };
    if (first === 'for-you' && !second) {
      const userId = await optionalUser(req.headers.authorization);
      return { body: await rec.forYou(query, { userId, visitor: params.visitor, k: count(params.k, 12) }) }; // personal: never cached
    }
  }
  if (req.method === 'GET' && area === 'ai' && first === 'recommend' && second) return { body: await rec.similar(query, second, count(params.k, 4, 12)), cacheable: true };
  if (req.method === 'POST' && area === 'events' && first === 'view' && !second) {
    const { limit, postgresStore } = await import('./_auth.mjs');
    const body = bodyOf(req) || {};
    try {
      await limit(postgresStore(query), `views:${req.headers['x-real-ip'] || 'unknown'}`, 600, 'Too many requests');
      await rec.recordView(query, { productId: String(body.productId ?? ''), userId: await optionalUser(req.headers.authorization), visitor: String(body.visitor ?? '') });
    } catch (err) {
      if (err.status !== 429) console.error('view not recorded', err.message); // a lost view never breaks the page
    }
    return { status: 204, body: null };
  }
  return null;
}

export default async function handler(req, res) {
  const { path: rawPath = '', ...params } = req.query || {};
  const path = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
  if (req.method === 'HEAD' || req.method === 'OPTIONS') return send(res, 204, null);
  const [area, ...rest] = path.split('/').filter(Boolean);
  if (!['health', 'location', 'payments'].includes(area)) {
    const [{ syncSellerProducts }, { syncCatalogState }] = await Promise.all([import('./_seller.mjs'), import('./_inventory.mjs')]);
    // Sellers' listed products join the catalog; the admin's edits, stock and review ratings apply (each at most every 30 s)
    await Promise.all([syncSellerProducts(), syncCatalogState()]);
  }
  if (area === 'seller') {
    const seller = await import('./_seller.mjs');
    if (seller.isSellerRoute(req.method, rest)) {
      let body;
      try {
        body = req.body;
      } catch {
        body = undefined;
      }
      const result = await seller.handleSeller({ method: req.method, rest, body, params, authorization: req.headers.authorization });
      return send(res, result.status, result.body);
    }
  }
  if (req.method === 'GET' && area === 'location' && rest[0] === 'pincode' && rest.length === 2) {
    const { PINCODE_RE, lookupPincode } = await import('./_location.mjs');
    if (!PINCODE_RE.test(rest[1])) return send(res, 400, { error: 'Please enter a valid 6-digit pincode' });
    const place = await lookupPincode(rest[1]);
    if (place.found !== null) res.setHeader('Cache-Control', 'public, s-maxage=2592000, stale-while-revalidate=86400'); // a month
    return send(res, 200, place, place.found !== null);
  }
  if (req.method === 'GET' && path === 'recommendations/festive') {
    const { festiveStore } = await import('./_demand.mjs');
    const { query } = await import('./_auth.mjs');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600'); // demand moves in minutes, not seconds
    return send(res, 200, await festiveStore(query), true);
  }
  if (area === 'products' && rest[1] === 'reviews') {
    const reviews = await import('./_reviews.mjs');
    if (reviews.isReviewRoute(req.method, rest)) {
      const result = await reviews.handleReviews({ method: req.method, rest, body: bodyOf(req), params, authorization: req.headers.authorization });
      return send(res, result.status, result.body);
    }
  }
  if (['recommendations', 'ai', 'events'].includes(area)) {
    const answer = await recommendations(req, area, rest, params);
    if (answer) return send(res, answer.status ?? 200, answer.body, answer.cacheable);
  }
  const isPersonal = SHOP_AREAS.has(area) || (['auth', 'payments'].includes(area) && rest.join('/') !== 'config');
  if (isPersonal && (await personal(req, res, area, rest, params))) return undefined;
  if (req.method !== 'GET') return send(res, 503, { error: OPENING_SOON });
  const { status = 200, body } = route(path, params);
  return send(res, status, body, status === 200);
}
