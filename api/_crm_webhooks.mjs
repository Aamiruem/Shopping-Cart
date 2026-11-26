// Provider webhooks: delivery reports and incoming WhatsApp messages. Every request is checked against the provider's
// signature over the exact bytes sent; anything unsigned or wrongly signed is refused and changes nothing.
//
//   POST /api/webhooks/resend     Svix signature (RESEND_WEBHOOK_SECRET, "whsec_..."): sent, delivered, opened, clicked,
//                                 bounced, complained
//   GET  /api/webhooks/whatsapp   Meta's subscription check (WHATSAPP_VERIFY_TOKEN)
//   POST /api/webhooks/whatsapp   X-Hub-Signature-256 (WHATSAPP_APP_SECRET): message statuses and incoming messages
//   POST /api/webhooks/twilio     X-Twilio-Signature (TWILIO_AUTH_TOKEN): SMS status callbacks
import { createHmac, timingSafeEqual } from 'node:crypto';
import { captureWhatsApp } from './_crm_leads.mjs';
import { unsubscribeAddress } from './_crm_marketing.mjs';
import { applyStatus, queueMessage, suppress } from './_messaging.mjs';

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function verifyResend(raw, headers, secret) {
  if (!secret?.startsWith('whsec_')) return false;
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigs = String(headers['svix-signature'] || '');
  if (!id || !ts || !sigs || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay window: 5 minutes
  const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  return sigs.split(' ').some((s) => same(s.split(',')[1] || '', expected));
}

export function verifyMeta(raw, signature, secret) {
  if (!secret || !String(signature).startsWith('sha256=')) return false;
  return same(String(signature).slice(7), createHmac('sha256', secret).update(raw).digest('hex'));
}

export function verifyTwilio(url, form, signature, token) {
  if (!token || !signature) return false;
  const data = url + Object.keys(form).sort().map((k) => k + form[k]).join('');
  return same(signature, createHmac('sha1', token).update(data).digest('base64'));
}

const RESEND = { 'email.sent': 'accepted', 'email.delivered': 'delivered', 'email.opened': 'opened', 'email.clicked': 'clicked', 'email.bounced': 'bounced', 'email.complained': 'bounced', 'email.failed': 'failed' };
const META = { sent: 'accepted', delivered: 'delivered', read: 'opened', failed: 'failed' };
const TWILIO = { sent: 'accepted', delivered: 'delivered', undelivered: 'failed', failed: 'failed' };
const STOP = /^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i;

export async function handleProviderWebhook(provider, { method, url, headers, raw }, { db, env = process.env }) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (provider === 'whatsapp' && method === 'GET') {
    const q = new URL(url).searchParams;
    if (env.WHATSAPP_VERIFY_TOKEN && q.get('hub.mode') === 'subscribe' && same(q.get('hub.verify_token') || '', env.WHATSAPP_VERIFY_TOKEN)) {
      return { status: 200, text: q.get('hub.challenge') || '' };
    }
    return { status: 403, body: { error: 'Verification failed' } };
  }
  if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };

  if (provider === 'resend') {
    if (!verifyResend(raw, h, env.RESEND_WEBHOOK_SECRET)) return { status: 401, body: { error: 'Invalid signature' } };
    const event = JSON.parse(raw);
    const status = RESEND[event.type];
    const ref = event.data?.email_id;
    const updated = status ? await applyStatus(db, 'resend', ref, status, event.type === 'email.bounced' ? String(event.data?.bounce?.message || 'Bounced').slice(0, 300) : null) : 0;
    if (event.type === 'email.complained') for (const to of event.data?.to || []) await suppress(db, 'email', to, 'complained');
    return { status: 200, body: { ok: true, updated } };
  }

  if (provider === 'whatsapp') {
    if (!verifyMeta(raw, h['x-hub-signature-256'], env.WHATSAPP_APP_SECRET)) return { status: 401, body: { error: 'Invalid signature' } };
    const payload = JSON.parse(raw);
    let statuses = 0;
    let messages = 0;
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        for (const s of v.statuses || []) {
          statuses += await applyStatus(db, 'meta', s.id, META[s.status], s.errors?.[0] ? String(s.errors[0].title || s.errors[0].message || '').slice(0, 300) : null);
        }
        for (const m of v.messages || []) {
          const from = String(m.from || '');
          const name = v.contacts?.find((c) => c.wa_id === from)?.profile?.name || null;
          const body = m.type === 'text' ? String(m.text?.body || '') : `[${m.type} message]`;
          // Meta may deliver the same message twice: its id is the dedupe key
          const row = await queueMessage(db, { channel: 'whatsapp', direction: 'in', kind: 'inbound', dedupeKey: `wa-in:${m.id}`, to: from, body: body.slice(0, 4000), status: 'received' });
          if (!row) continue;
          messages++;
          if (STOP.test(body)) await unsubscribeAddress(db, 'whatsapp', from.slice(-10));
          else await captureWhatsApp(db, { phone: from, name, message: body });
        }
      }
    }
    return { status: 200, body: { ok: true, statuses, messages } };
  }

  if (provider === 'twilio') {
    const form = Object.fromEntries(new URLSearchParams(raw));
    if (!verifyTwilio(url, form, h['x-twilio-signature'], env.TWILIO_AUTH_TOKEN)) return { status: 401, body: { error: 'Invalid signature' } };
    const updated = await applyStatus(db, 'twilio', form.MessageSid, TWILIO[form.MessageStatus], form.ErrorCode ? `Twilio error ${form.ErrorCode}` : null);
    return { status: 200, body: { ok: true, updated } };
  }
  if (provider === 'courier') {
    // Shiprocket tracking (its webhook URLs may not contain the word "shiprocket", hence /api/webhooks/courier)
    const { handleTracking } = await import('./_shipping.mjs');
    const { updateFulfilment } = await import('./_seller.mjs');
    return handleTracking(raw, h, { db, env, deliver: (orderId) => updateFulfilment({ db, userId: null, role: 'admin', id: orderId, body: { fulfilment: 'delivered' } }).catch((err) => console.error('delivered not recorded', err.message)) });
  }
  return { status: 404, body: { error: 'Unknown provider' } };
}
