// CRM customers. A customer is an account in `users` (everyone except the store admin), so website sign-ups and
// buyers are customers the moment they exist: there is no second copy to keep in sync. CRM-only details (tags, owner,
// dates, marketing consent per channel) live in crm_customer_profiles; notes and logged calls in crm_notes.
//
// Money: "spent" = the total of orders still in the 'placed' state (cancelled and returned orders don't count).
// Segments (lifecycle, from order history):
//   prospect  no orders           new       1 order, first in the last 60 days     one_time  1 order, 60–90 days ago
//   returning 2 orders, last ≤ 90 days     loyal     3+ orders, last ≤ 90 days
//   at_risk   last order 90–180 days ago   lost      last order more than 180 days ago
import {
  assertAssignable, audit, can, cleanPhone, DATE_RE, EMAIL_RE, fail, ID_RE, like, mask, need, pageOf, paging, PHONE_RE, text, where,
} from './_crm_core.mjs';

export const SEGMENTS = {
  prospect: 'Prospect (no orders)',
  new: 'New customer',
  one_time: 'One-time buyer',
  returning: 'Returning',
  loyal: 'Loyal',
  at_risk: 'At risk',
  lost: 'Lost',
};

export const CUSTOMER_STATS = `
  SELECT u.id, u.customer_code, u.name, u.email, u.phone, u.phone_verified, u.email_verified, u.role, u.created_at, u.last_login, u.disabled_at,
         COALESCE(p.tags, '[]'::jsonb) AS tags, p.assigned_to, a.name AS assignee_name,
         to_char(p.birthday, 'YYYY-MM-DD') AS birthday, to_char(p.anniversary, 'YYYY-MM-DD') AS anniversary,
         COALESCE(p.email_opt_in, FALSE) AS email_opt_in, COALESCE(p.sms_opt_in, FALSE) AS sms_opt_in,
         COALESCE(p.whatsapp_opt_in, FALSE) AS whatsapp_opt_in, COALESCE(p.source, 'website') AS source,
         COUNT(o.id) FILTER (WHERE o.status <> 'cancelled')::int AS orders,
         COALESCE(SUM(o.total) FILTER (WHERE o.status = 'placed'), 0)::float AS spent,
         MAX(o.created_at) FILTER (WHERE o.status <> 'cancelled') AS last_order,
         MIN(o.created_at) FILTER (WHERE o.status <> 'cancelled') AS first_order
    FROM users u
    LEFT JOIN crm_customer_profiles p ON p.user_id = u.id
    LEFT JOIN users a ON a.id = p.assigned_to
    LEFT JOIN orders o ON o.user_id = u.id
   WHERE u.role <> 'admin'
   GROUP BY u.id, p.user_id, a.name`;
export const SEGMENT_SQL = `CASE
    WHEN s.orders = 0 THEN 'prospect'
    WHEN s.last_order < NOW() - INTERVAL '180 days' THEN 'lost'
    WHEN s.last_order < NOW() - INTERVAL '90 days' THEN 'at_risk'
    WHEN s.orders >= 3 THEN 'loyal'
    WHEN s.orders = 2 THEN 'returning'
    WHEN s.first_order > NOW() - INTERVAL '60 days' THEN 'new'
    ELSE 'one_time' END`;

function shape(staff) {
  const full = can(staff, 'customers.contact');
  return (r) => ({
    ...r,
    email: full ? r.email : mask(r.email),
    phone: full ? r.phone : mask(r.phone),
    masked: !full,
    status: r.disabled_at ? 'inactive' : 'active',
    averageOrder: r.orders ? Math.round(r.spent / r.orders) : 0,
    segmentLabel: SEGMENTS[r.segment] ?? r.segment,
  });
}

