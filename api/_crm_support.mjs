// CRM support desk on the store's support_tickets / ticket_messages (the same tickets shoppers raise from Help and
// their order pages, api/_support.mjs). Adds owners, internal notes (never shown to the shopper), five statuses and
// response-time tracking:
//   Open → In progress → Waiting for customer → Resolved → Closed   (a shopper's reply reopens waiting/resolved/closed)
// First response = the first staff reply the shopper can see; resolution = when it was marked resolved or closed.
import { CATEGORY_LABELS, notifyReply, postReply, STATUSES, triage } from './_support.mjs';
import { assertAssignable, audit, can, fail, getSettings, ID_RE, like, mask, need, pageOf, paging, text, where } from './_crm_core.mjs';

const PRIORITIES = ['low', 'medium', 'high'];
const LIST = `
  SELECT t.id, t.user_id, t.order_id, t.subject, t.category, t.priority, t.status, t.sentiment::float, t.created_at, t.updated_at,
         t.first_response_at, t.resolved_at, t.closed_at, t.assigned_to, a.name AS assignee, u.name AS customer, u.email,
         (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id AND NOT m.internal) AS replies,
         (SELECT m.staff FROM ticket_messages m WHERE m.ticket_id = t.id AND NOT m.internal ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_from_staff
    FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to`;

function slaState(t, sla) {
  const hours = (a, b) => (new Date(b) - new Date(a)) / 3_600_000;
  const firstDue = new Date(new Date(t.created_at).getTime() + sla.firstResponseHours * 3_600_000);
  const responseBreached = t.first_response_at ? hours(t.created_at, t.first_response_at) > sla.firstResponseHours : !['resolved', 'closed'].includes(t.status) && Date.now() > firstDue;
  return { firstResponseDue: t.first_response_at ? null : firstDue.toISOString(), responseBreached, firstResponseHours: t.first_response_at ? Math.round(hours(t.created_at, t.first_response_at) * 10) / 10 : null };
}

const shape = (staff, sla) => (t) => ({ ...t, email: can(staff, 'customers.contact') ? t.email : mask(t.email), categoryLabel: CATEGORY_LABELS[t.category] ?? t.category, ...slaState(t, sla) });

