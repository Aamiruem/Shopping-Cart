// CRM lead pipeline on top of api/_leads.mjs (forms, classification, stage changes).
//
// Automatic capture (syncAutoLeads, at most once a minute, from the dashboard, the lead list and the daily cron):
//   registration    a shopper who signed up and hasn't ordered yet: one lead per account (unique index)
//   abandoned_cart  items left in a cart for N hours (CRM → Settings) with no order since: one open lead per shopper
//   conversion      an open lead whose person placed an order after it arrived moves to "Converted" with the order noted
//   auto-assign     optional: new leads go to the sales team member with the fewest open leads
// WhatsApp messages become leads in captureWhatsApp (called from the WhatsApp webhook).
//
// Lead score (0–100) is a transparent points system with its reasons listed, not a trained model.
import { getProduct } from './_catalog.mjs';
import { classifyLead, COLUMNS, FROM, KIND_LABELS, leadJson, OPEN_STATUSES, STATUSES } from './_leads.mjs';
import {
  assertAssignable, assignable, audit, can, cleanPhone, EMAIL_RE, fail, getSettings, ID_RE, like, need, pageOf, paging, PHONE_RE, text, throttled, where,
} from './_crm_core.mjs';

const OPEN_SQL = `('${OPEN_STATUSES.join("', '")}')`;

/** Runs the automatic capture now (`force`) or at most once a minute. Returns what changed. */
export async function syncAutoLeads(db, { force = false } = {}) {
  const run = async () => {
    const settings = await getSettings(db);
    const out = { registration: 0, abandonedCart: 0, converted: 0, assigned: 0 };
    if (settings.leads.registrationLeads) {
      const rows = await db(
        `INSERT INTO leads (source, kind, name, email, phone, user_id, intent, summary, marketing_consent, consent_at, created_at)
         SELECT 'registration', 'registration', u.name, u.email, u.phone, u.id, 'low', 'New sign-up, no order yet',
                COALESCE(p.email_opt_in, FALSE), u.created_at, u.created_at
           FROM users u LEFT JOIN crm_customer_profiles p ON p.user_id = u.id
          WHERE u.role = 'customer' AND u.disabled_at IS NULL AND u.created_at > NOW() - INTERVAL '60 days'
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM crm_staff s WHERE s.user_id = u.id)
         ON CONFLICT (user_id) WHERE source = 'registration' DO NOTHING RETURNING id`,
      );
      out.registration = rows.length;
    }
    if (settings.leads.abandonedCartLeads) out.abandonedCart = await captureAbandonedCarts(db, settings.leads.abandonedCartHours);
    // Converted: an order placed after the lead came in, by the same account or email address
    const won = await db(
      `WITH c AS (
         SELECT l.id, (SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id
                        WHERE (o.user_id = l.user_id OR (l.email IS NOT NULL AND lower(u.email) = lower(l.email)))
                          AND o.created_at >= l.created_at AND o.status <> 'cancelled' ORDER BY o.created_at LIMIT 1) AS order_id
           FROM leads l WHERE l.status IN ${OPEN_SQL} AND l.source <> 'newsletter')
       UPDATE leads SET status = 'won', updated_at = NOW(),
              notes = notes || jsonb_build_array(jsonb_build_object('at', NOW(), 'by', 'CRM', 'text', 'Converted: placed order #' || c.order_id))
         FROM c WHERE leads.id = c.id AND c.order_id IS NOT NULL RETURNING leads.id`,
    );
    out.converted = won.length;
    if (settings.leads.autoAssign) out.assigned = await autoAssign(db);
    return out;
  };
  return force ? run() : throttled(db, 'auto-leads', 60, run);
}

