// Run with: npm test (from frontend/). Enquiries and newsletter sign-ups (api/_leads.mjs) on PGlite, a real PostgreSQL
// engine, with the same schema the live database gets.
import { portalToken } from './portal-token.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { getProduct, listProducts } from '../../api/_catalog.mjs';
import { classifyLead, extractBudget, extractQuantity, handleLeads, isLeadRoute, matchProducts } from '../../api/_leads.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { handleShop } from '../../api/_shop.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
let ipCounter = 0;
const send = (body, { authorization, ip = `10.0.0.${++ipCounter}` } = {}) => handleLeads({ method: 'POST', rest: [], body, authorization, ip }, { db });
const ENQUIRY = { source: 'contact', name: 'Asha Rao', email: 'asha@example.com', message: 'Do you sell over-ear headphones under ₹3,000?', consent: true };

async function person(email, role = 'customer') {
  const { body } = await handleAuth(
    { method: 'POST', rest: 'register', body: { name: email.split('@')[0], email, password: 'secret123' }, ip: '1.1.1.1' },
    { store: postgresStore(db), domainError: async () => null },
  );
  const authorization = role === 'customer' ? `Bearer ${body.token}` : await portalToken(db, body.user.id, role);
  return {
    id: body.user.id,
    authorization,
    leads: (method, path = '', payload, params) => handleLeads({ method, rest: path.split('/').filter(Boolean), body: payload, params, authorization }, { db }),
    shop: (method, path, payload) => handleShop({ method, segments: path.split('/'), body: payload, authorization, ip: '1.1.1.1' }, { db, rz: { configured: false } }),
  };
}

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(async () => {
  await pg.exec('TRUNCATE users, auth_rate_limits, leads RESTART IDENTITY CASCADE');
});

test('budgets and quantities are read from what people write', () => {
  assert.equal(extractBudget('I need a laptop for machine learning under ₹70,000'), 70000);
  assert.equal(extractBudget('budget around 1.5 lakh'), 150000);
  assert.equal(extractBudget('something between 40k and 55k'), 55000);
  assert.equal(extractBudget('Rs. 2500 max'), 2500);
  assert.equal(extractBudget('need 50 units by Friday'), null); // a quantity is not money
  assert.equal(extractBudget('under 30 days delivery?'), null);
  assert.equal(extractQuantity('please quote for 50 units'), 50);
  assert.equal(extractQuantity('qty: 120'), 120);
  assert.equal(extractQuantity('two headphones'), null);
});

test('products are matched from the live catalog, within the budget, and never invented', () => {
  // The catalog's laptops all cost more than ₹1 lakh: nothing fits ₹70,000, so nothing is suggested
  const laptop = classifyLead({ source: 'contact', message: 'I need a laptop for AI and machine learning under ₹70,000.' });
  assert.deepEqual([laptop.kind, laptop.budget, laptop.matches], ['product_enquiry', 70000, []]);
  // Headphones under ₹3,000 do exist: every match is a real, in-stock product within budget
  const ids = matchProducts('over-ear headphones', { budget: 3000 });
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const p = getProduct(id);
    assert.ok(p && p.stock > 0 && p.price <= 3000 && /headphone/i.test(p.name), p?.name);
  }
  // Whole words only: "team" is not "Steam Iron" (found by a browser check)
  const headphones = listProducts({ q: 'over-ear headphones', limit: 1 })[0];
  const forTeam = matchProducts('Can I buy 30 of these for my team this week? Budget 60k.', { productId: headphones._id, budget: 60000 });
  assert.ok(forTeam.length && forTeam.every((id) => getProduct(id).category === headphones.category && !/iron/i.test(getProduct(id).name)), forTeam.map((id) => getProduct(id).name).join(', '));
  assert.deepEqual(matchProducts('my team'), []); // "team" appears only inside "Steam"
  // A question about one product, naming nothing else: alternatives from its category, not the product itself
  const product = listProducts({ category: 'electronics', limit: 1 })[0];
  const alternatives = matchProducts('Is this still available?', { productId: product._id });
  assert.ok(alternatives.length && alternatives.every((id) => id !== product._id && getProduct(id).category === product.category));
});

test('kind and purchase intent follow the words used', () => {
  const quote = classifyLead({ source: 'contact', message: 'Please send a quotation for 50 units of over-ear headphones, budget ₹2 lakh, we want to buy this week', phone: '9876543210' });
  assert.deepEqual([quote.kind, quote.intent, quote.quantity, quote.budget], ['quote', 'high', 50, 200000]);
  assert.match(quote.summary, /^Bulk \/ quote request · 50 units · budget up to ₹2,00,000 — “Please send a quotation/);
  assert.equal(classifyLead({ source: 'contact', message: 'My order #12 was not delivered and I want a refund' }).kind, 'support');
  assert.equal(classifyLead({ source: 'contact', message: 'We are a manufacturer of steel bottles and would like to become a supplier' }).kind, 'business');
  assert.equal(classifyLead({ source: 'business', message: 'Could we talk about stocking our handmade candles?' }).kind, 'business');
  assert.equal(classifyLead({ source: 'contact', message: 'Just looking at what you have, maybe later' }).intent, 'low');
  assert.equal(classifyLead({ source: 'newsletter' }).kind, 'newsletter');
});

