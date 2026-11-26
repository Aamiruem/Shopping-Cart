// CRM → Payments and Deliveries, plus OTP diagnostics and the admin's test OTP.
//
// Payment reconciliation compares our payment records with what Razorpay itself reports for each attempt. It only
// reports differences (and marks an attempt failed when the gateway says so); it never creates an order or marks
// anything paid on its own: paid orders come only from a verified signature or a signed webhook.
import { razorpayClient } from './_payments.mjs';
import { audit, can, fail, ID_RE, like, mask, need, pageOf, paging, text, where } from './_crm_core.mjs';

const PAYMENT_STATUSES = ['created', 'processing', 'paid', 'failed', 'refunded', 'refund_pending'];
const LABEL = { created: 'Pending', processing: 'Processing', paid: 'Paid', failed: 'Failed', refunded: 'Refunded', refund_pending: 'Refund initiated' };

export async function listPayments({ db, staff, params }) {
  const w = where();
  if (PAYMENT_STATUSES.includes(params.status)) w.add('p.status = ?', params.status);
  const q = text(params.q, 80);
  if (q) w.add('(u.name ILIKE ? OR u.email ILIKE ? OR p.provider_order_id ILIKE ? OR p.provider_payment_id ILIKE ? OR o.order_number ILIKE ?)', ...Array(5).fill(like(q)));
  const p = paging(params);
  const from = 'FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN orders o ON o.id = p.order_id';
  const [{ total }] = await db(`SELECT count(*)::int AS total ${from} ${w.sql()}`, w.args);
  const rows = await db(
    `SELECT p.id, p.provider, p.provider_order_id, p.provider_payment_id, p.method, p.amount::float, p.status, p.error, p.created_at, p.updated_at,
            p.order_id, o.order_number, u.name AS customer, u.email ${from} ${w.sql()} ORDER BY p.created_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`,
    w.args,
  );
  const summary = await db(`SELECT status, count(*)::int AS n, COALESCE(SUM(amount), 0)::float AS amount FROM payments WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY status`);
  const [cod] = await db(
    `SELECT count(*)::int AS orders, COALESCE(SUM(o.total), 0)::float AS amount FROM orders o
      WHERE o.payment_method = 'cod' AND o.status = 'placed' AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.fulfilment <> 'delivered')`,
  );
  const rz = razorpayClient();
  return {
    body: {
      ...pageOf(rows.map((r) => ({ ...r, statusLabel: LABEL[r.status] ?? r.status, email: can(staff, 'customers.contact') ? r.email : mask(r.email) })), p, total),
      summary: PAYMENT_STATUSES.map((s) => ({ status: s, label: LABEL[s], ...(summary.find((x) => x.status === s) || { n: 0, amount: 0 }) })),
      codToCollect: cod,
      gateway: { provider: 'razorpay', configured: rz.configured, mode: rz.mode, modeMismatch: rz.modeMismatch },
    },
  };
}

/** Checks attempts that never finished against the gateway. Reports; marks failed only what the gateway says failed. */
export async function reconcilePayments({ db, staff }, { rz = razorpayClient() } = {}) {
  need(staff, 'payments.manage');
  if (!rz.configured) fail('Razorpay isn’t connected, so there is nothing to compare with', 503);
  const open = await db(`SELECT id, provider_order_id, amount::float, status, order_id FROM payments
                          WHERE status IN ('created', 'processing') AND created_at < NOW() - INTERVAL '15 minutes' AND created_at > NOW() - INTERVAL '7 days'
                          ORDER BY created_at LIMIT 50`);
  const findings = [];
  for (const p of open) {
    try {
      const list = (await rz.fetchOrderPayments(p.provider_order_id)).items || [];
      const captured = list.find((x) => x.status === 'captured');
      if (captured) findings.push({ paymentId: p.id, issue: 'captured_without_order', gatewayPayment: captured.id, amount: captured.amount / 100, action: 'Check the Razorpay webhook: the store should have placed (or refunded) this' });
      else if (list.length && list.every((x) => x.status === 'failed')) {
        await db("UPDATE payments SET status = 'failed', error = 'reconciled: failed at the gateway', updated_at = NOW() WHERE id = $1 AND status IN ('created', 'processing')", [p.id]);
        findings.push({ paymentId: p.id, issue: 'failed_at_gateway', action: 'Marked failed' });
      } else if (!list.length) findings.push({ paymentId: p.id, issue: 'abandoned', action: 'Customer didn’t pay; nothing to do' });
    } catch (err) {
      findings.push({ paymentId: p.id, issue: 'gateway_error', action: err.message });
    }
  }
  await audit(db, staff, 'payments.reconcile', 'payment', null, { checked: open.length, findings: findings.length });
  return { body: { checked: open.length, findings } };
}

