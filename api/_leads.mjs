// Enquiries and newsletter sign-ups (a small CRM) on the Vercel store. Only what people send us themselves, with the
// consent they ticked: nothing is collected in the background.
//
//   POST   /leads           anyone: contact form, product question, bulk quote, business or newsletter (sign-in optional)
//   GET    /leads           admin: the pipeline, open and most promising first (?status= &kind= &intent= &q=)
//   GET    /leads/summary   admin: counts, follow-ups due and enquiry-to-order conversion
//   PATCH  /leads/:id       admin: status, assignee, follow-up date, a note (changes are logged on the lead)
//   DELETE /leads/:id       admin: erase a lead, e.g. when the person asks
//
// kind, intent and the summary come from keyword rules (classifyLead), not a trained model. Product matches are searched
// in the live catalog, and their price and stock are read again every time the admin opens the list.
import { ApiError, currentUserId, limit, normalizeEmail, postgresStore, query, safely } from './_auth.mjs';
import { getProduct, loadProducts, similar } from './_catalog.mjs';

export const SOURCES = ['contact', 'product', 'quote', 'business', 'newsletter'];
export const STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost', 'unsubscribed'];
export const KIND_LABELS = {
  product_enquiry: 'Product enquiry',
  quote: 'Bulk / quote request',
  support: 'Support request',
  business: 'Business opportunity',
  newsletter: 'Newsletter',
};
const CLOSED = ['won', 'lost', 'unsubscribed'];
const ID_RE = /^\d{1,9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SUPPORT = ['my order', 'order #', 'order id', 'order no', 'refund', 'return', 'not delivered', 'not received', 'cancel', 'damaged', 'tracking', 'complaint', 'wrong item'];
const BUSINESS = ['partner', 'supplier', 'distributor', 'distribution', 'collaborat', 'franchise', 'advertis', 'sell on', 'become a seller', 'vendor', 'b2b', 'manufacturer'];
const QUOTE = ['bulk', 'quote', 'quotation', 'wholesale', 'corporate', 'gifting', 'gst invoice', 'tender', 'large order'];
const HIGH = ['buy', 'purchase', 'urgent', 'asap', 'today', 'tomorrow', 'this week', 'immediately', 'ready to', 'final price', 'best price', 'place an order', 'pay now'];
const LOW = ['just looking', 'just browsing', 'curious', 'someday', 'maybe later', 'no hurry', 'in future', 'next year', 'just asking'];
const STOPWORDS = new Set(
  ('the and for with need want wants looking under below budget please price buy have you your this that what which can are any good best some from ' +
    'about also will would like into than more less inr rupees around within upto hello sir madam thanks thank kya hai chahiye mujhe liye mein ' +
    'plz pls send details quote bulk units pieces pcs order urgent asap today week tomorrow use using get know tell something thing things ' +
    'interested purchase available stock help much how when where there their them they who our ours just only very really lakh lakhs crore ' +
    'thousand per each piece unit days delivery deliver new one two three detail rupee these those').split(' '),
);
const UNIT = { k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 };

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const fail = (message, status = 400) => {
  throw new ApiError(status, message);
};
const hits = (haystack, words) => words.filter((w) => haystack.includes(w)).length;
export const rupees = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** The highest amount of money the message mentions, in rupees ("under ₹70,000", "1.5 lakh", "50k"), or null. */
export function extractBudget(message) {
  const amounts = [];
  const patterns = [
    /(?:₹|\brs\.?|\binr\b|\brupees?\b)\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|cr|crores?)?\b/gi,
    /\b([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|cr|crores?)\b/gi,
    /\b(?:budget|under|below|upto|up to|within|around|max(?:imum)?|less than)\s*(?:of|is|:)?\s*([\d,]+(?:\.\d+)?)\b(?!\s*(?:units?|pcs|pieces|days?|%))/gi,
  ];
  for (const re of patterns) {
    for (const m of message.matchAll(re)) {
      const value = Number(m[1].replace(/,/g, '')) * (UNIT[(m[2] || '').toLowerCase()] || 1);
      if (Number.isFinite(value) && value >= 50 && value <= 1e8) amounts.push(Math.round(value));
    }
  }
  return amounts.length ? Math.max(...amounts) : null;
}

/** How many units the message asks for ("50 units", "qty: 20"), or null. */
export function extractQuantity(message) {
  const m = message.match(/\b(\d{1,6})\s*(?:pcs|pieces|units|nos|sets|boxes|cartons|packs)\b/i) || message.match(/\b(?:qty|quantity)\s*(?:of|:|-)?\s*(\d{1,6})\b/i);
  const n = m ? Number(m[1]) : null;
  return n && n > 0 ? n : null;
}

const stem = (w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
// Whole words only: "team" must not find "Steam Iron"
const wordsOf = (s) => new Set((String(s).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).map(stem));
const productWords = new WeakMap(); // product object -> { name, all }; the catalog swaps objects when it changes
function wordsOfProduct(p) {
  let w = productWords.get(p);
  if (!w) {
    const name = wordsOf(p.name);
    w = { name, all: new Set([...name, ...wordsOf(`${p.brand || ''} ${p.category || ''} ${p.subCategory || ''} ${(p.tags || []).join(' ')}`)]) };
    productWords.set(p, w);
  }
  return w;
}

/** Up to `k` in-stock catalog products that fit the message (and the budget): a name match counts most. */
export function matchProducts(message, { budget = null, productId = null, k = 3 } = {}) {
  const raw = (message.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((w) => !STOPWORDS.has(w));
  const words = [...new Set(raw.map(stem))].filter((w) => !STOPWORDS.has(w)); // "details" -> "detail" is still a stopword
  const fits = (p) => p.stock > 0 && (budget === null || p.price <= budget);
  const scored = words.length
    ? loadProducts()
        .filter(fits)
        .map((p) => {
          const { name, all } = wordsOfProduct(p);
          const score = words.reduce((s, w) => s + (name.has(w) ? 3 : all.has(w) ? 1 : 0), 0);
          return { p, score };
        })
        .filter((x) => x.score >= 3) // at least one word in the name, or three elsewhere: one stray tag isn't a match
        .sort((a, b) => b.score - a.score || (b.p.rating || 0) - (a.p.rating || 0))
        .map((x) => x.p)
    : [];
  // Asked about one product and named nothing else: similar products are the alternatives
  const pool = scored.length || !productId ? scored : similar(productId, 12).filter(fits);
  return pool.filter((p) => p._id !== productId).slice(0, k).map((p) => p._id);
}

/** The kind of enquiry, how ready to buy it sounds, a one-line summary and catalog matches. Keyword rules only. */
export function classifyLead({ source, message = '', budget = null, quantity = null, productId = null, phone = null }) {
  const lower = ` ${message.toLowerCase()} `;
  const product = productId ? getProduct(productId) : null;
  const amount = budget ?? extractBudget(message);
  const units = quantity ?? extractQuantity(message);
  let kind;
  if (source === 'newsletter') kind = 'newsletter';
  else if (hits(lower, SUPPORT) && !hits(lower, QUOTE)) kind = 'support';
  else if (source === 'business' || hits(lower, BUSINESS)) kind = 'business';
  else if (source === 'quote' || hits(lower, QUOTE) || (units ?? 0) >= 10) kind = 'quote';
  else kind = 'product_enquiry';

  const matches = ['product_enquiry', 'quote'].includes(kind) ? matchProducts(message, { budget: amount, productId }) : [];
  let intent = 'low';
  if (!['support', 'newsletter'].includes(kind)) {
    const score =
      Math.min(hits(lower, HIGH), 2) * 2 + (amount ? 1 : 0) + (units ? (units >= 10 ? 2 : 1) : 0) + (product || matches.length ? 1 : 0) + (phone ? 1 : 0) - hits(lower, LOW) * 3;
    intent = score >= 4 ? 'high' : score >= 1 ? 'medium' : 'low';
  }
  const firstSentence = message.split(/(?<=[.!?])\s|\n/)[0].trim();
  const summary = [
    KIND_LABELS[kind],
    units && `${units.toLocaleString('en-IN')} units`,
    amount && `budget up to ${rupees(amount)}`,
    product && `about “${product.name}”`,
  ]
    .filter(Boolean)
    .join(' · ')
    .concat(firstSentence ? ` — “${firstSentence.length > 140 ? `${firstSentence.slice(0, 139)}…` : firstSentence}”` : '');
  return { kind, intent, budget: amount, quantity: units, matches, summary };
}

const brief = (p) => p && { _id: p._id, name: p.name, price: p.price, stock: p.stock, image: p.image };

/** A first reply the team can send, built from the lead and the products' current price and stock. Never sent automatically. */
function followUp(lead, product, matches) {
  const name = (lead.name || '').split(' ')[0] || 'there';
  const within = lead.budget ? ` within your ${rupees(lead.budget)} budget` : '';
  switch (lead.kind) {
    case 'quote':
      return `Hi ${name}, thanks for your bulk enquiry${lead.quantity ? ` for ${lead.quantity.toLocaleString('en-IN')} units` : ''}${product ? ` of ${product.name}` : ''}. Could you share your delivery pincode and GSTIN (if you need a GST invoice)? We’ll confirm pricing and delivery time within one working day.`;
    case 'support':
      return `Hi ${name}, for order issues the quickest route is a support ticket from your order page (Help → Contact support): it reaches the right team with your order details attached.`;
    case 'business':
      return `Hi ${name}, thanks for your interest in working with Arvixa Store. Could you share your company name, what you’d like to offer and a good time to talk?`;
    case 'newsletter':
      return null;
    default:
      if (matches.length) {
        const list = matches.map((p) => `${p.name} (${rupees(p.price)})`).join(', ');
        return `Hi ${name}, thanks for asking. These are in stock now${within}: ${list}. Would you like more details on any of them?`;
      }
      if (product) return `Hi ${name}, thanks for your question about ${product.name}. ${product.stock > 0 ? `It’s in stock at ${rupees(product.price)}.` : 'It’s out of stock right now; we can tell you when it’s back.'}`;
      return `Hi ${name}, thanks for your enquiry. We don’t have a match in stock${within} right now. Shall we let you know when something suitable arrives?`;
  }
}

// follow_up_on as text: a DATE must not shift a day with the server's time zone
const COLUMNS = `l.id, l.source, l.kind, l.name, l.email, l.phone, l.user_id, l.product_id, l.message, l.budget, l.quantity, l.intent,
  l.summary, l.matches, l.status, l.assigned_to, to_char(l.follow_up_on, 'YYYY-MM-DD') AS follow_up_on, l.notes,
  l.marketing_consent, l.consent_at, l.created_at, l.updated_at, a.name AS assignee_name,
  (SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id
    WHERE (o.user_id = l.user_id OR (l.email IS NOT NULL AND lower(u.email) = lower(l.email)))
      AND o.created_at >= l.created_at AND o.status <> 'cancelled'
    ORDER BY o.created_at LIMIT 1) AS converted_order_id`;
const FROM = 'FROM leads l LEFT JOIN users a ON a.id = l.assigned_to';

function leadJson(row) {
  const product = row.product_id ? brief(getProduct(row.product_id)) : null;
  const matches = (row.matches || []).map((id) => brief(getProduct(id))).filter(Boolean); // unlisted since: dropped
  return { ...row, kindLabel: KIND_LABELS[row.kind] ?? row.kind, product, matches, suggestedReply: followUp(row, product, matches) };
}

async function admin(db, authorization) {
  const [u] = await db('SELECT id, name, role FROM users WHERE id = $1', [currentUserId(authorization)]);
  if (!u) fail('Please log in again', 401);
  if (u.role !== 'admin') fail('Only the store team can see enquiries', 403);
  return u;
}

async function signedIn(db, authorization) {
  if (!authorization) return null;
  try {
    const [u] = await db('SELECT id, name, email, phone FROM users WHERE id = $1', [currentUserId(authorization)]);
    return u || null;
  } catch {
    return null; // an expired token doesn't stop someone sending an enquiry
  }
}

function contactDetails(body, user) {
  const name = text(body.name) || user?.name || '';
  const email = normalizeEmail(body.email) || user?.email || '';
  const phone = text(body.phone).replace(/[\s-]/g, '').replace(/^(\+91|91(?=\d{10}$)|0)/, '') || '';
  if (name && (name.length < 2 || name.length > 80)) fail('Please enter your name (2 to 80 characters)');
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) fail('Please enter a valid email address');
  if (phone && !/^[6-9]\d{9}$/.test(phone)) fail('Please enter a valid 10-digit mobile number');
  return { name: name || null, email: email || null, phone: phone || null };
}

const optionalNumber = (value, max, label) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`Please enter a valid ${label}`);
  return n;
};

