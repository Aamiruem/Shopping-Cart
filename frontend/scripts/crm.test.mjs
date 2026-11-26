// Run with: npm test (from frontend/). The CRM (api/_crm*.mjs) on PGlite, a real PostgreSQL engine, with the schema the
// live database gets. Providers are never called: tests pass a fake `fetch` and their own environment.
import { portalToken } from './portal-token.mjs';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createToken, handleAuth, postgresStore } from '../../api/_auth.mjs';
import { listProducts } from '../../api/_catalog.mjs';
import { handleCrm, isCrmRoute } from '../../api/_crm.mjs';
import { forecastSeries } from '../../api/_crm_insights.mjs';
import { scoreLead, syncAutoLeads } from '../../api/_crm_leads.mjs';
import { audienceOf, runAutomations, sendCampaign } from '../../api/_crm_marketing.mjs';
import { handleProviderWebhook, verifyMeta } from '../../api/_crm_webhooks.mjs';
import { handleLeads } from '../../api/_leads.mjs';
import { channelStatus, notify, unsubscribeToken } from '../../api/_messaging.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { handleShop } from '../../api/_shop.mjs';
import { handleSupport } from '../../api/_support.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
const rz = { configured: false, refund: async () => {} };
let n = 0;

async function person(email, role = 'customer', { crmRole = null, phone = '9876543210' } = {}) {
  const { body } = await handleAuth(
    { method: 'POST', rest: 'register', body: { name: email.split('@')[0].replace(/^./, (c) => c.toUpperCase()), email, password: 'secret123', phone }, ip: `9.9.9.${++n}` },
    { store: postgresStore(db), domainError: async () => null, env: { JWT_SECRET: process.env.JWT_SECRET } },
  );
  if (crmRole) await db('INSERT INTO crm_staff (user_id, role_key) VALUES ($1, $2)', [body.user.id, crmRole]);
  // CRM team members and admins sign in through the admin portal; customers through the store
  const authorization = crmRole ? `Bearer ${createToken({ ...body.user, role: 'customer' }, 'admin', { mfa: false })}` : role === 'customer' ? `Bearer ${body.token}` : await portalToken(db, body.user.id, role);
  return {
    id: body.user.id,
    token: body.token,
    authorization,
    crm: (method, path, payload, params) => handleCrm({ method, rest: path.split('/').filter(Boolean), body: payload, params, authorization, ip: `8.8.8.${n}` }, { db }),
    shop: (method, path, payload) => handleShop({ method, segments: path.split('/'), body: payload, authorization, ip: `7.7.7.${n}` }, { db, rz }),
    me: () => handleAuth({ method: 'GET', rest: 'me', authorization, ip: '1.1.1.1' }, { store: postgresStore(db) }),
  };
}

async function buy(who, product, daysAgo = 0) {
  const [address] = await db('SELECT id FROM addresses WHERE user_id = $1', [who.id]);
  if (!address) await who.shop('POST', 'addresses', { name: 'Test Person', phone: '9876543210', line1: '1 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' });
  const [a] = await db('SELECT id FROM addresses WHERE user_id = $1', [who.id]);
  await who.shop('POST', 'cart', { productId: product._id, qty: 1, size: product.sizes?.[0], color: product.colors?.[0] });
  const placed = await who.shop('POST', 'orders', { addressId: a.id, paymentMethod: 'cod' });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  if (daysAgo) await db("UPDATE orders SET created_at = NOW() - make_interval(days => $2) WHERE id = $1", [placed.body.id, daysAgo]);
  return placed.body.id;
}

const PRODUCTS = () => listProducts({ limit: 200 }).filter((p) => p.stock >= 30 && !p.sizes?.length);

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(async () => {
  await pg.exec(`TRUNCATE users, auth_rate_limits, leads, crm_staff, crm_roles, crm_sessions, crm_audit_log, crm_customer_profiles, crm_notes, crm_tasks,
                 crm_campaigns, crm_messages, crm_suppressions, crm_settings, stock_adjustments RESTART IDENTITY CASCADE`);
});

