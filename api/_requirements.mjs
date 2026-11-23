// Reads what a shopper wants from plain words, in English or Hinglish: budget, category, brand and what it's for.
// Used by the shopping assistant (api/_assistant.mjs) to search the real catalog, and by lead scoring (api/_leads.mjs).
// Rules, not a model: they're fast, free, testable, and they never invent a requirement that wasn't written.
import { loadProducts } from './_catalog.mjs';

// Words that point at a catalog category, and optionally a sub-category. Checked longest phrase first.
const CATEGORY_WORDS = [
  ['electronics', 'laptops', ['laptop', 'laptops', 'notebook', 'macbook', 'ultrabook']],
  ['electronics', 'tablets', ['tablet', 'ipad', 'tab ']],
  ['electronics', 'audio', ['headphone', 'headphones', 'earbuds', 'earphones', 'speaker', 'speakers', 'soundbar', 'neckband']],
  ['electronics', 'wearables', ['smartwatch', 'smart watch', 'fitness band', 'fitness tracker']],
  ['electronics', 'cameras', ['camera', 'dslr', 'webcam']],
  ['electronics', 'gaming', ['gaming console', 'console', 'controller', 'playstation', 'xbox']],
  ['electronics', 'storage', ['pendrive', 'pen drive', 'hard disk', 'ssd', 'memory card']],
  ['electronics', null, ['electronics', 'gadget', 'charger', 'power bank', 'keyboard', 'mouse', 'router', 'tv', 'television', 'iron', 'trimmer']],
  ['mobiles', 'smartphones', ['smartphone', 'mobile', 'phone', 'iphone', 'android', 'फोन', 'मोबाइल']],
  ['fashion', 'footwear', ['shoes', 'shoe', 'sneakers', 'sandals', 'slippers', 'heels', 'joote', 'chappal']],
  ['fashion', null, ['shirt', 'tshirt', 't-shirt', 'jeans', 'dress', 'kurta', 'saree', 'sari', 'jacket', 'hoodie', 'sweater', 'top', 'trousers', 'clothes', 'kapde', 'kapda', 'fashion']],
  ['accessories', null, ['watch', 'bag', 'handbag', 'backpack', 'wallet', 'sunglasses', 'jewellery', 'jewelry', 'earrings', 'necklace', 'cap', 'ghadi']],
  ['beauty', null, ['lipstick', 'mascara', 'perfume', 'fragrance', 'cream', 'moisturiser', 'moisturizer', 'face wash', 'shampoo', 'skincare', 'skin care', 'makeup', 'serum', 'sunscreen']],
  ['kitchen', null, ['cookware', 'pan', 'kadai', 'pressure cooker', 'mixer', 'grinder', 'kettle', 'utensil', 'utensils', 'kitchen']],
  ['home', null, ['sofa', 'bed', 'furniture', 'decor', 'lamp', 'curtain', 'bedsheet', 'cushion', 'table', 'chair']],
  ['sports', null, ['cricket', 'football', 'badminton', 'yoga', 'gym', 'dumbbell', 'fitness', 'cycling', 'sports']],
  ['grocery', null, ['grocery', 'snacks', 'chips', 'atta', 'rice', 'dal', 'oil', 'ghee', 'tea', 'coffee', 'biscuits', 'fruits', 'vegetables', 'sabzi', 'masala']],
];

// What a product is for, mapped to words found in product names, tags and descriptions
const USE_HINTS = {
  'machine learning': ['gpu', 'nvidia', 'rtx', 'ram', 'processor', 'pro', 'performance'],
  'gaming': ['gaming', 'gpu', 'rtx', 'high refresh', 'performance'],
  'programming': ['ram', 'processor', 'pro', 'performance'],
  'video editing': ['gpu', 'display', 'pro', 'performance'],
  'office': ['lightweight', 'battery', 'business'],
  'college': ['lightweight', 'battery', 'budget'],
  'students': ['lightweight', 'battery', 'budget'],
  'running': ['running', 'sports', 'lightweight'],
  'gym': ['gym', 'fitness', 'training'],
  'travel': ['travel', 'lightweight', 'portable'],
  'party': ['party', 'festive'],
  'wedding': ['wedding', 'ethnic', 'festive'],
  'gift': ['gift'],
  'photography': ['camera', 'lens'],
};

