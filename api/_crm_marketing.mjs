// Marketing: campaigns, the newsletter list, automations and unsubscribing.
//
// Consent first. A campaign only ever goes to people who agreed to that channel and never unsubscribed or bounced:
//   email     customers with email_opt_in, newsletter subscribers, and (optionally) leads who ticked marketing consent
//   SMS       customers with sms_opt_in and a verified mobile number
//   WhatsApp  customers with whatsapp_opt_in and a verified number, through an approved marketing template
// minus crm_suppressions. Every marketing email carries an unsubscribe link and a one-click List-Unsubscribe header.
//
// Sending is done in batches (POST /crm/campaigns/:id/send, called again until done) because a serverless function
// has a time limit. Recipients are written first with a dedupe key, so a campaign reaches each address once.
// Automations (abandoned cart, birthday, anniversary, win-back) are switched on in Settings and run from the daily
// cron or "Run now"; each is deduplicated per person and occasion.
import { getProduct } from './_catalog.mjs';
import { SEGMENT_SQL, CUSTOMER_STATS, SEGMENTS } from './_crm_customers.mjs';
import { channelStatus, checkUnsubscribe, dispatch, emailLayout, esc, queueMessage, suppress, textToHtml, unsubscribeUrl } from './_messaging.mjs';
import { audit, can, fail, getSettings, ID_RE, mask, need, pageOf, paging, pct, text, where } from './_crm_core.mjs';

const CHANNELS = ['email', 'sms', 'whatsapp'];
const KINDS = ['promotional', 'newsletter', 'retention', 'follow_up'];
const BATCH = 40;

function cleanCampaign(body, existing = {}) {
  const name = text(body.name ?? existing.name, 120);
  const channel = body.channel ?? existing.channel;
  if (name.length < 3) fail('Please name the campaign');
  if (!CHANNELS.includes(channel)) fail('Choose email, SMS or WhatsApp');
  const kind = KINDS.includes(body.kind ?? existing.kind) ? body.kind ?? existing.kind : 'promotional';
  const subject = text(body.subject ?? existing.subject, 200);
  const content = text(body.body ?? existing.body, channel === 'email' ? 20_000 : 1000);
  if (channel === 'email' && subject.length < 3) fail('Please write a subject line');
  if (content.length < 5) fail('Please write the message');
  const a = body.audience ?? existing.audience ?? {};
  const audience = {
    segment: Object.hasOwn(SEGMENTS, a.segment ?? '') ? a.segment : null,
    tag: text(a.tag, 30) || null,
    subscribers: a.subscribers !== false,
    leads: a.leads === true,
  };
  const template = text(body.templateName ?? existing.template_name, 80) || null;
  if (template && !/^[a-z0-9_]+$/.test(template)) fail('A WhatsApp template name uses lowercase letters, digits and _ only');
  const coupon = text(body.couponCode ?? existing.coupon_code, 30).toUpperCase() || null;
  return { name, channel, kind, subject: subject || null, body: content, audience, template, coupon };
}

