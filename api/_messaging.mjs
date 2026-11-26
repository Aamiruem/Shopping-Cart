// Outgoing messages for the CRM (campaigns, order and account updates, automations, staff messages) and what the
// providers report back. Real providers only: a channel without its credentials is "not configured" and nothing is
// sent or pretended. Every message is a crm_messages row whose status moves only on the provider's word:
//   queued → accepted (the provider took it) → delivered → opened → clicked;  or failed / bounced.
// "accepted" is not "delivered": delivery needs the provider's webhook (api/crm-webhooks.mjs).
//
// Providers (environment variables; see .env.example):
//   email     Resend  RESEND_API_KEY + EMAIL_FROM            or SMTP  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS + EMAIL_FROM
//             MARKETING_EMAIL_FROM (optional) sends campaigns from a separate address
//   SMS       Twilio  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM   (free text)
//             MSG91   MSG91_AUTH_KEY + MSG91_NOTIFY_TEMPLATE_ID (a DLT-approved flow template with one variable, ##VAR1##)
//   WhatsApp  Meta Cloud API  WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and approved templates:
//             WHATSAPP_UPDATE_TEMPLATE (utility, one body parameter) for order and support updates,
//             WHATSAPP_MARKETING_TEMPLATE (marketing, one body parameter) for campaigns, WHATSAPP_TEMPLATE_LANG
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_SETTINGS, getSettings, mask } from './_crm_core.mjs';

export const CHANNELS = ['email', 'sms', 'whatsapp'];
const RANK = { queued: 0, accepted: 1, delivered: 2, opened: 3, clicked: 4 };
const FAILED = ['failed', 'bounced'];

