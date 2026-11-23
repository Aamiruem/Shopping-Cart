// Email for the Vercel store, through Resend's HTTP API (https://resend.com). Off until RESEND_API_KEY and MAIL_FROM
// are set: each message is then logged as "skipped" and nothing is sent. Every attempt lands in the notifications
// table, so the admin can see what went out and what failed.
//
//   RESEND_API_KEY  re_...                        from Resend, after verifying the sending domain
//   MAIL_FROM       "Arvixa Store <orders@your-domain>"
//   ADMIN_EMAIL     where new-order and new-lead alerts go (optional)
//   SITE_URL        https://your-domain (optional: defaults to the Vercel production domain)
//
// Sending never throws: a lost email must not undo an order or block a password reset request.

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 5000;

export const emailEnabled = () => Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

export function siteUrl() {
  const explicit = process.env.SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : 'http://localhost:5173';
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function layout(title, paragraphs, action) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join('');
  const button = action
    ? `<p style="margin:20px 0"><a href="${escapeHtml(action.href)}" style="background:#2874f0;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>`
    : '';
  return `<div style="font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#212121;max-width:560px;margin:0 auto;padding:16px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${body}${button}
<p style="margin:24px 0 0;color:#757575;font-size:13px">Arvixa Store · <a href="${escapeHtml(siteUrl())}" style="color:#757575">${escapeHtml(siteUrl().replace(/^https?:\/\//, ''))}</a></p></div>`;
}

// Each template returns { subject, html, text }. Values are escaped here, never by the caller.
export const TEMPLATES = {
  order_placed: ({ name, order, items = [] }) => {
    const lines = items.map((i) => `${escapeHtml(i.name)} × ${Number(i.qty)} — ${rupees(i.price * i.qty)}`);
    const pay = order.payment_method === 'cod' ? 'Pay in cash when it arrives.' : 'Your payment has been received.';
    const link = `${siteUrl()}/orders/${order.id}`;
    return {
      subject: `Order #${order.id} confirmed — ${rupees(order.total)}`,
      html: layout(`Thanks for your order, ${name}`, [
        `We’ve received order <strong>#${order.id}</strong> for <strong>${rupees(order.total)}</strong>. ${pay}`,
        lines.join('<br>'),
        'We’ll email you again when it ships.',
      ], { href: link, label: 'View your order' }),
      text: `Order #${order.id} confirmed: ${rupees(order.total)}. ${pay}\n${items.map((i) => `${i.name} x ${i.qty}`).join('\n')}\nTrack it: ${link}`,
    };
  },
  password_reset: ({ name, link, minutes }) => ({
    subject: 'Reset your Arvixa Store password',
    html: layout(`Hi ${name}`, [
      `Someone asked to reset the password for your Arvixa Store account. The link works once, for ${minutes} minutes.`,
      'If this wasn’t you, ignore this email: your password stays the same.',
    ], { href: link, label: 'Choose a new password' }),
    text: `Reset your Arvixa Store password (works once, for ${minutes} minutes): ${link}\nIf this wasn't you, ignore this email.`,
  }),
  admin_new_order: ({ order, customer, items = [] }) => ({
    subject: `New order #${order.id}: ${rupees(order.total)} (${order.payment_method === 'cod' ? 'cash on delivery' : 'paid online'})`,
    html: layout(`New order #${order.id}`, [
      `${escapeHtml(customer)} ordered ${items.length} item${items.length === 1 ? '' : 's'} for <strong>${rupees(order.total)}</strong>.`,
      items.map((i) => `${escapeHtml(i.name)} × ${Number(i.qty)}`).join('<br>'),
    ], { href: `${siteUrl()}/seller/orders`, label: 'Open Seller Hub' }),
    text: `New order #${order.id} from ${customer}: ${rupees(order.total)}`,
  }),
  admin_new_lead: ({ lead }) => ({
    subject: `${lead.intent === 'high' ? 'Hot lead' : 'New lead'}: ${lead.summary.slice(0, 80)}`,
    html: layout('New enquiry', [
      `<strong>${escapeHtml(lead.summary)}</strong>`,
      `Source: ${escapeHtml(lead.source)} · Intent: ${escapeHtml(lead.intent)} · Type: ${escapeHtml(lead.kind)}`,
      lead.name || lead.email || lead.phone ? `Contact: ${escapeHtml([lead.name, lead.email, lead.phone].filter(Boolean).join(' · '))}` : 'No contact details given.',
      lead.next_step ? `Suggested next step: ${escapeHtml(lead.next_step)}` : '',
    ].filter(Boolean), { href: `${siteUrl()}/seller/leads`, label: 'Open leads' }),
    text: `New ${lead.intent}-intent lead from ${lead.source}: ${lead.summary}`,
  }),
};

async function post(payload, fetcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: data.id ?? null };
    return { ok: false, retry: res.status === 429 || res.status >= 500, error: `${res.status} ${data.message || data.name || ''}`.trim() };
  } catch (err) {
    return { ok: false, retry: true, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one email and records the attempt. Returns 'sent' | 'failed' | 'skipped'. Retries once on a network error,
 * a timeout, a rate limit or a provider error; a rejected message (bad address, unverified domain) is not retried.
 */
export async function sendEmail(db, { to, template, data }, { fetcher = fetch } = {}) {
  let status = 'skipped';
  let attempts = 0;
  let providerId = null;
  let error = null;
  let subject = template;
  try {
    const message = TEMPLATES[template](data);
    subject = message.subject.slice(0, 200);
    if (to && emailEnabled()) {
      let result;
      do {
        attempts += 1;
        result = await post({ from: process.env.MAIL_FROM, to: [to], subject, html: message.html, text: message.text }, fetcher);
      } while (!result.ok && result.retry && attempts < 2);
      status = result.ok ? 'sent' : 'failed';
      providerId = result.id ?? null;
      error = result.ok ? null : result.error;
    } else {
      error = to ? 'Email service not set up (RESEND_API_KEY, MAIL_FROM)' : 'No recipient';
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
  }
  if (status === 'failed') console.error(`email ${template} failed`, error);
  try {
    await db(
      `INSERT INTO notifications (template, recipient, subject, status, provider_id, error, attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [template, String(to || '-').slice(0, 254), subject, status, providerId, error ? String(error).slice(0, 500) : null, Math.max(attempts, 1)],
    );
  } catch (err) {
    console.error('notification log failed', err.message);
  }
  return status;
}

/** Order confirmation to the shopper and an alert to ADMIN_EMAIL. Never throws. */
export async function notifyOrderPlaced(db, order, items, options) {
  try {
    const [user] = await db('SELECT name, email FROM users WHERE id = $1', [order.user_id ?? order.userId]);
    if (!user) return;
    const sends = [sendEmail(db, { to: user.email, template: 'order_placed', data: { name: user.name, order, items } }, options)];
    if (process.env.ADMIN_EMAIL) {
      sends.push(sendEmail(db, { to: process.env.ADMIN_EMAIL, template: 'admin_new_order', data: { order, items, customer: user.name } }, options));
    }
    await Promise.all(sends);
  } catch (err) {
    console.error('order email failed', err.message);
  }
}