test('only the store team gets into the CRM, and the server checks every permission', async () => {
  const shopper = await person('asha@example.com');
  const owner = await person('owner@example.com', 'admin');
  const analyst = await person('ana@example.com', 'customer', { crmRole: 'analyst' });
  const sales = await person('sam@example.com', 'customer', { crmRole: 'sales_executive' });

  assert.equal((await handleCrm({ method: 'GET', rest: ['dashboard'] }, { db })).status, 401); // no login
  assert.equal((await shopper.crm('GET', 'dashboard')).status, 403);
  assert.equal((await shopper.crm('GET', 'customers')).status, 403);
  assert.equal((await shopper.me()).body.crm, null); // the More menu shows no CRM link
  assert.equal((await owner.me()).body.crm.role, 'super_admin');
  assert.equal((await owner.crm('GET', 'dashboard')).status, 200);

  // Analyst: reads reports, can't change anything, and sees contact details masked
  assert.equal((await analyst.crm('GET', 'reports/sales')).status, 200);
  assert.equal((await analyst.crm('POST', 'customers', { name: 'New Person', email: 'np@example.com' })).status, 403);
  assert.equal((await analyst.crm('GET', 'staff')).status, 403);
  const list = (await analyst.crm('GET', 'customers')).body;
  const asha = list.items.find((c) => c.id === shopper.id);
  assert.ok(asha.masked && asha.email.startsWith('a') && asha.email.includes('***') && !asha.email.includes('asha@'), asha.email);
  // Sales executive: leads yes, settings and the audit log no
  assert.equal((await sales.crm('GET', 'leads')).status, 200);
  assert.equal((await sales.crm('GET', 'settings')).status, 403);
  assert.equal((await sales.crm('GET', 'audit')).status, 403);
  // A deactivated team member is out at once
  await db('UPDATE crm_staff SET active = FALSE WHERE user_id = $1', [sales.id]);
  assert.equal((await sales.crm('GET', 'leads')).status, 403);
  // The first CRM request with a token is a login in the audit log
  const [login] = await db("SELECT * FROM crm_audit_log WHERE action = 'crm.login' AND actor_id = $1", [owner.id]);
  assert.ok(login);
  assert.ok(isCrmRoute('GET', ['customers', '12']) && !isCrmRoute('GET', ['secret']));
});

test('nobody can grant permissions they do not hold, and only the owner hands out team management', async () => {
  const owner = await person('owner@example.com', 'admin');
  const admin = await person('adm@example.com', 'customer', { crmRole: 'admin' });
  await person('new@example.com');
  const r = await admin.crm('POST', 'roles', { name: 'Team lead', permissions: ['dashboard.view', 'staff.manage'] });
  assert.equal(r.status, 403, 'staff.manage is owner-only');
  const ok = await admin.crm('POST', 'roles', { name: 'Team lead', permissions: ['dashboard.view', 'leads.view'] });
  assert.equal(ok.status, 201);
  const added = await admin.crm('POST', 'staff', { email: 'new@example.com', role: ok.body.key });
  assert.equal(added.status, 201);
  assert.equal((await admin.crm('POST', 'staff', { email: 'nobody@example.com', role: 'analyst' })).status, 404);
  assert.equal((await admin.crm('POST', 'staff', { email: 'owner@example.com', role: 'analyst' })).status, 400);
  assert.equal((await admin.crm('PATCH', `staff/${admin.id}`, { role: 'analyst' })).status, 400, 'not your own access');
  assert.equal((await owner.crm('DELETE', `roles/${ok.body.key}`)).status, 409, 'role still in use');
  const audit = await db("SELECT action FROM crm_audit_log WHERE action IN ('role.create', 'staff.add')");
  assert.equal(audit.length, 2);
});