function filters(params, staff) {
  const w = where();
  const q = text(params.q, 100);
  if (q) {
    const digits = q.replace(/\D/g, '');
    w.add(`(s.name ILIKE ? OR s.email ILIKE ? OR s.customer_code ILIKE ? ${digits.length >= 4 ? 'OR s.phone LIKE ?' : ''} ${ID_RE.test(q) ? 'OR s.id = ?' : ''})`,
      like(q), like(q), like(q), ...(digits.length >= 4 ? [`%${digits}%`] : []), ...(ID_RE.test(q) ? [Number(q)] : []));
  }
  if (params.status === 'active') w.raw('s.disabled_at IS NULL');
  if (params.status === 'inactive') w.raw('s.disabled_at IS NOT NULL');
  if (Object.hasOwn(SEGMENTS, params.segment ?? '')) w.add('s.segment = ?', params.segment);
  if (text(params.tag, 30)) w.add('s.tags @> jsonb_build_array(?::text)', text(params.tag, 30));
  if (params.assigned === 'me') w.add('s.assigned_to = ?', staff.id);
  else if (params.assigned === 'none') w.raw('s.assigned_to IS NULL');
  else if (ID_RE.test(params.assigned ?? '')) w.add('s.assigned_to = ?', Number(params.assigned));
  if (DATE_RE.test(params.joinedFrom ?? '')) w.add('s.created_at >= ?::date', params.joinedFrom);
  if (DATE_RE.test(params.joinedTo ?? '')) w.add('s.created_at < ?::date + 1', params.joinedTo);
  if (Number(params.minSpent) > 0) w.add('s.spent >= ?', Number(params.minSpent));
  if (params.consent && ['email', 'sms', 'whatsapp'].includes(params.consent)) w.raw(`s.${params.consent}_opt_in`);
  return w;
}

const SORTS = {
  joined: 's.created_at DESC', name: 's.name ASC', spent: 's.spent DESC', orders: 's.orders DESC',
  last_order: 's.last_order DESC NULLS LAST', last_login: 's.last_login DESC NULLS LAST',
};

export async function listCustomers({ db, staff, params }, { max = 100 } = {}) {
  const w = filters(params, staff);
  const p = paging(params, max);
  const base = `SELECT s.*, ${SEGMENT_SQL} AS segment FROM (${CUSTOMER_STATS}) s`;
  const [{ total }] = await db(`SELECT count(*)::int AS total FROM (${base}) s ${w.sql().replace(/\bsegment\b/g, 's.segment')}`, w.args);
  const rows = await db(
    `SELECT * FROM (${base}) s ${w.sql().replace(/\bsegment\b/g, 's.segment')} ORDER BY ${SORTS[params.sort] || SORTS.joined}, s.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`,
    w.args,
  );
  const tags = await db(`SELECT t AS tag, count(*)::int AS count FROM crm_customer_profiles, jsonb_array_elements_text(tags) t GROUP BY t ORDER BY count DESC, t LIMIT 50`);
  return { body: { ...pageOf(rows.map(shape(staff)), p, total), tags, segments: SEGMENTS } };
}

export async function exportCustomers({ db, staff, params }) {
  const { body } = await listCustomers({ db, staff, params: { ...params, page: 1, pageSize: 5000 } }, { max: 5000 });
  await audit(db, staff, 'customers.export', 'customer', null, { rows: body.items.length, filters: params, masked: !can(staff, 'customers.contact') });
  return { body: { rows: body.items.map((c) => ({
    customerId: c.customer_code, name: c.name, email: c.email, phone: c.phone, status: c.status, segment: c.segmentLabel, orders: c.orders, spent: c.spent,
    averageOrder: c.averageOrder, lastOrder: c.last_order, joined: c.created_at, tags: (c.tags || []).join('; '), assignedTo: c.assignee_name || '',
    emailOptIn: c.email_opt_in, smsOptIn: c.sms_opt_in, whatsappOptIn: c.whatsapp_opt_in,
  })), total: body.total } };
}

async function customerRow(db, id) {
  if (!ID_RE.test(String(id))) fail('Customer not found', 404);
  const [row] = await db(`SELECT s.*, ${SEGMENT_SQL} AS segment FROM (${CUSTOMER_STATS}) s WHERE s.id = $1`, [Number(id)]);
  if (!row) fail('Customer not found', 404);
  return row;
}