export async function listTickets({ db, staff, params }) {
  const w = where();
  if (STATUSES.includes(params.status)) w.add('t.status = ?', params.status);
  else if (params.status !== 'all') w.raw("t.status IN ('open', 'in_progress', 'waiting')");
  if (PRIORITIES.includes(params.priority)) w.add('t.priority = ?', params.priority);
  if (Object.hasOwn(CATEGORY_LABELS, params.category ?? '')) w.add('t.category = ?', params.category);
  if (params.assigned === 'me') w.add('t.assigned_to = ?', staff.id);
  else if (params.assigned === 'none') w.raw('t.assigned_to IS NULL');
  else if (ID_RE.test(params.assigned ?? '')) w.add('t.assigned_to = ?', Number(params.assigned));
  if (ID_RE.test(params.customer ?? '')) w.add('t.user_id = ?', Number(params.customer));
  const q = text(params.q, 80).replace(/^#/, '');
  if (q) w.add(`(t.subject ILIKE ? OR t.message ILIKE ? OR u.name ILIKE ? ${ID_RE.test(q) ? 'OR t.id = ?' : ''})`, like(q), like(q), like(q), ...(ID_RE.test(q) ? [Number(q)] : []));
  const p = paging(params);
  const [{ total }] = await db(`SELECT count(*)::int AS total FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id ${w.sql()}`, w.args);
  const rows = await db(
    `${LIST} ${w.sql()} ORDER BY CASE WHEN t.status IN ('resolved', 'closed') THEN 1 ELSE 0 END,
       CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`,
    w.args,
  );
  const { support } = await getSettings(db);
  const [m] = await db(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
            count(*) FILTER (WHERE status = 'waiting')::int AS waiting,
            count(*) FILTER (WHERE status IN ('open', 'in_progress') AND priority = 'high')::int AS urgent,
            count(*) FILTER (WHERE status IN ('open', 'in_progress', 'waiting') AND assigned_to IS NULL)::int AS unassigned,
            ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM first_response_at - created_at) / 3600)
                   FILTER (WHERE first_response_at IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'))::numeric, 1)::float AS median_first_response_hours,
            ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM resolved_at - created_at) / 3600)
                   FILTER (WHERE resolved_at IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'))::numeric, 1)::float AS median_resolution_hours,
            count(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days' AND first_response_at IS NOT NULL
                               AND first_response_at - created_at > make_interval(hours => $1))::int AS breached_30d
       FROM support_tickets`,
    [support.firstResponseHours],
  );
  return { body: { ...pageOf(rows.map(shape(staff, support)), p, total), metrics: m, sla: support, categories: CATEGORY_LABELS } };
}

async function ticketRow(db, id) {
  if (!ID_RE.test(String(id))) fail('Ticket not found', 404);
  const [t] = await db(`${LIST.replace('t.sentiment::float,', 't.sentiment::float, t.message, t.suggested_reply, t.category_confidence::float,')} WHERE t.id = $1`, [Number(id)]);
  if (!t) fail('Ticket not found', 404);
  return t;
}

export async function getTicket({ db, staff, id }) {
  const t = await ticketRow(db, id);
  const messages = await db(
    `SELECT m.id, m.staff, m.internal, m.body, m.created_at, u.name AS author FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.ticket_id = $1 ORDER BY m.created_at, m.id`,
    [t.id],
  );
  const [order] = t.order_id ? await db('SELECT id, status, total::float, payment_method, created_at FROM orders WHERE id = $1', [t.order_id]) : [];
  const history = await db(`SELECT action, actor_name, details, created_at FROM crm_audit_log WHERE entity = 'ticket' AND entity_id = $1 ORDER BY created_at`, [String(t.id)]);
  const { support } = await getSettings(db);
  return { body: { ...shape(staff, support)(t), messages, order: order ?? null, history } };
}

export async function replyTicket({ db, staff, id, body }) {
  need(staff, 'support.edit');
  const t = await ticketRow(db, id);
  const message = text(body.message, 4000);
  if (message.length < 2) fail('Please write a reply');
  const internal = body.internal === true;
  const status = body.status === undefined ? null : STATUSES.includes(body.status) ? body.status : fail('Unknown status');
  const messageId = await postReply(db, { ticket: t, userId: staff.id, staff: true, message, internal, status });
  if (!internal) await notifyReply(db, t, messageId, message);
  await audit(db, staff, internal ? 'ticket.internal_note' : 'ticket.reply', 'ticket', t.id, status ? { status } : {});
  return getTicket({ db, staff, id: t.id });
}

export async function updateTicket({ db, staff, id, body }) {
  need(staff, 'support.edit');
  const t = await ticketRow(db, id);
  const sets = [];
  const args = [t.id];
  const changes = {};
  const set = (sql, value) => {
    args.push(value);
    sets.push(sql.replace('?', `$${args.length}`));
  };
  if (body.status !== undefined && body.status !== t.status) {
    if (!STATUSES.includes(body.status)) fail('Unknown status');
    set('status = ?::varchar', body.status);
    changes.status = `${t.status} → ${body.status}`;
  }
  if (body.priority !== undefined && body.priority !== t.priority) {
    if (!PRIORITIES.includes(body.priority)) fail('Unknown priority');
    set('priority = ?', body.priority);
    changes.priority = body.priority;
  }
  if (body.category !== undefined && body.category !== t.category) {
    if (!Object.hasOwn(CATEGORY_LABELS, body.category)) fail('Unknown category');
    set('category = ?', body.category);
    changes.category = body.category;
  }
  if (body.assignedTo !== undefined) {
    const who = body.assignedTo ? await assertAssignable(db, body.assignedTo, 'support.edit') : null;
    if ((who?.id ?? null) !== t.assigned_to) {
      set('assigned_to = ?', who?.id ?? null);
      changes.assignedTo = who ? who.name : 'nobody';
    }
  }
  if (!sets.length) return getTicket({ db, staff, id: t.id });
  await db(`UPDATE support_tickets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, args);
  // resolved_at / closed_at follow the new status

  if (changes.status) {
    await db(
      `UPDATE support_tickets SET resolved_at = CASE WHEN status IN ('resolved', 'closed') THEN COALESCE(resolved_at, NOW()) ELSE NULL END,
              closed_at = CASE WHEN status = 'closed' THEN COALESCE(closed_at, NOW()) ELSE NULL END WHERE id = $1`,
      [t.id],
    );
  }
  await audit(db, staff, changes.assignedTo ? 'ticket.assign' : 'ticket.update', 'ticket', t.id, changes);
  return getTicket({ db, staff, id: t.id });
}

/** A ticket raised by the team for a customer (a phone call, an email to the store) */
export async function createTicket({ db, staff, body }) {
  need(staff, 'support.edit');
  if (!ID_RE.test(String(body.customerId ?? ''))) fail('Please choose the customer');
  const [u] = await db("SELECT id, name FROM users WHERE id = $1 AND role <> 'admin'", [Number(body.customerId)]);
  if (!u) fail('Customer not found', 404);
  const subject = text(body.subject, 200);
  const message = text(body.message, 4000);
  if (subject.length < 3) fail('Please add a short subject');
  if (message.length < 10) fail('Please describe the issue (at least 10 characters)');
  let orderId = null;
  if (body.orderId) {
    const [o] = ID_RE.test(String(body.orderId)) ? await db('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [Number(body.orderId), u.id]) : [];
    if (!o) fail('That order doesn’t belong to this customer', 404);
    orderId = o.id;
  }
  const tr = triage(subject, message, { name: u.name, orderId });
  const priority = PRIORITIES.includes(body.priority) ? body.priority : tr.priority;
  const assignee = body.assignedTo ? await assertAssignable(db, body.assignedTo, 'support.edit') : null;
  const [t] = await db(
    `INSERT INTO support_tickets (user_id, order_id, subject, message, category, category_confidence, sentiment, priority, suggested_reply, assigned_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [u.id, orderId, subject, message, Object.hasOwn(CATEGORY_LABELS, body.category ?? '') ? body.category : tr.category, tr.confidence, tr.sentiment, priority, tr.suggestedReply, assignee?.id ?? null],
  );
  await audit(db, staff, 'ticket.create', 'ticket', t.id, { customerId: u.id, onBehalf: true });
  return { status: 201, body: (await getTicket({ db, staff, id: t.id })).body };
}