const isProduction = (env) => env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';
export const siteUrl = (env = process.env) => String(env.SITE_URL || env.VITE_SITE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')).replace(/\/$/, '');

/** Which provider each channel uses and which variables are missing. Never returns a secret's value. */
export function channelStatus(env = process.env) {
  const need = (names) => names.filter((n) => !env[n]);
  const resend = need(['RESEND_API_KEY', 'EMAIL_FROM']);
  const smtp = need(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']);
  const email = !resend.length ? { provider: 'resend', missing: [] } : !smtp.length ? { provider: 'smtp', missing: [] } : { provider: 'resend', missing: resend, alternative: { provider: 'smtp', missing: smtp } };
  const twilio = need(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_SMS_FROM']);
  const msg91 = need(['MSG91_AUTH_KEY', 'MSG91_NOTIFY_TEMPLATE_ID']);
  const sms = env.SMS_PROVIDER === 'msg91' || (twilio.length && !msg91.length) ? { provider: 'msg91', missing: msg91 } : { provider: 'twilio', missing: twilio, ...(twilio.length ? { alternative: { provider: 'msg91', missing: msg91 } } : {}) };
  const whatsapp = { provider: 'meta', missing: need(['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']) };
  const out = { email, sms, whatsapp };
  for (const c of CHANNELS) out[c].configured = !out[c].missing.length;
  out.whatsapp.templates = { updates: env.WHATSAPP_UPDATE_TEMPLATE || null, marketing: env.WHATSAPP_MARKETING_TEMPLATE || null };
  out.webhooks = {
    resend: Boolean(env.RESEND_WEBHOOK_SECRET),
    whatsapp: Boolean(env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN),
    twilio: Boolean(env.TWILIO_AUTH_TOKEN),
  };
  return out;
}

const e164 = (phone) => (String(phone).startsWith('+') ? String(phone) : `+91${String(phone).slice(-10)}`);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Plain text → simple, safe HTML paragraphs (links become clickable, nothing else is interpreted) */
export function textToHtml(body) {
  return String(body ?? '')
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55">${esc(p).replace(/\n/g, '<br>').replace(/(https:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2f5bff">$1</a>')}</p>`)
    .join('');
}

export function emailLayout({ title, bodyHtml, footer = '', company = DEFAULT_SETTINGS.company }) {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#15171c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#0b1530;padding:18px 26px;color:#ffffff;font-size:19px;font-weight:bold">${esc(company.name || 'Arvixa Store')}</td></tr>
<tr><td style="padding:26px">${title ? `<h1 style="margin:0 0 14px;font-size:20px">${esc(title)}</h1>` : ''}${bodyHtml}</td></tr>
<tr><td style="padding:16px 26px;background:#f5f6f8;font-size:12px;color:#646b78">${footer}${company.address ? `<br>${esc(company.legalName || company.name)}, ${esc(company.address)}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

let smtpTransport;
async function smtpSend(env, msg) {
  if (!smtpTransport) {
    const { default: nodemailer } = await import('nodemailer');
    const port = Number(env.SMTP_PORT) || 587;
    smtpTransport = nodemailer.createTransport({ host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, connectionTimeout: 10_000 });
  }
  const info = await smtpTransport.sendMail({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers });
  return { provider: 'smtp', ref: info.messageId ?? null };
}

/**
 * Hands one message to the channel's provider. Returns { provider, ref } once the provider accepted it, throws with
 * the provider's reason otherwise. `msg`: { to, subject, text, html, headers, from, template: { name, params } }.
 */
export async function deliver(channel, msg, env = process.env, fetchImpl = fetch) {
  const status = channelStatus(env)[channel];
  if (!status?.configured) throw new Error(`${channel} is not configured`);
  const post = async (url, init) => {
    const res = await fetchImpl(url, { ...init, method: 'POST', signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${status.provider} ${res.status}: ${JSON.stringify(body).slice(0, 240)}`);
    return body;
  };
  if (channel === 'email') {
    const from = msg.from || env.EMAIL_FROM;
    if (status.provider === 'smtp') return smtpSend(env, { ...msg, from });
    const body = await post('https://api.resend.com/emails', {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html, ...(msg.headers ? { headers: msg.headers } : {}) }),
    });
    return { provider: 'resend', ref: body.id ?? null };
  }
  if (channel === 'sms' && status.provider === 'msg91') {
    const body = await post('https://control.msg91.com/api/v5/flow', {
      headers: { authkey: env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: env.MSG91_NOTIFY_TEMPLATE_ID, short_url: '0', recipients: [{ mobiles: e164(msg.to).slice(1), VAR1: msg.text.slice(0, 300) }] }),
    });
    if (body.type && body.type !== 'success') throw new Error(`msg91: ${String(body.message || body.type).slice(0, 200)}`);
    return { provider: 'msg91', ref: body.request_id ?? body.message ?? null };
  }
  if (channel === 'sms') {
    const form = { To: e164(msg.to), From: env.TWILIO_SMS_FROM, Body: msg.text.slice(0, 1500) };
    if (siteUrl(env) && isProduction(env)) form.StatusCallback = `${siteUrl(env)}/api/webhooks/twilio`;
    const body = await post(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    return { provider: 'twilio', ref: body.sid ?? null };
  }
  // WhatsApp: an approved template outside the 24-hour customer-service window, free text inside it
  const payload = msg.template
    ? {
        type: 'template',
        template: {
          name: msg.template.name,
          language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: msg.template.params?.length ? [{ type: 'body', parameters: msg.template.params.map((t) => ({ type: 'text', text: String(t).slice(0, 1000) })) }] : [],
        },
      }
    : { type: 'text', text: { body: msg.text.slice(0, 4000), preview_url: false } };
  const body = await post(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: e164(msg.to).slice(1), ...payload }),
  });
  return { provider: 'meta', ref: body.messages?.[0]?.id ?? null };
}

