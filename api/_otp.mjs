// One-time codes for the store API: signup, passwordless login, password reset and phone verification, by email,
// SMS or WhatsApp. A port of backend/app/services/verification.py on the same `verification_codes` table, so codes,
// limits and response shapes match the full backend.
//
// Rules: 6-digit codes from a cryptographic RNG, stored only as an HMAC; one-time use; expire (OTP_EXPIRY_SECONDS);
// a few wrong tries (OTP_MAX_ATTEMPTS) end the code; a cooldown before resending; at most MAX_PER_HOUR codes to one
// address per hour. A channel is offered only when its provider is configured. There is no fake delivery: without a
// provider the channel is simply unavailable. The one exception is local development (OTP_DEV_CODES=1, never in a
// production build), where the code is returned as `devCode` instead of being sent.
//
// Providers (environment variables, see .env.example):
//   email     Resend          RESEND_API_KEY, EMAIL_FROM
//   SMS       MSG91 (India)   MSG91_AUTH_KEY, MSG91_OTP_TEMPLATE_ID (a DLT-approved template)   or
//             Twilio          TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM
//   WhatsApp  Meta Cloud API  WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE_NAME (an approved
//                             authentication template), WHATSAPP_TEMPLATE_LANG (default en)
// Set EMAIL_OTP_ENABLED / SMS_OTP_ENABLED / WHATSAPP_OTP_ENABLED=false to switch a configured channel off.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { ApiError } from './_auth.mjs';

export const CODE_LENGTH = 6; // the code boxes on the site are made for six digits
const MAX_PER_HOUR = 5;
const LABEL = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };
const PURPOSE_TEXT = {
  signup: 'verify your email and finish creating your Arvixa Store account',
  login: 'log in to your Arvixa Store account',
  reset: 'reset your Arvixa Store password',
  phone: 'verify your mobile number on Arvixa',
  mobile: 'sign in to Arvixa Store',
  test: 'confirm a test delivery from the Arvixa admin panel',
};

const num = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
export const settings = (env = process.env) => ({
  expirySeconds: num(env.OTP_EXPIRY_SECONDS, 300, 60, 1800),
  maxAttempts: num(env.OTP_MAX_ATTEMPTS, 5, 1, 10),
  cooldownSeconds: num(env.OTP_RESEND_COOLDOWN_SECONDS, 30, 10, 600),
});

const isProduction = (env) => env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';
const devCodes = (env) => env.OTP_DEV_CODES === '1' && !isProduction(env);
const enabled = (env, channel) => env[`${channel.toUpperCase()}_OTP_ENABLED`] !== 'false';

