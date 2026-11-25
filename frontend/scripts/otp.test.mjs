// Run with: npm test (from frontend/). One-time codes in the store API (api/_otp.mjs and the auth routes) on PGlite,
// a real PostgreSQL engine, with a fake delivery function standing in for the providers. The provider requests
// themselves are checked against a fake fetch at the end.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { availableChannels, deliver, mask, providerStatus } from '../../api/_otp.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
const SECRET = 'x'.repeat(40);
// Every provider "configured" with fake credentials; the fake `send` below means nothing leaves the machine
const ENV = {
  JWT_SECRET: SECRET, RESEND_API_KEY: 're_test', EMAIL_FROM: 'Arvixa <otp@example.com>',
  MSG91_AUTH_KEY: 'msg91-test', MSG91_OTP_TEMPLATE_ID: 'tpl-1',
  WHATSAPP_ACCESS_TOKEN: 'wa-test', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TEMPLATE_NAME: 'arvixa_otp',
};
let outbox;
let failNext = false;
const send = async (message) => {
  if (failNext) {
    failNext = false;
    throw new Error('resend 422: {"message":"domain not verified", "echo":"123456"}');
  }
  outbox.push(message);
  return { provider: 'fake', ref: `ref-${outbox.length}` };
};
let ipCounter = 0;
const call = (method, rest, body, { authorization, env = ENV, ip = `10.1.0.${++ipCounter}` } = {}) =>
  handleAuth({ method, rest, body, ip, authorization }, { store: postgresStore(db), domainError: async () => null, env, send });
const lastCode = () => outbox.at(-1).code;
const wrong = (code) => (code === '000000' ? '111111' : '000000');

