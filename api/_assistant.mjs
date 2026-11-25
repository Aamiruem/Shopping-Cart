// Shopping assistant for the store API: POST /api/ai/ask { question } and POST /api/ai/agent { messages }.
//
// Grounded by construction: every product, price and stock figure comes from the live catalog (after the admin's
// edits, seller listings and sold stock are applied), policy answers come from the same constants checkout and
// returns use, and order answers come from the shopper's own rows. Nothing is generated, so it can't invent an offer,
// a price or a delivery date, and a prompt-injection attempt is just a search that finds nothing.
//
// Understands: product searches with a budget or range ("wireless headphones under ₹3,000", "laptop between 50k and
// 1 lakh"), cheapest / best-rated ordering, men's / women's, comparisons ("compare X vs Y"), follow-ups that refine the
// previous search ("cheaper", "under 2000"), order status (signed in), returns, refunds, delivery, payment,
// cancellation, sizes, coupons and handing over to a person. A little Hinglish ("5000 tak", "sasta", "joote").
import { ApiError, currentUserId, limit, postgresStore, query, safely } from './_auth.mjs';
import { getProduct, loadProducts } from './_catalog.mjs';
import { extractBudget } from './_leads.mjs';
import { paymentsConfig } from './_payment-config.mjs';
import { RETURN_WINDOW_DAYS } from './_returns.mjs';
import { DELIVERY_FEE, FREE_DELIVERY_ABOVE } from './_shop.mjs';

const MAX_CHARS = 500;
const MAX_TURNS = 12;
const PER_WINDOW = 120; // messages per visitor per 15 minutes
const CARDS = 4;

const rupees = (n) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;
const UNIT = { k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5 };
const amount = (digits, unit) => Number(String(digits).replace(/,/g, '')) * (UNIT[(unit || '').toLowerCase()] || 1);
const NUM = String.raw`(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?)?`;