/** Which provider each channel would use, and what's missing for the ones that aren't set up. */
export function providerStatus(env = process.env) {
  const need = (names) => names.filter((n) => !env[n]);
  const email = { provider: 'resend', missing: need(['RESEND_API_KEY', 'EMAIL_FROM']) };
  const msg91 = { provider: 'msg91', missing: need(['MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID']) };
  const twilio = { provider: 'twilio', missing: need(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_SMS_FROM']) };
  // SMS_PROVIDER picks one; otherwise whichever is fully set up, MSG91 first (Indian DLT templates)
  const pick = { msg91, twilio }[env.SMS_PROVIDER];
  const sms = pick || (!msg91.missing.length ? msg91 : !twilio.missing.length ? twilio : msg91);
  const whatsapp = { provider: 'meta', missing: need(['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_NAME']) };
  const out = {};
  for (const [channel, p] of Object.entries({ email, sms, whatsapp })) {
    const on = enabled(env, channel);
    out[channel] = { provider: p.provider, configured: on && !p.missing.length, missing: p.missing, switchedOff: !on };
  }
  return out;
}

/** The channels a shopper can choose right now. */
export function availableChannels(env = process.env) {
  if (devCodes(env)) return { email: true, sms: true, whatsapp: true, dev: true };
  const status = providerStatus(env);
  return { email: status.email.configured, sms: status.sms.configured, whatsapp: status.whatsapp.configured };
}

export function mask(target) {
  if (target.includes('@')) return target.replace(/^(.)(.*)(.@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.max(b.length, 1)) + c);
  return `${'*'.repeat(Math.max(target.length - 4, 0))}${target.slice(-4)}`;
}

const secret = (env = process.env) => env.OTP_HASH_SECRET || env.JWT_SECRET || '';
// Same HMAC as the full backend when OTP_HASH_SECRET isn't set, so either backend can check the other's codes
const hashCode = (code, env) => createHmac('sha256', secret(env)).update(`verify:${code}`).digest('hex');

// ---------- Delivery ----------
const e164 = (phone) => (phone.startsWith('+') ? phone : `+91${phone.slice(-10)}`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function emailHtml(code, why, minutes, support) {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#15171c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#0b1530;padding:20px 28px;color:#ffffff;font-size:20px;font-weight:bold">Arvixa Store</td></tr>
<tr><td style="padding:28px">
<p style="margin:0 0 12px;font-size:16px">Use this code to ${esc(why)}:</p>
<p style="margin:0 0 16px;font-size:34px;letter-spacing:8px;font-weight:bold;color:#2f5bff">${esc(code)}</p>
<p style="margin:0 0 12px;font-size:14px;color:#52514e">It expires in ${minutes} minutes and works once.</p>
<p style="margin:0 0 12px;font-size:14px;color:#52514e"><strong>Never share this code</strong>, not even with Arvixa staff. We will never ask for it.</p>
<p style="margin:0;font-size:13px;color:#898781">Didn’t ask for this? You can ignore this email; nothing changes without the code.${support ? ` Questions: ${esc(support)}` : ''}</p>
</td></tr></table></td></tr></table></body></html>`;
}

/**
 * Sends a code through the channel's provider. Returns { provider, ref } once the provider has accepted the message;
 * throws with the provider's reason otherwise. Accepted is not the same as delivered: that needs the provider's
 * delivery reports.
 */
export async function deliver({ channel, target, code, purpose }, env = process.env, fetchImpl = fetch) {
  const why = PURPOSE_TEXT[purpose];
  const minutes = Math.round(settings(env).expirySeconds / 60);
  const status = providerStatus(env)[channel];
  const post = async (url, init) => {
    const res = await fetchImpl(url, { ...init, method: 'POST', signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${status.provider} ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  };
  if (channel === 'email') {
    const body = await post('https://api.resend.com/emails', {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [target],
        subject: `${code} is your Arvixa Store verification code`,
        text: `${code} is your Arvixa Store code to ${why}. It expires in ${minutes} minutes. Never share it with anyone.`,
        html: emailHtml(code, why, minutes, env.SUPPORT_EMAIL || env.VITE_CONTACT_EMAIL),
      }),
    });
    return { provider: 'resend', ref: body.id ?? null };
  }
  if (channel === 'sms' && status.provider === 'msg91') {
    // MSG91's OTP API with a DLT-approved template that has a ##OTP## placeholder
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.search = new URLSearchParams({ template_id: env.MSG91_OTP_TEMPLATE_ID, mobile: e164(target).slice(1), otp: code, otp_expiry: String(minutes) });
    const body = await post(url, { headers: { authkey: env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' }, body: '{}' });
    if (body.type && body.type !== 'success') throw new Error(`msg91: ${String(body.message || body.type).slice(0, 200)}`);
    return { provider: 'msg91', ref: body.request_id ?? null };
  }
  if (channel === 'sms') {
    const body = await post(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: e164(target), From: env.TWILIO_SMS_FROM, Body: `${code} is your Arvixa Store code to ${why}. It expires in ${minutes} min. Never share it.`,
        // Delivery reports come back to the store (api/_crm_webhooks.mjs): only they mark a code delivered
        ...(env.SITE_URL && (env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production') ? { StatusCallback: `${env.SITE_URL.replace(/\/$/, '')}/api/webhooks/twilio` } : {}),
      }),
    });
    return { provider: 'twilio', ref: body.sid ?? null };
  }
  // WhatsApp: an approved "authentication" template, whose body and copy-code button both take the code
  const body = await post(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: e164(target).slice(1),
      type: 'template',
      template: {
        name: env.WHATSAPP_TEMPLATE_NAME,
        language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          ...(env.WHATSAPP_TEMPLATE_BUTTON === 'false' ? [] : [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }]),
        ],
      },
    }),
  });
  return { provider: 'meta', ref: body.messages?.[0]?.id ?? null };
}

// ---------- Codes ----------
const fail = (status, message, headers) => {
  throw new ApiError(status, message, headers);
};

/** What the caller is told after a code is sent; also returned, without sending anything, for unknown accounts. */
export const sentResponse = (target, channel, env = process.env) => ({ sentTo: mask(target), channel, expiresInSeconds: settings(env).expirySeconds });

async function log(db, entry) {
  await db(
    `INSERT INTO otp_delivery_logs (verification_id, purpose, channel, provider, target_masked, status, provider_ref, error, provider_code, latency_ms, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [entry.id ?? null, entry.purpose, entry.channel, entry.provider ?? null, entry.masked, entry.status, entry.ref ?? null, entry.error ?? null,
      entry.code ?? null, entry.ms ?? null, entry.attempts ?? 1],
  ).catch(() =>
    // Before db:setup added the new columns: the original log line still gets written
    db(`INSERT INTO otp_delivery_logs (verification_id, purpose, channel, provider, target_masked, status, provider_ref, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.id ?? null, entry.purpose, entry.channel, entry.provider ?? null, entry.masked, entry.status, entry.ref ?? null, entry.error ?? null]),
  ).catch((err) => console.error('otp log not written', err.message)); // a lost log line never blocks a login
}

// A provider timeout, network error or 5xx is worth one more try after a short pause; a 4xx (bad number, template,
// credentials) is not: the same request would fail the same way.
const transient = (err) => /timeout|aborted|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN| 5\d\d:/i.test(String(err?.message || err));
const httpCode = (err) => String(err?.message || '').match(/\b(\d{3}):/)?.[1] ?? (transient(err) ? 'network' : null);
async function sendWithRetry(send, args, env, retries = 1, pauseMs = 800) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return { ...(await send(args, env)), attempts };
    } catch (err) {
      if (attempts > retries || !transient(err)) {
        err.attempts = attempts;
        throw err;
      }
      await new Promise((r) => setTimeout(r, pauseMs * attempts));
    }
  }
}

/** A provider's delivery report for a code it accepted: only this ever marks a code delivered (or failed). */
export async function applyOtpStatus(db, provider, ref, status, error = null) {
  if (!ref || !['delivered', 'failed'].includes(status)) return 0;
  const rows = await db(
    `UPDATE otp_delivery_logs SET status = $3, error = COALESCE($4, error), delivered_at = CASE WHEN $3 = 'delivered' THEN NOW() ELSE delivered_at END, updated_at = NOW()
      WHERE provider = $1 AND provider_ref = $2 AND status IN ('accepted', 'delivered') RETURNING id`,
    [provider, ref, status, error],
  ).catch(() => []);
  return rows.length;
}

/**
 * Creates and sends a code for (purpose, target) by `channel`. user_id / payload ride along to the check.
 * `send` is the delivery function (tests pass a fake one).
 */
export async function sendCode(db, { purpose, target, channel, userId = null, payload = null }, { env = process.env, send = deliver, retries = 1 } = {}) {
  const channels = availableChannels(env);
  if (!channels[channel]) fail(503, `${LABEL[channel] || 'That'} codes aren’t available right now. Please choose another way.`);
  if (!secret(env) || secret(env).length < 32) fail(503, 'Verification is temporarily unavailable. Please try again later.');
  const { expirySeconds, cooldownSeconds } = settings(env);
  const [recent] = await db(
    `SELECT COUNT(*)::int AS hour,
            EXTRACT(EPOCH FROM NOW() - MAX(created_at) FILTER (WHERE purpose = $2))::float AS age
       FROM verification_codes WHERE target = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [target, purpose],
  );
  if (recent.age !== null && recent.age < cooldownSeconds) {
    const wait = Math.ceil(cooldownSeconds - recent.age);
    fail(429, `Please wait ${wait} seconds before requesting a new code`, { 'Retry-After': String(wait) });
  }
  if (recent.hour >= MAX_PER_HOUR) fail(429, 'Too many codes were sent to this address. Please try again in an hour.', { 'Retry-After': '3600' });

  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
  // A new code replaces any unused one for the same purpose and address
  const [row] = await db(
    `WITH old AS (UPDATE verification_codes SET used_at = NOW() WHERE purpose = $1 AND target = $2 AND used_at IS NULL)
     INSERT INTO verification_codes (purpose, target, channel, user_id, payload, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW() + make_interval(secs => $7)) RETURNING id`,
    [purpose, target, channel, userId, payload === null ? null : JSON.stringify(payload), hashCode(code, env), expirySeconds],
  );
  const masked = mask(target);
  if (channels.dev) {
    await log(db, { id: row.id, purpose, channel, provider: 'dev', masked, status: 'not_sent_dev' });
    return { ...sentResponse(target, channel, env), devCode: code }; // local development only: nothing is sent
  }
  const started = Date.now();
  try {
    const { provider, ref, attempts } = await sendWithRetry(send, { channel, target, code, purpose }, env, retries);
    // "accepted" = sent to the provider. It is not "delivered": only the provider's delivery report says that.
    await log(db, { id: row.id, purpose, channel, provider, masked, status: 'accepted', ref, code: '2xx', ms: Date.now() - started, attempts });
  } catch (err) {
    // Not sent: the code must not stay usable, and the shopper is told the truth
    await db('UPDATE verification_codes SET used_at = NOW() WHERE id = $1', [row.id]);
    const reason = String(err.message || err).replace(/\b\d{4,8}\b/g, '******').slice(0, 300); // never log a code
    await log(db, { id: row.id, purpose, channel, provider: providerStatus(env)[channel].provider, masked, status: 'failed', error: reason, code: httpCode(err), ms: Date.now() - started, attempts: err.attempts ?? 1 });
    console.error(`otp ${channel} not sent:`, reason);
    fail(502, `We couldn’t send the ${channel === 'email' ? 'email' : LABEL[channel]} right now. Please try again in a minute or choose another way.`);
  }
  return sentResponse(target, channel, env);
}

/** Consumes the latest code for (purpose, target) if `code` matches; returns its row ({ user_id, payload }). */
export async function checkCode(db, { purpose, target, code }, { env = process.env } = {}) {
  const value = String(code ?? '').trim();
  if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(value)) fail(400, `Please enter the ${CODE_LENGTH}-digit code`);
  const { maxAttempts } = settings(env);
  const [row] = await db(
    `SELECT *, expires_at < NOW() AS expired FROM verification_codes
      WHERE purpose = $1 AND target = $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [purpose, target],
  );
  if (!row) fail(400, 'No active code. Please request a new one.');
  if (row.expired) fail(400, 'This code has expired. Please request a new one.');
  if (row.attempts >= maxAttempts) fail(400, 'Too many wrong attempts. Please request a new code.');
  const ok = timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(value, env)));
  if (!ok) {
    await db('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    const left = maxAttempts - row.attempts - 1;
    fail(400, left > 0 ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new code.');
  }
  // One-time use: only the request that flips used_at gets the row, so two quick submits can't both succeed
  const [used] = await db('UPDATE verification_codes SET used_at = NOW(), verified_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING *', [row.id]);
  if (!used) fail(400, 'This code has already been used. Please request a new one.');
  // The person typed the code in, so it reached them: delivered, whatever the provider has reported so far
  await db(`UPDATE otp_delivery_logs SET status = 'delivered', delivered_at = COALESCE(delivered_at, NOW()), updated_at = NOW() WHERE verification_id = $1 AND status IN ('accepted', 'delivered')`, [row.id]).catch(() => {});
  return { ...used, payload: typeof used.payload === 'string' ? JSON.parse(used.payload) : used.payload };
}

/** For the admin: providers, counts for the last 24 hours and recent events. No codes and no full addresses. */
export async function otpReport(db, env = process.env) {
  const [codes] = await db(
    `SELECT COUNT(*)::int AS requested,
            COUNT(*) FILTER (WHERE verified_at IS NOT NULL)::int AS verified,
            COUNT(*) FILTER (WHERE used_at IS NULL AND expires_at < NOW())::int AS expired,
            COALESCE(SUM(attempts), 0)::int AS wrong_attempts
       FROM verification_codes WHERE created_at > NOW() - INTERVAL '24 hours'`,
  );
  const delivery = await db(
    `SELECT channel, status, COUNT(*)::int AS count FROM otp_delivery_logs
      WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY channel, status`,
  );
  const recent = await db(
    `SELECT purpose, channel, provider, target_masked, status, error, created_at FROM otp_delivery_logs
      ORDER BY created_at DESC, id DESC LIMIT 20`,
  );
  const status = providerStatus(env);
  for (const channel of Object.keys(status)) {
    const last = recent.find((r) => r.channel === channel && r.status !== 'not_sent_dev');
    // Health from real outcomes: the last delivery this channel attempted
    status[channel].health = !status[channel].configured ? 'not_configured' : !last ? 'unused' : ['accepted', 'delivered'].includes(last.status) ? 'healthy' : 'failing';
    status[channel].lastError = last?.status === 'failed' ? last.error : null;
  }
  return { channels: status, devCodes: devCodes(env), last24h: { ...codes, delivery }, recent };
}

/**
 * Admin-only OTP diagnostics (CRM → Notifications → OTP): per channel the provider, whether it is configured (and
 * which variables are missing), the last request, the last code a provider accepted, the last confirmed delivery,
 * the last failure with the provider's response code, the 7-day funnel and the delivery-report webhook.
 * Never includes a code, a secret, a token or a full address.
 */
export async function otpDiagnostics(db, env = process.env) {
  const status = providerStatus(env);
  const hooks = { email: Boolean(env.RESEND_WEBHOOK_SECRET), sms: status.sms.provider === 'twilio' ? Boolean(env.TWILIO_AUTH_TOKEN) : false, whatsapp: Boolean(env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN) };
  const rows = await db(
    `SELECT channel,
            max(created_at) AS last_request,
            max(created_at) FILTER (WHERE status IN ('accepted', 'delivered')) AS last_accepted,
            max(COALESCE(delivered_at, created_at)) FILTER (WHERE status = 'delivered') AS last_delivered,
            count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS sent_7d,
            count(*) FILTER (WHERE status IN ('accepted', 'delivered') AND created_at > NOW() - INTERVAL '7 days')::int AS accepted_7d,
            count(*) FILTER (WHERE status = 'delivered' AND created_at > NOW() - INTERVAL '7 days')::int AS delivered_7d,
            count(*) FILTER (WHERE status = 'failed' AND created_at > NOW() - INTERVAL '7 days')::int AS failed_7d
       FROM otp_delivery_logs WHERE status <> 'not_sent_dev' GROUP BY channel`,
  );
  const failures = await db(
    `SELECT DISTINCT ON (channel) channel, created_at, error, provider, provider_code FROM otp_delivery_logs
      WHERE status = 'failed' ORDER BY channel, created_at DESC`,
  ).catch(() => db(`SELECT DISTINCT ON (channel) channel, created_at, error, provider FROM otp_delivery_logs WHERE status = 'failed' ORDER BY channel, created_at DESC`));
  const [codes] = await db(
    `SELECT count(*)::int AS requested, count(*) FILTER (WHERE verified_at IS NOT NULL)::int AS verified,
            count(*) FILTER (WHERE used_at IS NULL AND expires_at < NOW())::int AS expired
       FROM verification_codes WHERE created_at > NOW() - INTERVAL '7 days'`,
  );
  const recent = await db(
    `SELECT id, purpose, channel, provider, target_masked, status, error, created_at FROM otp_delivery_logs ORDER BY created_at DESC, id DESC LIMIT 40`,
  );
  const channels = {};
  for (const ch of ['email', 'sms', 'whatsapp']) {
    const r = rows.find((x) => x.channel === ch) || {};
    const f = failures.find((x) => x.channel === ch);
    channels[ch] = {
      provider: status[ch].provider,
      state: status[ch].switchedOff ? 'switched_off' : !status[ch].configured ? 'not_configured' : !r.last_request ? 'never_used' : f && (!r.last_accepted || f.created_at > r.last_accepted) ? 'failing' : 'working',
      missing: status[ch].missing,
      webhook: hooks[ch],
      lastRequest: r.last_request ?? null,
      lastAccepted: r.last_accepted ?? null,
      lastDelivered: r.last_delivered ?? null,
      lastFailure: f ? { at: f.created_at, reason: f.error, code: f.provider_code ?? null } : null,
      last7Days: { sent: r.sent_7d ?? 0, acceptedByProvider: r.accepted_7d ?? 0, deliveredConfirmed: r.delivered_7d ?? 0, failed: r.failed_7d ?? 0 },
    };
  }
  const funnel = { requested: codes.requested, sentToProvider: rows.reduce((n, r) => n + r.accepted_7d, 0), delivered: rows.reduce((n, r) => n + r.delivered_7d, 0),
    failed: rows.reduce((n, r) => n + r.failed_7d, 0), verified: codes.verified, expired: codes.expired };
  return { channels, funnel, recent, devCodes: devCodes(env), settings: settings(env) };
}