test('ending sessions and deactivating an account lock the person out everywhere', async () => {
  const owner = await person('owner@example.com', 'admin');
  const shopper = await person('asha@example.com');
  assert.equal((await shopper.me()).status, 200);
  const off = await owner.crm('PATCH', `customers/${shopper.id}`, { status: 'inactive', reason: 'Fraud check' });
  assert.equal(off.status, 200);
  assert.equal(off.body.status, 'inactive');
  assert.equal((await shopper.me()).status, 401); // page load signs them out
  assert.equal((await shopper.shop('GET', 'cart')).status, 401); // the old token can't shop
  const login = await handleAuth({ method: 'POST', rest: 'login', body: { email: 'asha@example.com', password: 'secret123' }, ip: '5.5.5.5' }, { store: postgresStore(db) });
  assert.equal(login.status, 401);
  assert.match(login.body.error, /deactivated/);
  await owner.crm('PATCH', `customers/${shopper.id}`, { status: 'active' });
  const back = await handleAuth({ method: 'POST', rest: 'login', body: { email: 'asha@example.com', password: 'secret123' }, ip: '5.5.5.6' }, { store: postgresStore(db) });
  assert.equal(back.status, 200);
  assert.equal((await owner.crm('PATCH', `customers/${owner.id}`, { status: 'inactive' })).status, 404, 'the admin is not a customer');

  // A single CRM session can be revoked
  const staff = await person('sam@example.com', 'customer', { crmRole: 'sales_manager' });
  await staff.crm('GET', 'me');
  const [s] = await db('SELECT id FROM crm_sessions WHERE user_id = $1', [staff.id]);
  assert.equal((await owner.crm('POST', `sessions/${s.id}/revoke`)).status, 204);
  assert.equal((await staff.crm('GET', 'me')).status, 401);
});