// ---------- Recording and sending ----------
/** Adds a message to the log; returns null when one with the same dedupe_key already exists (never sent twice). */
export async function queueMessage(db, m) {
  const [row] = await db(
    `INSERT INTO crm_messages (channel, direction, kind, event, dedupe_key, user_id, lead_id, campaign_id, ticket_id, to_address, subject, body, status, sent_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [m.channel, m.direction || 'out', m.kind, m.event ?? null, m.dedupeKey ?? null, m.userId ?? null, m.leadId ?? null, m.campaignId ?? null, m.ticketId ?? null,
      String(m.to).slice(0, 255), m.subject ? String(m.subject).slice(0, 200) : null, m.body ?? null, m.status || 'queued', m.sentBy ?? null],
  );
  return row ?? null;
}

const redact = (s) => String(s?.message || s).replace(/\b\d{6}\b/g, '******').slice(0, 400);

/** Sends a queued message and records the provider's answer. Returns the updated row. */
export async function dispatch(db, row, content, { env = process.env, fetchImpl = fetch } = {}) {
  try {
    const { provider, ref } = await deliver(row.channel, { to: row.to_address, ...content }, env, fetchImpl);
    const [done] = await db(
      `UPDATE crm_messages SET status = 'accepted', provider = $2, provider_ref = $3, error = NULL, attempts = attempts + 1, updated_at = NOW(), status_at = NOW()
        WHERE id = $1 RETURNING *`,
      [row.id, provider, ref],
    );
    return done;
  } catch (err) {
    const [failed] = await db(
      "UPDATE crm_messages SET status = 'failed', provider = $2, error = $3, attempts = attempts + 1, updated_at = NOW(), status_at = NOW() WHERE id = $1 RETURNING *",
      [row.id, channelStatus(env)[row.channel]?.provider ?? null, redact(err)],
    );
    console.error(`crm ${row.channel} message ${row.id} not sent:`, redact(err));
    return failed;
  }
}

/** Moves a message's status from a provider report. Positive states only move forward; failures always count. */
export async function applyStatus(db, provider, ref, status, error = null) {
  if (!ref || !(status in RANK || FAILED.includes(status))) return 0;
  const rows = FAILED.includes(status)
    ? await db(
        `UPDATE crm_messages SET status = $3, error = COALESCE($4, error), updated_at = NOW(), status_at = NOW()
          WHERE provider = $1 AND provider_ref = $2 AND status NOT IN ('opened', 'clicked') RETURNING id, channel, to_address`,
        [provider, ref, status, error],
      )
    : await db(
        `UPDATE crm_messages SET status = $3, updated_at = NOW(), status_at = NOW()
          WHERE provider = $1 AND provider_ref = $2
            AND COALESCE(array_position(ARRAY['queued','accepted','delivered','opened','clicked'], status::text), 0) < $4 RETURNING id`,
        [provider, ref, status, RANK[status] + 1],
      );
  if (status === 'bounced') for (const r of rows) await suppress(db, r.channel, r.to_address, 'bounced');
  return rows.length;
}

export async function suppress(db, channel, address, reason) {
  const value = channel === 'email' ? String(address).toLowerCase() : String(address).slice(-10);
  await db('INSERT INTO crm_suppressions (channel, address, reason) VALUES ($1, $2, $3) ON CONFLICT (channel, address) DO NOTHING', [channel, value, reason]);
}

// ---------- Unsubscribe links ----------
const unsubSecret = (env) => env.UNSUBSCRIBE_SECRET || env.JWT_SECRET || '';
export function unsubscribeToken(channel, address, env = process.env) {
  return createHmac('sha256', unsubSecret(env)).update(`unsubscribe:${channel}:${String(address).toLowerCase()}`).digest('base64url').slice(0, 32);
}
export function checkUnsubscribe(channel, address, token, env = process.env) {
  const expected = Buffer.from(unsubscribeToken(channel, address, env));
  const given = Buffer.from(String(token ?? ''));
  return unsubSecret(env).length >= 32 && given.length === expected.length && timingSafeEqual(given, expected);
}
export function unsubscribeUrl(channel, address, env = process.env) {
  const base = siteUrl(env);
  if (!base) return null;
  const a = Buffer.from(String(address).toLowerCase()).toString('base64url');
  return `${base}/unsubscribe?c=${channel}&a=${a}&t=${unsubscribeToken(channel, address, env)}`;
}

// ---------- Order and account updates ----------
const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function orderFacts(db, orderId) {
  const [o] = await db('SELECT id, user_id, total, payment_method, status, created_at FROM orders WHERE id = $1', [orderId]);
  if (!o) return null;
  const items = await db('SELECT name, qty, price, courier, tracking_number FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
  return { ...o, items };
}

/** Subject, text and HTML for each update. Only facts from the database; no promises the store can't keep. */
export function compose(event, { user, order, ticket, reply, company, env = process.env }) {
  const first = (user.name || '').split(' ')[0] || 'there';
  const base = siteUrl(env);
  const orderLink = order && base ? `${base}/orders/${order.id}` : null;
  const lines = order ? order.items.map((i) => `• ${i.name} × ${i.qty}`).join('\n') : '';
  const tracking = order?.items.find((i) => i.tracking_number);
  const map = {
    welcome: {
      subject: `Welcome to ${company.name || 'Arvixa Store'}`,
      text: `Hi ${first},\n\nThanks for creating your account. You can track orders, save addresses and manage returns from your account page.${base ? `\n\nStart shopping: ${base}/products` : ''}`,
      short: `Welcome to ${company.name || 'Arvixa Store'}, ${first}! Your account is ready.`,
    },
    order_confirmation: order && {
      subject: `Order #${order.id} confirmed`,
      text: `Hi ${first},\n\nWe’ve received your order #${order.id} for ${rupees(order.total)} (${order.payment_method === 'cod' ? 'cash on delivery' : 'paid online'}).\n\n${lines}${orderLink ? `\n\nTrack it here: ${orderLink}` : ''}`,
      short: `Order #${order.id} confirmed: ${rupees(order.total)}. We'll update you when it ships.`,
    },
    payment_confirmation: order && {
      subject: `Payment received for order #${order.id}`,
      text: `Hi ${first},\n\nWe’ve received your payment of ${rupees(order.total)} for order #${order.id}.${orderLink ? `\n\nOrder details: ${orderLink}` : ''}`,
      short: `Payment of ${rupees(order.total)} received for order #${order.id}.`,
    },
    shipping_update: order && {
      subject: `Order #${order.id} has shipped`,
      text: `Hi ${first},\n\nYour order #${order.id} is on its way${tracking ? ` with ${tracking.courier || 'our courier'}, tracking number ${tracking.tracking_number}` : ''}.${orderLink ? `\n\nTrack it here: ${orderLink}` : ''}`,
      short: `Order #${order.id} has shipped${tracking ? ` (${tracking.courier || 'courier'} ${tracking.tracking_number})` : ''}.`,
    },
    delivery_confirmation: order && {
      subject: `Order #${order.id} delivered`,
      text: `Hi ${first},\n\nYour order #${order.id} has been delivered. If anything isn’t right, you can request a return from your order page within 7 days.${orderLink ? `\n\n${orderLink}` : ''}`,
      short: `Order #${order.id} delivered. Questions? Reply on your order page.`,
    },
    support_update: ticket && {
      subject: `Update on your ticket #${ticket.id}: ${ticket.subject}`,
      text: `Hi ${first},\n\nOur support team replied to your ticket #${ticket.id}:\n\n“${String(reply || '').slice(0, 1500)}”${base ? `\n\nReply here: ${base}/help` : ''}`,
      short: `Support replied to ticket #${ticket.id}. Open your Help page to read it.`,
    },
  };
  return map[event] || null;
}

