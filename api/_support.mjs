// Complaints and support tickets on the Vercel store: the same `support_tickets` table as backend/app/routers/support.py,
// plus a conversation (ticket_messages) between the shopper and the store team.
//
//   POST  /support/tickets               a shopper raises a ticket, optionally about one of their orders
//   GET   /support/tickets[?status=]     their own tickets; the admin sees everyone's, most urgent first
//   GET   /support/tickets/:id           one ticket with its conversation
//   POST  /support/tickets/:id/messages  a reply (a shopper's reply reopens a resolved ticket)
//   PATCH /support/tickets/:id           admin: open | in_progress | resolved
//
// The full API triages tickets with a trained model; here keyword rules pick the team, the urgency and a first answer.
import { ApiError, currentUserId, limit, postgresStore, query, safely } from './_auth.mjs';

export const CATEGORY_LABELS = {
  delivery: 'Delivery & tracking',
  returns: 'Returns & refunds',
  payment: 'Payments & billing',
  product: 'Product quality',
  account: 'Account & login',
  order_change: 'Order changes & cancellation',
};
const STATUSES = ['open', 'in_progress', 'resolved'];
const ID_RE = /^\d{1,9}$/;

// Words that point at each team. The highest score wins; ties go to the order listed here.
const KEYWORDS = {
  returns: ['return', 'refund', 'money back', 'replace', 'replacement', 'exchange', 'pickup', 'pick up', 'not refunded'],
  delivery: ['deliver', 'delivery', 'arrive', 'arrived', 'courier', 'track', 'tracking', 'shipped', 'shipping', 'package', 'parcel', 'late', 'delay', 'not received', 'missing'],
  payment: ['payment', 'paid', 'charged', 'charge', 'debited', 'deducted', 'upi', 'card', 'bank', 'invoice', 'bill', 'transaction', 'cod', 'cash'],
  product: ['damaged', 'broken', 'defective', 'quality', 'fake', 'wrong item', 'wrong product', 'size', 'fit', 'colour', 'color', 'not working', 'stopped working', 'warranty', 'expired'],
  order_change: ['cancel', 'cancellation', 'change address', 'modify', 'wrong address', 'change my order'],
  account: ['account', 'login', 'log in', 'sign in', 'password', 'otp', 'email', 'phone number', 'hacked', 'profile'],
};
const URGENT = ['urgent', 'immediately', 'asap', 'fraud', 'scam', 'cheat', 'charged twice', 'double charged', 'deducted twice', 'hacked', 'stolen', 'consumer court', 'legal action', 'police'];
const ANGRY = ['worst', 'terrible', 'horrible', 'pathetic', 'useless', 'angry', 'disappointed', 'frustrated', 'never again', 'unacceptable', 'still not', 'no response', 'again and again'];
const HAPPY = ['thanks', 'thank you', 'great', 'good', 'love', 'happy', 'excellent', 'awesome', 'helpful'];

const REPLIES = {
  delivery: 'Hi {name}, thanks for reaching out about your delivery{order}. Most orders arrive within 2–4 working days, and your order page shows the courier and tracking number once it ships. We’ve asked the courier for an update and will reply here within 24 hours.',
  returns: 'Hi {name}, you can return most items within 7 days of delivery from your order page{order}. Once the item is picked up, online payments are refunded to the account you paid from (usually 5–7 working days) and cash-on-delivery refunds go to the UPI ID or bank account you give us.',
  payment: 'Hi {name}, sorry for the payment trouble{order}. If money was debited but no order was placed, it is refunded automatically to the same account, usually within 5–7 working days. If you were charged twice, we’ll refund the extra amount. Our payments team is checking the transaction.',
  product: 'Hi {name}, we’re sorry the product isn’t right{order}. If it was delivered in the last 7 days you can start a return from your order page for a full refund. Please reply here with a photo of the item and its packaging so we can help faster.',
  account: 'Hi {name}, for account issues you can reset your password from the login page. If you think someone else used your account, change your password right away. We’ve flagged your account for a check.',
  order_change: 'Hi {name}, orders can be cancelled from your order page{order} until they ship, and online payments are refunded in full. Address and item changes aren’t possible after an order is placed, so the quickest fix is to cancel and order again.',
};

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const fail = (message, status = 400) => {
  throw new ApiError(status, message);
};
const count = (haystack, words) => words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);