test('customers: added by hand without duplicates, edited, tagged, imported and exported', async () => {
  const owner = await person('owner@example.com', 'admin');
  await person('asha@example.com');
  const made = await owner.crm('POST', 'customers', { name: 'Ravi Kumar', email: 'Ravi@Example.com', phone: '+91 91234 56789', tags: ['wholesale'] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.email, 'ravi@example.com');
  assert.deepEqual(made.body.tags, ['wholesale']);
  assert.equal((await owner.crm('POST', 'customers', { name: 'Ravi Again', email: 'ravi@example.com' })).status, 409);
  const samePhone = await owner.crm('POST', 'customers', { name: 'Other Ravi', email: 'other@example.com', phone: '9123456789' });
  assert.equal(samePhone.status, 409);
  assert.equal((await owner.crm('POST', 'customers', { name: 'Other Ravi', email: 'other@example.com', phone: '9123456789', confirmDuplicatePhone: true })).status, 201);
  // Consent can't be ticked without confirming the customer gave it
  assert.equal((await owner.crm('PATCH', `customers/${made.body.id}`, { emailOptIn: true })).status, 400);
  const edited = await owner.crm('PATCH', `customers/${made.body.id}`, { emailOptIn: true, consentConfirmed: true, tags: ['wholesale', 'vip'], birthday: '1990-05-01' });
  assert.equal(edited.body.email_opt_in, true);
  assert.deepEqual(edited.body.tags, ['wholesale', 'vip']);
  const byTag = await owner.crm('GET', 'customers', null, { tag: 'vip' });
  assert.deepEqual(byTag.body.items.map((c) => c.id), [made.body.id]);
  const search = await owner.crm('GET', 'customers', null, { q: '91234' });
  assert.ok(search.body.items.some((c) => c.id === made.body.id));

  const dry = await owner.crm('POST', 'customers/import', { dryRun: true, rows: [{ name: 'Neha', email: 'neha@example.com' }, { name: 'X', email: 'bad' }, { name: 'Asha', email: 'asha@example.com' }, { name: 'Neha Two', email: 'neha@example.com' }] });
  assert.deepEqual(dry.body.counts, { ok: 1, error: 2, skipped: 1 });
  assert.equal((await db("SELECT 1 FROM users WHERE email = 'neha@example.com'")).length, 0, 'a dry run saves nothing');
  const real = await owner.crm('POST', 'customers/import', { rows: [{ name: 'Neha', email: 'neha@example.com', tags: 'b2b; event' }] });
  assert.equal(real.body.counts.created, 1);
  const exported = await owner.crm('GET', 'customers/export');
  assert.ok(exported.body.rows.length >= 4);
  assert.ok((await db("SELECT 1 FROM crm_audit_log WHERE action = 'customers.export'")).length);
  const note = await owner.crm('POST', 'notes', { entity: 'customer', entityId: made.body.id, kind: 'call', body: 'Called about bulk pricing', outcome: 'Interested' });
  assert.equal(note.status, 201);
  const profile = await owner.crm('GET', `customers/${made.body.id}`);
  assert.ok(profile.body.timeline.some((t) => t.type === 'call'));
});

test('dashboard and reports add up to the orders actually placed', async () => {
  const owner = await person('owner@example.com', 'admin');
  const asha = await person('asha@example.com');
  const ravi = await person('ravi@example.com', 'customer', { phone: '9123456780' });
  const [p1, p2] = PRODUCTS();
  await buy(asha, p1);
  await buy(asha, p2, 40);
  const cancelled = await buy(ravi, p1);
  assert.equal((await owner.crm('POST', `orders/${cancelled}/cancel`, { reason: 'Customer asked by phone' })).status, 200);
  const d = (await owner.crm('GET', 'dashboard')).body;
  const total = (p) => p.price + (p.price >= 499 ? 0 : 40);
  assert.equal(d.kpis.revenue.period, total(p1));
  assert.equal(d.kpis.revenue.allTime, total(p1) + total(p2));
  assert.equal(d.kpis.orders.total, 2); // one placed today, one cancelled today; the 40-day-old one is out of range
  assert.equal(d.kpis.orders.cancelled, 1);
  assert.equal(d.kpis.customers.returning, 1);
  assert.equal(d.kpis.pendingPayments.codOrders, 2);
  assert.equal(d.trend.length, 30);
  const sales = (await owner.crm('GET', 'reports/sales')).body;
  assert.equal(sales.totals.revenue, total(p1) + total(p2));
  const stock = await db('SELECT delta FROM stock_adjustments WHERE product_id = $1', [p1._id]);
  assert.equal(stock[0].delta, -1, 'the cancelled order gave its stock back');
  assert.equal((await owner.crm('POST', `orders/${cancelled}/cancel`, { reason: 'again' })).status, 409);
  const inv = await owner.crm('GET', `orders/${(await db('SELECT id FROM orders WHERE status = $1 LIMIT 1', ['placed']))[0].id}/invoice`);
  assert.match(inv.body.number, /^ARV\/\d{4}\/\d{6}$/);
  for (const id of ['revenue', 'products', 'customers', 'leads', 'conversion', 'employees', 'campaigns', 'retention', 'refunds']) {
    const r = await owner.crm('GET', `reports/${id}`);
    assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
  }
});

test('leads arrive on their own: sign-ups, abandoned carts, duplicates merged, conversions noticed', async () => {
  const owner = await person('owner@example.com', 'admin');
  const asha = await person('asha@example.com');
  const [p] = PRODUCTS();
  await asha.shop('POST', 'cart', { productId: p._id, qty: 2 });
  await db("UPDATE cart_items SET added_at = NOW() - INTERVAL '8 hours'");
  const first = await syncAutoLeads(db, { force: true });
  assert.equal(first.registration, 1);
  assert.equal(first.abandonedCart, 1);
  const again = await syncAutoLeads(db, { force: true });
  assert.deepEqual([again.registration, again.abandonedCart], [0, 0], 'never twice');
  // The same person asking twice is one lead
  const ask = (msg) => handleLeads({ method: 'POST', rest: [], body: { source: 'contact', name: 'Kiran', email: 'kiran@example.com', message: msg, consent: true }, ip: `6.6.6.${++n}` }, { db });
  await ask('Do you have running shoes under 3000?');
  await ask('Also, do you deliver to Pune? I want to buy today');
  const kiran = await db("SELECT * FROM leads WHERE email = 'kiran@example.com'");
  assert.equal(kiran.length, 1);
  assert.equal(kiran[0].notes.length, 1);
  // Asha buys: her sign-up and cart leads convert
  await buy(asha, p);
  const sync = await syncAutoLeads(db, { force: true });
  assert.equal(sync.converted, 2);
  const board = (await owner.crm('GET', 'leads', null, { view: 'board' })).body;
  assert.equal(board.stages.length, 5);
  const lead = (await owner.crm('GET', 'leads', null, { q: 'kiran' })).body.items[0];
  assert.ok(lead.score > 0 && lead.reasons.length);
  // New pipeline stages through the existing PATCH, with logged activities
  const leads = (method, path, body) => handleLeads({ method, rest: path.split('/').filter(Boolean), body, authorization: owner.authorization }, { db });
  assert.equal((await leads('PATCH', `${lead.id}`, { status: 'proposal' })).status, 200);
  assert.equal((await owner.crm('POST', 'notes', { entity: 'lead', entityId: lead.id, kind: 'meeting', body: 'Showroom visit' })).status, 201);
  assert.equal((await owner.crm('GET', `leads/${lead.id}`)).body.activities.length, 1);
  const manual = await owner.crm('POST', 'leads', { name: 'Walk In', phone: '9988776655', requirements: 'Wants 20 office chairs', budget: 80000 });
  assert.equal(manual.status, 201);
  assert.equal((await owner.crm('POST', 'leads', { name: 'Walk In', phone: '9988776655' })).status, 409);
});

test('lead scores explain themselves', () => {
  const s = scoreLead({ intent: 'high', source: 'quote', budget: 60000, quantity: 20, phone: '9', matches: ['x'], is_customer: true, created_at: new Date().toISOString(), activities: 1, status: 'new' });
  assert.equal(s.band, 'hot');
  assert.ok(s.reasons.every((r) => r.points && r.why));
  assert.equal(scoreLead({ intent: 'low', source: 'registration', created_at: '2020-01-01', status: 'lost' }).score, 0);
});

test('support desk: owners, internal notes the shopper never sees, statuses and response times', async () => {
  const owner = await person('owner@example.com', 'admin');
  const agent = await person('sup@example.com', 'customer', { crmRole: 'support_executive' });
  const asha = await person('asha@example.com');
  const support = (who, method, path, body) => handleSupport({ method, rest: path.split('/'), body, authorization: who.authorization }, { db });
  const t = await support(asha, 'POST', 'tickets', { subject: 'Parcel late', message: 'My order has not arrived yet, please help' });
  assert.equal((await owner.crm('PATCH', `tickets/${t.body.id}`, { assignedTo: agent.id, priority: 'high' })).status, 200);
  assert.equal((await owner.crm('PATCH', `tickets/${t.body.id}`, { assignedTo: asha.id })).status, 400, 'only the team');
  await agent.crm('POST', `tickets/${t.body.id}/messages`, { message: 'Customer sounds upset, check courier', internal: true });
  const replied = await agent.crm('POST', `tickets/${t.body.id}/messages`, { message: 'Sorry! It arrives tomorrow.', status: 'waiting' });
  assert.equal(replied.body.status, 'waiting');
  assert.ok(replied.body.first_response_at);
  const seen = await support(asha, 'GET', `tickets/${t.body.id}`);
  assert.equal(seen.body.messages.length, 1, 'the internal note stays internal');
  assert.ok(!JSON.stringify(seen.body).includes('upset'));
  await support(asha, 'POST', `tickets/${t.body.id}/messages`, { message: 'Thanks, still waiting' });
  assert.equal((await agent.crm('GET', `tickets/${t.body.id}`)).body.status, 'open', 'a customer reply reopens it');
  const closed = await agent.crm('PATCH', `tickets/${t.body.id}`, { status: 'closed' });
  assert.ok(closed.body.closed_at && closed.body.resolved_at);
  const list = await agent.crm('GET', 'tickets', null, { status: 'all' });
  assert.equal(list.body.metrics.median_first_response_hours >= 0, true);
});

test('campaigns reach only people who agreed, once each, and unsubscribing sticks', async () => {
  const owner = await person('owner@example.com', 'admin');
  const yes = await person('yes@example.com');
  await person('no@example.com');
  await owner.crm('PATCH', `customers/${yes.id}`, { emailOptIn: true, consentConfirmed: true });
  await handleLeads({ method: 'POST', rest: [], body: { source: 'newsletter', email: 'reader@example.com', marketingConsent: true }, ip: '4.4.4.4' }, { db });
  await db("INSERT INTO crm_suppressions (channel, address, reason) VALUES ('email', 'gone@example.com', 'unsubscribed')");
  await handleLeads({ method: 'POST', rest: [], body: { source: 'newsletter', email: 'gone@example.com', marketingConsent: true }, ip: '4.4.4.5' }, { db });
  const people = await audienceOf(db, 'email', {});
  assert.deepEqual(people.map((p) => p.address).sort(), ['reader@example.com', 'yes@example.com']);

  const made = await owner.crm('POST', 'campaigns', { name: 'Diwali sale', channel: 'email', subject: 'Hi {{name}}', body: 'Hello {{name}}, 20% off this week.' });
  assert.equal(made.status, 201);
  assert.equal(made.body.audienceSize, 2);
  // Without a provider nothing is sent or pretended
  assert.equal((await owner.crm('POST', `campaigns/${made.body.id}/send`, { confirm: true })).status, 503);

  const env = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Store <s@x.in>', SITE_URL: 'https://shop.example', JWT_SECRET: process.env.JWT_SECRET };
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    if (body.to[0] === 'reader@example.com') return new Response(JSON.stringify({ message: 'rejected' }), { status: 422 });
    return new Response(JSON.stringify({ id: `em_${sent.length}` }), { status: 200 });
  };
  const staff = { id: owner.id, name: 'Owner', permissions: new Set(['marketing.send']), ip: 'x' };
  const res = await sendCampaign({ db, staff, id: made.body.id, body: { confirm: true } }, { env, fetchImpl });
  assert.equal(res.body.done, true);
  assert.deepEqual([res.body.accepted, res.body.failed], [1, 1], 'a rejected email is recorded as failed, not sent');
  const mail = sent.find((m) => m.to[0] === 'yes@example.com');
  assert.match(mail.subject, /^Hi Yes/);
  assert.match(mail.html, /Unsubscribe/);
  assert.ok(mail.headers['List-Unsubscribe'].includes('/api/crm/unsubscribe?'));
  await assert.rejects(sendCampaign({ db, staff, id: made.body.id, body: { confirm: true } }, { env, fetchImpl }), /This campaign is sent/);
  assert.equal(sent.length, 2, 'nobody got it twice');

  // Delivery report from Resend, signed
  const secret = `whsec_${Buffer.from('k'.repeat(24)).toString('base64')}`;
  const raw = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_1' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`msg1.${ts}.${raw}`).digest('base64');
  const bad = await handleProviderWebhook('resend', { method: 'POST', url: 'https://x', headers: { 'svix-id': 'msg1', 'svix-timestamp': ts, 'svix-signature': 'v1,forged' }, raw }, { db, env: { RESEND_WEBHOOK_SECRET: secret } });
  assert.equal(bad.status, 401);
  const good = await handleProviderWebhook('resend', { method: 'POST', url: 'https://x', headers: { 'svix-id': 'msg1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }, raw }, { db, env: { RESEND_WEBHOOK_SECRET: secret } });
  assert.equal(good.body.updated, 1);
  const [m] = await db("SELECT status FROM crm_messages WHERE provider_ref = 'em_1'");
  assert.equal(m.status, 'delivered');

  // Unsubscribe through the signed link
  const a = Buffer.from('yes@example.com').toString('base64url');
  const forged = await handleCrm({ method: 'POST', rest: ['unsubscribe'], params: { c: 'email', a, t: 'nope' }, ip: '3.3.3.3' }, { db });
  assert.equal(forged.status, 400);
  const t = unsubscribeToken('email', 'yes@example.com');
  const ok = await handleCrm({ method: 'POST', rest: ['unsubscribe'], params: { c: 'email', a, t }, ip: '3.3.3.3' }, { db });
  assert.equal(ok.status, 200);
  assert.deepEqual((await audienceOf(db, 'email', {})).map((p) => p.address), ['reader@example.com']);
});

test('order updates go out once per order on configured channels only', async () => {
  const asha = await person('asha@example.com');
  const [p] = PRODUCTS();
  const order = await buy(asha, p);
  const calls = [];
  const env = { RESEND_API_KEY: 're', EMAIL_FROM: 's@x.in' };
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `id${calls.length}` }), { status: 200 });
  };
  const first = await notify(db, 'shipping_update', { userId: asha.id, orderId: order }, { env, fetchImpl });
  const second = await notify(db, 'shipping_update', { userId: asha.id, orderId: order }, { env, fetchImpl });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0, 'deduplicated');
  assert.match(calls[0].subject, /^Order ARV-ORD-\d{4}-\d{6} has shipped$/); // the customer-facing order number
  // SMS is off by default and needs a verified number
  assert.equal(channelStatus({}).sms.configured, false);
  assert.deepEqual(await notify(db, 'order_confirmation', { userId: asha.id, orderId: order }, { env: {}, fetchImpl }), []);
});