/** The price range a message asks for: { min, max } (either may be null). */
export function priceRange(message) {
  const lower = message.toLowerCase();
  const between = lower.match(new RegExp(String.raw`(?:between|from)\s*${NUM}\s*(?:and|to|-)\s*${NUM}`));
  if (between) {
    const [a, b] = [amount(between[1], between[2] || between[4]), amount(between[3], between[4])];
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const above = lower.match(new RegExp(String.raw`(?:above|over|more than|at least|min(?:imum)?|starting(?: from| at)?)\s*${NUM}`));
  const hinglish = lower.match(new RegExp(String.raw`${NUM}\s*(?:tak|se kam|ke andar|ke niche)`));
  const max = hinglish ? amount(hinglish[1], hinglish[2]) : extractBudget(message.replace(/(?:above|over|more than|at least|min(?:imum)?)\s*(?:₹|rs\.?|inr)?\s*[\d,]+\s*(?:k|thousand|lakhs?|lacs?)?/gi, ''));
  return { min: above ? amount(above[1], above[2]) : null, max };
}

// Words that name a kind of product but don't appear in the catalog's own category names
const SYNONYMS = {
  headphone: ['audio'], headphones: ['audio'], earphone: ['audio'], earphones: ['audio'], earbud: ['audio'], earbuds: ['audio'],
  speaker: ['audio'], speakers: ['audio'], headset: ['audio', 'gaming'],
  phone: ['smartphones'], phones: ['smartphones'], mobile: ['smartphones'], mobiles: ['smartphones'], iphone: ['smartphones'],
  notebook: ['laptops'], macbook: ['laptops'], computer: ['laptops', 'computer-accessories'],
  watch: ['mens-watches', 'womens-watches', 'wearables'], watches: ['mens-watches', 'womens-watches', 'wearables'], smartwatch: ['wearables'],
  perfume: ['fragrances'], perfumes: ['fragrances'], scent: ['fragrances'],
  shoe: ['mens-shoes', 'womens-shoes', 'footwear'], shoes: ['mens-shoes', 'womens-shoes', 'footwear'], sneakers: ['footwear', 'mens-shoes', 'womens-shoes'],
  joote: ['mens-shoes', 'womens-shoes', 'footwear'], joota: ['mens-shoes', 'womens-shoes', 'footwear'], chappal: ['footwear'], sandals: ['footwear'],
  tshirt: ['mens-tshirts'], 't-shirt': ['mens-tshirts'], tee: ['mens-tshirts'], shirt: ['mens-shirts'], shirts: ['mens-shirts'],
  kurta: ['mens-ethnic', 'womens-ethnic'], saree: ['womens-ethnic'], sari: ['womens-ethnic'], ethnic: ['mens-ethnic', 'womens-ethnic'],
  dress: ['womens-dresses'], dresses: ['womens-dresses'], jeans: ['mens-jeans', 'mens-bottomwear', 'womens-bottomwear'], trousers: ['mens-bottomwear', 'womens-bottomwear'],
  jacket: ['mens-jackets', 'womens-jackets', 'mens-winterwear', 'womens-winterwear', 'rainwear'], raincoat: ['rainwear'], sweater: ['mens-winterwear', 'womens-winterwear'], hoodie: ['mens-winterwear', 'womens-winterwear'],
  bag: ['womens-bags', 'bags'], handbag: ['womens-bags'], backpack: ['bags'], jewellery: ['womens-jewellery'], jewelry: ['womens-jewellery'], necklace: ['womens-jewellery'], earrings: ['womens-jewellery'],
  sunglass: ['sunglasses'], cap: ['caps-hats'], hat: ['caps-hats'],
  camera: ['cameras'], tablet: ['tablets'], ipad: ['tablets'], charger: ['mobile-accessories'], cable: ['mobile-accessories', 'computer-accessories'], powerbank: ['mobile-accessories'],
  mouse: ['computer-accessories'], keyboard: ['computer-accessories'], router: ['networking'], wifi: ['networking'], pendrive: ['storage'], ssd: ['storage'], 'hard-disk': ['storage'],
  trimmer: ['personal-care-appliances'], dryer: ['personal-care-appliances'], bulb: ['lighting'], lamp: ['lighting', 'home-decoration'],
  mixer: ['kitchen-appliances'], kettle: ['kitchen-appliances'], pan: ['cookware'], cooker: ['cookware', 'kitchen-appliances'],
  sofa: ['furniture'], chair: ['furniture'], table: ['furniture'], bed: ['furniture'],
  shampoo: ['hair-care'], soap: ['bath-body'], toothpaste: ['oral-care'], cream: ['skin-care'], moisturizer: ['skin-care'], sunscreen: ['skin-care'], lipstick: ['beauty'], makeup: ['beauty'],
  chips: ['snacks'], biscuit: ['snacks'], biscuits: ['snacks'], chocolate: ['snacks', 'breakfast-spreads'], tea: ['tea-coffee-drinks'], coffee: ['tea-coffee-drinks'], juice: ['tea-coffee-drinks'],
  milk: ['dairy-bread-eggs'], bread: ['dairy-bread-eggs'], eggs: ['dairy-bread-eggs'], rice: ['atta-rice-dal'], atta: ['atta-rice-dal'], dal: ['atta-rice-dal'], oil: ['oil-ghee-masala'], ghee: ['oil-ghee-masala'],
  fruit: ['fruits-vegetables'], fruits: ['fruits-vegetables'], vegetables: ['fruits-vegetables'], sabzi: ['fruits-vegetables'], nuts: ['dry-fruits-health'],
  cricket: ['sports-accessories'], football: ['sports-accessories'], gym: ['sports-accessories'], yoga: ['sports-accessories'],
};
// Category words too broad to pick a shelf on their own ("men", "home") or that are part of every product's name
const GENERIC = new Set(['mens', 'men', 'womens', 'women', 'accessories', 'accessory', 'home', 'essentials', 'care', 'appliances', 'appliance', 'and', 'body', 'bath', 'health', 'drinks', 'food']);
const STOPWORDS = new Set(
  ('the and for with need want wants looking look show find give get under below above over budget please price buy have you your this that what which can are any good ' +
    'best some from about also will would like into than more less inr rupees around within upto hello thanks thank kya hai chahiye mujhe liye mein koi dikhao ' +
    'plz pls something thing things available stock help much how there their them they just only very really lakh lakhs thousand one two three ' +
    'cheap cheaper cheapest affordable budget lowest low top rated rating recommend recommendation suggest suggestion options option between tak kam sasta saste ' +
    'compare comparison versus difference better product products item items quality nice great new latest men women mens womens man woman boys girls kids').split(' '),
);

// Plural to singular, the same on both sides: shoes -> shoe, watches -> watch, accessories -> accessory
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const tokens = (s) => String(s).toLowerCase().replace(/[’']/g, '').match(/[a-z][a-z0-9-]*/g) || [];
const wordsOf = (s) => new Set(tokens(s).map(stem));

const productText = new WeakMap();
function textOfProduct(p) {
  let t = productText.get(p);
  if (!t) {
    t = {
      name: wordsOf(p.name),
      meta: wordsOf(`${p.brand || ''} ${(p.tags || []).join(' ')} ${p.category} ${(p.subCategory || '').replace(/-/g, ' ')}`),
      description: wordsOf(p.description || ''),
    };
    productText.set(p, t);
  }
  return t;
}

/** The shelves (sub-categories) a message is about, from catalog names and the synonyms above. */
function shelvesFor(words, products) {
  const shelves = new Set();
  const known = new Set(products.map((p) => p.subCategory).filter(Boolean));
  for (const w of words) {
    (SYNONYMS[w] || SYNONYMS[stem(w)] || []).forEach((s) => known.has(s) && shelves.add(s));
    if (GENERIC.has(w)) continue;
    for (const sub of known) {
      if (sub.split('-').some((part) => !GENERIC.has(part) && stem(part) === stem(w))) shelves.add(sub);
    }
  }
  return shelves;
}

const AUDIENCE = { men: ['men', 'unisex'], women: ['women', 'unisex'] };
function audienceOf(lower) {
  if (/\b(women|womens|woman|ladies|lady|girls?|her|wife|mom|mother|sister)\b|women['’]s/.test(lower)) return 'women';
  if (/\b(men|mens|man|gents|boys?|him|husband|dad|father|brother)\b|men['’]s/.test(lower)) return 'men';
  return null;
}
const shelfAudience = (sub) => (sub?.startsWith('womens-') ? 'women' : sub?.startsWith('mens-') ? 'men' : null);

/**
 * Catalog products for a message: { products, shelves, range, nearest } where nearest are the closest in-stock
 * products on the same shelves when nothing fits the price range.
 */
export function searchCatalog(message, { k = CARDS } = {}) {
  const lower = message.toLowerCase();
  const all = loadProducts().filter((p) => p.active !== false);
  const words = [...new Set(tokens(lower))].filter((w) => !STOPWORDS.has(w) && !/^\d/.test(w));
  const range = priceRange(message);
  const audience = audienceOf(lower);
  let shelves = shelvesFor(words, all);
  if (audience && shelves.size > 1) {
    const forAudience = [...shelves].filter((s) => [audience, null].includes(shelfAudience(s)));
    if (forAudience.length) shelves = new Set(forAudience);
  }
  const shelfWords = new Set([...shelves].flatMap((s) => s.split('-').map(stem)));
  // Synonyms still count as words: "earbuds" picks the audio shelf and then ranks earbuds above speakers
  const featureWords = words.map(stem).filter((w) => !shelfWords.has(w));

  const scored = all
    .filter((p) => (!shelves.size || shelves.has(p.subCategory)) && (!audience || p.category !== 'fashion' || !p.audience || AUDIENCE[audience].includes(p.audience)))
    .map((p) => {
      const t = textOfProduct(p);
      // The kind of product in its name ("earbuds", "headphones") counts most, then any other word in its name
      const inName = (w) => (SYNONYMS[w] ? 5 : 3);
      const score = (shelves.size ? 3 : 0) + featureWords.reduce((s, w) => s + (t.name.has(w) ? inName(w) : t.meta.has(w) ? 2 : t.description.has(w) ? 1 : 0), 0);
      return { p, score };
    })
    .filter((x) => x.score >= 3);

  const cheapFirst = /\b(cheap|cheaper|cheapest|affordable|budget|lowest|sasta|saste|kam daam)\b/.test(lower);
  const topRated = /\b(best|top|highest|top-rated|rated|popular)\b/.test(lower);
  const order = (a, b) =>
    b.score - a.score ||
    (cheapFirst ? a.p.price - b.p.price : 0) ||
    (topRated ? (b.p.rating || 0) - (a.p.rating || 0) : 0) ||
    (b.p.ratingCount || 0) - (a.p.ratingCount || 0);
  const inStock = scored.filter((x) => x.p.stock > 0);
  const fits = inStock.filter((x) => (range.min === null || x.p.price >= range.min) && (range.max === null || x.p.price <= range.max));
  const products = fits.sort(order).map((x) => x.p).slice(0, k);
  let nearest = [];
  if (!products.length && inStock.length && (range.min !== null || range.max !== null)) {
    const gap = (p) => (range.max !== null && p.price > range.max ? p.price - range.max : range.min !== null && p.price < range.min ? range.min - p.price : 0);
    nearest = inStock.map((x) => x.p).sort((a, b) => gap(a) - gap(b)).slice(0, k);
  }
  return { products, shelves: [...shelves], range, nearest, words: featureWords };
}

/** The fields a product card in the chat needs: all live catalog values. */
export const card = (p) => ({
  _id: p._id,
  name: p.name,
  brand: p.brand || null,
  price: p.price,
  mrp: p.mrp || null,
  discount: p.discount || 0,
  image: p.image,
  rating: p.rating ?? null,
  ratingCount: p.ratingCount ?? 0,
  stock: p.stock,
  category: p.category,
  sizes: p.sizes || [],
});

const shelfName = (s) => s.replace(/^(mens|womens)-/, (m) => (m === 'mens-' ? "men's " : "women's ")).replace(/-/g, ' ');
const describeRange = ({ min, max }) =>
  min !== null && max !== null ? `between ${rupees(min)} and ${rupees(max)}` : max !== null ? `under ${rupees(max)}` : min !== null ? `above ${rupees(min)}` : '';
const stockNote = (p) => (p.stock <= 5 ? ` (only ${p.stock} left)` : '');
const line = (p, i) => `${i + 1}. ${p.name}${p.brand ? ` by ${p.brand}` : ''}: ${rupees(p.price)}${p.mrp > p.price ? ` (MRP ${rupees(p.mrp)}, ${p.discount}% off)` : ''}${stockNote(p)}`;

const has = (lower, list) => list.some((w) => (w.includes(' ') ? lower.includes(w) : new RegExp(`\\b${w}\\b`).test(lower)));

const INTENTS = [
  ['human', ['human', 'agent', 'person', 'representative', 'customer care', 'call me', 'complaint', 'complain', 'talk to someone', 'speak to', 'escalate', 'not helpful']],
  ['order', ['my order', 'my orders', 'order status', 'track', 'tracking', 'where is my', 'when will my', 'delivered yet', 'shipped yet', 'order kab', 'mera order']],
  ['cancel', ['cancel', 'cancellation']],
  ['return', ['return', 'returns', 'refund', 'refunds', 'exchange', 'replace', 'replacement', 'damaged', 'defective', 'wrong item']],
  ['payment', ['payment', 'pay', 'upi', 'card', 'cod', 'cash on delivery', 'net banking', 'netbanking', 'emi', 'wallet', 'razorpay']],
  ['delivery', ['delivery', 'deliver', 'shipping', 'ship', 'courier', 'pincode', 'dispatch']],
  ['coupon', ['coupon', 'promo', 'promo code', 'voucher', 'discount code', 'offer code']],
  ['size', ['size', 'sizes', 'fit', 'size chart']],
  ['greeting', ['hi', 'hello', 'hey', 'namaste', 'hii', 'good morning', 'good evening']],
];
// Product features that read like support words: "noise cancellation" is not about cancelling an order
const FEATURE_PHRASES = /(noise[- ]cancell?(?:ation|ing)|anc|memory card|card reader|card holder|return gift|cash box|payment terminal)/g;
const SHOPPING_INTENTS = new Set(['cancel', 'return', 'payment', 'delivery']);
// About the store rather than a product: "how do returns work", "my order", "delivery charges"
const ABOUT_STORE = /(order|orders|policy|policies|how|can i|do you|is there|charges?|fee|fees|days?|time|available|accept|option)/;
function intentOf(lower, { productWords = false } = {}) {
  const plain = lower.replace(FEATURE_PHRASES, ' ');
  const intent = INTENTS.find(([, words]) => has(plain, words))?.[0] || null;
  // "wireless earphones cash on delivery?" is about payment; "return gift for kids under 500" is a search
  if (SHOPPING_INTENTS.has(intent) && productWords && !ABOUT_STORE.test(plain)) return null;
  return intent;
}

const SUGGESTIONS = ['Wireless earbuds under ₹3,000', 'Best-rated laptops', "Women's ethnic wear under ₹2,000", 'Where is my order?', 'Return policy'];

function policy(intent) {
  const pay = paymentsConfig();
  switch (intent) {
    case 'return':
      return `You can return an order within ${RETURN_WINDOW_DAYS} days of delivery: open it in My Orders and choose "Return order". Once the return is approved, our courier picks it up in 2–3 days. Online payments are refunded to the same account or card (banks usually take 5–7 working days). For cash-on-delivery orders you give us a UPI ID or bank account, and we transfer the refund within 2 working days of pickup.`;
    case 'cancel':
      return 'You can cancel an order any time before it ships: open it in My Orders and choose "Cancel order". Online payments for cancelled orders are refunded in full; nothing is charged for a cancelled cash-on-delivery order.';
    case 'payment':
      return pay.enabled
        ? 'You can pay online with UPI, credit or debit card, net banking, wallets or EMI (processed securely by Razorpay, and we never see your full card details), or choose cash on delivery.'
        : 'Right now orders are paid by cash on delivery. Online payment (UPI, cards, net banking) is being set up and will appear at checkout once it is live.';
    case 'delivery':
      return `We deliver across India. Delivery is free on orders of ${rupees(FREE_DELIVERY_ABOVE)} or more, and ${rupees(DELIVERY_FEE)} below that. Enter your pincode on any product page to check delivery to your area.`;
    case 'coupon':
      return 'Enter a coupon code in your cart or at checkout. The store checks it there and shows the exact saving before you pay. I can’t see or make up codes, so only use ones the store has shared with you.';
    case 'human':
      return 'I’ll get you to a person. Open Help Center → Contact support (link below) and send your question. It creates a support ticket that our team answers, and you can follow the replies under My Account → Support tickets. For a problem with a specific order, choose "Raise a complaint" on that order’s page.';
    default:
      return null;
  }
}

async function orderStatus(db, userId, lower) {
  if (!userId) return { answer: 'Please log in and I’ll look up your orders. You can also see every order, with its tracking, under My Orders.', links: [{ label: 'My Orders', to: '/orders' }] };
  const wanted = lower.match(/#?\b(\d{1,9})\b/);
  const rows = await db(
    `SELECT id, status, total, created_at, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o WHERE user_id = $1 ${wanted ? 'AND id = $2' : ''} ORDER BY id DESC LIMIT 3`,
    wanted ? [userId, Number(wanted[1])] : [userId],
  );
  if (!rows.length) {
    return wanted
      ? { answer: `I couldn’t find order #${wanted[1]} on your account. Here are your orders:`, links: [{ label: 'My Orders', to: '/orders' }] }
      : { answer: 'You haven’t placed any orders yet. Tell me what you’re looking for and I’ll help you find it.', links: [{ label: 'Shop all products', to: '/products' }] };
  }
  const STATUS = { placed: 'placed and being prepared', packed: 'packed', shipped: 'on its way', delivered: 'delivered', cancelled: 'cancelled', returned: 'returned' };
  const date = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const lines = rows.map((o) => `Order #${o.id} (${date(o.created_at)}, ${o.items} item${Number(o.items) === 1 ? '' : 's'}, ${rupees(o.total)}): ${STATUS[o.status] || o.status}`);
  return {
    answer: `${rows.length === 1 ? 'Here’s your order:' : 'Here are your latest orders:'}\n${lines.join('\n')}\n\nOpen an order to see each step, cancel it before it ships, or start a return after delivery.`,
    links: rows.map((o) => ({ label: `Order #${o.id}`, to: `/orders/${o.id}` })),
  };
}

function compare(lower) {
  const sides = lower.replace(/^.*?\b(compare|comparison of|difference between)\b/, '').split(/\s+(?:vs\.?|versus|or|and|with)\s+|,/).map((s) => s.trim()).filter((s) => s.length > 1);
  if (sides.length < 2) return null;
  const picks = sides.slice(0, 3).map((s) => searchCatalog(s, { k: 1 }).products[0]).filter(Boolean);
  const unique = [...new Map(picks.map((p) => [p._id, p])).values()];
  if (unique.length < 2) return null;
  const rows = unique.map((p) =>
    `• ${p.name}: ${rupees(p.price)}${p.discount ? ` (${p.discount}% off)` : ''}, ${p.brand || 'no brand'}, ${p.stock > 0 ? `${p.stock} in stock` : 'out of stock'}${p.rating ? `, rated ${p.rating}/5` : ''}`,
  );
  const cheapest = [...unique].sort((a, b) => a.price - b.price)[0];
  return { answer: `Here’s how they compare:\n${rows.join('\n')}\n\n${cheapest.name} is the cheaper option. Open each one for full details.`, products: unique };
}

function productAnswer(message, previous) {
  let found = searchCatalog(message);
  // A follow-up such as "cheaper" or "under 2000" refines the last search instead of starting over
  if (!found.shelves.length && !found.words.length && previous) {
    const own = priceRange(message);
    // A new price replaces the old one; "cheaper" keeps it
    const earlier = own.max !== null || own.min !== null ? previous.replace(/(?:under|below|above|over|between|upto|up to|within)?\s*(?:₹|rs\.?|inr)?\s*[\d,]+\s*(?:k|thousand|lakhs?)?/gi, ' ') : previous;
    found = searchCatalog(`${earlier} ${message}`);
  }
  const { products, shelves, range, nearest } = found;
  const what = shelves.length ? shelves.slice(0, 2).map(shelfName).join(' / ') : 'products';
  const span = describeRange(range);
  if (products.length) {
    return {
      answer: `Here are ${products.length === 1 ? 'the best match' : `${products.length} picks`} for ${what}${span ? ` ${span}` : ''}, with today’s prices and stock:\n${products.map(line).join('\n')}`,
      products,
    };
  }
  if (nearest.length) {
    return {
      answer: `We don’t have ${what} ${span} in stock right now. These are the closest:\n${nearest.map(line).join('\n')}`,
      products: nearest,
    };
  }
  return null;
}

/** One reply to the conversation so far. */
export async function reply(messages, { db = query, userId = null } = {}) {
  const userTurns = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const message = userTurns.at(-1);
  const previous = userTurns.at(-2) || null;
  const lower = message.toLowerCase();
  const namesProduct = searchCatalog(message, { k: 1 }).shelves.length > 0;
  const intent = intentOf(lower, { productWords: namesProduct });

  if (intent === 'order') return { intent, ...(await orderStatus(db, userId, lower)) };
  if (/\b(compare|comparison|versus|vs\.?|difference between)\b/.test(lower)) {
    const result = compare(lower);
    if (result) return { intent: 'compare', ...result };
  }
  if (intent === 'size') {
    const { products } = searchCatalog(message, { k: 1 });
    const p = products[0];
    if (p?.sizes?.length) return { intent, answer: `${p.name} comes in sizes ${p.sizes.join(', ')}. The product page shows which sizes are in stock.`, products: [p] };
    return { intent, answer: 'Each clothing and footwear product lists its sizes on its page. Tell me the product (for example "size of the denim jacket") and I’ll check.' };
  }
  if (intent && intent !== 'greeting') {
    const links = intent === 'human' ? [{ label: 'Contact support', to: '/help#contact' }] : intent === 'return' || intent === 'cancel' ? [{ label: 'My Orders', to: '/orders' }, { label: 'Refund policy', to: '/refunds' }] : [];
    // "is delivery free on headphones?" is about delivery, but a search with real words in it still deserves products
    const search = intent !== 'human' && namesProduct ? productAnswer(message, null) : null;
    return { intent, answer: policy(intent), links, products: search?.products?.slice(0, 2) || [] };
  }
  const found = productAnswer(message, previous);
  if (found) return { intent: 'search', ...found };
  if (intent === 'greeting' || tokens(lower).length <= 2) {
    return { intent: 'greeting', answer: 'Hi! I can find products within your budget, compare them, check your orders and explain delivery, payment and returns. What are you looking for?', suggestions: SUGGESTIONS };
  }
  return {
    intent: 'none',
    answer: 'I couldn’t find anything in our catalog that matches that. Try naming the product and a budget, like "running shoes under ₹3,000", or browse a category. If you need a person, ask for support.',
    suggestions: SUGGESTIONS,
    links: [{ label: 'Shop all products', to: '/products' }],
  };
}

const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_CHARS) : '');

function conversation(rest, body) {
  if (rest[0] === 'ask') {
    const question = clean(body?.question);
    return question ? [{ role: 'user', content: question }] : [];
  }
  const raw = Array.isArray(body?.messages) ? body.messages.slice(-MAX_TURNS) : [];
  return raw
    .filter((m) => m && ['user', 'assistant'].includes(m.role))
    .map((m) => ({ role: m.role, content: clean(m.content) }))
    .filter((m) => m.content);
}

export const isAssistantRoute = (method, rest) => method === 'POST' && rest.length === 1 && ['ask', 'agent'].includes(rest[0]);

export function handleAssistant({ rest, body, authorization, ip }, { db = query } = {}) {
  return safely(async () => {
    const messages = conversation(rest, body);
    if (!messages.length || messages.at(-1).role !== 'user') throw new ApiError(400, 'Please type a message');
    try {
      await limit(postgresStore(db), `assistant:${ip}`, PER_WINDOW, 'You’re sending messages very quickly. Please wait a few minutes and try again.');
    } catch (err) {
      if (err.status === 429) throw err;
      console.error('assistant rate limit unavailable', err.message); // the catalog answers still work without the database
    }
    let userId = null;
    if (authorization) {
      try {
        userId = currentUserId(authorization);
      } catch {
        userId = null; // an expired login still gets catalog and policy answers
      }
    }
    const result = await reply(messages, { db, userId });
    const products = (result.products || []).map((p) => card(getProduct(p._id) || p));
    return {
      body: {
        answer: result.answer, // /ai/ask shape
        reply: result.answer, // /ai/agent shape
        intent: result.intent,
        products,
        links: result.links || [],
        suggestions: result.suggestions || [],
        actions: [],
        grounded: true,
      },
    };
  });
}
