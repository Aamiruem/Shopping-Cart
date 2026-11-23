// The shopping assistant on the Vercel store.
//
//   POST /ai/ask    { question }   one question
//   POST /ai/agent  { messages }   a conversation: [{ role: 'user' | 'assistant', content }]
//
// Both answer { reply, products, mode }. `products` are real catalog cards the shopper can open or add to the cart
// with a button: the assistant never changes the cart, places orders or takes payments itself.
//
// With ANTHROPIC_API_KEY set, Claude answers, using tools that read the live catalog (prices, stock, reviews) and the
// store's policies, so it can't make up a product, a price or a discount. Without the key, or if Claude is
// unavailable, rules answer instead: the same requirement parser and catalog search, in plain sentences.
import Anthropic from '@anthropic-ai/sdk';
import { ApiError, databaseConfigured, limit, postgresStore, query, safely } from './_auth.mjs';
import { getProduct } from './_catalog.mjs';
import { recordAssistantLead } from './_leads.mjs';
import { paymentsConfig } from './_payment-config.mjs';
import { findProducts, parseRequirements, productCard } from './_requirements.mjs';

const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
const MAX_TURNS = 12; // messages of history sent to the model
const MAX_TOOL_ROUNDS = 5;
const CATEGORIES = ['mobiles', 'electronics', 'fashion', 'accessories', 'beauty', 'home', 'kitchen', 'sports', 'grocery'];
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

