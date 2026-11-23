// Leads for the sales team on the Vercel store.
//
//   POST  /leads           anyone: contact form, product enquiry, quote request, newsletter sign-up
//   GET   /leads[?status=&intent=&source=]   admin: the leads, newest first, with conversion to orders
//   PATCH /leads/:id       admin: status (new | contacted | qualified | won | lost) and notes
//
// Shopping-assistant conversations add a lead through recordAssistantLead when a shopper states a clear need.
// Contact details are only what people type into a form, and only with the consent box ticked. Nothing is
// collected silently: no fingerprinting, no tracking of who browsed what.
import { ApiError, currentUserId, limit, normalizeEmail, postgresStore, query, safely } from './_auth.mjs';
import { getProduct } from './_catalog.mjs';
import { findProducts, parseRequirements } from './_requirements.mjs';

const SOURCES = ['contact', 'product', 'quote', 'newsletter'];
const STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'];
const INTENTS = ['high', 'medium', 'low'];
const ID_RE = /^\d{1,9}$/;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[6-9]\d{9}$/;

const SUPPORT_WORDS = ['my order', 'refund', 'return', 'not received', 'not delivered', 'cancel', 'complaint', 'damaged', 'wrong item', 'tracking', 'where is my'];
const BUSINESS_WORDS = ['bulk', 'wholesale', 'distributor', 'dealer', 'reseller', 'partner', 'partnership', 'supplier', 'b2b', 'corporate', 'sell on arvixa', 'become a seller', 'collaboration', 'franchise'];
const URGENT_WORDS = ['urgent', 'asap', 'today', 'tomorrow', 'immediately', 'right now', 'buy now', 'want to buy', 'ready to buy', 'order now', 'kal tak', 'aaj', 'jaldi'];

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const contains = (t, words) => words.some((w) => t.includes(w));
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

/** Type, purchase intent, a one-line summary and a suggested next step, from what the person wrote and where. */
export function classifyLead({ source, message = '', productId = null, hasContact = false }) {
  const t = message.toLowerCase();
  const req = parseRequirements(message);
  const product = productId ? getProduct(productId) : null;
  if (product && !req.category) Object.assign(req, { category: product.category, product: null });
  const quantity = Number((t.match(/\b(\d{2,6})\s*(?:pcs|pieces|units|nos|qty|quantity)\b/) || [])[1] || 0);

  let kind;
  if (source === 'newsletter') kind = 'newsletter';
  else if (contains(t, BUSINESS_WORDS) || quantity >= 25) kind = 'business';
  else if (contains(t, SUPPORT_WORDS)) kind = 'support';
  else if (source === 'product' && !req.budgetMax && !contains(t, URGENT_WORDS)) kind = 'product_enquiry';
  else kind = 'purchase';

  const wants = Boolean(req.category || product);
  const budget = req.budgetMax ?? req.budgetMin;
  let intent = 'low';
  if (kind === 'newsletter') intent = 'low';
  else if (kind === 'support') intent = contains(t, URGENT_WORDS) ? 'medium' : 'low';
  else if (kind === 'business') intent = hasContact ? 'high' : 'medium';
  else if ((wants && budget) || contains(t, URGENT_WORDS) || (source === 'quote' && hasContact)) intent = 'high';
  else if (wants || hasContact) intent = 'medium';

  const what = product ? product.name : req.product || req.category;
  const parts = [];
  if (kind === 'newsletter') parts.push('Newsletter sign-up');
  else if (kind === 'support') parts.push('Support request');
  else if (kind === 'business') parts.push(quantity ? `Business enquiry for ${quantity} units` : 'Business enquiry');
  else parts.push(what ? `${kind === 'product_enquiry' ? 'Question about' : 'Wants'} ${what}` : 'General enquiry');
  if (kind !== 'newsletter' && kind !== 'support') {
    if (req.use) parts.push(`for ${req.use}`);
    if (req.brand && !(product && product.brand === req.brand)) parts.push(`brand ${req.brand}`);
    if (req.budgetMin && req.budgetMax) parts.push(`budget ${rupees(req.budgetMin)}–${rupees(req.budgetMax)}`);
    else if (req.budgetMax) parts.push(`budget up to ${rupees(req.budgetMax)}`);
    else if (req.budgetMin) parts.push(`budget from ${rupees(req.budgetMin)}`);
  }
  const summary = parts.join(', ');

  const recommended = kind === 'purchase' || kind === 'product_enquiry' ? findProducts(req, { k: 3 }) : { matches: [], closest: [] };
  const ids = (recommended.matches.length ? recommended.matches : recommended.closest).map((p) => p._id);
  const nextStep = {
    newsletter: 'Add to the newsletter list. Send offers only with this consent.',
    support: 'Pass to support. Reply within one working day and link the order if there is one.',
    business: hasContact ? 'Reply within one working day with bulk pricing and delivery terms.' : 'No contact details: the request is for demand planning only.',
    product_enquiry: hasContact ? 'Answer the question about this product from its listing; offer similar in-stock items if relevant.' : 'No contact details given.',
    purchase: !hasContact
      ? 'No contact details given: shows demand, can’t be followed up.'
      : recommended.matches.length
        ? 'Contact within 24 hours with the matching in-stock products below.'
        : recommended.closest.length
          ? 'Nothing in stock fits the budget: offer the closest options below, or note the demand for buying.'
          : 'Nothing in stock fits: note the demand for buying and tell the customer when it arrives.',
  }[kind];

  return { kind, intent, summary, nextStep, category: req.category, brand: req.brand, budget: budget ?? null, recommended: ids };
}