const NUMBER = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|hazaar|hazar|l|lakh|lac|lakhs)?`;
const CURRENCY = String.raw`(?:₹|rs\.?|inr|rupees?)?\s*`;

function amount(digits, unit = '') {
  const n = Number(String(digits).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = unit.toLowerCase();
  if (['k', 'thousand', 'hazaar', 'hazar'].includes(u)) return Math.round(n * 1000);
  if (['l', 'lakh', 'lac', 'lakhs'].includes(u)) return Math.round(n * 100000);
  return n;
}

/** { min, max } in rupees from "under ₹70,000", "between 20k and 30k", "5000 se kam", "1.5 lakh tak"; nulls if none. */
export function parseBudget(message) {
  const t = ` ${message.toLowerCase()} `;
  const range = t.match(new RegExp(String.raw`(?:between|from)\s*${CURRENCY}${NUMBER}\s*(?:and|to|-)\s*${CURRENCY}${NUMBER}`));
  if (range) {
    const a = amount(range[1], range[2] || range[4]);
    const b = amount(range[3], range[4]);
    if (a && b) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const below = t.match(new RegExp(String.raw`(?:under|below|less than|within|upto|up to|max(?:imum)?|budget(?: of| is)?|not more than|around|about|approx\.?)\s*${CURRENCY}${NUMBER}`));
  if (below) {
    const max = amount(below[1], below[2]);
    // "around 20k" is a target, not a cap: allow 15% either way
    return /around|about|approx/.test(below[0]) ? { min: Math.round(max * 0.85), max: Math.round(max * 1.15) } : { min: null, max };
  }
  const hindi = t.match(new RegExp(String.raw`${CURRENCY}${NUMBER}\s*(?:se kam|tak|ke andar|ke under|ke niche|ke neeche|से कम|तक)`));
  if (hindi) return { min: null, max: amount(hindi[1], hindi[2]) };
  const above = t.match(new RegExp(String.raw`(?:above|over|more than|at least|minimum)\s*${CURRENCY}${NUMBER}`));
  if (above) return { min: amount(above[1], above[2]), max: null };
  const plain = t.match(new RegExp(String.raw`(?:₹|rs\.?|inr)\s*${NUMBER}`));
  if (plain) return { min: null, max: amount(plain[1], plain[2]) };
  return { min: null, max: null };
}

const has = (t, word) => new RegExp(`(^|[^\\p{L}])${word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(t);

let brandList = null;
const brands = () => (brandList ??= [...new Set(loadProducts().map((p) => p.brand).filter(Boolean))].sort((a, b) => b.length - a.length));

/** Everything the message says about what the shopper wants. Fields are null when not mentioned. */
export function parseRequirements(message) {
  const t = String(message || '').toLowerCase().slice(0, 1000);
  let category = null;
  let subCategory = null;
  let product = null;
  for (const [cat, sub, words] of CATEGORY_WORDS) {
    const word = words.find((w) => has(t, w));
    if (word) {
      category = cat;
      subCategory = sub;
      product = word.trim();
      break;
    }
  }
  const brand = brands().find((b) => b.length > 2 && has(t, b.toLowerCase())) ?? null;
  const useMatch = t.match(/\bfor (?:my |a |an |the )?([a-z][a-z -]{2,30}?)(?=\s+(?:under|below|within|upto|up to|around|between|budget|with|that|which|and|in|at)\b|[,.?!]|$)/);
  let use = Object.keys(USE_HINTS).find((u) => has(t, u)) ?? null;
  if (!use && useMatch && !/^(me|you|him|her|them|us|sale|delivery|cod|cash)$/.test(useMatch[1].trim())) use = useMatch[1].trim();
  const budget = parseBudget(t);
  return { category, subCategory, product, brand, use, budgetMin: budget.min, budgetMax: budget.max };
}

const searchText = (p) => [p.name, p.brand, p.category, p.subCategory, ...(p.tags || []), p.description].join(' ').toLowerCase();

/**
 * Real, in-stock products that fit the requirements, best match first, and what was relaxed to find them.
 * Never stretches the budget silently: when nothing fits, `closest` holds the nearest options above it.
 */
export function findProducts(req, { k = 5, terms = [] } = {}) {
  const words = [...terms, req.product, req.brand, ...(req.use ? [req.use, ...(USE_HINTS[req.use] || [])] : [])]
    .filter(Boolean)
    .map((w) => String(w).toLowerCase());
  const fits = (p) =>
    (p.stock ?? 0) > 0 &&
    (!req.category || p.category === req.category) &&
    (!req.subCategory || p.subCategory === req.subCategory) &&
    (!req.brand || p.brand === req.brand);
  const score = (p) => {
    const text = searchText(p);
    return words.reduce((s, w) => s + (text.includes(w) ? (p.name.toLowerCase().includes(w) ? 3 : 1) : 0), 0) + (p.reviewRating ?? 0) / 10;
  };
  const all = loadProducts().filter(fits);
  // A named product ("lipstick") narrows to products that are one, when there are any, rather than padding with the category
  const named = req.product ? all.filter((p) => searchText(p).includes(req.product)) : [];
  const pool = named.length ? named : all;
  const inBudget = pool.filter((p) => (req.budgetMax == null || p.price <= req.budgetMax) && (req.budgetMin == null || p.price >= req.budgetMin));
  const ranked = (list) => list.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s || b.p.ratingCount - a.p.ratingCount).map((x) => x.p);
  const matches = ranked(inBudget).slice(0, k);
  const closest = matches.length || req.budgetMax == null ? [] : pool.filter((p) => p.price > req.budgetMax).sort((a, b) => a.price - b.price).slice(0, 3);
  return { matches, closest };
}

/** The fields a shopper or the assistant may see: real values from the catalog, nothing derived or estimated. */
export function productCard(p) {
  return {
    id: p._id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    price: p.price,
    mrp: p.mrp,
    inStock: (p.stock ?? 0) > 0,
    stock: Math.min(p.stock ?? 0, 10), // "only a few left" without exposing the warehouse count
    image: p.image,
    rating: p.reviewCount ? { average: p.reviewRating, count: p.reviewCount } : null, // verified-buyer reviews only
    url: `/products/${p._id}`,
  };
}