test('automations need consent, a provider and an unsubscribe link', async () => {
  const owner = await person('owner@example.com', 'admin');
  const asha = await person('asha@example.com');
  await owner.crm('PUT', 'settings', { automations: { birthday: true } });
  await owner.crm('PATCH', `customers/${asha.id}`, { emailOptIn: true, consentConfirmed: true });
  await db("UPDATE crm_customer_profiles SET birthday = (CURRENT_DATE - INTERVAL '30 years')::date WHERE user_id = $1", [asha.id]);
  assert.match((await runAutomations(db, { env: {} })).skipped[0], /not configured/);
  const calls = [];
  const env = { RESEND_API_KEY: 're', EMAIL_FROM: 's@x.in', SITE_URL: 'https://shop.example', JWT_SECRET: process.env.JWT_SECRET };
  const fetchImpl = async (url, init) => (calls.push(init), new Response('{"id":"b1"}', { status: 200 }));
  assert.equal((await runAutomations(db, { env, fetchImpl })).birthday, 1);
  assert.equal((await runAutomations(db, { env, fetchImpl })).birthday, 0, 'once a year');
  assert.equal((await owner.crm('PUT', 'settings', { leads: { abandonedCartHours: 0 } })).status, 400);
});

test('WhatsApp webhook: signed only, messages become leads once, STOP opts out', async () => {
  const env = { WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_VERIFY_TOKEN: 'verify-me' };
  const challenge = await handleProviderWebhook('whatsapp', { method: 'GET', url: 'https://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42', headers: {} }, { db, env });
  assert.deepEqual([challenge.status, challenge.text], [200, '42']);
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '919812345678', profile: { name: 'Meena' } }], messages: [{ id: 'wamid.1', from: '919812345678', type: 'text', text: { body: 'Please quote for 10 units of office chairs, need this week' } }] } }] }] });
  const sig = `sha256=${createHmac('sha256', 'appsecret').update(payload).digest('hex')}`;
  assert.ok(verifyMeta(payload, sig, 'appsecret'));
  assert.equal((await handleProviderWebhook('whatsapp', { method: 'POST', url: 'u', headers: { 'X-Hub-Signature-256': 'sha256=00' }, raw: payload }, { db, env })).status, 401);
  await handleProviderWebhook('whatsapp', { method: 'POST', url: 'u', headers: { 'X-Hub-Signature-256': sig }, raw: payload }, { db, env });
  await handleProviderWebhook('whatsapp', { method: 'POST', url: 'u', headers: { 'X-Hub-Signature-256': sig }, raw: payload }, { db, env }); // Meta retries
  const leads = await db("SELECT * FROM leads WHERE source = 'whatsapp'");
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, '9812345678');
  assert.equal(leads[0].kind, 'quote');
});