export async function listShipments({ db, staff, params }) {
  const w = where();
  if (text(params.status, 30)) w.add('s.status = ?', text(params.status, 30));
  const q = text(params.q, 60);
  if (q) w.add('(s.awb ILIKE ? OR o.order_number ILIKE ? OR u.name ILIKE ?)', like(q), like(q), like(q));
  const p = paging(params);
  const from = 'FROM shipments s JOIN orders o ON o.id = s.order_id JOIN users u ON u.id = o.user_id';
  const [{ total }] = await db(`SELECT count(*)::int AS total ${from} ${w.sql()}`, w.args);
  const rows = await db(
    `SELECT s.*, o.order_number, o.payment_method, o.total::float, u.name AS customer,
            (SELECT e.location FROM shipment_events e WHERE e.shipment_id = s.id ORDER BY e.occurred_at DESC LIMIT 1) AS last_location
       ${from} ${w.sql()} ORDER BY s.updated_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`,
    w.args,
  );
  const counts = await db('SELECT status, count(*)::int AS n FROM shipments GROUP BY status');
  const [waiting] = await db(
    `SELECT count(*)::int AS n FROM orders o WHERE o.status = 'placed' AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.awb IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.fulfilment IN ('shipped', 'delivered'))`,
  );
  const { shippingConfigured } = await import('./_shipping.mjs');
  return { body: { ...pageOf(rows, p, total), counts, toShip: waiting.n, connected: shippingConfigured(), staffCanBook: can(staff, 'shipping.manage') } };
}

// ---------- OTP diagnostics and the admin's own test ----------
export async function otpStatusPage({ db }) {
  const { otpDiagnostics } = await import('./_otp.mjs');
  return { body: await otpDiagnostics(db) };
}

/**
 * Sends a real code to the admin's OWN verified email or mobile number, never to anyone else: proves the whole path
 * (provider accepts → it arrives → the code verifies). Audited without the code.
 */
export async function sendTestOtp({ db, staff, body }, opts = {}) {
  need(staff, 'otp.diagnostics');
  const { sendCode } = await import('./_otp.mjs');
  const channel = ['email', 'sms', 'whatsapp'].includes(body.channel) ? body.channel : fail('Choose email, SMS or WhatsApp');
  const [me] = await db('SELECT email, phone, phone_verified FROM users WHERE id = $1', [staff.id]);
  const target = channel === 'email' ? me.email : me.phone_verified ? me.phone : fail('Verify your own mobile number first (Account → Profile): test codes only go to your own verified number', 409);
  const sent = await sendCode(db, { purpose: 'test', target, channel, userId: staff.id }, opts);
  await audit(db, staff, 'otp.test_send', 'otp', channel, { to: sent.sentTo });
  return { body: sent };
}

export async function verifyTestOtp({ db, staff, body }, opts = {}) {
  need(staff, 'otp.diagnostics');
  const { checkCode } = await import('./_otp.mjs');
  const channel = ['email', 'sms', 'whatsapp'].includes(body.channel) ? body.channel : fail('Choose the channel');
  const [me] = await db('SELECT email, phone FROM users WHERE id = $1', [staff.id]);
  await checkCode(db, { purpose: 'test', target: channel === 'email' ? me.email : me.phone, code: body.code }, opts);
  await audit(db, staff, 'otp.test_verified', 'otp', channel, {});
  return { body: { verified: true, channel } };
}

export { ID_RE };