/** The team, urgency, mood (-1 angry .. +1 happy) and a first answer for a new ticket. */
export function triage(subject, message, { name = 'there', orderId = null, refundStuck = false } = {}) {
  const all = ` ${subject} ${message} `.toLowerCase();
  let category = 'delivery';
  let best = 0;
  for (const [team, words] of Object.entries(KEYWORDS)) {
    const score = count(all, words) + (team === 'product' ? count(all, ['damaged', 'broken', 'defective']) : 0); // a broken item outranks "delivered"
    if (score > best) [category, best] = [team, score];
  }
  const angry = count(all, ANGRY);
  const happy = count(all, HAPPY);
  const sentiment = Math.max(-1, Math.min(1, (happy - angry * 1.5) / 3));
  const urgent = count(all, URGENT) > 0 || angry >= 2 || refundStuck;
  const priority = urgent ? 'high' : category === 'account' || sentiment > 0.3 ? 'low' : 'medium';
  const reply = REPLIES[category].replace('{name}', name.split(' ')[0] || 'there').replace('{order}', orderId ? ` (order #${orderId})` : '');
  return { category, categoryLabel: CATEGORY_LABELS[category], priority, sentiment: Math.round(sentiment * 1000) / 1000, confidence: best ? Math.min(0.95, 0.4 + best * 0.15) : 0.3, suggestedReply: reply };
}

const ticketJson = (t) => ({
  ...t,
  categoryLabel: CATEGORY_LABELS[t.category] ?? t.category,
  sentiment: t.sentiment === null || t.sentiment === undefined ? 0 : Number(t.sentiment),
  category_confidence: t.category_confidence === null || t.category_confidence === undefined ? null : Number(t.category_confidence),
});

async function account(db, userId) {
  const [u] = await db('SELECT id, name, role FROM users WHERE id = $1', [userId]);
  if (!u) fail('Please log in again', 401);
  return u;
}

/** The ticket, if this person may see it: its owner, or the admin. */
async function visibleTicket(db, user, id) {
  if (!ID_RE.test(String(id))) fail('Ticket not found', 404);
  const [t] = await db(
    `SELECT t.*, u.name AS customer_name, u.email AS customer_email FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
    [Number(id)],
  );
  if (!t || (user.role !== 'admin' && t.user_id !== user.id)) fail('Ticket not found', 404);
  if (user.role !== 'admin') delete t.customer_email;
  return t;
}

async function createTicket({ db, user, body, store }) {
  const subject = text(body.subject);
  const message = text(body.message);
  if (subject.length < 3 || subject.length > 200) fail('Please add a short subject (3 to 200 characters)');
  if (message.length < 10 || message.length > 4000) fail('Please describe the issue in a little more detail (at least 10 characters)');
  let orderId = null;
  if (body.orderId !== null && body.orderId !== undefined && body.orderId !== '') {
    if (!ID_RE.test(String(body.orderId))) fail('Order not found', 404);
    const [order] = await db('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [Number(body.orderId), user.id]);
    if (!order) fail('Order not found', 404);
    orderId = order.id;
  }
  await limit(store, `ticket:${user.id}`, 5, 'You’ve raised several tickets just now. Our team will get back to you soon.');
  // A refund that hasn't gone through is always urgent
  const [stuck] = orderId
    ? await db("SELECT 1 FROM order_returns WHERE order_id = $1 AND refund IN ('refund_pending', 'cod_manual')", [orderId])
    : [];
  const t = triage(subject, message, { name: user.name, orderId, refundStuck: Boolean(stuck) });
  const [ticket] = await db(
    `INSERT INTO support_tickets (user_id, order_id, subject, message, category, category_confidence, sentiment, priority, suggested_reply)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [user.id, orderId, subject, message, t.category, t.confidence, t.sentiment, t.priority, t.suggestedReply],
  );
  return { status: 201, body: ticketJson(ticket) };
}

