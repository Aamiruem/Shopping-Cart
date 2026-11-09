// Online payments through Razorpay, an RBI-authorised payment aggregator: UPI, net banking with every major bank,
// credit/debit cards, wallets and EMI. Port of backend/app/routers/payments.py, on the same `payments` table.
//
// 1. POST /payments/razorpay/order   the cart total becomes a Razorpay order (nothing is charged yet)
// 2. Razorpay Checkout                the shopper pays in the browser
// 3. POST /payments/razorpay/verify  the signature is checked here, then the store order is created
// 4. POST /payments/razorpay/webhook Razorpay reports captures, failures and refunds (razorpay-webhook.mjs), so an
//                                     order is still placed if the shopper closes the tab after paying
// If an order can't be placed after money was taken, the payment is refunded straight away.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, currentUserId, limit, postgresStore, query, safely } from './_auth.mjs';
import { checkoutSummary, createOrder, resolveAddress } from './_shop.mjs';

const API = 'https://api.razorpay.com/v1';
// Razorpay payment.method -> orders.payment_method. Anything unknown is kept as 'online' rather than guessed.
const METHODS = { upi: 'upi', card: 'card', netbanking: 'netbanking', wallet: 'wallet', emi: 'emi', cardless_emi: 'emi', paylater: 'paylater' };
const START_LIMIT = 30;