/** Who a campaign would reach right now: [{ address, name, userId, leadId }] */
export async function audienceOf(db, channel, audience = {}) {
  const w = where();
  if (audience.segment) w.add('s.segment = ?', audience.segment);
  if (audience.tag) w.add('s.tags @> jsonb_build_array(?::text)', audience.tag);
  w.raw('s.disabled_at IS NULL');
  if (channel === 'email') w.raw('s.email_opt_in');
  else w.raw(`s.${channel}_opt_in AND s.phone_verified AND s.phone IS NOT NULL`);
  const customers = await db(`SELECT * FROM (SELECT s.*, ${SEGMENT_SQL} AS segment FROM (${CUSTOMER_STATS}) s) s ${w.sql()}`, w.args);
  const list = customers.map((c) => ({ address: channel === 'email' ? c.email.toLowerCase() : c.phone, name: c.name, userId: c.id, leadId: null }));
  const narrowed = audience.segment || audience.tag;
  if (channel === 'email' && !narrowed && (audience.subscribers !== false || audience.leads)) {
    const sources = [audience.subscribers !== false && "source = 'newsletter'", audience.leads && "source <> 'newsletter'"].filter(Boolean).join(' OR ');
    const leads = await db(`SELECT id, lower(email) AS email, name, user_id FROM leads WHERE email IS NOT NULL AND marketing_consent AND status <> 'unsubscribed' AND (${sources})`);
    list.push(...leads.map((l) => ({ address: l.email, name: l.name, userId: l.user_id, leadId: l.id })));
  }
  const suppressed = new Set((await db('SELECT address FROM crm_suppressions WHERE channel = $1', [channel])).map((s) => s.address));
  const seen = new Set();
  return list.filter((r) => {
    const key = channel === 'email' ? r.address : r.address.slice(-10);
    if (!r.address || seen.has(key) || suppressed.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const personalise = (body, name) => body.replace(/\{\{\s*name\s*\}\}/gi, (name || '').split(' ')[0] || 'there');

async function campaignRow(db, id) {
  if (!ID_RE.test(String(id))) fail('Campaign not found', 404);
  const [c] = await db('SELECT * FROM crm_campaigns WHERE id = $1 AND deleted_at IS NULL', [Number(id)]);
  if (!c) fail('Campaign not found', 404);
  return c;
}

async function stats(db, ids) {
  if (!ids.length) return new Map();
  const rows = await db(
    `SELECT campaign_id, count(*)::int AS recipients,
            count(*) FILTER (WHERE status = 'queued' OR status = 'sending')::int AS queued,
            count(*) FILTER (WHERE status IN ('accepted', 'delivered', 'opened', 'clicked'))::int AS accepted,
            count(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked'))::int AS delivered,
            count(*) FILTER (WHERE status IN ('opened', 'clicked'))::int AS opened,
            count(*) FILTER (WHERE status = 'clicked')::int AS clicked,
            count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM crm_messages WHERE campaign_id = ANY($1::int[]) GROUP BY campaign_id`,
    [ids],
  );
  return new Map(rows.map((r) => [r.campaign_id, r]));
}

async function couponResults(db, c) {
  if (!c.coupon_code || !c.sent_at) return null;
  const [r] = await db(
    `SELECT count(*)::int AS orders, COALESCE(SUM(o.total), 0)::float AS revenue,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM crm_messages m WHERE m.campaign_id = $2 AND m.user_id = o.user_id))::int AS from_recipients
       FROM orders o WHERE o.coupon_code = $1 AND o.created_at >= $3 AND o.status = 'placed'`,
    [c.coupon_code, c.id, c.sent_at],
  );
  return r;
}

const campaignJson = (c, s) => {
  const st = s ?? { recipients: 0, queued: 0, accepted: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0 };
  return { ...c, stats: { ...st, deliveryRate: pct(st.delivered, st.accepted), openRate: pct(st.opened, st.delivered || st.accepted), clickRate: pct(st.clicked, st.delivered || st.accepted) } };
};

export async function listCampaigns({ db, params }) {
  const p = paging(params);
  const [{ total }] = await db('SELECT count(*)::int AS total FROM crm_campaigns WHERE deleted_at IS NULL');
  const rows = await db(`SELECT c.*, u.name AS created_by_name FROM crm_campaigns c LEFT JOIN users u ON u.id = c.created_by WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`);
  const s = await stats(db, rows.map((r) => r.id));
  const [newsletter] = await db("SELECT count(*) FILTER (WHERE marketing_consent AND status <> 'unsubscribed')::int AS subscribers, count(*) FILTER (WHERE status = 'unsubscribed')::int AS unsubscribed FROM leads WHERE source = 'newsletter'");
  const [optIns] = await db('SELECT count(*) FILTER (WHERE email_opt_in)::int AS email, count(*) FILTER (WHERE sms_opt_in)::int AS sms, count(*) FILTER (WHERE whatsapp_opt_in)::int AS whatsapp FROM crm_customer_profiles');
  const [suppressed] = await db('SELECT count(*)::int AS n FROM crm_suppressions');
  return { body: { ...pageOf(rows.map((c) => campaignJson(c, s.get(c.id))), p, total), newsletter, optIns, suppressed: suppressed.n, channels: channelStatus() } };
}

export async function getCampaign({ db, staff, id }) {
  const c = await campaignRow(db, id);
  const s = await stats(db, [c.id]);
  const audience = c.status === 'draft' ? await audienceOf(db, c.channel, c.audience) : null;
  const messages = await db(`SELECT id, to_address, status, error, created_at, status_at FROM crm_messages WHERE campaign_id = $1 ORDER BY id DESC LIMIT 100`, [c.id]);
  return {
    body: {
      ...campaignJson(c, s.get(c.id)),
      audienceSize: audience?.length ?? null,
      audiencePreview: audience?.slice(0, 8).map((r) => ({ name: r.name, address: can(staff, 'customers.contact') ? r.address : mask(r.address) })) ?? null,
      messages: messages.map((m) => ({ ...m, to_address: can(staff, 'customers.contact') ? m.to_address : mask(m.to_address) })),
      coupon: await couponResults(db, c),
    },
  };
}

export async function createCampaign({ db, staff, body }) {
  need(staff, 'marketing.send');
  const c = cleanCampaign(body);
  const [row] = await db(
    `INSERT INTO crm_campaigns (name, kind, channel, audience, subject, body, template_name, coupon_code, created_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9) RETURNING id`,
    [c.name, c.kind, c.channel, JSON.stringify(c.audience), c.subject, c.body, c.template, c.coupon, staff.id],
  );
  await audit(db, staff, 'campaign.create', 'campaign', row.id, { name: c.name, channel: c.channel });
  return { status: 201, body: (await getCampaign({ db, staff, id: row.id })).body };
}

export async function updateCampaign({ db, staff, id, body }) {
  need(staff, 'marketing.send');
  const existing = await campaignRow(db, id);
  if (existing.status !== 'draft') fail('Only a draft can be edited', 409);
  const c = cleanCampaign(body, existing);
  await db(
    `UPDATE crm_campaigns SET name = $2, kind = $3, channel = $4, audience = $5::jsonb, subject = $6, body = $7, template_name = $8, coupon_code = $9, updated_at = NOW() WHERE id = $1`,
    [existing.id, c.name, c.kind, c.channel, JSON.stringify(c.audience), c.subject, c.body, c.template, c.coupon],
  );
  await audit(db, staff, 'campaign.update', 'campaign', existing.id, { name: c.name });
  return getCampaign({ db, staff, id: existing.id });
}

export async function deleteCampaign({ db, staff, id }) {
  need(staff, 'marketing.send');
  const c = await campaignRow(db, id);
  if (c.status === 'sending') fail('Stop the campaign before deleting it', 409);
  await db('UPDATE crm_campaigns SET deleted_at = NOW() WHERE id = $1', [c.id]);
  await audit(db, staff, 'campaign.delete', 'campaign', c.id, { name: c.name });
  return { status: 204, body: null };
}

export async function cancelCampaign({ db, staff, id }) {
  need(staff, 'marketing.send');
  const c = await campaignRow(db, id);
  if (c.status !== 'sending') fail('Only a campaign that is sending can be stopped', 409);
  const stopped = await db("UPDATE crm_messages SET status = 'failed', error = 'Campaign stopped before sending', updated_at = NOW() WHERE campaign_id = $1 AND status = 'queued' RETURNING id", [c.id]);
  await db("UPDATE crm_campaigns SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [c.id]);
  await audit(db, staff, 'campaign.cancel', 'campaign', c.id, { notSent: stopped.length });
  return getCampaign({ db, staff, id: c.id });
}

/** Content for a stored message: what was written to crm_messages is exactly what is sent (and what a retry resends). */
export function contentOf(row, { company, env = process.env, templateName = null }) {
  if (row.channel === 'email') {
    const unsub = row.kind === 'transactional' ? null : unsubscribeUrl('email', row.to_address, env);
    const footer = unsub ? `You’re receiving this because you agreed to emails from us. <a href="${esc(unsub)}" style="color:#646b78">Unsubscribe</a>.` : '';
    return {
      subject: row.subject,
      text: `${row.body}${unsub ? `\n\nUnsubscribe: ${unsub}` : ''}`,
      html: emailLayout({ title: null, bodyHtml: textToHtml(row.body), footer, company }),
      headers: unsub ? { 'List-Unsubscribe': `<${unsub.replace('/unsubscribe?', '/api/crm/unsubscribe?')}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
      from: row.kind === 'transactional' ? undefined : env.MARKETING_EMAIL_FROM || undefined,
    };
  }
  if (row.channel === 'sms') return { text: row.kind === 'transactional' ? row.body : `${row.body} Reply STOP to opt out.` };
  return { text: row.body, template: { name: templateName || env.WHATSAPP_MARKETING_TEMPLATE, params: [row.body] } };
}

export async function sendCampaign({ db, staff, id, body }, { env = process.env, fetchImpl = fetch } = {}) {
  need(staff, 'marketing.send');
  const c = await campaignRow(db, id);
  if (!['draft', 'sending'].includes(c.status)) fail(`This campaign is ${c.status}`, 409);
  const channel = channelStatus(env)[c.channel];
  if (!channel.configured) fail(`${c.channel === 'email' ? 'Email' : c.channel === 'sms' ? 'SMS' : 'WhatsApp'} isn’t set up yet: add ${channel.missing.join(', ')} in Vercel (CRM → Settings → Integrations).`, 503);
  if (c.channel === 'email' && !unsubscribeUrl('email', 'x@y.z', env)) fail('Set SITE_URL in Vercel first: every marketing email needs a working unsubscribe link.', 503);
  if (c.channel === 'whatsapp' && !(c.template_name || env.WHATSAPP_MARKETING_TEMPLATE)) fail('WhatsApp campaigns need an approved marketing template: name it on the campaign or set WHATSAPP_MARKETING_TEMPLATE.', 503);
  if (c.status === 'draft') {
    if (body.confirm !== true) fail('Please confirm sending');
    const people = await audienceOf(db, c.channel, c.audience);
    if (!people.length) fail('Nobody in this audience has agreed to receive this channel', 409);
    for (const p of people) {
      await queueMessage(db, {
        channel: c.channel, kind: 'campaign', event: c.kind, dedupeKey: `campaign:${c.id}:${p.address}`, userId: p.userId, leadId: p.leadId, campaignId: c.id,
        to: p.address, subject: c.subject ? personalise(c.subject, p.name) : null, body: personalise(c.body, p.name), sentBy: staff.id,
      });
    }
    const [started] = await db("UPDATE crm_campaigns SET status = 'sending', sent_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'draft' RETURNING id", [c.id]);
    if (started) await audit(db, staff, 'campaign.send', 'campaign', c.id, { recipients: people.length, channel: c.channel });
  }
  // Claim a batch: two people pressing "send" at once never send the same message twice
  const batch = await db(
    `UPDATE crm_messages SET status = 'sending', updated_at = NOW() WHERE id IN (
       SELECT id FROM crm_messages WHERE campaign_id = $1 AND status = 'queued' ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING *`,
    [c.id],
  );
  const { company } = await getSettings(db);
  for (let i = 0; i < batch.length; i += 5) {
    await Promise.all(batch.slice(i, i + 5).map((m) => dispatch(db, m, contentOf(m, { company, env, templateName: c.template_name }), { env, fetchImpl })));
  }
  const [{ left }] = await db("SELECT count(*)::int AS left FROM crm_messages WHERE campaign_id = $1 AND status IN ('queued', 'sending')", [c.id]);
  if (!left) await db("UPDATE crm_campaigns SET status = 'sent', updated_at = NOW() WHERE id = $1 AND status = 'sending'", [c.id]);
  const s = (await stats(db, [c.id])).get(c.id);
  return { body: { id: c.id, done: !left, sentThisBatch: batch.length, ...s } };
}

/** Requeues failed messages (not bounces: those addresses are suppressed) for another try, up to 3 attempts */
export async function retryMessages({ db, staff, body }, { env = process.env, fetchImpl = fetch } = {}) {
  need(staff, 'marketing.send');
  const w = where();
  w.raw("status = 'failed' AND attempts < 3 AND direction = 'out' AND error IS DISTINCT FROM 'Campaign stopped before sending'");
  if (ID_RE.test(String(body.campaignId ?? ''))) w.add('campaign_id = ?', Number(body.campaignId));
  if (ID_RE.test(String(body.messageId ?? ''))) w.add('id = ?', Number(body.messageId));
  const rows = await db(`UPDATE crm_messages SET status = 'sending', updated_at = NOW() WHERE id IN (SELECT id FROM crm_messages ${w.sql()} ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING *`, w.args);
  const { company } = await getSettings(db);
  const results = [];
  for (const m of rows) {
    const [c] = m.campaign_id ? await db('SELECT template_name FROM crm_campaigns WHERE id = $1', [m.campaign_id]) : [];
    const content = m.kind === 'transactional' && m.channel !== 'email'
      ? m.channel === 'sms' ? { text: m.body } : { text: m.body, template: { name: env.WHATSAPP_UPDATE_TEMPLATE, params: [m.body] } }
      : contentOf(m, { company, env, templateName: c?.template_name });
    results.push(await dispatch(db, m, content, { env, fetchImpl }));
  }
  await audit(db, staff, 'messages.retry', 'message', null, { count: rows.length });
  return { body: { retried: rows.length, accepted: results.filter((r) => r.status === 'accepted').length, failed: results.filter((r) => r.status === 'failed').length } };
}

export async function listMessages({ db, staff, params }) {
  const w = where();
  if (CHANNELS.includes(params.channel)) w.add('m.channel = ?', params.channel);
  if (params.status) w.add('m.status = ?', text(params.status, 12));
  if (['campaign', 'transactional', 'automation', 'manual', 'inbound'].includes(params.kind)) w.add('m.kind = ?', params.kind);
  const p = paging(params);
  const [{ total }] = await db(`SELECT count(*)::int AS total FROM crm_messages m ${w.sql()}`, w.args);
  const rows = await db(`SELECT m.id, m.channel, m.direction, m.kind, m.event, m.to_address, m.subject, m.status, m.provider, m.error, m.attempts, m.created_at, m.status_at, m.user_id, m.campaign_id
                           FROM crm_messages m ${w.sql()} ORDER BY m.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.args);
  const [summary] = await db(`SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status IN ('accepted','delivered','opened','clicked'))::int AS accepted,
                                     count(*) FILTER (WHERE status IN ('delivered','opened','clicked'))::int AS delivered FROM crm_messages WHERE created_at > NOW() - INTERVAL '30 days'`);
  const full = can(staff, 'customers.contact');
  return { body: { ...pageOf(rows.map((m) => ({ ...m, to_address: full ? m.to_address : mask(m.to_address) })), p, total), summary } };
}

/** A one-off message from the team to a customer or lead (email, SMS, or WhatsApp inside the 24-hour window) */
export async function sendDirect({ db, staff, body }, { env = process.env, fetchImpl = fetch } = {}) {
  need(staff, 'notes.write');
  const channel = CHANNELS.includes(body.channel) ? body.channel : fail('Choose a channel');
  const status = channelStatus(env)[channel];
  if (!status.configured) fail(`${channel} isn’t set up yet: add ${status.missing.join(', ')} in Vercel.`, 503);
  const message = text(body.message, channel === 'email' ? 10_000 : 1000);
  if (message.length < 2) fail('Please write the message');
  let to;
  let userId = null;
  let leadId = null;
  if (ID_RE.test(String(body.customerId ?? ''))) {
    need(staff, 'customers.contact');
    const [u] = await db('SELECT id, email, phone, phone_verified FROM users WHERE id = $1', [Number(body.customerId)]);
    if (!u) fail('Customer not found', 404);
    to = channel === 'email' ? u.email : u.phone_verified ? u.phone : fail('This customer has no verified mobile number');
    userId = u.id;
  } else if (ID_RE.test(String(body.leadId ?? ''))) {
    need(staff, 'leads.edit');
    const [l] = await db('SELECT id, email, phone, user_id FROM leads WHERE id = $1', [Number(body.leadId)]);
    if (!l) fail('Lead not found', 404);
    to = channel === 'email' ? l.email : l.phone;
    if (!to) fail(`This lead has no ${channel === 'email' ? 'email address' : 'mobile number'}`);
    leadId = l.id;
    userId = l.user_id;
  } else fail('Choose who to send to');
  if (channel === 'whatsapp') {
    // Free-text WhatsApp only within 24 hours of the person's last message (Meta's customer-service window)
    const [last] = await db("SELECT created_at FROM crm_messages WHERE direction = 'in' AND channel = 'whatsapp' AND right(to_address, 10) = right($1, 10) ORDER BY id DESC LIMIT 1", [to]);
    if (!last || Date.now() - new Date(last.created_at).getTime() > 24 * 3_600_000) fail('WhatsApp allows free-text replies only within 24 hours of the customer’s last message. Use a template campaign instead.', 409);
  }
  const subject = channel === 'email' ? text(body.subject, 200) || 'A message from our team' : null;
  const row = await queueMessage(db, { channel, kind: 'manual', userId, leadId, to, subject, body: message, sentBy: staff.id });
  const { company } = await getSettings(db);
  const content = channel === 'email'
    ? { subject, text: message, html: emailLayout({ title: null, bodyHtml: textToHtml(message), company }) }
    : { text: message };
  const sent = await dispatch(db, row, content, { env, fetchImpl });
  await audit(db, staff, 'message.send', userId ? 'customer' : 'lead', userId ?? leadId, { channel, status: sent.status });
  if (leadId) await db("UPDATE leads SET status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, updated_at = NOW() WHERE id = $1", [leadId]);
  return { status: 201, body: { id: sent.id, status: sent.status, error: sent.error } };
}

// ---------- Newsletter ----------
export async function listSubscribers({ db, staff, params }) {
  const p = paging(params);
  const status = params.status === 'unsubscribed' ? "status = 'unsubscribed'" : "status <> 'unsubscribed' AND marketing_consent";
  const [{ total }] = await db(`SELECT count(*)::int AS total FROM leads WHERE source = 'newsletter' AND ${status}`);
  const rows = await db(`SELECT id, name, email, status, consent_at, created_at, updated_at FROM leads WHERE source = 'newsletter' AND ${status} ORDER BY created_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`);
  return { body: pageOf(rows.map((r) => ({ ...r, email: can(staff, 'customers.contact') ? r.email : mask(r.email) })), p, total) };
}

/** Records an unsubscribe everywhere it applies: suppression list, customer consent, newsletter and lead consent */
export async function unsubscribeAddress(db, channel, address, reason = 'unsubscribed') {
  await suppress(db, channel, address, reason);
  if (channel === 'email') {
    await db(`UPDATE crm_customer_profiles SET email_opt_in = FALSE, consent_updated_at = NOW(), updated_at = NOW() WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower($1))`, [address]);
    await db(`UPDATE leads SET marketing_consent = FALSE, status = CASE WHEN source = 'newsletter' THEN 'unsubscribed' ELSE status END, updated_at = NOW() WHERE lower(email) = lower($1)`, [address]);
  } else {
    await db(`UPDATE crm_customer_profiles SET ${channel}_opt_in = FALSE, consent_updated_at = NOW(), updated_at = NOW() WHERE user_id IN (SELECT id FROM users WHERE phone = right($1, 10))`, [address]);
  }
}

export async function staffUnsubscribe({ db, staff, id }) {
  need(staff, 'marketing.send');
  const [l] = ID_RE.test(String(id)) ? await db("SELECT id, email FROM leads WHERE id = $1 AND source = 'newsletter'", [Number(id)]) : [];
  if (!l) fail('Subscriber not found', 404);
  await unsubscribeAddress(db, 'email', l.email, 'admin');
  await audit(db, staff, 'newsletter.unsubscribe', 'lead', l.id, {});
  return { status: 204, body: null };
}

/** Public: the unsubscribe page (GET checks the link, POST unsubscribes). No login: the signed link is the proof. */
export async function publicUnsubscribe({ db, method, params, body }) {
  const p = { ...(params || {}), ...(body && typeof body === 'object' ? body : {}) };
  const channel = CHANNELS.includes(p.c) ? p.c : null;
  let address = '';
  try {
    address = Buffer.from(String(p.a || ''), 'base64url').toString('utf8');
  } catch {
    address = '';
  }
  if (!channel || !address || !checkUnsubscribe(channel, address, p.t)) fail('This unsubscribe link isn’t valid. Please use the link from your latest email.', 400);
  if (method === 'GET') return { body: { valid: true, channel, address: mask(address) } };
  await unsubscribeAddress(db, channel, address);
  return { body: { unsubscribed: true, channel, address: mask(address) } };
}

// ---------- Automations ----------
export async function runAutomations(db, { staff = null, env = process.env, fetchImpl = fetch } = {}) {
  const settings = await getSettings(db);
  const a = settings.automations;
  const out = { abandonedCart: 0, birthday: 0, anniversary: 0, winBack: 0, skipped: [] };
  if (!channelStatus(env).email.configured) {
    out.skipped.push('Email is not configured, so no automation emails were sent');
    return out;
  }
  if (!unsubscribeUrl('email', 'x@y.z', env)) {
    out.skipped.push('SITE_URL is not set, so marketing emails cannot carry an unsubscribe link');
    return out;
  }
  const suppressed = new Set((await db("SELECT address FROM crm_suppressions WHERE channel = 'email'")).map((s) => s.address));
  const send = async (key, u, subject, bodyText, event) => {
    if (suppressed.has(u.email.toLowerCase())) return 0;
    const row = await queueMessage(db, { channel: 'email', kind: 'automation', event, dedupeKey: key, userId: u.id, to: u.email.toLowerCase(), subject, body: bodyText });
    if (!row) return 0;
    await dispatch(db, row, contentOf(row, { company: settings.company, env }), { env, fetchImpl });
    return 1;
  };
  const optedIn = `JOIN crm_customer_profiles p ON p.user_id = u.id AND p.email_opt_in WHERE u.disabled_at IS NULL`;
  if (a.abandonedCartReminder) {
    const carts = await db(
      `SELECT u.id, u.name, u.email, to_char(MIN(c.added_at), 'YYYYMMDD') AS since, json_agg(json_build_object('productId', c.product_id, 'qty', c.qty)) AS items
         FROM cart_items c JOIN users u ON u.id = c.user_id ${optedIn}
        GROUP BY u.id HAVING MAX(c.added_at) < NOW() - make_interval(hours => $1) AND MAX(c.added_at) > NOW() - INTERVAL '7 days'
           AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.created_at > MIN(c.added_at))`,
      [settings.leads.abandonedCartHours],
    );
    for (const c of carts) {
      const names = c.items.map((i) => getProduct(i.productId)).filter((p) => p && p.stock > 0).map((p) => `• ${p.name}`);
      if (!names.length) continue;
      const coupon = a.abandonedCartCoupon ? `\n\nUse code ${a.abandonedCartCoupon} at checkout.` : '';
      out.abandonedCart += await send(`automation:cart:${c.id}:${c.since}`, c, 'You left something in your cart', `Hi ${(c.name || '').split(' ')[0] || 'there'},\n\nThese are still in your cart:\n${names.join('\n')}${coupon}`, 'abandoned_cart');
    }
  }
  const today = new Date().toISOString().slice(5, 10);
  const year = new Date().getFullYear();
  for (const [flag, column, event, subject, line] of [
    ['birthday', 'birthday', 'birthday', 'Happy birthday from us!', 'Happy birthday! Wishing you a wonderful year ahead.'],
    ['anniversary', 'anniversary', 'anniversary', 'Happy anniversary!', 'Happy anniversary! Thank you for being with us.'],
  ]) {
    if (!a[flag]) continue;
    const people = await db(`SELECT u.id, u.name, u.email FROM users u ${optedIn} AND to_char(p.${column}, 'MM-DD') = $1`, [today]);
    const coupon = flag === 'birthday' && a.birthdayCoupon ? `\n\nHere’s a little gift: use code ${a.birthdayCoupon} on your next order.` : '';
    for (const u of people) out[flag] += await send(`automation:${flag}:${u.id}:${year}`, u, subject, `Hi ${(u.name || '').split(' ')[0] || 'there'},\n\n${line}${coupon}`, event);
  }
  if (a.winBack) {
    const people = await db(
      `SELECT u.id, u.name, u.email, max(o.id) AS last_order
         FROM users u
         JOIN crm_customer_profiles p ON p.user_id = u.id AND p.email_opt_in
         JOIN orders o ON o.user_id = u.id AND o.status <> 'cancelled'
        WHERE u.disabled_at IS NULL
        GROUP BY u.id
       HAVING max(o.created_at) < NOW() - make_interval(days => $1) AND max(o.created_at) > NOW() - make_interval(days => $1 + 7)`,
      [a.winBackDays],
    );
    for (const u of people) out.winBack += await send(`automation:winback:${u.id}:${u.last_order}`, u, 'We miss you', `Hi ${(u.name || '').split(' ')[0] || 'there'},\n\nIt’s been a while! Come and see what’s new in the store.`, 'win_back');
  }
  if (staff) await audit(db, staff, 'automations.run', 'automation', null, out);
  return out;
}

export { SEGMENTS };