/**
 * Sends an order or account update on every channel the CRM settings switch on and whose provider is configured.
 * Deduplicated: the same update for the same order / ticket message goes out once per channel, however often it's
 * triggered. Never throws: a provider failure is logged on the message and the store carries on.
 */
export async function notify(db, event, { userId, orderId = null, ticketId = null, messageId = null, reply = null } = {}, { env = process.env, fetchImpl = fetch } = {}) {
  try {
    if (!db) return [];
    const configured = channelStatus(env);
    const settings = await getSettings(db);
    const wanted = CHANNELS.filter((c) => settings.notifications[event]?.[c] && configured[c].configured);
    if (!wanted.length) return [];
    const [user] = await db('SELECT id, name, email, phone, phone_verified, disabled_at FROM users WHERE id = $1', [userId]);
    if (!user || user.disabled_at) return [];
    const order = orderId ? await orderFacts(db, orderId) : null;
    const [ticket] = ticketId ? await db('SELECT id, subject FROM support_tickets WHERE id = $1', [ticketId]) : [];
    const content = compose(event, { user, order, ticket, reply, company: settings.company, env });
    if (!content) return [];
    const ref = orderId ? `order:${orderId}` : ticketId ? `ticket:${ticketId}:${messageId}` : `user:${userId}`;
    const sent = [];
    for (const channel of wanted) {
      // Texts go only to a number the customer verified: a mistyped number must not get someone else's order details
      const to = channel === 'email' ? user.email : user.phone_verified ? user.phone : null;
      if (!to) continue;
      if (channel === 'whatsapp' && !env.WHATSAPP_UPDATE_TEMPLATE) continue; // business-initiated WhatsApp needs a template
      const row = await queueMessage(db, { channel, kind: 'transactional', event, dedupeKey: `${event}:${ref}:${channel}`, userId, ticketId, to, subject: content.subject, body: channel === 'email' ? content.text : content.short });
      if (!row) continue;
      const payload = channel === 'email'
        ? { subject: content.subject, text: content.text, html: emailLayout({ title: content.subject, bodyHtml: textToHtml(content.text), company: settings.company }) }
        : channel === 'sms'
          ? { text: content.short }
          : { text: content.short, template: { name: env.WHATSAPP_UPDATE_TEMPLATE, params: [content.short] } };
      sent.push(await dispatch(db, row, payload, { env, fetchImpl }));
    }
    return sent;
  } catch (err) {
    console.error(`notification ${event} skipped:`, err.message);
    return [];
  }
}

export const maskAddress = (row, canSee) => (canSee ? row.to_address : mask(row.to_address));