async function createLead({ db, body, authorization, ip }) {
  const source = SOURCES.includes(body.source) ? body.source : fail('Unknown form');
  // A hidden field people never see: bots fill it in. Answer as usual and keep nothing.
  if (text(body.website)) return { status: 201, body: { received: true, kind: source === 'newsletter' ? 'newsletter' : 'enquiry' } };
  const store = postgresStore(db);
  await limit(store, `lead:${ip}`, 8, 'You’ve sent several messages just now. Please try again in 15 minutes.');
  const user = await signedIn(db, authorization);
  const contact = contactDetails(body, user);

  if (source === 'newsletter') {
    if (!contact.email) fail('Please enter your email address');
    if (body.marketingConsent !== true) fail('Please tick the box to agree to receive our emails');
    await limit(store, `lead-email:${contact.email}`, 4, 'Please try again in 15 minutes.');
    // Signing up again re-subscribes; the answer is the same either way, so the form can't reveal who is subscribed
    await db(
      `INSERT INTO leads (source, kind, name, email, user_id, intent, summary, marketing_consent, consent_at)
       VALUES ('newsletter', 'newsletter', $1, $2, $3, 'low', 'Newsletter subscriber', TRUE, NOW())
       ON CONFLICT ((lower(email))) WHERE source = 'newsletter'
       DO UPDATE SET marketing_consent = TRUE, consent_at = NOW(), updated_at = NOW(),
                     status = CASE WHEN leads.status = 'unsubscribed' THEN 'new' ELSE leads.status END`,
      [contact.name, contact.email, user?.id ?? null],
    );
    return { status: 201, body: { received: true, kind: 'newsletter' } };
  }

  if (body.consent !== true) fail('Please tick the box so we can contact you about this enquiry');
  if (!contact.name) fail('Please enter your name');
  if (!contact.email && !contact.phone) fail('Please give an email address or a mobile number so we can reply');
  const message = text(body.message);
  if (message.length < 10 || message.length > 2000) fail('Please tell us a little more (10 to 2,000 characters)');
  let productId = null;
  if (body.productId) {
    productId = String(body.productId);
    if (!getProduct(productId)) fail('Product not found', 404);
  }
  const budget = optionalNumber(body.budget, 1e8, 'budget');
  const quantity = optionalNumber(body.quantity, 1e6, 'quantity');
  if (contact.email) await limit(store, `lead-email:${contact.email}`, 4, 'You’ve sent several messages just now. Please try again in 15 minutes.');

  const c = classifyLead({ source, message, budget, quantity, productId, phone: contact.phone });
  await db(
    `INSERT INTO leads (source, kind, name, email, phone, user_id, product_id, message, budget, quantity, intent, summary, matches, marketing_consent, consent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, NOW())`,
    [source, c.kind, contact.name, contact.email, contact.phone, user?.id ?? null, productId, message, c.budget, c.quantity, c.intent, c.summary, JSON.stringify(c.matches), body.marketingConsent === true],
  );
  return { status: 201, body: { received: true, kind: c.kind === 'support' ? 'support' : 'enquiry' } };
}