test('tasks: mine by default, overdue shown automatically, others only for managers', async () => {
  const owner = await person('owner@example.com', 'admin');
  const exec = await person('sam@example.com', 'customer', { crmRole: 'sales_executive' });
  const t = await owner.crm('POST', 'tasks', { title: 'Call Kiran back', assignedTo: exec.id, dueAt: new Date(Date.now() - 3_600_000).toISOString(), priority: 'high' });
  assert.equal(t.status, 201);
  assert.equal(t.body.display_status, 'overdue');
  assert.equal((await exec.crm('POST', 'tasks', { title: 'For the boss', assignedTo: owner.id })).status, 403);
  const mine = await exec.crm('GET', 'tasks');
  assert.equal(mine.body.items.length, 1);
  const done = await exec.crm('PATCH', `tasks/${t.body.id}`, { status: 'completed' });
  assert.ok(done.body.completed_at);
  const feed = await exec.crm('GET', 'feed');
  assert.ok(feed.body.events.some((e) => e.id === `task:${t.body.id}:assigned`));
});

test('the sales forecast is only shown with enough history, and reports how wrong it was', () => {
  assert.equal(forecastSeries([1, 2, 3]).ok, false);
  const weekly = Array.from({ length: 20 }, (_, i) => 1000 + i * 100);
  const f = forecastSeries(weekly);
  assert.ok(f.ok && f.backtest.mae < 50 && f.backtest.beatsNaive);
  assert.ok(Math.abs(f.points[0].value - 3000) < 60);
});
