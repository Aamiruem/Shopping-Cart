// Run with: npm test (from frontend/). The shopping assistant, leads, email notifications and password reset in
// api/_assistant.mjs, api/_leads.mjs, api/_notify.mjs and api/_auth.mjs, on PGlite with the live schema.
// Claude and the email provider are stand-ins: nothing here calls a paid service.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { claudeAnswer, handleAssistant, rulesAnswer } from '../../api/_assistant.mjs';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { loadProducts } from '../../api/_catalog.mjs';
import { classifyLead, handleLeads } from '../../api/_leads.mjs';
import { sendEmail } from '../../api/_notify.mjs';
import { findProducts, parseBudget, parseRequirements } from '../../api/_requirements.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { handleShop } from '../../api/_shop.mjs';

let pg;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
const domainError = async () => null;
const auth = (rest, body, authorization) => handleAuth({ method: 'POST', rest, body, ip: '1.1.1.1', authorization }, { store: postgresStore(db), domainError });

async function signUp(email = 'asha@example.com', role = 'customer') {
  const { body } = await auth('register', { name: 'Asha Rao', email, password: 'secret123' });
  if (role !== 'customer') await db('UPDATE users SET role = $1 WHERE id = $2', [role, body.user.id]);
  return { authorization: `Bearer ${body.token}`, id: body.user.id };
}
const leads = (method, rest, body, authorization, params = {}) => handleLeads({ method, rest, body, params, ip: '2.2.2.2', authorization }, { db });
const ask = (body, opts = {}, rest = ['agent']) => handleAssistant({ rest, body, ip: '3.3.3.3' }, { db, useDb: true, ...opts });

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  delete process.env.RESEND_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ADMIN_EMAIL;
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(async () => {
  await pg.exec('TRUNCATE users, auth_rate_limits, leads, notifications, verification_codes RESTART IDENTITY CASCADE');
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------- Requirements ----------

test('budgets in English and Hinglish', () => {
  assert.deepEqual(parseBudget('laptop under ₹70,000'), { min: null, max: 70000 });
  assert.deepEqual(parseBudget('between 15k and 25k'), { min: 15000, max: 25000 });
  assert.deepEqual(parseBudget('3000 se kam'), { min: null, max: 3000 });
  assert.deepEqual(parseBudget('1.5 lakh tak'), { min: null, max: 150000 });
  assert.deepEqual(parseBudget('around 20k'), { min: 17000, max: 23000 });
  assert.deepEqual(parseBudget('just browsing'), { min: null, max: null });
});

test('requirements: product, use, brand and budget', () => {
  const r = parseRequirements('I need a laptop for machine learning under ₹70,000');
  assert.equal(r.category, 'electronics');
  assert.equal(r.subCategory, 'laptops');
  assert.equal(r.use, 'machine learning');
  assert.equal(r.budgetMax, 70000);
  assert.equal(parseRequirements('Samsung phone between 15k and 25k').brand, 'Samsung');
});

test('search keeps to the budget and stock, and says what is closest when nothing fits', () => {
  const { matches, closest } = findProducts(parseRequirements('laptop under ₹70,000'));
  const laptops = loadProducts().filter((p) => p.subCategory === 'laptops' && p.stock > 0);
  assert.ok(matches.every((p) => p.price <= 70000 && p.stock > 0));
  if (!laptops.some((p) => p.price <= 70000)) {
    assert.equal(matches.length, 0);
    assert.ok(closest.length > 0 && closest.every((p) => p.price > 70000));
  }
  const shoes = findProducts(parseRequirements('running shoes under 3000')).matches;
  assert.ok(shoes.length > 0 && shoes.every((p) => p.price <= 3000 && /shoe/i.test(`${p.name} ${p.tags}`)));
});

// ---------- Assistant: rules ----------

test('rules answer with real products and prices, and never stretch the budget silently', () => {
  const { reply, products } = rulesAnswer(['running shoes under 3000']);
  assert.ok(products.length > 0);
  for (const card of products) {
    const real = loadProducts().find((p) => p._id === card.id);
    assert.equal(card.price, real.price);
    assert.ok(reply.includes(real.name));
  }
  const laptop = rulesAnswer(['laptop for machine learning under ₹70,000']);
  if (!laptop.products.some((p) => p.price <= 70000)) assert.match(laptop.reply, /don’t have/);
});

test('rules: policies, follow-ups and a prompt when nothing is asked', () => {
  assert.match(rulesAnswer(['what is your return policy?']).reply, /7 days/);
  assert.match(rulesAnswer(['hello']).reply, /what you’re looking for/);
  // a policy question after a product search answers the policy, not the products again
  const policy = rulesAnswer(['running shoes under 3000', 'what is your return policy?']);
  assert.match(policy.reply, /7 days/);
  assert.equal(policy.products.length, 0);
  // "under 3000" alone continues the earlier "running shoes"
  const follow = rulesAnswer(['running shoes', 'under 3000 please']);
  assert.ok(follow.products.length && follow.products.every((p) => p.price <= 3000));
});

test('the assistant answers without a Claude key, and records a lead with no identity', async () => {
  const res = await ask({ messages: [{ role: 'user', content: 'Need running shoes under 3000, buying today' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'rules');
  assert.ok(res.body.products.length > 0);
  await ask({ messages: [{ role: 'user', content: 'Need running shoes under 3000, buying today' }] });
  const all = await db('SELECT * FROM leads');
  assert.equal(all.length, 1, 'the same need from signed-out shoppers is recorded once a day');
  const [lead] = all;
  assert.equal(lead.source, 'assistant');
  assert.equal(lead.intent, 'medium', 'no one to follow up, so never high');
  assert.equal(lead.user_id, null);
  assert.equal(lead.email, null);
  const bad = await ask({ messages: [{ role: 'assistant', content: 'hi' }] });
  assert.equal(bad.status, 400);
});

// ---------- Assistant: Claude tool loop with a stand-in model ----------

test('Claude path: tools read the catalog, show_products returns real cards, refusals are handled', async () => {
  const shoe = findProducts(parseRequirements('running shoes under 3000')).matches[0];
  const calls = [];
  const create = async (params) => {
    calls.push(params);
    assert.equal(params.model, 'claude-opus-5-5');
    assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(params.fallbacks, 'default');
    if (calls.length === 1) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'search_products', input: { query: 'running shoes', max_price: 3000 } }] };
    }
    if (calls.length === 2) {
      const result = JSON.parse(params.messages.at(-1).content[0].content);
      assert.ok(result.matches.every((p) => p.price <= 3000));
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'show_products', input: { product_ids: [shoe._id, 'no-such-id'] } }] };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: `Try ${shoe.name}.` }] };
  };
  const answer = await claudeAnswer([{ role: 'user', content: 'running shoes under 3000' }], { create });
  assert.equal(answer.reply, `Try ${shoe.name}.`);
  assert.deepEqual(answer.products.map((p) => p.id), [shoe._id]);
  assert.equal(answer.products[0].price, shoe.price);

  const refused = await claudeAnswer([{ role: 'user', content: 'x' }], { create: async () => ({ stop_reason: 'refusal', content: [] }) });
  assert.match(refused.reply, /can’t help/);
});