async function captureAbandonedCarts(db, hours) {
  const carts = await db(
    `SELECT c.user_id, u.name, u.email, u.phone, COALESCE(p.email_opt_in, FALSE) AS consent,
            json_agg(json_build_object('productId', c.product_id, 'qty', c.qty) ORDER BY c.added_at) AS items, MIN(c.added_at) AS since
       FROM cart_items c JOIN users u ON u.id = c.user_id LEFT JOIN crm_customer_profiles p ON p.user_id = u.id
      WHERE u.disabled_at IS NULL
      GROUP BY c.user_id, u.name, u.email, u.phone, p.email_opt_in
     HAVING MAX(c.added_at) < NOW() - make_interval(hours => $1)
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = c.user_id AND o.created_at > MIN(c.added_at))`,
    [hours],
  );
  let n = 0;
  for (const cart of carts) {
    const lines = cart.items.map((i) => ({ ...i, p: getProduct(i.productId) })).filter((i) => i.p);
    if (!lines.length) continue;
    const value = lines.reduce((s, i) => s + i.p.price * i.qty, 0);
    const units = lines.reduce((s, i) => s + i.qty, 0);
    const summary = `Abandoned cart · ${units} item${units === 1 ? '' : 's'} · ₹${Math.round(value).toLocaleString('en-IN')} — ${lines.slice(0, 3).map((i) => i.p.name).join(', ')}`;
    const rows = await db(
      `INSERT INTO leads (source, kind, name, email, phone, user_id, product_id, budget, quantity, intent, summary, matches, marketing_consent, consent_at, created_at)
       VALUES ('abandoned_cart', 'abandoned_cart', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NOW(), $12)
       ON CONFLICT (user_id) WHERE source = 'abandoned_cart' AND status IN ${OPEN_SQL}
       DO UPDATE SET summary = EXCLUDED.summary, budget = EXCLUDED.budget, quantity = EXCLUDED.quantity, matches = EXCLUDED.matches,
                     intent = EXCLUDED.intent, updated_at = NOW()
         WHERE leads.summary IS DISTINCT FROM EXCLUDED.summary
       RETURNING (xmax = 0) AS inserted`,
      [cart.name, cart.email, cart.phone, cart.user_id, lines[0].productId, Math.round(value), units, value >= 5000 ? 'high' : 'medium', summary,
        JSON.stringify(lines.map((i) => i.productId).slice(0, 6)), cart.consent, cart.since],
    );
    if (rows[0]?.inserted) n++;
  }
  return n;
}

