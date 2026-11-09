// Returns and refunds on the Vercel store.
//
//   shopper   POST   /orders/:id/return     asks for a return within 7 days of delivery (all of the order)
//   shopper   DELETE /orders/:id/return     withdraws it while it is still waiting for a decision
//   staff     GET    /seller/returns        the seller's returns (the admin sees every one)
//   staff     PATCH  /seller/returns/:id    approve | reject | receive | refund
//
// requested -> approved (courier pickup) -> received (the refund goes out) ; or rejected ; or withdrawn by the shopper.
// Where the money goes:
//   paid online       back to the UPI app, bank account or card it came from, through Razorpay. Nothing to type in.
//   cash on delivery  to the UPI ID or bank account the shopper gives with the request (the account number is stored
//                     encrypted). The admin makes the transfer, records its UTR, and the account number is wiped.
// A seller can handle returns for orders that hold only their products; anything mixed, and every manual bank or UPI
// refund, is for the admin.
import { ApiError } from './_auth.mjs';
import { refundPaidOrder } from './_payments.mjs';
import { decrypt, encrypt } from './_seller.mjs';

export const RETURN_WINDOW_DAYS = 7;
export const RETURN_REASONS = {
  damaged: 'Damaged or defective',
  wrong_item: 'Wrong item delivered',
  missing: 'Missing parts or items',
  not_as_described: 'Not as described',
  size_fit: 'Size or fit issue',
  quality: 'Quality not as expected',
  not_needed: 'No longer needed',
  other: 'Other reason',
};
const ACTIONS = ['approve', 'reject', 'receive', 'refund'];
const ID_RE = /^\d{1,9}$/;
const UPI_RE = /^[\w.-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;
const UTR_RE = /^[A-Za-z0-9-]{6,30}$/;
// Bank and UPI details are cleared from the row once they are no longer needed
const WIPE_ACCOUNT = 'refund_account_number = NULL';

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const fail = (message, status = 400) => {
  throw new ApiError(status, message);
};

const event = (db, orderId, status, note) => db('INSERT INTO order_events (order_id, status, note) VALUES ($1, $2, $3)', [orderId, status, note]);

/** Where a refund goes, in words the shopper recognises. */
function destination(r) {
  if (r.refund_to === 'original') return 'your original payment method';
  if (r.refund_to === 'upi') return `your UPI ID ${r.refund_upi}`;
  return `your bank account ••••${r.refund_account_last4}`;
}

/** A return as the shopper sees it, or with the full account number for the admin who makes a manual transfer. */
export function returnJson(r, { admin = false } = {}) {
  if (!r) return null;
  const json = {
    id: r.id,
    order_id: r.order_id,
    status: r.status,
    reason: r.reason,
    reason_code: r.reason_code,
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    refund: r.refund,
    refund_to: r.refund_to,
    refund_upi: r.refund_upi,
    refund_bank: r.refund_account_last4 ? { name: r.refund_account_name, last4: r.refund_account_last4, ifsc: r.refund_ifsc } : null,
    refund_reference: r.refund_reference,
    note: r.note,
    created_at: r.created_at,
    updated_at: r.updated_at,
    resolved_at: r.resolved_at,
    refunded_at: r.refunded_at,
  };
  if (admin && r.refund === 'cod_manual' && r.refund_account_number) json.refund_bank.number = decrypt(r.refund_account_number);
  return json;
}

/** The order's return, unless the shopper withdrew it (they can then ask again). */
export async function orderReturn(db, orderId) {
  const [row] = await db("SELECT * FROM order_returns WHERE order_id = $1 AND status <> 'withdrawn'", [orderId]);
  return returnJson(row);
}

// Cash orders: the refund needs somewhere to go
function refundAccount(body) {
  if (body.refundTo === 'upi') {
    const upi = text(body.upi);
    if (!UPI_RE.test(upi)) fail('Please enter a valid UPI ID, like name@okhdfcbank');
    return { to: 'upi', upi };
  }
  if (body.refundTo === 'bank') {
    const name = text(body.accountName);
    const number = text(body.accountNumber).replace(/\s/g, '');
    const ifsc = text(body.ifsc).toUpperCase();
    if (name.length < 2 || name.length > 120) fail('Please enter the account holder’s name');
    if (!ACCOUNT_RE.test(number)) fail('Please enter a valid bank account number (9 to 18 digits)');
    if (!IFSC_RE.test(ifsc)) fail('Please enter a valid IFSC code, like HDFC0001234');
    let sealed;
    try {
      sealed = encrypt(number);
    } catch {
      fail('Refunds to a bank account aren’t available yet. Please give a UPI ID instead.', 503);
    }
    return { to: 'bank', name, number: sealed, last4: number.slice(-4), ifsc };
  }
  return fail('Please tell us where to send your refund: a UPI ID or a bank account');
}

export async function requestReturn({ db, userId, id, body }) {
  if (!ID_RE.test(String(id))) fail('Order not found', 404);
  // The full API sends only `reason`; that counts as "other"
  const code = Object.hasOwn(RETURN_REASONS, body.reasonCode) ? body.reasonCode : text(body.reason) ? 'other' : null;
  if (!code) fail('Please choose why you are returning this order');
  const details = text(body.details ?? body.reason).slice(0, 500);
  if (code === 'other' && details.length < 3) fail('Please tell us why you are returning this order');

  const [order] = await db(
    `SELECT o.id, o.status, o.total,
            bool_and(oi.fulfilment = 'delivered') AS delivered, MAX(oi.fulfilled_at) AS delivered_at,
            EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'paid') AS paid_online
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id = $1 AND o.user_id = $2
      GROUP BY o.id`,
    [Number(id), userId],
  );
  if (!order) fail('Order not found', 404);
  if (order.status !== 'placed') fail(`This order was ${order.status}, so it can’t be returned`);
  if (!order.delivered) fail('You can return an order once it has been delivered');
  if (Date.now() - new Date(order.delivered_at).getTime() > RETURN_WINDOW_DAYS * 86400000) {
    fail(`The ${RETURN_WINDOW_DAYS}-day return window for this order has closed. Please contact support if something is wrong with it.`);
  }

  const account = order.paid_online ? { to: 'original' } : refundAccount(body);
  const reason = details ? `${RETURN_REASONS[code]}: ${details}` : RETURN_REASONS[code];
  const [saved] = await db(
    `WITH saved AS (
       INSERT INTO order_returns (order_id, user_id, reason, reason_code, amount, refund_to, refund_upi,
                                  refund_account_name, refund_account_number, refund_account_last4, refund_ifsc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (order_id) DO UPDATE SET
         reason = EXCLUDED.reason, reason_code = EXCLUDED.reason_code, amount = EXCLUDED.amount,
         refund_to = EXCLUDED.refund_to, refund_upi = EXCLUDED.refund_upi, refund_account_name = EXCLUDED.refund_account_name,
         refund_account_number = EXCLUDED.refund_account_number, refund_account_last4 = EXCLUDED.refund_account_last4,
         refund_ifsc = EXCLUDED.refund_ifsc, status = 'requested', refund = NULL, refund_reference = NULL, note = NULL,
         created_at = NOW(), updated_at = NOW(), resolved_at = NULL, refunded_at = NULL
       WHERE order_returns.status = 'withdrawn'  -- one live return per order
       RETURNING *
     ), timeline AS (
       INSERT INTO order_events (order_id, status, note) SELECT order_id, 'return_requested', $12 FROM saved
     )
     SELECT * FROM saved`,
    [order.id, userId, reason, code, order.total, account.to, account.upi ?? null, account.name ?? null, account.number ?? null,
      account.last4 ?? null, account.ifsc ?? null, `Return requested: ${RETURN_REASONS[code]}`],
  );
  if (!saved) fail('A return has already been requested for this order', 409);
  return { status: 201, body: returnJson(saved) };
}

export async function withdrawReturn({ db, userId, id }) {
  const [row] = ID_RE.test(String(id))
    ? await db(
        `WITH gone AS (
           UPDATE order_returns SET status = 'withdrawn', ${WIPE_ACCOUNT}, updated_at = NOW()
            WHERE order_id = $1 AND user_id = $2 AND status = 'requested' RETURNING *
         ), timeline AS (
           INSERT INTO order_events (order_id, status, note) SELECT order_id, 'return_withdrawn', 'You withdrew your return request' FROM gone
         )
         SELECT * FROM gone`,
        [Number(id), userId],
      )
    : [];
  if (!row) fail('This return can no longer be withdrawn. Our courier may already be on the way.');
  return { body: { ok: true } };
}

// ---------- The seller's and admin's side ----------
const OPEN = "(r.status IN ('requested', 'approved') OR (r.status = 'received' AND r.refund IS DISTINCT FROM 'refunded'))";

export async function listReturns({ db, userId, role, params = {} }) {
  const admin = role === 'admin';
  const rows = await db(
    `SELECT r.*, o.total, o.payment_method, o.address, split_part(o.address, ',', 1) AS customer,
            json_agg(json_build_object('name', oi.name, 'image', oi.image, 'qty', oi.qty, 'price', oi.price) ORDER BY oi.id) AS items,
            bool_and(oi.seller_id IS NOT DISTINCT FROM $1::int) AS all_mine
       FROM order_returns r JOIN orders o ON o.id = r.order_id JOIN order_items oi ON oi.order_id = o.id
      WHERE r.status <> 'withdrawn' ${params.view === 'all' ? '' : `AND ${OPEN}`}
      GROUP BY r.id, o.id
     HAVING $2::boolean OR bool_or(oi.seller_id = $1::int)
      ORDER BY CASE r.status WHEN 'requested' THEN 0 WHEN 'approved' THEN 1 WHEN 'received' THEN 2 ELSE 3 END, r.created_at DESC
      LIMIT 200`,
    [userId, admin],
  );
  return {
    body: rows.map((r) => ({
      ...returnJson(r, { admin }),
      total: Number(r.total),
      payment_method: r.payment_method,
      customer: r.customer,
      address: r.address,
      items: r.items,
      canManage: admin || r.all_mine,
      canRecordRefund: admin,
    })),
  };
}

/** Sends an online refund back to where it was paid from. Already refunded (say by the webhook) counts as done. */
async function refundOnline(db, orderId, rz) {
  const status = await refundPaidOrder(db, orderId, rz);
  if (status) return status;
  const [done] = await db("SELECT 1 FROM payments WHERE order_id = $1 AND status = 'refunded'", [orderId]);
  return done ? 'refunded' : 'refund_pending';
}

async function recordRefund(db, r, refund) {
  await db(`UPDATE order_returns SET refund = $1::varchar, refunded_at = CASE WHEN $1::varchar = 'refunded' THEN NOW() END, updated_at = NOW() WHERE id = $2`, [refund, r.id]);
  const amount = rupees(r.amount ?? r.total);
  const notes = {
    refunded: `Refund of ${amount} sent to ${destination(r)}. Banks usually show it within 5–7 working days.`,
    refund_pending: `Refund of ${amount} to ${destination(r)} is being processed.`,
    cod_manual: `Refund of ${amount} will be sent to ${destination(r)} within 2 working days.`,
  };
  await event(db, r.order_id, refund === 'refunded' ? 'refunded' : 'refund_initiated', notes[refund]);
}

export async function actOnReturn({ db, userId, role, id, body, rz }) {
  if (!ID_RE.test(String(id))) fail('Return not found', 404);
  if (!ACTIONS.includes(body.action)) fail('Unknown action');
  const admin = role === 'admin';
  const [r] = await db(
    `SELECT r.*, o.total, bool_and(oi.seller_id IS NOT DISTINCT FROM $2::int) AS all_mine, bool_or(oi.seller_id = $2::int) AS any_mine
       FROM order_returns r JOIN orders o ON o.id = r.order_id JOIN order_items oi ON oi.order_id = o.id
      WHERE r.order_id = $1 AND r.status <> 'withdrawn'
      GROUP BY r.id, o.id`,
    [Number(id), userId],
  );
  if (!r || (!admin && !r.any_mine)) fail('Return not found', 404);
  if (!admin && !r.all_mine) fail('This order has other sellers’ items too, so the store team handles its return.', 403);
  const note = text(body.note).slice(0, 500) || null;
  const orderId = r.order_id;
  // Each step moves on only from the step before it, so a double click or two people at once can't repeat it
  const step = async (from, set, extra = []) =>
    (await db(`UPDATE order_returns SET ${set}, updated_at = NOW() WHERE id = $1 AND status = $2 RETURNING *`, [r.id, from, ...extra]))[0];

  if (body.action === 'approve') {
    const done = await step('requested', "status = 'approved', note = COALESCE($3, note)", [note]);
    if (!done) fail(`This return is already ${r.status}`, 409);
    await event(db, orderId, 'return_approved', `Return approved. Our courier will pick the item up in 2–3 days.${note ? ` ${note}` : ''}`);
    return { body: returnJson(done, { admin }) };
  }

  if (body.action === 'reject') {
    if (!note || note.length < 5) fail('Please tell the customer why the return isn’t approved');
    const done = await step('requested', `status = 'rejected', note = $3, resolved_at = NOW(), ${WIPE_ACCOUNT}`, [note]);
    if (!done) fail(`This return is already ${r.status}`, 409);
    await event(db, orderId, 'return_rejected', `Return not approved: ${note}`);
    return { body: returnJson(done, { admin }) };
  }

  if (body.action === 'receive') {
    const done = await step('approved', "status = 'received', resolved_at = NOW(), note = COALESCE($3, note)", [note]);
    if (!done) fail(r.status === 'requested' ? 'Approve the return before marking it received' : `This return is already ${r.status}`, 409);
    await db("UPDATE orders SET status = 'returned' WHERE id = $1", [orderId]);
    await event(db, orderId, 'returned', 'Item picked up and returned');
    const refund = done.refund_to === 'original' ? await refundOnline(db, orderId, rz) : 'cod_manual';
    await recordRefund(db, { ...done, total: r.total }, refund);
    const [latest] = await db('SELECT * FROM order_returns WHERE id = $1', [r.id]);
    return { body: returnJson(latest, { admin }) };
  }

  // refund: retry an online refund that didn't go through, or record a manual bank / UPI transfer
  if (r.status !== 'received' || r.refund === 'refunded') fail(r.refund === 'refunded' ? 'This return has already been refunded' : 'Mark the item received first', 409);
  if (r.refund_to === 'original') {
    const [claimed] = await db(
      "UPDATE order_returns SET refund = 'processing', updated_at = NOW() WHERE id = $1 AND refund IS DISTINCT FROM 'refunded' AND refund IS DISTINCT FROM 'processing' RETURNING *",
      [r.id],
    );
    if (!claimed) fail('This refund is already being sent', 409);
    await recordRefund(db, r, await refundOnline(db, orderId, rz));
  } else {
    if (!admin) fail('Only the store admin can record a bank or UPI refund', 403);
    const reference = text(body.reference).toUpperCase();
    if (!UTR_RE.test(reference)) fail('Enter the UTR or reference number of the transfer');
    const [done] = await db(
      `UPDATE order_returns SET refund = 'refunded', refund_reference = $2, refunded_at = NOW(), ${WIPE_ACCOUNT}, updated_at = NOW()
        WHERE id = $1 AND status = 'received' AND refund = 'cod_manual' RETURNING *`,
      [r.id, reference],
    );
    if (!done) fail('This refund has already been recorded', 409);
    await event(db, orderId, 'refunded', `Refund of ${rupees(done.amount ?? r.total)} sent to ${destination(done)} (reference ${reference}).`);
  }
  const [latest] = await db('SELECT * FROM order_returns WHERE id = $1', [r.id]);
  return { body: returnJson(latest, { admin }) };
}
