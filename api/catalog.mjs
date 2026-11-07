// Store API for the Vercel deployment: every /api/* request lands here (see vercel.json). Catalog reads come from
// products.json, accounts from _auth.mjs and shopping from _shop.mjs. Anything the full API alone can do answers 503
// with a friendly message, which the storefront shows as-is.
import { categories, facets, getProduct, listProducts, popular, similar, subcategories } from './_catalog.mjs';

const OPENING_SOON = 'This part of Arvixa Store is opening soon.';
const SHOP_AREAS = new Set(['cart', 'wishlist', 'addresses', 'orders']);

const send = (res, status, body, cacheable = false) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheable ? 'public, s-maxage=3600, stale-while-revalidate=86400' : 'no-store');
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
  if (area === 'payments' && first === 'config') return { body: { enabled: false } }; // no Razorpay keys yet: cash on delivery
  return { status: 503, body: { error: OPENING_SOON } };
}

// Account and shopping routes. Loaded on demand: catalog requests stay fast and need none of their dependencies.
async function personal(req, res, area, rest) {
  const auth = area === 'auth' ? await import('./_auth.mjs') : null;
  const shop = auth ? null : await import('./_shop.mjs');
  const segments = [area, ...rest];
  if (auth ? !auth.isAuthRoute(req.method, rest.join('/')) : !shop.isShopRoute(req.method, segments)) return false;
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
  const result = await (auth ? auth.handleAuth({ ...request, rest: rest.join('/') }) : shop.handleShop({ ...request, segments }));
  Object.entries(result.headers).forEach(([key, value]) => res.setHeader(key, value));
  send(res, result.status, result.body); // never cached: these answers are personal
  return true;
}

export default async function handler(req, res) {
  const { path: rawPath = '', ...params } = req.query || {};
  const path = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
  if (req.method === 'HEAD' || req.method === 'OPTIONS') return send(res, 204, null);
  const [area, ...rest] = path.split('/').filter(Boolean);
  const isPersonal = SHOP_AREAS.has(area) || (area === 'auth' && rest.join('/') !== 'config');
  if (isPersonal && (await personal(req, res, area, rest))) return undefined;
  if (req.method !== 'GET') return send(res, 503, { error: OPENING_SOON });
  const { status = 200, body } = route(path, params);
  return send(res, status, body, status === 200);
}
