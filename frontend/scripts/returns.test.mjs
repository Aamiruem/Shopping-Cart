// Run with: npm test (from frontend/). Returns, refunds (api/_returns.mjs) and complaints (api/_support.mjs) on PGlite,
// a real PostgreSQL engine, with the same schema the live database gets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { handleAuth, postgresStore } from '../../api/_auth.mjs';
import { listProducts } from '../../api/_catalog.mjs';
import { handleWebhook } from '../../api/_payments.mjs';
import { STORE_SCHEMA } from '../../api/_schema.mjs';
import { handleSeller } from '../../api/_seller.mjs';
import { handleShop, isShopRoute } from '../../api/_shop.mjs';
import { handleSupport, isSupportRoute, triage } from '../../api/_support.mjs';
import { createHmac } from 'node:crypto';

let pg;
let rz;
const db = async (statement, params = []) => (await pg.query(statement, params)).rows;
const products = (listProducts({ limit: 24 }).products ?? listProducts({ limit: 24 })).filter((p) => p.stock >= 20);
const ADDRESS = { name: 'Asha Rao', phone: '9876543210', line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };
const UPI = { reasonCode: 'damaged', details: 'Screen cracked', refundTo: 'upi', upi: 'asha@okhdfcbank' };
const WEBHOOK_SECRET = 'whsec_test';

// Razorpay's refund endpoint; `failing` makes it throw, like an outage
function fakeRazorpay() {
  const state = { refunded: [], failing: false };
  return {
    state,
    configured: true,
    refund: async (id) => {
      if (state.failing) throw new Error('Razorpay down');
      state.refunded.push(id);
    },
    verifyWebhook: (raw, signature) => signature === createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
  };
}

async function person(email, role = 'customer') {
  const { body } = await handleAuth(
    { method: 'POST', rest: 'register', body: { name: email.split('@')[0], email, password: 'secret123' }, ip: '1.1.1.1' },
    { store: postgresStore(db), domainError: async () => null },
  );
  if (role !== 'customer') await db('UPDATE users SET role = $1 WHERE id = $2', [role, body.user.id]);
  const authorization = `Bearer ${body.token}`;
  return {
    id: body.user.id,
    shop: (method, path, payload) => handleShop({ method, segments: path.split('/'), body: payload, authorization, ip: '1.1.1.1' }, { db, rz }),
    seller: (method, path, payload, params) => handleSeller({ method, rest: path.split('/'), body: payload, params, authorization }, { db, rz }),
    support: (method, path, payload, params) => handleSupport({ method, rest: path.split('/'), body: payload, params, authorization }, { db }),
  };
}

/** A cash order of one product, from `sellerId` if given. `online` turns it into a paid UPI order. */
async function order(shopper, { sellerId = null, online = false, product = products[0] } = {}) {
  const addressId = (await shopper.shop('POST', 'addresses', ADDRESS)).body.id;
  await shopper.shop('POST', 'cart', { productId: product._id, qty: 1 });
  const placed = await shopper.shop('POST', 'orders', { addressId, paymentMethod: 'cod' });
  assert.equal(placed.status, 201);
  const id = placed.body.id;
  if (sellerId) await db('UPDATE order_items SET seller_id = $1 WHERE order_id = $2', [sellerId, id]);
  if (online) {
    await db("UPDATE orders SET payment_method = 'upi' WHERE id = $1", [id]);
    await db(
      "INSERT INTO payments (user_id, order_id, provider_order_id, provider_payment_id, method, amount, status, address) VALUES ($1, $2, $3, $4, 'upi', $5, 'paid', 'x')",
      [shopper.id, id, `order_${id}`, `pay_${id}`, placed.body.total],
    );
  }
  return placed.body;
}

const deliver = (orderId, daysAgo = 1) =>
  db(`UPDATE order_items SET fulfilment = 'delivered', fulfilled_at = NOW() - make_interval(days => $2) WHERE order_id = $1`, [orderId, daysAgo]);

const events = async (orderId) => (await db('SELECT status FROM order_events WHERE order_id = $1 ORDER BY id', [orderId])).map((e) => e.status);

before(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../backend/app/db/schema.sql', import.meta.url), 'utf8').replaceAll('{analytics}', 'analytics'));
  await pg.exec(STORE_SCHEMA);
});

beforeEach(async () => {
  rz = fakeRazorpay();
  await pg.exec('TRUNCATE users, auth_rate_limits RESTART IDENTITY CASCADE');
});