async function listTickets({ db, user, params }) {
  const admin = user.role === 'admin';
  const args = [];
  const where = [];
  if (!admin) {
    args.push(user.id);
    where.push(`t.user_id = $${args.length}`);
  }
  if (STATUSES.includes(params.status)) {
    args.push(params.status);
    where.push(`t.status = $${args.length}`);
  }
  const order = admin
    ? "CASE t.status WHEN 'resolved' THEN 1 ELSE 0 END, CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.updated_at DESC"
    : 't.updated_at DESC';
  const rows = await db(
    `SELECT t.*, u.name AS customer_name,
            (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS replies,
            (SELECT m.staff FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_from_staff
       FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order} LIMIT 200`,
    args,
  );
  return { body: rows.map(ticketJson) };
}

async function getTicket({ db, user, id }) {
  const ticket = await visibleTicket(db, user, id);
  const messages = await db(
    `SELECT m.id, m.staff, m.body, m.created_at, CASE WHEN m.staff THEN 'Arvixa support' ELSE u.name END AS author
       FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.ticket_id = $1 ORDER BY m.created_at, m.id`,
    [ticket.id],
  );
  return { body: { ...ticketJson(ticket), messages } };
}

async function reply({ db, user, id, body, store }) {
  const ticket = await visibleTicket(db, user, id);
  const message = text(body.message);
  if (message.length < 2 || message.length > 4000) fail('Please write a reply');
  const staff = user.role === 'admin' && ticket.user_id !== user.id;
  await limit(store, `ticket-reply:${user.id}`, staff ? 200 : 30, 'Too many replies just now. Please try again in 15 minutes.');
  // Staff replying moves an open ticket to "in progress"; the shopper replying reopens a resolved one
  const next = staff ? (ticket.status === 'open' ? 'in_progress' : ticket.status) : ticket.status === 'resolved' ? 'open' : ticket.status;
  await db(
    `WITH said AS (
       INSERT INTO ticket_messages (ticket_id, user_id, staff, body) VALUES ($1, $2, $3, $4) RETURNING id
     )
     UPDATE support_tickets SET status = $5::varchar, updated_at = NOW(),
            resolved_at = CASE WHEN $5::varchar = 'resolved' THEN resolved_at ELSE NULL END
      WHERE id = $1 AND EXISTS (SELECT 1 FROM said)`,
    [ticket.id, user.id, staff, message, next],
  );
  return getTicket({ db, user, id });
}

async function setStatus({ db, user, id, body }) {
  if (user.role !== 'admin') fail('Only the store team can change a ticket’s status', 403);
  if (!STATUSES.includes(body.status)) fail(`status must be one of: ${STATUSES.join(', ')}`);
  const [ticket] = ID_RE.test(String(id))
    ? await db(
        `UPDATE support_tickets SET status = $1::varchar, updated_at = NOW(),
                resolved_at = CASE WHEN $1::varchar = 'resolved' THEN NOW() ELSE NULL END
          WHERE id = $2 RETURNING *`,
        [body.status, Number(id)],
      )
    : [];
  if (!ticket) fail('Ticket not found', 404);
  return { body: ticketJson(ticket) };
}

const ROUTES = {
  'POST tickets': createTicket,
  'GET tickets': listTickets,
  'GET tickets/:id': getTicket,
  'PATCH tickets/:id': setStatus,
  'POST tickets/:id/messages': reply,
};

function findRoute(method, rest) {
  const [first, second, third, ...extra] = rest;
  if (extra.length || first !== 'tickets') return null;
  const key = `${method} ${[first, second && ':id', third].filter(Boolean).join('/')}`;
  return Object.hasOwn(ROUTES, key) ? { key, id: second } : null;
}

export const isSupportRoute = (method, rest) => Boolean(findRoute(method, rest));

export function handleSupport({ method, rest, body, params = {}, authorization }, { db = query } = {}) {
  return safely(async () => {
    const userId = currentUserId(authorization);
    const { key, id } = findRoute(method, rest);
    const user = await account(db, userId);
    return ROUTES[key]({ db, user, id, body: body ?? {}, params, store: postgresStore(db) });
  });
}