test('an enquiry needs consent, a name, a way to reply and a real message', async () => {
  assert.match((await send({ ...ENQUIRY, consent: false })).body.error, /tick the box/);
  assert.match((await send({ ...ENQUIRY, name: '' })).body.error, /your name/);
  assert.match((await send({ ...ENQUIRY, email: '' })).body.error, /email address or a mobile number/);
  assert.match((await send({ ...ENQUIRY, email: 'not-an-email' })).body.error, /valid email/);
  assert.match((await send({ ...ENQUIRY, phone: '12345' })).body.error, /10-digit mobile/);
  assert.match((await send({ ...ENQUIRY, message: 'hi' })).body.error, /a little more/);
  assert.equal((await send({ ...ENQUIRY, productId: 'no-such-product' })).status, 404);
  assert.equal((await send({ ...ENQUIRY, source: 'spam' })).status, 400);
  assert.equal((await db('SELECT count(*)::int AS n FROM leads'))[0].n, 0);

  const ok = await send({ ...ENQUIRY, email: '', phone: '+91 98765-43210' });
  assert.deepEqual([ok.status, ok.body], [201, { received: true, kind: 'enquiry' }]); // the public never sees the scoring
  const [row] = await db('SELECT phone, email, kind, intent, matches, consent_at, marketing_consent FROM leads');
  assert.deepEqual([row.phone, row.email, row.kind, row.marketing_consent], ['9876543210', null, 'product_enquiry', false]);
  assert.ok(row.consent_at && row.matches.length > 0);
});

test('bots that fill the hidden field get the usual answer and nothing is saved', async () => {
  const res = await send({ ...ENQUIRY, website: 'http://spam.example' });
  assert.equal(res.status, 201);
  assert.equal((await db('SELECT count(*)::int AS n FROM leads'))[0].n, 0);
});

test('enquiries are rate limited per visitor', async () => {
  const statuses = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await send({ ...ENQUIRY, email: `p${i}@example.com` }, { ip: '9.9.9.9' })).status);
  assert.deepEqual(statuses, [...Array(8).fill(201), 429, 429]);
});

test('a signed-in shopper’s details fill in, and the enquiry is linked to their account', async () => {
  const asha = await person('asha@example.com');
  const res = await send({ source: 'product', productId: listProducts({ limit: 1 })[0]._id, message: 'Is this available in a bigger size?', consent: true }, { authorization: asha.authorization });
  assert.equal(res.status, 201);
  const [row] = await db('SELECT name, email, user_id, source FROM leads');
  assert.deepEqual([row.name, row.email, row.user_id, row.source], ['asha', 'asha@example.com', asha.id, 'product']);
});

test('newsletter: needs its own consent, one row per address, and the answer never reveals who is subscribed', async () => {
  assert.match((await send({ source: 'newsletter', email: 'ravi@example.com' })).body.error, /agree to receive/);
  const first = await send({ source: 'newsletter', email: 'Ravi@Example.com', marketingConsent: true });
  const again = await send({ source: 'newsletter', email: 'ravi@example.com', marketingConsent: true });
  assert.deepEqual([first.status, first.body], [again.status, again.body]);
  const rows = await db("SELECT email, marketing_consent FROM leads WHERE source = 'newsletter'");
  assert.deepEqual(rows, [{ email: 'ravi@example.com', marketing_consent: true }]);
  // Unsubscribed, then signs up again: subscribed again, still one row
  await db("UPDATE leads SET status = 'unsubscribed', marketing_consent = FALSE");
  await send({ source: 'newsletter', email: 'ravi@example.com', marketingConsent: true });
  assert.deepEqual(await db('SELECT status, marketing_consent FROM leads'), [{ status: 'new', marketing_consent: true }]);
});

test('only the admin can read, change or delete enquiries', async () => {
  await send(ENQUIRY);
  const shopper = await person('ravi@example.com');
  const seller = await person('seller@example.com', 'seller');
  for (const who of [shopper, seller]) {
    assert.equal((await who.leads('GET')).status, 403);
    assert.equal((await who.leads('GET', 'summary')).status, 403);
    assert.equal((await who.leads('PATCH', '1', { status: 'won' })).status, 403);
    assert.equal((await who.leads('DELETE', '1')).status, 403);
  }
  assert.equal((await handleLeads({ method: 'GET', rest: [] }, { db })).status, 401);
  assert.equal((await db('SELECT status FROM leads'))[0].status, 'new');
});