/** New, unassigned leads → the active sales team member with the fewest open leads */
async function autoAssign(db) {
  const team = (await assignable(db, 'leads.edit')).filter((t) => t.role !== 'super_admin' && t.role !== 'admin');
  if (!team.length) return 0;
  const loads = await db(`SELECT assigned_to, count(*)::int AS n FROM leads WHERE status IN ${OPEN_SQL} AND assigned_to = ANY($1::int[]) GROUP BY 1`, [team.map((t) => t.id)]);
  const load = new Map(team.map((t) => [t.id, loads.find((l) => l.assigned_to === t.id)?.n ?? 0]));
  const fresh = await db(`SELECT id FROM leads WHERE assigned_to IS NULL AND status = 'new' AND source <> 'newsletter' ORDER BY created_at LIMIT 200`);
  for (const lead of fresh) {
    const [who] = [...load.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
    const person = team.find((t) => t.id === who);
    await db(
      `UPDATE leads SET assigned_to = $2, updated_at = NOW(), notes = notes || jsonb_build_array(jsonb_build_object('at', NOW(), 'by', 'CRM', 'text', $3::text)) WHERE id = $1 AND assigned_to IS NULL`,
      [lead.id, who, `Assigned automatically to ${person.name}`],
    );
    load.set(who, load.get(who) + 1);
  }
  return fresh.length;
}

/** WhatsApp message → a lead (one open WhatsApp lead per number; later messages are added to it) */
export async function captureWhatsApp(db, { phone, name, message }) {
  const digits = cleanPhone(phone).slice(-10);
  if (!PHONE_RE.test(digits) || !message) return null;
  const [open] = await db(`SELECT id FROM leads WHERE source = 'whatsapp' AND phone = $1 AND status IN ${OPEN_SQL} ORDER BY created_at DESC LIMIT 1`, [digits]);
  if (open) {
    await db(`UPDATE leads SET notes = notes || $2::jsonb, updated_at = NOW() WHERE id = $1`, [open.id, JSON.stringify([{ at: new Date().toISOString(), by: name || 'WhatsApp', text: `WhatsApp: ${message.slice(0, 2000)}` }])]);
    return open.id;
  }
  const [user] = await db('SELECT id, name, email FROM users WHERE phone = $1 ORDER BY phone_verified DESC, id LIMIT 1', [digits]);
  const c = classifyLead({ source: 'contact', message, phone: digits });
  const [row] = await db(
    `INSERT INTO leads (source, kind, name, email, phone, user_id, message, budget, quantity, intent, summary, matches, marketing_consent, consent_at)
     VALUES ('whatsapp', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, FALSE, NOW()) RETURNING id`,
    [c.kind === 'newsletter' ? 'product_enquiry' : c.kind, (name || user?.name || '').slice(0, 80) || null, user?.email ?? null, digits, user?.id ?? null, message.slice(0, 2000), c.budget, c.quantity, c.intent, `WhatsApp · ${c.summary}`, JSON.stringify(c.matches)],
  );
  return row.id;
}

// ---------- Lead score ----------
const SOURCE_POINTS = { quote: 12, business: 6, consultation: 10, product: 8, checkout: 12, abandoned_cart: 10, whatsapp: 8, contact: 5, crm: 5, registration: 2, newsletter: 0 };
export function scoreLead(l) {
  const reasons = [];
  const add = (points, why) => {
    if (points) reasons.push({ points, why });
  };
  add({ high: 30, medium: 15, low: 0 }[l.intent] ?? 0, `${l.intent === 'high' ? 'Hot' : l.intent === 'medium' ? 'Warm' : 'Cold'} purchase intent in the message`);
  add(SOURCE_POINTS[l.source] ?? 0, `Came from ${l.source.replace('_', ' ')}`);
  if (l.budget) add(l.budget >= 50_000 ? 15 : l.budget >= 5_000 ? 10 : 5, `Budget of ₹${Number(l.budget).toLocaleString('en-IN')}`);
  if (l.quantity >= 10) add(10, `${l.quantity} units`);
  if (l.phone) add(8, 'Gave a phone number');
  if ((l.matches || []).length) add(5, 'Matching products in stock');
  if (l.is_customer) add(10, 'Already a customer');
  const ageDays = (Date.now() - new Date(l.created_at).getTime()) / 86_400_000;
  if (ageDays <= 3) add(10, 'Arrived in the last 3 days');
  else if (ageDays > 30) add(-10, 'Older than 30 days');
  if (l.activities > 0) add(Math.min(l.activities * 2, 6), `${l.activities} logged interaction${l.activities === 1 ? '' : 's'}`);
  if (['lost', 'unsubscribed'].includes(l.status)) add(-40, 'Closed as lost');
  const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.points, 0)));
  return { score, band: score >= 60 ? 'hot' : score >= 35 ? 'warm' : 'cold', reasons, method: 'points' };
}

const CRM_COLUMNS = `${COLUMNS},
  EXISTS (SELECT 1 FROM orders o WHERE o.user_id = l.user_id AND l.user_id IS NOT NULL AND o.created_at < l.created_at) AS is_customer,
  (SELECT count(*)::int FROM crm_notes n WHERE n.entity = 'lead' AND n.entity_id = l.id::text AND n.deleted_at IS NULL) AS activities`;

const maskLead = (staff) => (l) => (can(staff, 'customers.contact') ? l : { ...l, email: l.email && `${l.email[0]}***@${l.email.split('@')[1]}`, phone: l.phone && `******${l.phone.slice(-4)}`, masked: true });
const crmLeadJson = (staff) => (row) => maskLead(staff)({ ...leadJson(row), ...scoreLead(row) });