test('a return can only start after delivery, within 7 days, once per order', async () => {
  const asha = await person('asha@example.com');
  const o = await order(asha);
  assert.match((await asha.shop('POST', `orders/${o.id}/return`, UPI)).body.error, /once it has been delivered/);
  await deliver(o.id, 8);
  assert.match((await asha.shop('POST', `orders/${o.id}/return`, UPI)).body.error, /7-day return window/);
  await deliver(o.id, 2);
  assert.equal((await asha.shop('POST', `orders/${o.id}/return`, { refundTo: 'upi', upi: 'asha@okhdfcbank' })).status, 400); // no reason
  assert.equal((await asha.shop('POST', `orders/${o.id}/return`, UPI)).status, 201);
  assert.equal((await asha.shop('POST', `orders/${o.id}/return`, UPI)).status, 409);
  const ravi = await person('ravi@example.com');
  assert.equal((await ravi.shop('POST', `orders/${o.id}/return`, UPI)).status, 404); // someone else's order
  const detail = (await asha.shop('GET', `orders/${o.id}`)).body;
  assert.deepEqual([detail.return.status, detail.return.reason_code, detail.return.refund_to, detail.return.amount], ['requested', 'damaged', 'upi', o.total]);
});

test('cash orders need a valid UPI ID or bank account for the refund; the account number is stored encrypted', async () => {
  const asha = await person('asha@example.com');
  const o = await order(asha);
  await deliver(o.id);
  const ask = (extra) => asha.shop('POST', `orders/${o.id}/return`, { reasonCode: 'size_fit', ...extra });
  assert.match((await ask({})).body.error, /where to send your refund/);
  assert.match((await ask({ refundTo: 'upi', upi: 'not-a-upi' })).body.error, /UPI ID/);
  assert.match((await ask({ refundTo: 'bank', accountName: 'Asha Rao', accountNumber: '12', ifsc: 'HDFC0001234' })).body.error, /account number/);
  assert.match((await ask({ refundTo: 'bank', accountName: 'Asha Rao', accountNumber: '123456789012', ifsc: 'HDFC1' })).body.error, /IFSC/);
  const made = await ask({ refundTo: 'bank', accountName: 'Asha Rao', accountNumber: '1234 5678 9012', ifsc: 'hdfc0001234' });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.refund_bank, { name: 'Asha Rao', last4: '9012', ifsc: 'HDFC0001234' });
  const [row] = await db('SELECT refund_account_number FROM order_returns WHERE order_id = $1', [o.id]);
  assert.ok(row.refund_account_number && !row.refund_account_number.includes('123456789012'));
});

test('cash order: approve, pick up, then the admin sends the bank transfer and records its UTR', async () => {
  const asha = await person('asha@example.com');
  const admin = await person('owner@example.com', 'admin');
  const o = await order(asha);
  await deliver(o.id);
  await asha.shop('POST', `orders/${o.id}/return`, { reasonCode: 'wrong_item', refundTo: 'bank', accountName: 'Asha Rao', accountNumber: '123456789012', ifsc: 'HDFC0001234' });

  const queue = (await admin.seller('GET', 'returns')).body;
  assert.deepEqual(queue.map((r) => [r.order_id, r.status, r.canManage]), [[o.id, 'requested', true]]);
  assert.equal(queue[0].refund_bank.number, undefined); // the full number only once a transfer is due

  assert.match((await admin.seller('PATCH', `returns/${o.id}`, { action: 'receive' })).body.error, /Approve the return/);
  assert.equal((await admin.seller('PATCH', `returns/${o.id}`, { action: 'approve' })).body.status, 'approved');
  assert.equal((await admin.seller('PATCH', `returns/${o.id}`, { action: 'approve' })).status, 409);
  assert.equal((await asha.shop('DELETE', `orders/${o.id}/return`)).status, 400); // too late to withdraw
  const received = await admin.seller('PATCH', `returns/${o.id}`, { action: 'receive' });
  assert.deepEqual([received.body.status, received.body.refund], ['received', 'cod_manual']);
  assert.equal(received.body.refund_bank.number, '123456789012'); // the admin can now make the transfer
  assert.equal((await asha.shop('GET', `orders/${o.id}`)).body.status, 'returned');

  assert.match((await admin.seller('PATCH', `returns/${o.id}`, { action: 'refund' })).body.error, /UTR/);
  const paid = await admin.seller('PATCH', `returns/${o.id}`, { action: 'refund', reference: 'utr123456789' });
  assert.deepEqual([paid.body.refund, paid.body.refund_reference], ['refunded', 'UTR123456789']);
  assert.equal((await admin.seller('PATCH', `returns/${o.id}`, { action: 'refund', reference: 'UTR123456789' })).status, 409);
  const [row] = await db('SELECT refund_account_number, refund_account_last4 FROM order_returns WHERE order_id = $1', [o.id]);
  assert.deepEqual(row, { refund_account_number: null, refund_account_last4: '9012' }); // wiped once paid
  assert.deepEqual(await events(o.id), ['placed', 'return_requested', 'return_approved', 'returned', 'refund_initiated', 'refunded']);
  assert.deepEqual((await admin.seller('GET', 'returns')).body, []); // done: off the open queue
  assert.equal((await admin.seller('GET', 'returns', null, { view: 'all' })).body.length, 1);
});