function sameHmac(secret, message, signature) {
  if (!secret || typeof signature !== 'string' || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(message).digest('hex'));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function razorpayClient(env = process.env) {
  const keyId = env.RAZORPAY_KEY_ID || '';
  const secret = env.RAZORPAY_KEY_SECRET || '';
  const configured = Boolean(keyId && secret);
  async function call(method, path, body) {
    if (!configured) throw new ApiError(503, 'Online payments are not set up yet. Please choose cash on delivery.');
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new ApiError(502, 'The payment service is not responding. Please try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(502, `Payment service error: ${data?.error?.description || res.status}`);
    return data;
  }
  const id = (value) => encodeURIComponent(String(value));
  return {
    configured,
    keyId: configured ? keyId : null,
    // Razorpay works in paise (1 rupee = 100 paise)
    createOrder: (rupees, receipt, notes) => call('POST', '/orders', { amount: Math.round(rupees * 100), currency: 'INR', receipt, notes }),
    // expand[]=card says whether a card was credit or debit
    fetchPayment: (paymentId) => call('GET', `/payments/${id(paymentId)}?expand[]=card`),
    capture: (paymentId, paise) => call('POST', `/payments/${id(paymentId)}/capture`, { amount: paise, currency: 'INR' }),
    refund: (paymentId) => call('POST', `/payments/${id(paymentId)}/refund`, {}),
    // Checkout returns razorpay_signature = HMAC-SHA256(order_id|payment_id, key secret)
    verifyPayment: (orderId, paymentId, signature) => sameHmac(secret, `${orderId}|${paymentId}`, signature),
    // Webhooks carry X-Razorpay-Signature = HMAC-SHA256(raw body, webhook secret)
    verifyWebhook: (raw, signature) => sameHmac(env.RAZORPAY_WEBHOOK_SECRET || '', raw, signature),
  };
}

const CARD_TYPES = { credit: 'credit_card', debit: 'debit_card', prepaid: 'card' };

/** How the shopper paid, for the order: UPI, credit card, debit card, net banking, EMI, Pay Later or a wallet. */
export function methodOf(details) {
  if (details?.method === 'card') return CARD_TYPES[details.card?.type] || 'card';
  return METHODS[details?.method] || 'online';
}

async function startPayment({ db, userId, body, rz, store }) {
  if (!rz.configured) throw new ApiError(503, 'Online payments are not set up yet. Please choose cash on delivery.');
  await limit(store, `pay:${userId}`, START_LIMIT, 'Too many payment attempts. Please try again in a few minutes.');
  const address = await resolveAddress(db, userId, body.addressId);
  const { summary } = await checkoutSummary(db, userId);
  const [account] = await db('SELECT name, email, phone FROM users WHERE id = $1', [userId]);
  const order = await rz.createOrder(summary.total, `user${userId}`, { userId: String(userId) });
  await db('INSERT INTO payments (user_id, provider_order_id, amount, address) VALUES ($1, $2, $3, $4)', [userId, order.id, summary.total, address]);
  return {
    body: {
      keyId: rz.keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      name: 'Arvixa Store',
      description: `${summary.items.length} item(s)`,
      prefill: { name: account.name, email: account.email, contact: account.phone || '' },
    },
  };
}

// Only one caller wins, so verify, a double submit and the webhook can never create two orders for one payment
async function claim(db, paymentRowId) {
  const rows = await db(
    "UPDATE payments SET status = 'processing', updated_at = NOW() WHERE id = $1 AND status IN ('created', 'failed') RETURNING id",
    [paymentRowId],
  );
  return rows.length > 0;
}

async function resultOfClaimed(db, paymentRowId) {
  const [row] = await db('SELECT status, order_id, error FROM payments WHERE id = $1', [paymentRowId]);
  if (row.order_id) return { orderId: row.order_id, status: 'paid' };
  if (row.status === 'processing') throw new ApiError(409, 'We are confirming your payment. Please check My Orders in a minute.');
  throw new ApiError(409, row.error || 'This payment could not be completed.');
}

// The money must go back. If Razorpay is down the row says so, for a retry from the Razorpay dashboard.
async function refundAfterFailure(db, rz, paymentRowId, providerPaymentId, method, reason) {
  let status = 'refunded';
  try {
    await rz.refund(providerPaymentId);
  } catch (err) {
    console.error('refund failed for payment', providerPaymentId, err.message);
    status = 'refund_pending';
  }
  await db(
    'UPDATE payments SET status = $1, provider_payment_id = $2, method = $3, error = $4, updated_at = NOW() WHERE id = $5',
    [status, providerPaymentId, method, String(reason).slice(0, 500), paymentRowId],
  );
}

// Turns a claimed payment into an order. If the order can't be placed, the shopper is refunded straight away.
async function settle(db, rz, payment, providerPaymentId, details) {
  const method = methodOf(details);
  if (!['authorized', 'captured'].includes(details?.status)) {
    await db("UPDATE payments SET status = 'created', updated_at = NOW() WHERE id = $1", [payment.id]);
    throw new ApiError(402, 'This payment has not completed. No order was placed.');
  }
  let order;
  try {
    if (details.status === 'authorized') await rz.capture(providerPaymentId, details.amount);
    const { summary } = await checkoutSummary(db, payment.user_id);
    if (Math.round(summary.total * 100) !== details.amount) {
      throw new ApiError(409, 'Your cart changed during payment. The amount has been refunded; please check out again.');
    }
    order = await createOrder(db, { userId: payment.user_id, address: payment.address, method, summary });
    if (!order) throw new ApiError(409, 'Your cart changed during payment. The amount has been refunded; please check out again.');
  } catch (err) {
    await refundAfterFailure(db, rz, payment.id, providerPaymentId, method, err.message);
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, 'Your order could not be placed, so your payment has been refunded.');
  }
  await db(
    "UPDATE payments SET status = 'paid', order_id = $1, provider_payment_id = $2, method = $3, updated_at = NOW() WHERE id = $4",
    [order.id, providerPaymentId, method, payment.id],
  );
  return order;
}

async function verifyPayment({ db, userId, body, rz }) {
  const orderId = String(body.razorpay_order_id ?? '');
  const paymentId = String(body.razorpay_payment_id ?? '');
  const [payment] = await db('SELECT * FROM payments WHERE provider_order_id = $1 AND user_id = $2', [orderId, userId]);
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status === 'paid' && payment.order_id) return { body: { orderId: payment.order_id, status: 'paid' } }; // double submit
  if (!rz.verifyPayment(orderId, paymentId, body.razorpay_signature)) {
    await db("UPDATE payments SET status = 'failed', error = 'signature mismatch', updated_at = NOW() WHERE id = $1", [payment.id]);
    throw new ApiError(400, 'We could not verify this payment. If money was deducted it will be refunded automatically.');
  }
  if (!(await claim(db, payment.id))) return { body: await resultOfClaimed(db, payment.id) };
  const details = await rz.fetchPayment(paymentId);
  const order = await settle(db, rz, payment, paymentId, details);
  return { body: { orderId: order.id, status: 'paid', method: methodOf(details) } };
}