function leadJson(row) {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    intent: row.intent,
    status: row.status,
    name: row.name,
    email: row.email,
    phone: row.phone,
    product: row.product_id ? (getProduct(row.product_id) ? { id: row.product_id, name: getProduct(row.product_id).name } : { id: row.product_id, name: null }) : null,
    category: row.category,
    brand: row.brand,
    budget: row.budget === null ? null : Number(row.budget),
    message: row.message,
    summary: row.summary,
    nextStep: row.next_step,
    recommended: (row.recommended || []).map((id) => getProduct(id)).filter(Boolean).map((p) => ({ id: p._id, name: p.name, price: p.price, inStock: (p.stock ?? 0) > 0 })),
    notes: row.notes,
    consent: row.consent,
    signedIn: row.user_id !== null,
    convertedOrder: row.order_id ? { id: row.order_id, total: Number(row.order_total), at: row.order_at } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertLead(db, fields) {
  const [row] = await db(
    `INSERT INTO leads (source, kind, intent, user_id, name, email, phone, product_id, category, brand, budget, message, summary, next_step,
                        recommended, consent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16) RETURNING *`,
    [fields.source, fields.kind, fields.intent, fields.userId ?? null, fields.name || null, fields.email || null, fields.phone || null,
      fields.productId || null, fields.category, fields.brand, fields.budget, fields.message || null, fields.summary, fields.nextStep,
      JSON.stringify(fields.recommended || []), Boolean(fields.consent)],
  );
  if (row.intent === 'high' && process.env.ADMIN_EMAIL) {
    const { sendEmail } = await import('./_notify.mjs');
    await sendEmail(db, { to: process.env.ADMIN_EMAIL, template: 'admin_new_lead', data: { lead: row } });
  }
  return row;
}

function optionalUserId(authorization) {
  if (!authorization) return null;
  try {
    return currentUserId(authorization);
  } catch {
    return null;
  }
}

async function createLead({ db, body, ip, authorization }) {
  const source = text(body.source, 20);
  if (!SOURCES.includes(source)) throw new ApiError(400, `source must be one of: ${SOURCES.join(', ')}`);
  const name = text(body.name, 100);
  const email = normalizeEmail(body.email).slice(0, 254);
  const phone = text(body.phone, 15).replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
  const message = text(body.message, 2000);
  const productId = text(body.productId, 64) || null;
  if (email && !EMAIL_RE.test(email)) throw new ApiError(400, 'Please enter a valid email address');
  if (phone && !PHONE_RE.test(phone)) throw new ApiError(400, 'Please enter a valid 10-digit mobile number');
  if ((email || phone) && body.consent !== true) throw new ApiError(400, 'Please tick the box to let us contact you about this.');
  if (source === 'newsletter' && !email) throw new ApiError(400, 'Please enter your email address');
  if (source !== 'newsletter' && message.length < 5) throw new ApiError(400, 'Please tell us a little about what you need');
  if (['contact', 'quote'].includes(source) && !email && !phone) throw new ApiError(400, 'Please give an email address or mobile number so we can reply');
  if (productId && !getProduct(productId)) throw new ApiError(400, 'Product not found');
  await limit(postgresStore(db), `lead:${ip}`, 10, 'You’ve sent a few messages just now. Please try again in 15 minutes.');

  const userId = optionalUserId(authorization);
  if (source === 'newsletter') {
    const [already] = await db(`SELECT id FROM leads WHERE source = 'newsletter' AND email = $1 LIMIT 1`, [email]);
    if (already) return { status: 200, body: { ok: true, message: 'You’re already subscribed. Thanks!' } };
  }
  const c = classifyLead({ source, message, productId, hasContact: Boolean(email || phone) });
  await insertLead(db, { ...c, source, userId, name, email, phone, productId, message, consent: body.consent === true });
  const reply = {
    newsletter: 'Thanks! You’ll get our offers by email. Unsubscribe any time from any email.',
    product: 'Thanks! We’ll reply about this product soon.',
    quote: 'Thanks! We’ll send you a quote within one working day.',
    contact: 'Thanks! We’ll get back to you within one working day.',
  }[source];
  return { status: 201, body: { ok: true, message: reply } };
}

/**
 * A lead from the shopping assistant, when a message states a clear need (a product or category, plus a budget or
 * urgency). Linked to the account when signed in; otherwise it holds no identity at all, only what was asked, and
 * counts as medium intent at most. At most one per need per day for each account, and for signed-out shoppers together.
 */
export async function recordAssistantLead(db, { userId = null, message }) {
  try {
    const c = classifyLead({ source: 'assistant', message, hasContact: Boolean(userId) });
    if (c.kind !== 'purchase' || !c.category || c.intent === 'low') return null;
    // Signed out: nobody to follow up, so it records demand at most medium intent and never alerts the team
    if (!userId && c.intent === 'high') c.intent = 'medium';
    const [dup] = await db(
      `SELECT id FROM leads WHERE source = 'assistant' AND user_id IS NOT DISTINCT FROM $1::int AND summary = $2 AND created_at > NOW() - INTERVAL '1 day'`,
      [userId, c.summary],
    );
    if (dup) return null;
    const [user] = userId ? await db('SELECT name, email, phone FROM users WHERE id = $1', [userId]) : [];
    return await insertLead(db, { ...c, source: 'assistant', userId, name: user?.name, email: user?.email, phone: user?.phone, message, consent: false });
  } catch (err) {
    console.error('assistant lead not saved', err.message); // a lost lead never breaks the chat
    return null;
  }
}

// The first order the lead's customer placed after the enquiry, matched by account or by email
const LIST_SQL = `
  SELECT l.*, o.id AS order_id, o.total AS order_total, o.created_at AS order_at
    FROM leads l
    LEFT JOIN LATERAL (
      SELECT o.id, o.total, o.created_at FROM orders o JOIN users u ON u.id = o.user_id
       WHERE o.created_at >= l.created_at AND o.status <> 'cancelled'
         AND (o.user_id = l.user_id OR (l.email IS NOT NULL AND u.email = l.email))
       ORDER BY o.created_at LIMIT 1
    ) o ON TRUE`;

async function admin(db, authorization) {
  const [user] = await db('SELECT id, role FROM users WHERE id = $1', [currentUserId(authorization)]);
  if (!user) throw new ApiError(401, 'Login required');
  if (user.role !== 'admin') throw new ApiError(403, 'Only the store team can see leads');
  return user;
}

async function listLeads({ db, params, authorization }) {
  await admin(db, authorization);
  const where = [];
  const args = [];
  for (const [field, allowed] of [['status', STATUSES], ['intent', INTENTS], ['source', [...SOURCES, 'assistant']]]) {
    if (params[field] && allowed.includes(params[field])) {
      args.push(params[field]);
      where.push(`l.${field} = $${args.length}`);
    }
  }
  const rows = await db(`${LIST_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.created_at DESC, l.id DESC LIMIT 500`, args);
  // Stats cover the listed leads (the filters apply to them too)
  const converted = rows.filter((r) => r.order_id).length;
  const contactable = rows.filter((r) => r.kind !== 'newsletter' && (r.user_id !== null || r.email)).length;
  return {
    body: {
      leads: rows.map(leadJson),
      stats: {
        total: rows.length,
        high: rows.filter((r) => r.intent === 'high').length,
        new: rows.filter((r) => r.status === 'new').length,
        converted,
        conversionRate: contactable ? Math.round((converted / contactable) * 1000) / 10 : null, // % of leads we could follow up
      },
    },
  };
}

async function updateLead({ db, id, body, authorization }) {
  await admin(db, authorization);
  if (!ID_RE.test(String(id))) throw new ApiError(404, 'Lead not found');
  const status = body.status === undefined ? null : text(body.status, 12);
  if (status !== null && !STATUSES.includes(status)) throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
  const notes = body.notes === undefined ? null : text(body.notes, 2000);
  const [row] = await db(
    `UPDATE leads SET status = COALESCE($2, status), notes = COALESCE($3, notes), updated_at = NOW() WHERE id = $1 RETURNING id`,
    [Number(id), status, notes],
  );
  if (!row) throw new ApiError(404, 'Lead not found');
  const [full] = await db(`${LIST_SQL} WHERE l.id = $1`, [row.id]);
  return { body: leadJson(full) };
}

function findRoute(method, rest) {
  if (rest.length === 0) return { POST: createLead, GET: listLeads }[method] ?? null;
  if (rest.length === 1 && method === 'PATCH') return updateLead;
  return null;
}

export const isLeadRoute = (method, rest) => Boolean(findRoute(method, rest));

export function handleLeads({ method, rest, body, params = {}, ip = 'unknown', authorization }, { db = query } = {}) {
  return safely(() => findRoute(method, rest)({ db, id: rest[0], body: body ?? {}, params, ip, authorization }));
}
