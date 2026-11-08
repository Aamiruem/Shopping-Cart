// Read-only catalog built from backend/app/data/products.json: used by the /api function and the prerender step.
// Filters, sorting and response shapes mirror backend/app/routers/products.py, so the storefront runs unchanged
// against either this or the full FastAPI backend.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATHS = [join(process.cwd(), 'backend/app/data/products.json'), join(HERE, '../backend/app/data/products.json')];

export const CATEGORY_GROUPS = {
  daily: ['grocery', 'kitchen', 'beauty'],
  general: ['mobiles', 'electronics', 'fashion', 'accessories', 'home', 'sports'],
};

// Same value as stable_product_id in backend/app/services/catalog.py: product URLs survive a move to MongoDB
export function stableId(name, occurrence = 0) {
  return createHash('sha1').update(occurrence ? `${name}#${occurrence}` : name).digest('hex').slice(0, 24);
}

export const discountPercent = (price, mrp) => (!mrp || mrp <= price ? 0 : Math.round(((mrp - price) / mrp) * 100));

let cache;
// Listed products from sellers (api/_seller.mjs keeps these fresh), shown after the store's own catalog
let sellerProducts = [];
let merged = null;

export function setSellerProducts(products) {
  sellerProducts = products.map((p) => ({ ...p, discount: discountPercent(p.price, p.mrp), active: true }));
  merged = null;
}

export function loadProducts() {
  if (merged) return merged;
  merged = [...loadBaseProducts(), ...sellerProducts];
  return merged;
}

function loadBaseProducts() {
  if (cache) return cache;
  const file = DATA_PATHS.find((p) => existsSync(p));
  const seen = new Map();
  cache = JSON.parse(readFileSync(file, 'utf8')).map((p) => {
    const occurrence = seen.get(p.name) || 0;
    seen.set(p.name, occurrence + 1);
    const id = stableId(p.name, occurrence);
    return { ...p, _id: id, id, discount: discountPercent(p.price, p.mrp), active: true };
  });
  return cache;
}

const SORTS = {
  relevance: (a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || b.rating - a.rating,
  popularity: (a, b) => b.ratingCount - a.ratingCount,
  price_asc: (a, b) => a.price - b.price,
  price_desc: (a, b) => b.price - a.price,
  rating: (a, b) => b.rating - a.rating,
  newest: (a, b) => b.ratingCount - a.ratingCount, // the static catalog has no dates
};

// "All products" opens with fashion: styles with a 360° view and several photos first, men's and women's alternating
// (unisex joins men's). Only for the unfiltered default listing; every filter and sort keeps its own order.
function fashionFirst(list) {
  const richness = (p) => (p.images360?.length >= 4 ? 2 : 0) + ((p.images?.length || 0) > 1 ? 1 : 0);
  const fashion = list.filter((p) => p.category === 'fashion').sort((a, b) => richness(b) - richness(a) || b.ratingCount - a.ratingCount);
  const women = fashion.filter((p) => p.audience === 'women');
  const men = fashion.filter((p) => p.audience !== 'women');
  const mixed = [];
  for (let i = 0; i < Math.max(women.length, men.length); i += 1) {
    if (men[i]) mixed.push(men[i]);
    if (women[i]) mixed.push(women[i]);
  }
  return [...mixed, ...list.filter((p) => p.category !== 'fashion')];
}

const textOf = (p) => [p.name, p.brand, p.category, p.subCategory, ...(p.tags || [])].join(' ').toLowerCase();

function baseFilter({ q, category, audience, use }) {
  const needle = (q || '').trim().toLowerCase();
  const group = CATEGORY_GROUPS[use];
  return (p) =>
    (!needle || textOf(p).includes(needle)) &&
    (category ? p.category === category : !group || group.includes(p.category)) &&
    (!['women', 'men'].includes(audience) || [audience, 'unisex'].includes(p.audience));
}

const number = (v) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const anyOf = (values, list) => !list || list.split(',').some((v) => (values || []).includes(v));

export function listProducts(params = {}) {
  const { q, subCategory, size, color, ageGroup, brand, featured, sort = 'relevance' } = params;
  const low = number(params.minPrice);
  const high = number(params.maxPrice);
  const minRating = number(params.minRating);
  const base = baseFilter(params);
  const brands = brand ? brand.split(',') : null;
  const found = loadProducts().filter(
    (p) =>
      base(p) &&
      (!subCategory || p.subCategory === subCategory) &&
      anyOf(p.sizes, size) &&
      anyOf(p.colors, color) &&
      anyOf(p.ageGroups, ageGroup) &&
      (!brands || brands.includes(p.brand)) &&
      (low === null || p.price >= low) &&
      (high === null || p.price <= high) &&
      (minRating === null || p.rating >= minRating) &&
      (featured !== 'true' || p.featured === true),
  );
  const order = SORTS[sort] || SORTS.relevance;
  // Search ranks name matches first, so "lay" finds Lay's before products that only mention it in a tag
  const needle = (q || '').trim().toLowerCase();
  const rank = (p) => (needle && sort === 'relevance' && !p.name.toLowerCase().includes(needle) ? 1 : 0);
  const limit = Math.max(1, Math.min(Number(params.limit) || 200, 200));
  // skip pages through long lists ("Load more"); the response stays a plain array
  const skip = Math.max(0, Math.min(Math.trunc(Number(params.skip)) || 0, 5000));
  const sorted = found.sort((a, b) => rank(a) - rank(b) || order(a, b));
  const unfiltered = sort === 'relevance' && !needle && !params.category && !params.use && !subCategory && !brand && featured !== 'true'
    && low === null && high === null && minRating === null;
  return (unfiltered ? fashionFirst(sorted) : sorted).slice(skip, skip + limit);
}

export const getProduct = (id) => loadProducts().find((p) => p._id === id) || null;

function groupCovers(products, key, order) {
  const groups = new Map();
  [...products].sort(order).forEach((p) => {
    if (!p[key]) return;
    const group = groups.get(p[key]) || { id: p[key], count: 0, image: p.image };
    group.count += 1;
    groups.set(p[key], group);
  });
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const categories = () => groupCovers(loadProducts(), 'category', SORTS.rating);
export const subcategories = (category) => groupCovers(loadProducts().filter((p) => p.category === category), 'subCategory', SORTS.popularity);

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', 'Free Size'];
function compareSizes(a, b) {
  const rank = (s) => (SIZE_ORDER.includes(s) ? [0, SIZE_ORDER.indexOf(s)] : Number.isNaN(Number(s)) ? [2, 0] : [1, Number(s)]);
  const [x, y] = [rank(a), rank(b)];
  return x[0] - y[0] || x[1] - y[1];
}

export function facets(params = {}) {
  const found = loadProducts().filter(baseFilter(params));
  const unique = (values) => [...new Set(values.filter(Boolean))];
  const prices = found.map((p) => p.price);
  return {
    brands: unique(found.map((p) => p.brand)).sort(),
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    sizes: unique(found.flatMap((p) => p.sizes || [])).sort(compareSizes),
    colors: unique(found.flatMap((p) => p.colors || [])).sort(),
  };
}

export const popular = (k = 12, category) =>
  loadProducts().filter((p) => p.stock > 0 && (!category || p.category === category)).sort(SORTS.popularity).slice(0, k);

// "Customers also viewed" stand-in: popular products from the same category, without the product itself
export function similar(id, k = 8) {
  const product = getProduct(id);
  if (!product) return [];
  return popular(k + 1, product.category).filter((p) => p._id !== id).slice(0, k);
}