async function myPayments({ db, userId }) {
  const rows = await db(
    `SELECT id, order_id, provider, provider_payment_id, method, amount, status, created_at
       FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  return { body: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
}

/**
 * Refunds a cancelled or returned order's online payment in full, to the account it was paid from. A refund that
 * failed before (refund_pending) is tried again. null when there is no online payment left to refund.
 */
export async function refundPaidOrder(db, orderId, rz = razorpayClient()) {
  const [payment] = await db("SELECT * FROM payments WHERE order_id = $1 AND status IN ('paid', 'refund_pending') ORDER BY id DESC LIMIT 1", [orderId]);
  if (!payment) return null;
  let status = 'refunded';
  try {
    await rz.refund(payment.provider_payment_id);
  } catch (err) {
    console.error('refund failed for payment', payment.provider_payment_id, err.message);
    status = 'refund_pending'; // the shopper is told it is on its way; retry from the Razorpay dashboard
  }
  await db('UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2', [status, payment.id]);
  return status;
}

// ---------- Payment history: every payment and refund in one timeline ----------
const RETURN_REFUND = { refunded: 'refunded', refund_pending: 'processing', processing: 'processing', cod_manual: 'processing' };

/** What happened to the money on one order: was it paid, how, and is anything still owed back. */
function orderPayment(o, payment) {
  const delivered = o.delivered && o.status !== 'cancelled';
  if (payment) {
    return { status: payment.status === 'paid' || payment.status === 'refunded' || payment.status === 'refund_pending' ? 'paid' : payment.status, reference: payment.provider_payment_id };
  }
  if (o.payment_method !== 'cod') return { status: 'paid', reference: null }; // the full API's demo payments
  if (o.status === 'cancelled') return { status: 'not_charged', reference: null };
  return { status: delivered ? 'paid_on_delivery' : 'due_on_delivery', reference: null };
}

export async function paymentHistory({ db, userId }) {
  const [orders, payments, returns] = await Promise.all([
    db(
      `SELECT o.id, o.created_at, o.status, o.total, o.payment_method,
              bool_and(oi.fulfilment = 'delivered') AS delivered, MAX(oi.fulfilled_at) AS delivered_at,
              (array_agg(oi.name ORDER BY oi.id))[1] AS first_item, (array_agg(oi.image ORDER BY oi.id))[1] AS image, COUNT(*)::int AS lines
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_id = $1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 300`,
      [userId],
    ),
    db('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 300', [userId]),
    db("SELECT * FROM order_returns WHERE user_id = $1 AND status <> 'withdrawn'", [userId]),
  ]);
  const paymentOf = new Map(payments.filter((p) => p.order_id).map((p) => [p.order_id, p]));
  const returnOf = new Map(returns.map((r) => [r.order_id, r]));
  const entries = [];
  for (const o of orders) {
    const payment = paymentOf.get(o.id);
    const order = { id: o.id, item: o.first_item, image: o.image, items: o.lines };
    const paid = orderPayment(o, payment);
    entries.push({
      id: `pay-${o.id}`, kind: 'payment', date: o.status === 'placed' && paid.status === 'paid_on_delivery' ? o.delivered_at || o.created_at : o.created_at,
      amount: Number(o.total), method: payment?.method || o.payment_method, status: paid.status, reference: paid.reference, order,
    });
    // Money going back: a cancelled online order, or a return
    const ret = returnOf.get(o.id);
    if (ret?.refund) {
      entries.push({
        id: `refund-${o.id}`, kind: 'refund', reason: 'return', date: ret.refunded_at || ret.updated_at, amount: Number(ret.amount ?? o.total),
        method: ret.refund_to === 'original' ? payment?.method || o.payment_method : ret.refund_to,
        to: ret.refund_to === 'original' ? 'original' : ret.refund_to === 'upi' ? `UPI ${ret.refund_upi}` : `Bank ••••${ret.refund_account_last4}`,
        status: RETURN_REFUND[ret.refund] || 'processing', reference: ret.refund_reference, order,
      });
    } else if (o.status === 'cancelled' && payment && ['refunded', 'refund_pending'].includes(payment.status)) {
      entries.push({
        id: `refund-${o.id}`, kind: 'refund', reason: 'cancelled', date: payment.updated_at, amount: Number(payment.amount),
        method: payment.method, to: 'original', status: payment.status === 'refunded' ? 'refunded' : 'processing', reference: null, order,
      });
    }
  }
  // Attempts that never became an order: failed, or taken and given straight back
  for (const p of payments.filter((x) => !x.order_id && ['failed', 'refunded', 'refund_pending'].includes(x.status))) {
    entries.push({
      id: `attempt-${p.id}`, kind: p.status === 'failed' ? 'failed' : 'refund', reason: 'not_placed', date: p.updated_at, amount: Number(p.amount),
      method: p.method || 'online', to: 'original', status: p.status === 'failed' ? 'failed' : p.status === 'refunded' ? 'refunded' : 'processing',
      reference: p.provider_payment_id, order: null, note: p.status === 'failed' ? 'Payment didn’t go through. Nothing was charged.' : 'The order couldn’t be placed, so the money was sent back.',
    });
  }
  entries.sort((a, b) => new Date(b.date) - new Date(a.date));
  const sum = (list) => Math.round(list.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  const charged = entries.filter((e) => e.kind === 'payment' && ['paid', 'paid_on_delivery'].includes(e.status));
  return {
    body: {
      summary: {
        paid: sum(charged),
        refunded: sum(entries.filter((e) => e.kind === 'refund' && e.status === 'refunded')),
        refundPending: sum(entries.filter((e) => e.kind === 'refund' && e.status === 'processing')),
        dueOnDelivery: sum(entries.filter((e) => e.status === 'due_on_delivery')),
        orders: orders.length,
      },
      entries,
    },
  };
}

const ROUTES = { 'POST razorpay/order': startPayment, 'POST razorpay/verify': verifyPayment, 'GET mine': myPayments, 'GET history': paymentHistory };

export const isPaymentRoute = (method, rest) => Object.hasOwn(ROUTES, `${method} ${rest}`);

export function handlePayments({ method, rest, body, authorization }, { db = query, rz = razorpayClient() } = {}) {
  return safely(async () => {
    const userId = currentUserId(authorization);
    return ROUTES[`${method} ${rest}`]({ db, userId, body: body ?? {}, rz, store: postgresStore(db) });
  });
}

/** Razorpay webhook (payment.captured, payment.failed, refund.processed). `raw` must be the exact request body. */
export async function handleWebhook(raw, signature, { db = query, rz = razorpayClient() } = {}) {
  if (!rz.verifyWebhook(raw, signature)) return { status: 400, body: { error: 'Invalid signature' } };
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: 'Invalid body' } };
  }
  const kind = event.event || '';
  const entity = event.payload?.payment?.entity || {};
  try {
    if (kind === 'payment.failed' && entity.order_id) {
      await db(
        "UPDATE payments SET status = 'failed', error = $1, updated_at = NOW() WHERE provider_order_id = $2 AND status = 'created'",
        [String(entity.error_description || 'payment failed').slice(0, 500), entity.order_id],
      );
    } else if (kind === 'payment.captured' && entity.order_id) {
      // Usually verify got there first. If the shopper closed the tab after paying, this places the order.
      const [payment] = await db('SELECT * FROM payments WHERE provider_order_id = $1', [entity.order_id]);
      if (payment && (await claim(db, payment.id))) {
        try {
          await settle(db, rz, payment, entity.id, entity);
        } catch (err) {
          console.warn('captured payment could not become an order', entity.id, err.message); // already refunded and recorded
        }
      }
    } else if (kind === 'refund.processed') {
      const refund = event.payload?.refund?.entity || {};
      const paid = await db("UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE provider_payment_id = $1 RETURNING order_id", [refund.payment_id]);
      // A returned order's refund that was still pending is now complete
      const orderId = paid[0]?.order_id;
      if (orderId) {
        await db(
          "UPDATE order_returns SET refund = 'refunded', refunded_at = NOW(), updated_at = NOW() WHERE order_id = $1 AND refund IN ('refund_pending', 'processing')",
          [orderId],
        );
      }
    }
  } catch (err) {
    console.error('webhook error', err);
    return { status: 500, body: { error: 'Webhook failed' } }; // Razorpay retries
  }
  return { status: 200, body: { ok: true } };
}
