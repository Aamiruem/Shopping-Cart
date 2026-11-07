// Store API for the Vercel deployment: every /api/* request lands here (see vercel.json). Catalog reads come from
// products.json and accounts from _auth.mjs. Anything else that needs a database answers 503 with a friendly message,
// which the storefront shows as-is.
import { categories, facets, getProduct, listProducts, popular, similar, subcategories } from './_catalog.mjs';

const OPENING_SOON = 'Arvixa Store is opening soon. Cart and checkout are not available yet.';

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
  return { status: 503, body: { error: OPENING_SOON } };
}

// Loaded on demand: catalog requests stay fast and need none of the account dependencies
async function accounts(req, res, rest) {
  const { handleAuth, isAuthRoute } = await import('./_auth.mjs');
  if (!isAuthRoute(req.method, rest)) return false;
  let body;
  try {
    body = req.body; // Vercel parses JSON on first read and throws on malformed input
  } catch {
    send(res, 400, { error: 'Invalid request' });
    return true;
  }
  const ip = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const result = await handleAuth({ method: req.method, rest, body, ip, authorization: req.headers.authorization });
  Object.entries(result.headers).forEach(([key, value]) => res.setHeader(key, value));
  send(res, result.status, result.body); // never cached: these answers are personal
  return true;
}

export default async function handler(req, res) {
  const { path: rawPath = '', ...params } = req.query || {};
  const path = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
  if (req.method === 'HEAD' || req.method === 'OPTIONS') return send(res, 204, null);
  const [area, ...rest] = path.split('/').filter(Boolean);
  if (area === 'auth' && rest.join('/') !== 'config' && (await accounts(req, res, rest.join('/')))) return undefined;
  if (req.method !== 'GET') return send(res, 503, { error: OPENING_SOON });
  const { status = 200, body } = route(path, params);
  return send(res, status, body, status === 200);
}