test('paid online: the refund goes back to the original payment, with a retry if Razorpay is down', async () => {
  const asha = await person('asha@example.com');
  const admin = await person('owner@example.com', 'admin');
  const o = await order(asha, { online: true });
  await deliver(o.id);
  const made = await asha.shop('POST', `orders/${o.id}/return`, { reasonCode: 'not_needed' }); // no account details needed
  assert.equal(made.body.refund_to, 'original');
  await admin.seller('PATCH', `returns/${o.id}`, { action: 'approve' });

  rz.state.failing = true;
  const received = await admin.seller('PATCH', `returns/${o.id}`, { action: 'receive' });
  assert.equal(received.body.refund, 'refund_pending');
  rz.state.failing = false;
  const retried = await admin.seller('PATCH', `returns/${o.id}`, { action: 'refund' });
  assert.equal(retried.body.refund, 'refunded');
  assert.deepEqual(rz.state.refunded, [`pay_${o.id}`]);
  const [payment] = await db('SELECT status FROM payments WHERE order_id = $1', [o.id]);
  assert.equal(payment.status, 'refunded');
  assert.match((await asha.shop('GET', `orders/${o.id}`)).body.events.at(-1).note, /original payment method/);
});

test('the Razorpay webhook completes a pending return refund', async () => {
  const asha = await person('asha@example.com');
  const admin = await person('owner@example.com', 'admin');
  const o = await order(asha, { online: true });
  await deliver(o.id);
  await asha.shop('POST', `orders/${o.id}/return`, { reasonCode: 'quality' });
  await admin.seller('PATCH', `returns/${o.id}`, { action: 'approve' });
  rz.state.failing = true;
  await admin.seller('PATCH', `returns/${o.id}`, { action: 'receive' });
  const raw = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { payment_id: `pay_${o.id}` } } } });
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  assert.equal((await handleWebhook(raw, sig, { db, rz })).status, 200);
  assert.equal((await asha.shop('GET', `orders/${o.id}`)).body.return.refund, 'refunded');
});

test('rejecting needs a reason the shopper sees; a withdrawn return can be asked again', async () => {
  const asha = await person('asha@example.com');
  const admin = await person('owner@example.com', 'admin');
  const o = await order(asha);
  await deliver(o.id);
  await asha.shop('POST', `orders/${o.id}/return`, UPI);
  assert.equal((await asha.shop('DELETE', `orders/${o.id}/return`)).status, 200);
  assert.equal((await asha.shop('GET', `orders/${o.id}`)).body.return, null);
  assert.equal((await asha.shop('POST', `orders/${o.id}/return`, UPI)).status, 201);
  assert.match((await admin.seller('PATCH', `returns/${o.id}`, { action: 'reject' })).body.error, /why/);
  const rejected = await admin.seller('PATCH', `returns/${o.id}`, { action: 'reject', note: 'The seal has been opened' });
  assert.equal(rejected.body.status, 'rejected');
  const detail = (await asha.shop('GET', `orders/${o.id}`)).body;
  assert.deepEqual([detail.status, detail.return.note], ['placed', 'The seal has been opened']);
  assert.equal(detail.events.at(-1).note, 'Return not approved: The seal has been opened');
});

test('sellers handle returns of their own orders only; manual refunds are for the admin', async () => {
  const asha = await person('asha@example.com');
  const mine = await person('seller@example.com', 'seller');
  const other = await person('other@example.com', 'seller');
  const o = await order(asha, { sellerId: mine.id });
  const mixed = await order(asha, { sellerId: mine.id, product: products[1] });
  await db('UPDATE order_items SET seller_id = $1 WHERE order_id = $2', [other.id, mixed.id]);
  await db("INSERT INTO order_items (order_id, product_id, name, price, qty, seller_id, fulfilment) VALUES ($1, 'x', 'Extra', 10, 1, $2, 'delivered')", [mixed.id, mine.id]);
  for (const id of [o.id, mixed.id]) {
    await deliver(id);
    await asha.shop('POST', `orders/${id}/return`, UPI);
  }
  const queue = (await mine.seller('GET', 'returns')).body;
  assert.deepEqual(queue.map((r) => [r.order_id, r.canManage]).sort(), [[o.id, true], [mixed.id, false]].sort());
  assert.equal((await other.seller('PATCH', `returns/${o.id}`, { action: 'approve' })).status, 404);
  assert.equal((await mine.seller('PATCH', `returns/${mixed.id}`, { action: 'approve' })).status, 403);
  assert.equal((await asha.seller('GET', 'returns')).status, 403); // customers aren't sellers
  await mine.seller('PATCH', `returns/${o.id}`, { action: 'approve' });
  // The seller can't move an order with a return in progress back along the delivery steps
  assert.match((await mine.seller('PATCH', `orders/${o.id}`, { fulfilment: 'shipped' })).body.error, /return in progress/);
  assert.equal((await mine.seller('PATCH', `returns/${o.id}`, { action: 'receive' })).body.refund, 'cod_manual');
  assert.equal((await mine.seller('PATCH', `returns/${o.id}`, { action: 'refund', reference: 'UTR123456789' })).status, 403);
  assert.equal((await mine.seller('GET', 'orders', null, { status: 'returned' })).body[0].return_status, 'received');
});