async function listLeads({ db, params }) {
  const args = [];
  const where = [];
  const add = (sql, value) => {
    args.push(value);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (STATUSES.includes(params.status)) add('l.status = ?', params.status);
  else if (params.status === 'open') where.push(`l.status NOT IN ('won', 'lost', 'unsubscribed')`);
  if (Object.hasOwn(KIND_LABELS, params.kind ?? '')) add('l.kind = ?', params.kind);
  if (['high', 'medium', 'low'].includes(params.intent)) add('l.intent = ?', params.intent);
  const q = text(params.q).slice(0, 100);
  if (q) add(`(l.name ILIKE ? OR l.email ILIKE $${args.length + 1} OR l.phone ILIKE $${args.length + 1} OR l.message ILIKE $${args.length + 1})`, `%${q.replace(/[\\%_]/g, '\\$&')}%`);
  const rows = await db(
    `SELECT ${COLUMNS} ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE WHEN l.status IN ('won', 'lost', 'unsubscribed') THEN 1 ELSE 0 END,
               CASE l.intent WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, l.created_at DESC
      LIMIT 200`,
    args,
  );
  return { body: rows.map(leadJson) };
}

async function summary({ db }) {
  const [totals] = await db(
    `WITH x AS (
       SELECT l.*, EXISTS (SELECT 1 FROM orders o JOIN users u ON u.id = o.user_id
                            WHERE (o.user_id = l.user_id OR (l.email IS NOT NULL AND lower(u.email) = lower(l.email)))
                              AND o.created_at >= l.created_at AND o.status <> 'cancelled') AS converted
         FROM leads l)
     SELECT count(*) FILTER (WHERE source <> 'newsletter')::int AS enquiries,
            count(*) FILTER (WHERE source <> 'newsletter' AND status = 'new')::int AS new,
            count(*) FILTER (WHERE source <> 'newsletter' AND intent = 'high' AND status NOT IN ('won', 'lost'))::int AS hot,
            count(*) FILTER (WHERE follow_up_on <= CURRENT_DATE AND status NOT IN ('won', 'lost', 'unsubscribed'))::int AS due,
            count(*) FILTER (WHERE source <> 'newsletter' AND converted)::int AS converted,
            count(*) FILTER (WHERE source = 'newsletter' AND status <> 'unsubscribed')::int AS subscribers
       FROM x`,
  );
  const bySource = await db("SELECT source, count(*)::int AS count FROM leads WHERE source <> 'newsletter' GROUP BY source ORDER BY count DESC");
  const team = await db("SELECT id, name FROM users WHERE role = 'admin' ORDER BY name, id"); // who a lead can be assigned to
  return { body: { ...totals, conversionRate: totals.enquiries ? Math.round((totals.converted / totals.enquiries) * 1000) / 10 : null, bySource, team } };
}

async function getLead(db, id) {
  const [row] = ID_RE.test(String(id)) ? await db(`SELECT ${COLUMNS} ${FROM} WHERE l.id = $1`, [Number(id)]) : [];
  if (!row) fail('Enquiry not found', 404);
  return row;
}

async function updateLead({ db, user, id, body }) {
  const lead = await getLead(db, id);
  const sets = [];
  const args = [];
  const log = []; // every change is written on the lead, with who made it
  const set = (column, value) => {
    args.push(value);
    sets.push(`${column} = $${args.length}`);
  };
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) fail(`status must be one of: ${STATUSES.join(', ')}`);
    if (body.status !== lead.status) {
      set('status', body.status);
      if (body.status === 'unsubscribed') set('marketing_consent', false);
      log.push(`Status: ${lead.status} → ${body.status}`);
    }
  }
  if (body.assignedTo !== undefined) {
    let assignee = null;
    if (body.assignedTo !== null && body.assignedTo !== '') {
      [assignee] = ID_RE.test(String(body.assignedTo)) ? await db("SELECT id, name FROM users WHERE id = $1 AND role = 'admin'", [Number(body.assignedTo)]) : [];
      if (!assignee) fail('Enquiries can only be assigned to the store team');
    }
    if ((assignee?.id ?? null) !== lead.assigned_to) {
      set('assigned_to', assignee?.id ?? null);
      log.push(assignee ? `Assigned to ${assignee.name}` : 'Unassigned');
    }
  }
  if (body.followUpOn !== undefined) {
    const day = body.followUpOn || null;
    if (day !== null && (!DATE_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)))) fail('Please pick a valid follow-up date');
    if (day !== lead.follow_up_on) {
      set('follow_up_on', day);
      log.push(day ? `Follow up on ${day}` : 'Follow-up date cleared');
    }
  }
  const note = text(body.note);
  if (body.note !== undefined && (note.length < 1 || note.length > 1000)) fail('Please write a note (up to 1,000 characters)');
  if (note) log.push(note);
  if (!log.length) return { body: leadJson(lead) };
  const at = new Date().toISOString();
  args.push(JSON.stringify(log.map((t) => ({ at, by: user.name, text: t }))));
  sets.push(`notes = notes || $${args.length}::jsonb`, 'updated_at = NOW()');
  args.push(lead.id);
  await db(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
  return { body: leadJson(await getLead(db, lead.id)) };
}

async function deleteLead({ db, id }) {
  const [gone] = ID_RE.test(String(id)) ? await db('DELETE FROM leads WHERE id = $1 RETURNING id', [Number(id)]) : [];
  if (!gone) fail('Enquiry not found', 404);
  return { status: 204, body: null };
}

const ROUTES = {
  'POST ': createLead,
  'GET ': listLeads,
  'GET summary': summary,
  'PATCH :id': updateLead,
  'DELETE :id': deleteLead,
};

function findRoute(method, rest) {
  const [first, ...extra] = rest;
  if (extra.length) return null;
  const key = `${method} ${first === undefined ? '' : first === 'summary' ? 'summary' : ':id'}`;
  return Object.hasOwn(ROUTES, key) ? { key, id: first } : null;
}

export const isLeadRoute = (method, rest) => Boolean(findRoute(method, rest));

export function handleLeads({ method, rest, body, params = {}, authorization, ip = 'unknown' }, { db = query } = {}) {
  return safely(async () => {
    const { key, id } = findRoute(method, rest);
    if (key === 'POST ') return createLead({ db, body: body ?? {}, authorization, ip });
    const user = await admin(db, authorization);
    return ROUTES[key]({ db, user, id, body: body ?? {}, params });
  });
}