test('the admin works the pipeline: status, assignee, follow-up and notes, each change logged', async () => {
  const owner = await person('owner@example.com', 'admin');
  const shopper = await person('ravi@example.com');
  await send({ ...ENQUIRY, message: 'Just looking, maybe later' });
  await send({ ...ENQUIRY, email: 'b@example.com', message: 'Quote for 40 units of over-ear headphones, want to buy today', phone: '9876543210' });
  const list = (await owner.leads('GET')).body;
  assert.deepEqual(list.map((l) => l.intent), ['high', 'low']); // most promising first
  const hot = list[0];
  assert.equal(hot.kindLabel, 'Bulk / quote request');
  assert.ok(hot.matches.every((m) => m.stock > 0 && m.name && m.price));
  assert.match(hot.suggestedReply, /bulk enquiry for 40 units/);

  assert.equal((await owner.leads('PATCH', String(hot.id), { assignedTo: shopper.id })).status, 400); // only the store team
  assert.equal((await owner.leads('PATCH', String(hot.id), { followUpOn: '2026-02-30x' })).status, 400);
  assert.equal((await owner.leads('PATCH', String(hot.id), { status: 'bogus' })).status, 400);
  const updated = await owner.leads('PATCH', String(hot.id), { status: 'contacted', assignedTo: owner.id, followUpOn: '2026-12-01', note: 'Called, sending a quote' });
  assert.equal(updated.status, 200);
  assert.deepEqual([updated.body.status, updated.body.assignee_name, updated.body.follow_up_on], ['contacted', 'owner', '2026-12-01']);
  assert.deepEqual(updated.body.notes.map((n) => [n.by, n.text]), [
    ['owner', 'Status: new → contacted'],
    ['owner', 'Assigned to owner'],
    ['owner', 'Follow up on 2026-12-01'],
    ['owner', 'Called, sending a quote'],
  ]);
  // Saving the same values again logs nothing new
  assert.equal((await owner.leads('PATCH', String(hot.id), { status: 'contacted' })).body.notes.length, 4);

  assert.deepEqual((await owner.leads('GET', '', null, { intent: 'low' })).body.map((l) => l.id), [list[1].id]);
  assert.deepEqual((await owner.leads('GET', '', null, { q: 'b@example' })).body.map((l) => l.id), [hot.id]);
  assert.deepEqual((await owner.leads('GET', '', null, { q: '%' })).body, []); // a wildcard is just a character
  assert.equal((await owner.leads('DELETE', String(list[1].id))).status, 204);
  assert.equal((await owner.leads('DELETE', String(list[1].id))).status, 404);
  assert.equal((await owner.leads('PATCH', 'abc', { status: 'won' })).status, 404);
});

test('conversion counts real orders placed after the enquiry, by the same person', async () => {
  const owner = await person('owner@example.com', 'admin');
  const asha = await person('asha@example.com');
  await send(ENQUIRY); // asha@example.com, sent while signed out
  await send({ ...ENQUIRY, email: 'nobody@example.com' });
  await send({ source: 'newsletter', email: 'asha@example.com', marketingConsent: true });
  let s = (await owner.leads('GET', 'summary')).body;
  assert.deepEqual([s.enquiries, s.new, s.converted, s.conversionRate, s.subscribers], [2, 2, 0, 0, 1]);

  const product = listProducts({ limit: 30 }).find((p) => p.stock >= 5);
  const addressId = (await asha.shop('POST', 'addresses', { name: 'Asha Rao', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' })).body.id;
  await asha.shop('POST', 'cart', { productId: product._id, qty: 1 });
  const order = await asha.shop('POST', 'orders', { addressId, paymentMethod: 'cod' });
  assert.equal(order.status, 201);

  s = (await owner.leads('GET', 'summary')).body;
  assert.deepEqual([s.converted, s.conversionRate], [1, 50]);
  const leads = (await owner.leads('GET')).body;
  assert.equal(leads.find((l) => l.email === 'asha@example.com' && l.source === 'contact').converted_order_id, order.body.id);
  assert.equal(leads.find((l) => l.email === 'nobody@example.com').converted_order_id, null);

  // A cancelled order is not a conversion
  await db("UPDATE orders SET status = 'cancelled'");
  assert.equal((await owner.leads('GET', 'summary')).body.converted, 0);
});

test('only the listed lead routes are served', () => {
  assert.equal(isLeadRoute('POST', []), true);
  assert.equal(isLeadRoute('GET', ['summary']), true);
  assert.equal(isLeadRoute('PATCH', ['5']), true);
  for (const [method, rest] of [['PUT', []], ['GET', ['5']], ['POST', ['summary']], ['DELETE', []], ['GET', ['5', 'x']], ['GET', ['constructor', 'x']]]) {
    assert.equal(isLeadRoute(method, rest), false, `${method} ${rest.join('/')}`);
  }
});