function policies() {
  const online = paymentsConfig().enabled;
  return {
    delivery: 'Delivery is free on orders of ₹499 or more; below that a flat ₹40 is charged. Most orders arrive in 2–4 working days; any product page gives an estimate for a pincode.',
    returns: 'Most items can be returned within 7 days of delivery, in original condition: open the order in My Orders and choose “Return order”. After approval a courier picks it up in 2–3 days.',
    refunds: 'Online payments are refunded to the same UPI, card or bank account, usually 5–7 working days after pickup. Cash-on-delivery orders are refunded to a UPI ID or bank account the customer gives, within 2 working days of pickup.',
    payment: online
      ? 'Customers can pay online with UPI, cards, net banking or wallets through Razorpay, or choose cash on delivery.'
      : 'Payment is cash on delivery for now. Online payment is not available yet.',
    cancellation: 'An order can be cancelled from My Orders until it ships. Online payments are refunded automatically.',
    tracking: 'My Orders shows each order’s status (placed, packed, shipped, delivered) with the courier and tracking number once shipped.',
    support: 'For order problems, raise a ticket on the Help page; the team replies within one working day.',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rules: no model, no cost. Also the fallback when Claude is off or fails.

const POLICY_WORDS = {
  returns: ['return', 'wapas', 'exchange'],
  refunds: ['refund', 'money back', 'paisa wapas'],
  cancellation: ['cancel'],
  tracking: ['track', 'where is my order', 'order status', 'kab aayega'],
  delivery: ['delivery', 'shipping', 'deliver', 'kitne din'],
  payment: ['payment', 'pay ', 'upi', 'card', 'cod', 'cash on delivery', 'emi', 'net banking'],
  support: ['complaint', 'help', 'contact', 'customer care', 'support'],
};

/** Requirements from the conversation so far: later messages win field by field ("laptop" … "under 70k"). */
function conversationNeeds(userMessages) {
  const merged = {};
  for (const message of userMessages.slice(-3)) {
    for (const [key, value] of Object.entries(parseRequirements(message))) if (value !== null) merged[key] = value;
  }
  // A new product or category in the latest message starts a new search, keeping only the budget if restated
  const latest = parseRequirements(userMessages.at(-1));
  if (latest.category && latest.category !== merged.category) Object.assign(merged, latest);
  return { category: null, subCategory: null, product: null, brand: null, use: null, budgetMin: null, budgetMax: null, ...merged };
}

export function rulesAnswer(userMessages) {
  const last = userMessages.at(-1).toLowerCase();
  const needs = conversationNeeds(userMessages);
  const topic = Object.keys(POLICY_WORDS).find((k) => POLICY_WORDS[k].some((w) => last.includes(w)));
  // A policy question in the latest message wins over products asked about earlier ("…and what's your return policy?")
  const latest = parseRequirements(userMessages.at(-1));
  if (topic && !latest.product && !latest.category) return { reply: policies()[topic], products: [] };
  if (!needs.category && !needs.brand && !needs.product) {
    return {
      reply: 'Tell me what you’re looking for, what it’s for and your budget — for example “running shoes under ₹3,000” or “a Samsung phone between ₹15,000 and ₹25,000”. I can also answer questions about delivery, payment, returns and refunds.',
      products: [],
    };
  }
  const { matches, closest } = findProducts(needs, { k: 4 });
  const what = [needs.brand, needs.product || needs.category].filter(Boolean).join(' ');
  const budget = needs.budgetMin && needs.budgetMax ? ` between ${rupees(needs.budgetMin)} and ${rupees(needs.budgetMax)}` : needs.budgetMax ? ` under ${rupees(needs.budgetMax)}` : '';
  const use = needs.use ? ` for ${needs.use}` : '';
  if (matches.length) {
    const lines = matches.map((p) => `• ${p.name} — ${rupees(p.price)}${p.stock <= 5 ? ` (only ${p.stock} left)` : ''}`);
    return {
      reply: `Here’s what we have in stock: ${what}${use}${budget}:\n${lines.join('\n')}\nOpen one for full details, or add it to your cart.`,
      products: matches.map(productCard),
    };
  }
  if (closest.length) {
    return {
      reply: `We don’t have a ${what}${use}${budget} in stock right now. The closest options are just above your budget:\n${closest.map((p) => `• ${p.name} — ${rupees(p.price)}`).join('\n')}`,
      products: closest.map(productCard),
    };
  }
  return { reply: `Sorry, we don’t have a ${what}${budget} in stock right now. Try a different budget or brand, or browse the category for similar items.`, products: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Claude, with tools over the live catalog

const SYSTEM = `You are the shopping assistant for Arvixa Store, an online store in India. You help shoppers find products that fit what they need, compare options, and answer questions about delivery, payment, returns and refunds.

How to work:
- Work out the shopper's requirements: what product, what it's for, budget, preferred brand, must-have features. If something important is missing (usually the budget or the use), you may ask one short question, but if you can already search, search first.
- Facts about products (names, prices, stock, specifications, ratings) come only from search_products and get_product. Store policies come only from store_policy. Never state a price, discount, offer, delivery date, specification or rating that a tool did not return. If a listing doesn't say something, say you don't know rather than guessing.
- Ratings are shown only when a tool returns verified-buyer reviews; otherwise don't mention ratings.
- If nothing fits the budget, say so plainly and offer the closest options the tool returned, with their real prices. Never stretch the budget silently.
- When you recommend products, call show_products with the ids you recommend, best first (at most 4). The shopper sees them as cards with an "Add to cart" button. You cannot add to the cart, place orders, take payments, cancel or refund anything yourself: point the shopper to the button, the checkout, or My Orders.
- Compare products on the attributes their listings actually state, and say briefly why each fits the shopper's need.
- Reply in the shopper's language and script (English, Hindi or Hinglish). Keep replies short: a few sentences or a short list. Prices in rupees, like ₹24,899. Plain text, no markdown headings or tables.
- Don't ask for or repeat phone numbers, addresses, card or UPI details.`;

const TOOLS = [
  {
    name: 'search_products',
    description: 'Search the store catalog for in-stock products. Returns real products with current prices. When nothing fits the price range, "closest" lists the nearest options above the budget.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the shopper wants, in their words, e.g. "laptop for machine learning" or "running shoes".' },
        category: { type: 'string', enum: CATEGORIES, description: 'Catalog category, when clear.' },
        brand: { type: 'string', description: 'Brand name, only if the shopper asked for one.' },
        min_price: { type: 'number', description: 'Lowest price in rupees.' },
        max_price: { type: 'number', description: 'Highest price in rupees (the budget).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_product',
    description: 'Full listing for one product: description, tags, sizes and colours, price, stock, verified reviews.',
    input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  },
  {
    name: 'store_policy',
    description: 'The store’s policy on one topic.',
    input_schema: {
      type: 'object',
      properties: { topic: { type: 'string', enum: ['delivery', 'returns', 'refunds', 'payment', 'cancellation', 'tracking', 'support'] } },
      required: ['topic'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_products',
    description: 'Show product cards to the shopper, with an Add to cart button on each. Use the ids from search_products or get_product.',
    input_schema: {
      type: 'object',
      properties: { product_ids: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
      required: ['product_ids'],
      additionalProperties: false,
    },
  },
];

const listing = (p) => ({
  ...productCard(p),
  description: String(p.description || '').slice(0, 600),
  tags: p.tags || [],
  ...(p.sizes ? { sizes: p.sizes } : {}),
  ...(p.colors ? { colors: p.colors } : {}),
});

function runTool(name, input, shown) {
  if (name === 'search_products') {
    const parsed = parseRequirements(String(input.query || ''));
    const category = CATEGORIES.includes(input.category) ? input.category : parsed.category;
    const req = {
      ...parsed,
      category,
      subCategory: category === parsed.category ? parsed.subCategory : null,
      brand: input.brand || parsed.brand,
      budgetMin: Number.isFinite(input.min_price) ? input.min_price : parsed.budgetMin,
      budgetMax: Number.isFinite(input.max_price) ? input.max_price : parsed.budgetMax,
    };
    let { matches, closest } = findProducts(req, { k: 6 });
    if (!matches.length && !closest.length && req.brand) ({ matches, closest } = findProducts({ ...req, brand: null }, { k: 6 })); // brand not stocked
    return { matches: matches.map(listing), closest: closest.map(listing), brandStocked: !req.brand || matches.some((p) => p.brand === req.brand) };
  }
  if (name === 'get_product') {
    const p = getProduct(String(input.product_id || ''));
    return p ? listing(p) : { error: 'No product with that id' };
  }
  if (name === 'store_policy') return { policy: policies()[input.topic] ?? 'No policy on that topic.' };
  if (name === 'show_products') {
    const ids = (Array.isArray(input.product_ids) ? input.product_ids : []).slice(0, 4);
    const found = ids.map((id) => getProduct(String(id))).filter((p) => p && (p.stock ?? 0) > 0);
    shown.splice(0, shown.length, ...found.map(productCard));
    return { shown: found.length, missing: ids.length - found.length };
  }
  return { error: `Unknown tool ${name}` };
}

let client;
const anthropic = () => (client ??= new Anthropic());

/** One conversation turn with Claude. Returns { reply, products } or throws (the caller falls back to rules). */
export async function claudeAnswer(messages, { create = (params) => anthropic().beta.messages.create(params) } = {}) {
  const history = messages.map((m) => ({ role: m.role, content: m.content }));
  const shown = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const response = await create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages: history,
      cache_control: { type: 'ephemeral' }, // the system prompt and tools are the same on every request
      output_config: { effort: 'low' }, // a chat reply: fast and cheap is right here
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // if the model declines, the API retries on a fallback model in the same call
    });
    if (response.stop_reason === 'refusal') {
      return { reply: 'Sorry, I can’t help with that. I can help you find products or answer questions about orders, delivery and returns.', products: [] };
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const calls = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) {
      return { reply: text || 'Sorry, I didn’t catch that. Could you say it another way?', products: shown };
    }
    history.push({ role: 'assistant', content: response.content });
    history.push({
      role: 'user',
      content: calls.map((call) => {
        let result;
        try {
          result = runTool(call.name, call.input && typeof call.input === 'object' ? call.input : {}, shown);
        } catch (err) {
          result = { error: err.message };
        }
        return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result), ...(result.error ? { is_error: true } : {}) };
      }),
    });
  }
  return { reply: 'Here’s what I found so far.', products: shown };
}

// ---------------------------------------------------------------------------------------------------------------

function cleanConversation(body, single) {
  const raw = single ? [{ role: 'user', content: body.question }] : Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 2000) }))
    .slice(-MAX_TURNS);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages.at(-1).role !== 'user') throw new ApiError(400, 'Please type a question');
  return messages;
}