test('cancelling a paid order puts the refund on the order timeline', async () => {
  const asha = await person('asha@example.com');
  const o = await order(asha, { online: true });
  const cancelled = await asha.shop('PATCH', `orders/${o.id}/cancel`);
  assert.equal(cancelled.body.refund, 'refunded');
  assert.match((await asha.shop('GET', `orders/${o.id}`)).body.events.at(-1).note, /Refund of ₹[\d,]+ sent to your original payment method/);
});

test('triage picks the team and urgency from the words used', () => {
  assert.equal(triage('Refund not received', 'I returned the shoes last week, where is my money back?').category, 'returns');
  assert.equal(triage('Parcel late', 'My courier tracking has not moved in 4 days').category, 'delivery');
  assert.equal(triage('Broken item', 'The mixer was delivered damaged and broken').category, 'product');
  assert.equal(triage('Charged twice', 'My UPI payment was deducted twice, this is fraud').priority, 'high');
  assert.equal(triage('Password', 'How do I change my account password?').priority, 'low');
  assert.match(triage('Late', 'where is my parcel', { name: 'Asha Rao', orderId: 7 }).suggestedReply, /^Hi Asha.*order #7/);
});

test('complaints: raise, talk it through with the store team, resolve, reopen', async () => {
  const asha = await person('asha@example.com');
  const ravi = await person('ravi@example.com');
  const admin = await person('owner@example.com', 'admin');
  const o = await order(asha);
  assert.equal((await asha.support('POST', 'tickets', { subject: 'Hi', message: 'short' })).status, 400);
  assert.equal((await ravi.support('POST', 'tickets', { subject: 'Late order', message: 'Where is my order please?', orderId: o.id })).status, 404);
  const made = await asha.support('POST', 'tickets', { subject: 'Order not delivered', message: 'My parcel has not arrived yet, tracking is stuck', orderId: o.id });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.category, made.body.status, made.body.order_id], ['delivery', 'open', o.id]);
  assert.ok(made.body.suggested_reply.includes(`order #${o.id}`));

  assert.equal((await ravi.support('GET', `tickets/${made.body.id}`)).status, 404); // private
  assert.deepEqual((await ravi.support('GET', 'tickets')).body, []);
  assert.equal((await admin.support('GET', 'tickets')).body.length, 1);
  assert.equal((await asha.support('PATCH', `tickets/${made.body.id}`, { status: 'resolved' })).status, 403);

  const answered = await admin.support('POST', `tickets/${made.body.id}/messages`, { message: 'The courier will deliver it tomorrow.' });
  assert.deepEqual([answered.body.status, answered.body.messages.map((m) => [m.staff, m.author])], ['in_progress', [[true, 'Arvixa support']]]);
  assert.equal((await admin.support('PATCH', `tickets/${made.body.id}`, { status: 'resolved' })).body.status, 'resolved');
  const reopened = await asha.support('POST', `tickets/${made.body.id}/messages`, { message: 'It still has not come.' });
  assert.deepEqual([reopened.body.status, reopened.body.messages.length, reopened.body.resolved_at], ['open', 2, null]);
  assert.equal((await asha.support('GET', 'tickets', null, { status: 'open' })).body[0].replies, 2);
  assert.equal((await asha.support('GET', 'tickets')).body[0].customer_email, undefined);
});

test('complaints are rate limited and need a login', async () => {
  assert.equal((await handleSupport({ method: 'GET', rest: ['tickets'] }, { db })).status, 401);
  const asha = await person('asha@example.com');
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await asha.support('POST', 'tickets', { subject: `Issue ${i}`, message: 'Something is wrong with my order' })).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
});

test('only the listed return and support routes are served', () => {
  assert.ok(isShopRoute('POST', ['orders', '1', 'return']));
  assert.ok(isShopRoute('DELETE', ['orders', '1', 'return']));
  assert.equal(isShopRoute('PATCH', ['orders', '1', 'return']), false);
  assert.ok(isSupportRoute('POST', ['tickets', '1', 'messages']));
  assert.equal(isSupportRoute('DELETE', ['tickets', '1']), false);
  assert.equal(isSupportRoute('GET', ['other']), false);
});