test('when Claude fails the shopper still gets an answer', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const res = await ask({ question: 'running shoes under 3000' }, { create: async () => { throw new Error('overloaded'); } }, ['ask']);
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'rules');
  assert.ok(res.body.products.length > 0);
});

// ---------- Leads ----------

test('lead classification', () => {
  assert.equal(classifyLead({ source: 'quote', message: 'Need 50 pieces of t-shirts for our office', hasContact: true }).kind, 'business');
  assert.equal(classifyLead({ source: 'contact', message: 'Where is my order? Not received', hasContact: true }).kind, 'support');
  const hot = classifyLead({ source: 'contact', message: 'Want to buy a Samsung phone under 25000', hasContact: true });
  assert.equal(hot.kind, 'purchase');
  assert.equal(hot.intent, 'high');
  assert.match(hot.summary, /budget up to ₹25,000/);
  assert.equal(classifyLead({ source: 'newsletter', message: '' }).intent, 'low');
});

test('lead forms: validation, consent, rate limit and newsletter duplicates', async () => {
  assert.equal((await leads('POST', [], { source: 'contact', message: 'Need a quote', email: 'a@example.com' })).status, 400); // no consent
  assert.equal((await leads('POST', [], { source: 'contact', message: 'Need a quote' })).status, 400); // no way to reply
  assert.equal((await leads('POST', [], { source: 'assistant', message: 'hello there' })).status, 400); // internal source
  assert.equal((await leads('POST', [], { source: 'contact', message: 'Phone under 20k', phone: '12345', consent: true })).status, 400);
  const ok = await leads('POST', [], { source: 'contact', name: 'Asha', email: 'asha@example.com', phone: '+91 98765 43210', consent: true, message: 'Phone under 20k' });
  assert.equal(ok.status, 201);
  const [row] = await db('SELECT phone, consent FROM leads');
  assert.deepEqual(row, { phone: '9876543210', consent: true });
  assert.equal((await leads('POST', [], { source: 'newsletter', email: 'n@example.com', consent: true })).status, 201);
  assert.equal((await leads('POST', [], { source: 'newsletter', email: 'n@example.com', consent: true })).status, 200);
  for (let i = 0; i < 8; i += 1) await leads('POST', [], { source: 'newsletter', email: `x${i}@example.com`, consent: true });
  assert.equal((await leads('POST', [], { source: 'newsletter', email: 'late@example.com', consent: true })).status, 429);
});