before(async () => {
  process.env.JWT_SECRET = SECRET;
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(async () => {
  await pg.exec('TRUNCATE users, auth_rate_limits, verification_codes, otp_delivery_logs RESTART IDENTITY CASCADE');
  outbox = [];
  failNext = false;
});

async function signUp(email = 'asha@example.com', password = 'secret123') {
  const start = await call('POST', 'register', { name: 'Asha Rao', email, password });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  return (await call('POST', 'register/verify', { email, code: lastCode() })).body;
}

test('only configured channels are offered; development codes never appear in production', () => {
  assert.deepEqual(availableChannels({}), { email: false, sms: false, whatsapp: false });
  assert.deepEqual(availableChannels(ENV), { email: true, sms: true, whatsapp: true });
  assert.deepEqual(availableChannels({ ...ENV, WHATSAPP_OTP_ENABLED: 'false' }).whatsapp, false);
  assert.deepEqual(providerStatus({ RESEND_API_KEY: 'k' }).email.missing, ['EMAIL_FROM']);
  assert.equal(providerStatus({ TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_SMS_FROM: '+1' }).sms.provider, 'twilio');
  assert.equal(availableChannels({ OTP_DEV_CODES: '1' }).dev, true);
  assert.equal(availableChannels({ OTP_DEV_CODES: '1', VERCEL_ENV: 'production' }).dev, undefined);
  assert.equal(availableChannels({ OTP_DEV_CODES: '1', NODE_ENV: 'production' }).email, false);
  assert.equal(mask('asha@example.com'), 'a**a@example.com');
  assert.equal(mask('9876543210'), '******3210');
});

test('signup: the account exists only after the emailed code comes back, and it is verified', async () => {
  const start = await call('POST', 'register', { name: 'Asha Rao', email: 'Asha@Example.com', password: 'secret123' });
  assert.equal(start.status, 202);
  assert.deepEqual(Object.keys(start.body).sort(), ['channel', 'expiresInSeconds', 'sentTo', 'verify']);
  assert.equal(start.body.sentTo, 'a**a@example.com');
  assert.equal((await db('SELECT count(*)::int AS n FROM users'))[0].n, 0, 'no account yet');
  assert.deepEqual([outbox[0].channel, outbox[0].target, outbox[0].purpose], ['email', 'asha@example.com', 'signup']);
  const code = lastCode();
  assert.match(code, /^\d{6}$/);
  // Only a hash is stored
  const stored = JSON.stringify(await db('SELECT * FROM verification_codes'));
  assert.ok(!stored.includes(code), 'the code itself is never stored');

  const bad = await call('POST', 'register/verify', { email: 'asha@example.com', code: wrong(code) });
  assert.deepEqual([bad.status, bad.body.error], [400, 'That code is not correct. 4 attempts left.']);
  const ok = await call('POST', 'register/verify', { email: 'asha@example.com', code });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.emailVerified, true);
  assert.ok(ok.body.token);
  // One-time use
  assert.equal((await call('POST', 'register/verify', { email: 'asha@example.com', code })).status, 400);
  // Verified status persists: a fresh password login sees it
  const again = await call('POST', 'login', { email: 'asha@example.com', password: 'secret123' });
  assert.equal(again.body.user.emailVerified, true);
});

test('expiry, attempt limit, cooldown and the hourly cap', async () => {
  await call('POST', 'register', { name: 'Asha Rao', email: 'asha@example.com', password: 'secret123' });
  const first = lastCode();
  await db("UPDATE verification_codes SET expires_at = NOW() - INTERVAL '1 second'");
  assert.match((await call('POST', 'register/verify', { email: 'asha@example.com', code: first })).body.error, /expired/);

  // Cooldown: a second code right away is refused, with Retry-After
  const quick = await call('POST', 'register/resend', { email: 'asha@example.com' });
  assert.equal(quick.status, 429);
  assert.ok(Number(quick.headers['Retry-After']) > 0);

  await db("UPDATE verification_codes SET created_at = NOW() - INTERVAL '2 minutes'");
  assert.equal((await call('POST', 'register/resend', { email: 'asha@example.com' })).status, 200);
  const code = lastCode();
  for (let i = 0; i < 5; i += 1) await call('POST', 'register/verify', { email: 'asha@example.com', code: wrong(code) });
  assert.match((await call('POST', 'register/verify', { email: 'asha@example.com', code })).body.error, /Too many wrong attempts/);

  // At most 5 codes to one address in an hour, whatever the IP
  for (let i = 0; i < 3; i += 1) {
    await db("UPDATE verification_codes SET created_at = created_at - INTERVAL '2 minutes'");
    assert.equal((await call('POST', 'register/resend', { email: 'asha@example.com' })).status, 200);
  }
  await db("UPDATE verification_codes SET created_at = created_at - INTERVAL '2 minutes'");
  const capped = await call('POST', 'register/resend', { email: 'asha@example.com' });
  assert.deepEqual([capped.status, /an hour/.test(capped.body.error)], [429, true]);
});

test('code requests are rate limited per connection', async () => {
  const ip = '10.9.9.9';
  let status;
  for (let i = 0; i < 9; i += 1) status = (await call('POST', 'otp', { identifier: `nobody${i}@example.com` }, { ip })).status;
  assert.equal(status, 429);
});

test('passwordless login: the same reply for unknown accounts, and nothing is sent to them', async () => {
  await signUp();
  outbox = [];
  const unknown = await call('POST', 'otp', { identifier: 'nobody@example.com' });
  const known = await call('POST', 'otp', { identifier: 'ASHA@example.com' });
  assert.deepEqual([unknown.status, Object.keys(unknown.body).sort()], [200, Object.keys(known.body).sort()]);
  assert.equal(outbox.length, 1, 'only the real account got a code');
  assert.equal((await call('POST', 'otp/verify', { identifier: 'nobody@example.com', code: '123456' })).status, 400);
  const ok = await call('POST', 'otp/verify', { identifier: 'asha@example.com', code: lastCode() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, 'asha@example.com');
});

test('mobile numbers: verify by WhatsApp, then log in by SMS; unverified numbers get nothing', async () => {
  const { token } = await signUp();
  const authorization = `Bearer ${token}`;
  outbox = [];
  // Typed at signup or in the profile, but not verified: a login code is not sent
  assert.equal((await call('POST', 'otp', { identifier: '9876543210', channel: 'sms' })).status, 200);
  assert.equal(outbox.length, 0);

  const sent = await call('POST', 'phone/otp', { phone: '9876543210', channel: 'whatsapp' }, { authorization });
  assert.deepEqual([sent.status, sent.body.channel, sent.body.sentTo], [200, 'whatsapp', '******3210']);
  assert.equal(outbox[0].channel, 'whatsapp');
  const user = await call('POST', 'phone/verify', { phone: '9876543210', code: lastCode() }, { authorization });
  assert.deepEqual([user.body.phone, user.body.phoneVerified], ['9876543210', true]);

  await call('POST', 'otp', { identifier: '+91 98765 43210', channel: 'sms' });
  assert.deepEqual([outbox.at(-1).channel, outbox.at(-1).target], ['sms', '9876543210']);
  const ok = await call('POST', 'otp/verify', { identifier: '919876543210', code: lastCode() });
  assert.equal(ok.body.user.phoneVerified, true);

  // Someone else can't take a verified number
  const other = await signUp('ravi@example.com');
  const taken = await call('POST', 'phone/otp', { phone: '9876543210' }, { authorization: `Bearer ${other.token}` });
  assert.equal(taken.status, 409);
});

test('password reset by code', async () => {
  await signUp();
  await call('POST', 'password/forgot', { identifier: 'asha@example.com' });
  assert.equal(outbox.at(-1).purpose, 'reset');
  const code = lastCode();
  assert.equal((await call('POST', 'password/reset', { identifier: 'asha@example.com', code, password: 'short' })).status, 400);
  const reset = await call('POST', 'password/reset', { identifier: 'asha@example.com', code, password: 'brandnew99' });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.token);
  assert.equal((await call('POST', 'login', { email: 'asha@example.com', password: 'secret123' })).status, 401);
  assert.equal((await call('POST', 'login', { email: 'asha@example.com', password: 'brandnew99' })).status, 200);
  // A login code can't reset a password: purposes are separate
  await db("UPDATE verification_codes SET created_at = NOW() - INTERVAL '2 minutes'");
  await call('POST', 'otp', { identifier: 'asha@example.com' });
  assert.equal((await call('POST', 'password/reset', { identifier: 'asha@example.com', code: lastCode(), password: 'another123' })).status, 400);
});

test('no fake delivery: an unconfigured channel is refused, and a provider failure is reported truthfully', async () => {
  const noEmail = { JWT_SECRET: SECRET };
  // Without an email provider, signup creates the account directly and unverified (no code pretends to be sent)
  const direct = await call('POST', 'register', { name: 'Ravi', email: 'ravi@example.com', password: 'secret123' }, { env: noEmail });
  assert.deepEqual([direct.status, direct.body.user.emailVerified], [201, false]);
  const refused = await call('POST', 'otp', { identifier: 'ravi@example.com' }, { env: noEmail });
  assert.deepEqual([refused.status, /aren’t available/.test(refused.body.error)], [503, true]);
  assert.equal(outbox.length, 0);
  assert.equal((await db('SELECT count(*)::int AS n FROM verification_codes'))[0].n, 0);

  failNext = true;
  const failed = await call('POST', 'register', { name: 'Asha Rao', email: 'asha@example.com', password: 'secret123' });
  assert.deepEqual([failed.status, /couldn’t send the email/.test(failed.body.error)], [502, true]);
  const [row] = await db('SELECT used_at FROM verification_codes');
  assert.ok(row.used_at, 'the unsent code is cancelled');
  const [entry] = await db('SELECT * FROM otp_delivery_logs');
  assert.equal(entry.status, 'failed');
  assert.doesNotMatch(entry.error, /123456/, 'digits that look like a code are blanked out of the log');
  assert.equal(entry.target_masked, 'a**a@example.com');
});

test('admin report: providers and counts, without codes or full addresses; customers are refused', async () => {
  const asha = await signUp();
  await call('POST', 'otp', { identifier: 'nobody@example.com' });
  assert.equal((await call('GET', 'otp/status', null, { authorization: `Bearer ${asha.token}` })).status, 403);
  await db("UPDATE users SET role = 'admin' WHERE email = 'asha@example.com'");
  const report = (await call('GET', 'otp/status', null, { authorization: `Bearer ${asha.token}` })).body;
  assert.equal(report.channels.email.health, 'healthy');
  assert.equal(report.channels.sms.health, 'unused');
  assert.equal(report.last24h.requested, 1);
  assert.equal(report.last24h.verified, 1);
  const text = JSON.stringify(report);
  assert.ok(!text.includes('asha@example.com'), 'addresses are masked');
});

test('provider requests: Resend, MSG91, Twilio and the WhatsApp Cloud API', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'em_1', type: 'success', request_id: 'r1', sid: 'SM1', messages: [{ id: 'wamid.1' }] }), { status: 200 });
  };
  const msg = { code: '482913', purpose: 'login' };
  assert.deepEqual(await deliver({ ...msg, channel: 'email', target: 'asha@example.com' }, ENV, fakeFetch), { provider: 'resend', ref: 'em_1' });
  assert.deepEqual(await deliver({ ...msg, channel: 'sms', target: '9876543210' }, ENV, fakeFetch), { provider: 'msg91', ref: 'r1' });
  const twilioEnv = { ...ENV, SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_SMS_FROM: '+15550001' };
  assert.deepEqual(await deliver({ ...msg, channel: 'sms', target: '9876543210' }, twilioEnv, fakeFetch), { provider: 'twilio', ref: 'SM1' });
  assert.deepEqual(await deliver({ ...msg, channel: 'whatsapp', target: '9876543210' }, ENV, fakeFetch), { provider: 'meta', ref: 'wamid.1' });

  const [resend, msg91, twilio, meta] = calls;
  assert.equal(resend.url, 'https://api.resend.com/emails');
  assert.equal(resend.init.headers.Authorization, 'Bearer re_test');
  assert.match(JSON.parse(resend.init.body).html, /482913/);
  assert.match(msg91.url, /^https:\/\/control\.msg91\.com\/api\/v5\/otp\?template_id=tpl-1&mobile=919876543210&otp=482913/);
  assert.equal(msg91.init.headers.authkey, 'msg91-test');
  assert.equal(twilio.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
  assert.equal(new URLSearchParams(twilio.init.body).get('To'), '+919876543210');
  assert.equal(meta.url, 'https://graph.facebook.com/v21.0/123/messages');
  const template = JSON.parse(meta.init.body).template;
  assert.deepEqual([template.name, template.components[0].parameters[0].text, template.components[1].parameters[0].text], ['arvixa_otp', '482913', '482913']);

  // A provider error is an error, never a success
  const refusing = async () => new Response(JSON.stringify({ message: 'invalid template' }), { status: 400 });
  await assert.rejects(deliver({ ...msg, channel: 'sms', target: '9876543210' }, ENV, refusing), /msg91 400/);
  const msg91Says = async () => new Response(JSON.stringify({ type: 'error', message: 'DLT template not approved' }), { status: 200 });
  await assert.rejects(deliver({ ...msg, channel: 'sms', target: '9876543210' }, ENV, msg91Says), /DLT template not approved/);
});