/** GET /crm/leads: filters, search, paging; ?view=board returns every open lead grouped by stage */
export async function listLeads({ db, staff, params }) {
  await syncAutoLeads(db).catch((err) => console.error('auto leads', err.message));
  const w = where();
  if (STATUSES.includes(params.status)) w.add('l.status = ?', params.status);
  else if (params.status === 'open' || params.view === 'board') w.raw(`l.status IN ${OPEN_SQL}`);
  if (params.view === 'board' || params.newsletter !== '1') w.raw(`l.source <> 'newsletter'`);
  if (params.source) w.add('l.source = ?', text(params.source, 20));
  if (Object.hasOwn(KIND_LABELS, params.kind ?? '')) w.add('l.kind = ?', params.kind);
  if (['high', 'medium', 'low'].includes(params.intent)) w.add('l.intent = ?', params.intent);
  if (params.assigned === 'me') w.add('l.assigned_to = ?', staff.id);
  else if (params.assigned === 'none') w.raw('l.assigned_to IS NULL');
  else if (ID_RE.test(params.assigned ?? '')) w.add('l.assigned_to = ?', Number(params.assigned));
  if (params.due === '1') w.raw(`l.follow_up_on <= CURRENT_DATE AND l.status IN ${OPEN_SQL}`);
  const q = text(params.q, 100);
  if (q) w.add('(l.name ILIKE ? OR l.email ILIKE ? OR l.phone ILIKE ? OR l.message ILIKE ? OR l.summary ILIKE ?)', ...Array(5).fill(like(q)));
  if (params.view === 'board') {
    const rows = await db(`SELECT ${CRM_COLUMNS} ${FROM} ${w.sql()} ORDER BY l.created_at DESC LIMIT 500`, w.args);
    const items = rows.map(crmLeadJson(staff));
    return { body: { stages: OPEN_STATUSES.map((s) => ({ stage: s, leads: items.filter((l) => l.status === s).sort((a, b) => b.score - a.score) })) } };
  }
  const p = paging(params);
  const sort = { created: 'l.created_at DESC', updated: 'l.updated_at DESC', follow_up: 'l.follow_up_on ASC NULLS LAST', name: 'l.name ASC NULLS LAST', budget: 'l.budget DESC NULLS LAST' }[params.sort] || 'l.created_at DESC';
  const [{ total }] = await db(`SELECT count(*)::int AS total FROM leads l ${w.sql()}`, w.args);
  const rows = await db(`SELECT ${CRM_COLUMNS} ${FROM} ${w.sql()} ORDER BY ${sort}, l.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.args);
  let items = rows.map(crmLeadJson(staff));
  if (params.sort === 'score') items = items.sort((a, b) => b.score - a.score);
  return { body: pageOf(items, p, total) };
}

export async function getLead({ db, staff, id }) {
  const [row] = ID_RE.test(String(id)) ? await db(`SELECT ${CRM_COLUMNS} ${FROM} WHERE l.id = $1`, [Number(id)]) : [];
  if (!row) fail('Lead not found', 404);
  const activities = await db(
    `SELECT n.id, n.kind, n.body, n.outcome, n.happened_at, n.created_at, u.name AS author FROM crm_notes n LEFT JOIN users u ON u.id = n.author_id
      WHERE n.entity = 'lead' AND n.entity_id = $1 AND n.deleted_at IS NULL ORDER BY n.happened_at DESC, n.id DESC`,
    [String(row.id)],
  );
  const tasks = await db(
    `SELECT t.id, t.title, t.status, t.priority, t.due_at, u.name AS assignee FROM crm_tasks t LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.lead_id = $1 AND t.deleted_at IS NULL ORDER BY t.due_at NULLS LAST`,
    [row.id],
  );
  const messages = await db(
    `SELECT id, channel, direction, kind, subject, status, created_at FROM crm_messages
      WHERE lead_id = $1 OR ($2::int IS NOT NULL AND user_id = $2) OR ($3::text IS NOT NULL AND lower(to_address) = lower($3)) OR ($4::text IS NOT NULL AND to_address = $4)
      ORDER BY created_at DESC LIMIT 50`,
    [row.id, row.user_id, row.email, row.phone],
  );
  return { body: { ...crmLeadJson(staff)(row), activities, tasks, messages } };
}

/** POST /crm/leads: a lead the team enters by hand (a phone call, a walk-in, a trade show) */
export async function createLead({ db, staff, body }) {
  const name = text(body.name, 80);
  const email = text(body.email, 254).toLowerCase() || null;
  const phone = cleanPhone(body.phone) || null;
  if (name.length < 2) fail('Please enter the person’s name');
  if (!email && !phone) fail('Please add an email address or a mobile number');
  if (email && !EMAIL_RE.test(email)) fail('Please enter a valid email address');
  if (phone && !PHONE_RE.test(phone)) fail('Please enter a valid 10-digit mobile number');
  const message = text(body.requirements, 2000);
  let productId = null;
  if (body.productId) {
    productId = String(body.productId);
    if (!getProduct(productId)) fail('Product not found', 404);
  }
  const budget = body.budget ? Number(body.budget) : null;
  if (budget !== null && (!Number.isFinite(budget) || budget < 1 || budget > 1e8)) fail('Please enter a valid budget');
  const [dupe] = await db(
    `SELECT id FROM leads WHERE status IN ${OPEN_SQL} AND source <> 'newsletter' AND ((($1::text) IS NOT NULL AND lower(email) = $1) OR (($2::text) IS NOT NULL AND phone = $2)) LIMIT 1`,
    [email, phone],
  );
  if (dupe && body.allowDuplicate !== true) fail(`This person already has an open lead (#${dupe.id}). Open it instead, or confirm to add another.`, 409);
  const assignee = body.assignedTo ? (need(staff, 'leads.assign'), await assertAssignable(db, body.assignedTo, 'leads.view')) : null;
  const followUp = body.followUpOn && /^\d{4}-\d{2}-\d{2}$/.test(body.followUpOn) ? body.followUpOn : null;
  const c = classifyLead({ source: 'contact', message: message || '', budget: budget ? Math.round(budget) : null, productId, phone });
  const [user] = email ? await db('SELECT id FROM users WHERE lower(email) = $1', [email]) : [];
  const [row] = await db(
    `INSERT INTO leads (source, kind, name, email, phone, user_id, product_id, message, budget, quantity, intent, summary, matches, assigned_to, follow_up_on, marketing_consent, consent_at, notes)
     VALUES ('crm', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, NOW(), $16::jsonb) RETURNING id`,
    [c.kind === 'newsletter' ? 'product_enquiry' : c.kind, name, email, phone, user?.id ?? null, productId, message || null, c.budget, c.quantity, c.intent,
      `Added by ${staff.name} · ${c.summary}`, JSON.stringify(c.matches), assignee?.id ?? null, followUp, body.marketingConsent === true,
      JSON.stringify([{ at: new Date().toISOString(), by: staff.name, text: `Lead added by hand${assignee ? `, assigned to ${assignee.name}` : ''}` }])],
  );
  await audit(db, staff, 'lead.create', 'lead', row.id, { source: 'crm', assignedTo: assignee?.id ?? null });
  return { status: 201, body: (await getLead({ db, staff, id: row.id })).body };
}

export const LEAD_SOURCES = ['contact', 'product', 'quote', 'business', 'newsletter', 'checkout', 'consultation', 'registration', 'abandoned_cart', 'whatsapp', 'crm'];

/** Funnel and conversion by source, for the dashboard and reports */
export async function leadFunnel(db, { from, to } = {}) {
  const range = from ? `AND l.created_at >= $1::date AND l.created_at < $2::date + 1` : '';
  const args = from ? [from, to] : [];
  const stages = await db(`SELECT l.status, count(*)::int AS count FROM leads l WHERE l.source <> 'newsletter' ${range} GROUP BY 1`, args);
  const bySource = await db(
    `SELECT l.source, count(*)::int AS leads, count(*) FILTER (WHERE l.status = 'won')::int AS converted,
            count(*) FILTER (WHERE l.status = 'lost')::int AS lost
       FROM leads l WHERE l.source <> 'newsletter' ${range} GROUP BY 1 ORDER BY leads DESC`,
    args,
  );
  const count = (s) => stages.find((x) => x.status === s)?.count ?? 0;
  // A lead that reached a later stage has passed the earlier ones
  const order = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won'];
  const funnel = order.map((s, i) => ({ stage: s, reached: order.slice(i).reduce((n, x) => n + count(x), 0), now: count(s) }));
  return { funnel, lost: count('lost'), bySource };
}