test('only the admin sees leads; an order after the enquiry counts as a conversion', async () => {
  const shopper = await signUp('asha@example.com');
  const owner = await signUp('owner@example.com', 'admin');
  await leads('POST', [], { source: 'contact', name: 'Asha', email: 'asha@example.com', consent: true, message: 'Want running shoes under 3000' });
  assert.equal((await leads('GET', [], null, shopper.authorization)).status, 403);
  assert.equal((await leads('GET', [], null)).status, 401);

  let list = await leads('GET', [], null, owner.authorization);
  assert.equal(list.status, 200);
  assert.equal(list.body.stats.total, 1);
  assert.equal(list.body.leads[0].convertedOrder, null);
  assert.ok(list.body.leads[0].recommended.length > 0);

  const shop = (method, path, body) => handleShop({ method, segments: path.split('/'), body, authorization: shopper.authorization, ip: '1.1.1.1' }, { db });
  const address = (await shop('POST', 'addresses', { name: 'Asha Rao', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' })).body.id;
  const product = loadProducts().find((p) => p.stock >= 20);
  await shop('POST', 'cart', { productId: product._id, qty: 1 });
  const order = await shop('POST', 'orders', { addressId: address, paymentMethod: 'cod' });
  assert.equal(order.status, 201);

  list = await leads('GET', [], null, owner.authorization);
  assert.equal(list.body.leads[0].convertedOrder.id, order.body.id);
  assert.equal(list.body.stats.conversionRate, 100);

  const id = list.body.leads[0].id;
  const updated = await leads('PATCH', [String(id)], { status: 'won', notes: 'Bought online' }, owner.authorization);
  assert.equal(updated.body.status, 'won');
  assert.equal((await leads('PATCH', [String(id)], { status: 'maybe' }, owner.authorization)).status, 400);
  assert.equal((await leads('PATCH', [String(id)], { status: 'lost' }, shopper.authorization)).status, 403);

  // the order also wrote two notification log rows, skipped because no email service is set up
  const log = await db("SELECT template, status FROM notifications WHERE template = 'order_placed'");
  assert.deepEqual(log, [{ template: 'order_placed', status: 'skipped' }]);
});

// ---------- Email ----------

test('email: sent, retried once on a provider error, never retried when rejected, never throws', async () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.MAIL_FROM = 'Arvixa <orders@example.com>';
  const order = { id: 7, total: 1299, payment_method: 'cod', user_id: 1 };
  const data = { name: 'Asha <b>', order, items: [{ name: 'Shoes', qty: 1, price: 1299 }] };
  const sent = [];
  const ok = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: 'em_1' }) };
  };
  assert.equal(await sendEmail(db, { to: 'asha@example.com', template: 'order_placed', data }, { fetcher: ok }), 'sent');
  assert.ok(sent[0].html.includes('Asha &lt;b&gt;'), 'names are escaped');
  let tries = 0;
  const flaky = async () => (tries += 1) === 1 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ id: 'em_2' }) };
  assert.equal(await sendEmail(db, { to: 'asha@example.com', template: 'order_placed', data }, { fetcher: flaky }), 'sent');
  assert.equal(tries, 2);
  tries = 0;
  const rejected = async () => { tries += 1; return { ok: false, status: 422, json: async () => ({ message: 'invalid to' }) }; };
  assert.equal(await sendEmail(db, { to: 'bad', template: 'order_placed', data }, { fetcher: rejected }), 'failed');
  assert.equal(tries, 1);
  const rows = await db('SELECT status, attempts, provider_id FROM notifications ORDER BY id');
  assert.deepEqual(rows, [
    { status: 'sent', attempts: 1, provider_id: 'em_1' },
    { status: 'sent', attempts: 2, provider_id: 'em_2' },
    { status: 'failed', attempts: 1, provider_id: null },
  ]);
});

// ---------- Password reset ----------

test('password reset: off without email, same answer for unknown accounts, link works once and expires', async () => {
  await signUp('asha@example.com');
  assert.equal((await auth('forgot', { email: 'asha@example.com' })).status, 503);

  process.env.RESEND_API_KEY = 're_test';
  process.env.MAIL_FROM = 'Arvixa <orders@example.com>';
  const realFetch = globalThis.fetch;
  const mails = [];
  globalThis.fetch = async (url, init) => {
    mails.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: 'em' }) };
  };
  try {
    const known = await auth('forgot', { email: 'ASHA@example.com' });
    const unknown = await auth('forgot', { email: 'nobody@example.com' });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(mails.length, 1);
    const token = mails[0].text.match(/token=([\w-]+)/)[1];

    assert.equal((await auth('reset', { token, password: 'short' })).status, 400);
    const done = await auth('reset', { token, password: 'newpass123' });
    assert.equal(done.status, 200);
    assert.ok(done.body.token);
    assert.equal(done.body.user.emailVerified, true);
    assert.equal((await auth('reset', { token, password: 'another123' })).status, 400, 'a link works once');
    assert.equal((await handleAuth({ method: 'POST', rest: 'login', body: { email: 'asha@example.com', password: 'newpass123' }, ip: '9.9.9.9' }, { store: postgresStore(db), domainError })).status, 200);

    // a newer link replaces the older one, and expired links fail
    await auth('forgot', { email: 'asha@example.com' });
    await auth('forgot', { email: 'asha@example.com' });
    const [first, second] = mails.slice(1).map((m) => m.text.match(/token=([\w-]+)/)[1]);
    assert.equal((await auth('reset', { token: first, password: 'newpass456' })).status, 400);
    await db("UPDATE verification_codes SET expires_at = NOW() - interval '1 minute' WHERE purpose = 'reset'");
    assert.equal((await auth('reset', { token: second, password: 'newpass456' })).status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});