async function answer({ body, ip, authorization, single, db, deps }) {
  const messages = cleanConversation(body, single);
  const userMessages = messages.filter((m) => m.role === 'user').map((m) => m.content);
  let userId = null;
  if (authorization) {
    const { currentUserId } = await import('./_auth.mjs');
    try {
      userId = currentUserId(authorization);
    } catch {
      userId = null;
    }
  }
  const { useDb } = deps;
  let useClaude = Boolean(process.env.ANTHROPIC_API_KEY) && !deps.rulesOnly;
  if (useClaude) {
    // Each Claude reply costs money: cap it per connection and per account. No database means no cap, so no Claude.
    if (!useDb) useClaude = false;
    else {
      try {
        const store = postgresStore(db);
        await limit(store, `assistant:${ip}`, 40, 'You’ve sent a lot of messages just now. Please try again in 15 minutes.');
        if (userId) await limit(store, `assistant-user:${userId}`, 60, 'You’ve sent a lot of messages just now. Please try again in 15 minutes.');
      } catch (err) {
        if (err.status === 429) throw err;
        console.error('assistant limit unavailable', err.message);
        useClaude = false;
      }
    }
  }
  let result;
  let mode = 'rules';
  if (useClaude) {
    try {
      result = await claudeAnswer(messages, deps);
      mode = 'claude';
    } catch (err) {
      console.error('assistant: Claude unavailable, answering with rules', err.status ?? '', err.message);
    }
  }
  result ??= rulesAnswer(userMessages);
  if (useDb) await recordAssistantLead(db, { userId, message: userMessages.at(-1) });
  return { body: { reply: result.reply, answer: result.reply, products: result.products, mode } };
}

export const isAssistantRoute = (method, rest) => method === 'POST' && rest.length === 1 && ['ask', 'agent'].includes(rest[0]);

/** deps: db (statement, params) => rows; useDb (default: DATABASE_URL is set); rulesOnly; create (stands in for Claude in tests). */
export function handleAssistant({ rest, body, ip = 'unknown', authorization }, { db = query, useDb = databaseConfigured(), ...deps } = {}) {
  return safely(() => answer({ body: body ?? {}, ip, authorization, single: rest[0] === 'ask', db, deps: { ...deps, useDb } }));
}
