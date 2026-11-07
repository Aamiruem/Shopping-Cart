// Read-only store API for preview mode: every /api/* request lands here (see vercel.json). Anything that needs an
// account or a database answers 503 with a friendly message, which the storefront shows as-is.
import { categories, facets, getProduct, listProducts, popular, similar, subcategories } from './_catalog.mjs';

const OPENING_SOON = 'Arvixa Store is opening soon. Accounts, cart and checkout are not available yet.';

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

export default function handler(req, res) {
  const { path = '', ...params } = req.query || {};
  if (req.method === 'HEAD' || req.method === 'OPTIONS') return send(res, 204, null);
  if (req.method !== 'GET') return send(res, 503, { error: OPENING_SOON });
  const { status = 200, body } = route(Array.isArray(path) ? path.join('/') : path, params);
  return send(res, status, body, status === 200);
}