export async function getCustomer({ db, staff, id }) {
  const c = shape(staff)(await customerRow(db, id));
  const uid = c.id;
  const [addresses, orders, notes, tasks, leads, tickets, messages, reviews, returns] = await Promise.all([
    db('SELECT id, name, phone, line1, city, state, pincode, type, created_at FROM addresses WHERE user_id = $1 ORDER BY created_at DESC', [uid]),
    db(
      `SELECT o.id, o.created_at, o.status, o.total::float, o.payment_method, o.coupon_code,
              json_agg(json_build_object('name', oi.name, 'qty', oi.qty, 'price', oi.price, 'fulfilment', oi.fulfilment, 'image', oi.image) ORDER BY oi.id) AS items,
              MIN(array_position(ARRAY['pending','packed','shipped','delivered'], oi.fulfilment::text)) AS step,
              (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status,
              (SELECT r.status FROM order_returns r WHERE r.order_id = o.id) AS return_status
         FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.user_id = $1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100`,
      [uid],
    ),
    db(`SELECT n.id, n.kind, n.body, n.outcome, n.happened_at, n.author_id, u.name AS author FROM crm_notes n LEFT JOIN users u ON u.id = n.author_id
         WHERE n.entity = 'customer' AND n.entity_id = $1 AND n.deleted_at IS NULL ORDER BY n.happened_at DESC, n.id DESC`, [String(uid)]),
    db(`SELECT t.id, t.title, t.status, t.priority, t.due_at, u.name AS assignee FROM crm_tasks t LEFT JOIN users u ON u.id = t.assigned_to
         WHERE t.customer_id = $1 AND t.deleted_at IS NULL ORDER BY t.due_at NULLS LAST`, [uid]),
    db(`SELECT id, source, kind, status, summary, created_at FROM leads WHERE user_id = $1 OR (email IS NOT NULL AND lower(email) = lower($2)) ORDER BY created_at DESC`, [uid, c.masked ? '' : c.email]),
    db(`SELECT id, subject, category, priority, status, created_at, resolved_at FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC`, [uid]),
    db(`SELECT id, channel, direction, kind, event, subject, status, created_at, error FROM crm_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [uid]),
    db(`SELECT product_id, rating, title, created_at FROM product_reviews WHERE user_id = $1 ORDER BY created_at DESC`, [uid]),
    db(`SELECT order_id, status, refund, amount::float, created_at FROM order_returns WHERE user_id = $1 ORDER BY created_at DESC`, [uid]),
  ]);
  const STEPS = ['pending', 'packed', 'shipped', 'delivered'];
  // Everything that happened with this person, newest first
  const timeline = [
    { at: c.created_at, type: 'account', text: `Account created${c.source !== 'website' ? ` (${c.source})` : ''}` },
    ...(c.last_login ? [{ at: c.last_login, type: 'account', text: 'Last login' }] : []),
    ...orders.map((o) => ({ at: o.created_at, type: 'order', text: `Order #${o.id} · ₹${Math.round(o.total).toLocaleString('en-IN')} · ${o.status}`, ref: o.id })),
    ...returns.map((r) => ({ at: r.created_at, type: 'return', text: `Return on order #${r.order_id}: ${r.status}${r.refund ? ` (${r.refund.replace('_', ' ')})` : ''}`, ref: r.order_id })),
    ...tickets.map((t) => ({ at: t.created_at, type: 'ticket', text: `Ticket #${t.id}: ${t.subject} (${t.status.replace('_', ' ')})`, ref: t.id })),
    ...leads.map((l) => ({ at: l.created_at, type: 'lead', text: `Lead #${l.id} (${l.source.replace('_', ' ')}): ${l.status}`, ref: l.id })),
    ...notes.map((n) => ({ at: n.happened_at, type: n.kind, text: `${n.kind === 'note' ? 'Note' : n.kind[0].toUpperCase() + n.kind.slice(1)} by ${n.author || 'team'}: ${n.body.slice(0, 160)}` })),
    ...messages.map((m) => ({ at: m.created_at, type: 'message', text: `${m.direction === 'in' ? 'Received' : 'Sent'} ${m.channel}: ${m.subject || m.event || m.kind} (${m.status})` })),
    ...reviews.map((r) => ({ at: r.created_at, type: 'review', text: `Reviewed a product: ${r.rating}★ ${r.title}` })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  return {
    body: {
      ...c,
      addresses: can(staff, 'customers.contact') ? addresses : addresses.map((a) => ({ ...a, phone: mask(a.phone), line1: '••••', masked: true })),
      orders: orders.map(({ step, ...o }) => ({ ...o, fulfilment: STEPS[(step || 1) - 1] })),
      notes, tasks, leads, tickets, messages, returns, timeline: timeline.slice(0, 200),
    },
  };
}

// ---------- Changes ----------
const TAG_RE = /^[\p{L}\p{N} _&+-]{1,30}$/u;
function cleanTags(tags) {
  if (!Array.isArray(tags)) fail('Tags must be a list');
  const out = [...new Set(tags.map((t) => text(t, 30)).filter(Boolean))];
  if (out.length > 15) fail('At most 15 tags per customer');
  for (const t of out) if (!TAG_RE.test(t)) fail(`“${t}” isn’t a valid tag (letters, numbers, spaces and - _ & + only)`);
  return out;
}
const optionalDate = (v, label) => {
  if (v === null || v === '' || v === undefined) return null;
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || v > new Date().toISOString().slice(0, 10)) fail(`Please enter a valid ${label}`);
  return v;
};

async function upsertProfile(db, userId, fields, staffId) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const values = cols.map((k) => (k === 'tags' ? JSON.stringify(fields[k]) : fields[k]));
  await db(
    `INSERT INTO crm_customer_profiles (user_id, created_by, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((k, i) => `$${i + 3}${k === 'tags' ? '::jsonb' : ''}`).join(', ')})
     ON CONFLICT (user_id) DO UPDATE SET ${cols.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = NOW()`,
    [userId, staffId, ...values],
  );
}

function contactFields(body, { requireEmail = true } = {}) {
  const name = text(body.name, 100);
  const email = text(body.email, 254).toLowerCase();
  const phone = cleanPhone(body.phone);
  if (name.length < 2) fail('Please enter the customer’s full name');
  if (requireEmail && !EMAIL_RE.test(email)) fail('Please enter a valid email address');
  if (phone && !PHONE_RE.test(phone)) fail('Please enter a valid 10-digit mobile number');
  return { name, email, phone: phone || null };
}

function consentFields(body) {
  const out = {};
  for (const ch of ['email', 'sms', 'whatsapp']) if (typeof body[`${ch}OptIn`] === 'boolean') out[`${ch}_opt_in`] = body[`${ch}OptIn`];
  if (Object.values(out).some(Boolean) && body.consentConfirmed !== true) fail('Only record marketing consent the customer actually gave: please confirm it');
  if (Object.keys(out).length) out.consent_updated_at = new Date().toISOString();
  return out;
}

/** Duplicate rules: an email is one account (unique); a phone number already on another account needs confirming. */
async function duplicateCheck(db, { email, phone }, exceptId = null, allowPhone = false) {
  if (email) {
    const [e] = await db('SELECT id, name FROM users WHERE lower(email) = $1 AND id IS DISTINCT FROM $2', [email, exceptId]);
    if (e) fail(`A customer with this email already exists (#${e.id} ${e.name})`, 409);
  }
  if (phone && !allowPhone) {
    const [p] = await db('SELECT id, name, phone_verified FROM users WHERE phone = $1 AND id IS DISTINCT FROM $2 ORDER BY phone_verified DESC LIMIT 1', [phone, exceptId]);
    if (p?.phone_verified) fail(`This mobile number is verified on another account (#${p.id} ${p.name})`, 409);
    if (p) fail(`This mobile number is already on customer #${p.id} (${p.name}). Confirm if they are different people.`, 409);
  }
}

export async function createCustomer({ db, staff, body }) {
  const contact = contactFields(body);
  await duplicateCheck(db, contact, null, body.confirmDuplicatePhone === true);
  // No password: the customer signs in with a one-time code or sets a password with "Forgot password"
  const [u] = await db(
    `INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, $2, $3, NULL, 'customer') ON CONFLICT (email) DO NOTHING RETURNING id`,
    [contact.name, contact.email, contact.phone],
  );
  if (!u) fail('A customer with this email already exists', 409);
  const profile = { source: 'crm', ...consentFields(body) };
  if (body.tags) profile.tags = cleanTags(body.tags);
  if (body.birthday) profile.birthday = optionalDate(body.birthday, 'birthday');
  if (body.anniversary) profile.anniversary = optionalDate(body.anniversary, 'anniversary');
  if (body.assignedTo) profile.assigned_to = (await assertAssignable(db, body.assignedTo, 'customers.view')).id;
  await upsertProfile(db, u.id, profile, staff.id);
  await audit(db, staff, 'customer.create', 'customer', u.id, { name: contact.name, source: 'crm' });
  return { status: 201, body: (await getCustomer({ db, staff, id: u.id })).body };
}

export async function updateCustomer({ db, staff, id, body }) {
  const before = await customerRow(db, id);
  const changes = {};
  if (body.name !== undefined || body.phone !== undefined) {
    const contact = contactFields({ name: body.name ?? before.name, phone: body.phone ?? before.phone }, { requireEmail: false });
    if (contact.phone !== before.phone) await duplicateCheck(db, { phone: contact.phone }, before.id, body.confirmDuplicatePhone === true);
    if (contact.name !== before.name || contact.phone !== before.phone) {
      await db(
        `UPDATE users SET name = $2, phone = $3::varchar, phone_verified = CASE WHEN phone IS DISTINCT FROM $3::varchar THEN FALSE ELSE phone_verified END WHERE id = $1`,
        [before.id, contact.name, contact.phone],
      );
      Object.assign(changes, { name: contact.name, phone: contact.phone ? 'changed' : null });
    }
  }
  const profile = consentFields(body);
  if (body.tags !== undefined) profile.tags = cleanTags(body.tags);
  if (body.birthday !== undefined) profile.birthday = optionalDate(body.birthday, 'birthday');
  if (body.anniversary !== undefined) profile.anniversary = optionalDate(body.anniversary, 'anniversary');
  if (body.assignedTo !== undefined) profile.assigned_to = body.assignedTo ? (await assertAssignable(db, body.assignedTo, 'customers.view')).id : null;
  await upsertProfile(db, before.id, profile, staff.id);
  Object.assign(changes, profile);
  if (body.status !== undefined) {
    if (!['active', 'inactive'].includes(body.status)) fail('status must be active or inactive');
    if (before.id === staff.id) fail('You can’t deactivate your own account');
    const [isStaff] = await db('SELECT 1 FROM crm_staff WHERE user_id = $1 AND active', [before.id]);
    if (isStaff && body.status === 'inactive') fail('Remove this person’s CRM access under Team before deactivating their account');
    if (body.status === 'inactive' && !before.disabled_at) {
      // Login is refused and every open session ends at once
      await db('UPDATE users SET disabled_at = NOW(), sessions_revoked_at = NOW() WHERE id = $1', [before.id]);
      changes.status = 'inactive';
    } else if (body.status === 'active' && before.disabled_at) {
      await db('UPDATE users SET disabled_at = NULL WHERE id = $1', [before.id]);
      changes.status = 'active';
    }
    if (body.status === 'inactive' && body.reason) changes.reason = text(body.reason, 300);
  }
  if (Object.keys(changes).length) {
    const action = changes.status ? `customer.${changes.status === 'inactive' ? 'deactivate' : 'activate'}` : profile.assigned_to !== undefined ? 'customer.assign' : 'customer.update';
    await audit(db, staff, action, 'customer', before.id, changes);
  }
  return getCustomer({ db, staff, id: before.id });
}

// ---------- Import ----------
const MAX_IMPORT = 1000;
/** Rows from a CSV the browser parsed: { name, email, phone, tags, birthday, emailOptIn }. dryRun checks without saving. */
export async function importCustomers({ db, staff, body }) {
  const rows = Array.isArray(body.rows) ? body.rows : fail('Please choose a file with customers');
  if (!rows.length) fail('The file has no customer rows');
  if (rows.length > MAX_IMPORT) fail(`At most ${MAX_IMPORT} customers per import`);
  if (rows.some((r) => r?.emailOptIn === true || r?.emailOptIn === 'yes') && body.consentConfirmed !== true) {
    fail('The file marks some customers as agreeing to marketing emails. Confirm that you have their consent, or remove that column.');
  }
  const existing = await db('SELECT lower(email) AS email FROM users WHERE lower(email) = ANY($1::text[])', [rows.map((r) => text(r?.email, 254).toLowerCase())]);
  const taken = new Set(existing.map((e) => e.email));
  const seen = new Set();
  const results = [];
  for (const [i, raw] of rows.entries()) {
    const line = i + 2; // row 1 is the header
    try {
      const contact = contactFields(raw || {});
      if (seen.has(contact.email)) throw new Error('Same email appears earlier in the file');
      seen.add(contact.email);
      if (taken.has(contact.email)) {
        results.push({ line, email: contact.email, result: 'skipped', reason: 'Already a customer' });
        continue;
      }
      const tags = raw.tags ? cleanTags(String(raw.tags).split(/[;|]/)) : [];
      const birthday = raw.birthday ? optionalDate(String(raw.birthday), 'birthday') : null;
      const optIn = raw.emailOptIn === true || String(raw.emailOptIn).toLowerCase() === 'yes';
      if (!body.dryRun) {
        const [u] = await db(`INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, $2, $3, NULL, 'customer') ON CONFLICT (email) DO NOTHING RETURNING id`, [contact.name, contact.email, contact.phone]);
        if (!u) {
          results.push({ line, email: contact.email, result: 'skipped', reason: 'Already a customer' });
          continue;
        }
        await upsertProfile(db, u.id, { source: 'import', tags, birthday, email_opt_in: optIn, ...(optIn ? { consent_updated_at: new Date().toISOString() } : {}) }, staff.id);
        results.push({ line, email: contact.email, result: 'created', id: u.id });
      } else results.push({ line, email: contact.email, result: 'ok' });
    } catch (err) {
      results.push({ line, email: text(raw?.email, 254), result: 'error', reason: err.message });
    }
  }
  const counts = results.reduce((c, r) => ({ ...c, [r.result]: (c[r.result] || 0) + 1 }), {});
  if (!body.dryRun) await audit(db, staff, 'customers.import', 'customer', null, counts);
  return { body: { dryRun: Boolean(body.dryRun), counts, results } };
}

// ---------- Notes and logged interactions (customers, leads, orders, tickets) ----------
const NOTE_KINDS = ['note', 'call', 'meeting', 'email', 'sms', 'whatsapp'];
const NOTE_ENTITIES = { customer: 'customers.view', lead: 'leads.view', order: 'sales.view', ticket: 'support.view' };

export async function addNote({ db, staff, body }) {
  const entity = Object.hasOwn(NOTE_ENTITIES, body.entity ?? '') ? body.entity : fail('Unknown record type');
  need(staff, NOTE_ENTITIES[entity]);
  if (!ID_RE.test(String(body.entityId ?? ''))) fail('Record not found', 404);
  const table = { customer: 'users', lead: 'leads', order: 'orders', ticket: 'support_tickets' }[entity];
  const [exists] = await db(`SELECT 1 FROM ${table} WHERE id = $1`, [Number(body.entityId)]);
  if (!exists) fail('Record not found', 404);
  const kind = NOTE_KINDS.includes(body.kind) ? body.kind : 'note';
  const note = text(body.body, 4000);
  if (note.length < 2) fail('Please write the note');
  const at = body.happenedAt && !Number.isNaN(Date.parse(body.happenedAt)) ? new Date(body.happenedAt) : new Date();
  if (at > new Date(Date.now() + 60_000)) fail('A logged call or meeting can’t be in the future: add a task for that instead');
  const [row] = await db(
    `INSERT INTO crm_notes (entity, entity_id, kind, body, outcome, happened_at, author_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [entity, String(Number(body.entityId)), kind, note, text(body.outcome, 120) || null, at.toISOString(), staff.id],
  );
  if (entity === 'lead') {
    await db("UPDATE leads SET updated_at = NOW(), status = CASE WHEN status = 'new' AND $2 IN ('call', 'meeting', 'email', 'sms', 'whatsapp') THEN 'contacted' ELSE status END WHERE id = $1", [Number(body.entityId), kind]);
  }
  await audit(db, staff, `${entity}.${kind === 'note' ? 'note' : 'log_activity'}`, entity, body.entityId, { kind });
  return { status: 201, body: { ...row, author: staff.name } };
}

export async function deleteNote({ db, staff, id }) {
  if (!ID_RE.test(String(id))) fail('Note not found', 404);
  const [n] = await db('SELECT * FROM crm_notes WHERE id = $1 AND deleted_at IS NULL', [Number(id)]);
  if (!n) fail('Note not found', 404);
  if (n.author_id !== staff.id && !can(staff, 'customers.edit')) fail('Only the author or a manager can remove a note', 403);
  await db('UPDATE crm_notes SET deleted_at = NOW() WHERE id = $1', [n.id]);
  await audit(db, staff, 'note.delete', n.entity, n.entity_id, { noteId: n.id });
  return { status: 204, body: null };
}
