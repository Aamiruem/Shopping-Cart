// Run with: npm test (from frontend/). Covers the read-only store API used in preview mode.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { facets, listProducts, loadProducts, similar, stableId } from '../../api/_catalog.mjs';
import { route } from '../../api/catalog.mjs';

test('every product has a unique, Mongo-compatible id', () => {
  const ids = loadProducts().map((p) => p._id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[0-9a-f]{24}$/.test(id)));
});

test('ids match the backend seed (backend/app/services/catalog.py stable_product_id)', () => {
  assert.equal(stableId('Rolex Cellini Moonphase'), '237c9d07351f778f746dd905');
  assert.notEqual(stableId('Rolex Cellini Moonphase', 1), stableId('Rolex Cellini Moonphase'));
});

test('filters by category, audience, use and price', () => {
  assert.ok(listProducts({ category: 'mobiles' }).every((p) => p.category === 'mobiles'));
  assert.ok(listProducts({ category: 'fashion', audience: 'women' }).every((p) => ['women', 'unisex'].includes(p.audience)));
  assert.ok(listProducts({ use: 'daily' }).every((p) => ['grocery', 'kitchen', 'beauty'].includes(p.category)));
  assert.ok(listProducts({ minPrice: '100', maxPrice: '500' }).every((p) => p.price >= 100 && p.price <= 500));
});

test('sorts, and caps the result size like the real API', () => {
  const prices = listProducts({ sort: 'price_asc' }).map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.equal(listProducts({ limit: '1000' }).length, 200);
  assert.equal(listProducts({ limit: '3' }).length, 3);
});

test('search puts name matches first', () => {
  const [first] = listProducts({ q: 'lay' });
  assert.match(first.name.toLowerCase(), /lay/);
  assert.deepEqual(listProducts({ q: 'zzzz-no-such-product' }), []);
});

test('facets describe the matching products', () => {
  const result = facets({ category: 'mobiles' });
  assert.ok(result.brands.includes('Apple'));
  assert.ok(result.minPrice > 0 && result.minPrice <= result.maxPrice);
});

test('similar products share the category and exclude the product itself', () => {
  const [product] = listProducts({ category: 'beauty' });
  const items = similar(product._id, 4);
  assert.equal(items.length, 4);
  assert.ok(items.every((p) => p.category === 'beauty' && p._id !== product._id));
});

test('routes answer like the real API', () => {
  const [product] = listProducts({ limit: '1' });
  assert.equal(route(`products/${product._id}`).body.name, product.name);
  assert.equal(route('products/not-a-product').status, 404);
  assert.ok(Array.isArray(route('products/categories').body));
  assert.equal(route('recommendations/for-you').body.strategy, 'trending');
  assert.ok(Array.isArray(route(`recommendations/together/${product._id}`).body.items));
  assert.deepEqual(route('auth/config').body, { googleClientId: null });
});

test('anything needing an account answers 503 with a readable message', () => {
  const [product] = listProducts({ limit: '1' });
  for (const path of ['cart', 'orders', 'auth/me', 'wishlist', 'seller/products', `products/${product._id}/reviews`]) {
    const { status, body } = route(path);
    assert.equal(status, 503);
    assert.match(body.error, /opening soon/i);
  }
});

test('paging with skip reaches every product exactly once', () => {
  const seen = [];
  for (let skip = 0; ; skip += 48) {
    const page = listProducts({ limit: 48, skip });
    seen.push(...page.map((p) => p._id));
    if (page.length < 48) break;
  }
  assert.equal(seen.length, loadProducts().length);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(listProducts({ limit: 5, skip: 'abc' })[0]._id, listProducts({ limit: 5 })[0]._id); // bad skip = start
});
