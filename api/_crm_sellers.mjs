// CRM → Sellers: applications, document review, approval, suspension, commission and settlements.
//
// Approval rules: the applicant verified their email or mobile number, gave a PAN, and the reviewer confirmed they
// checked the identity, PAN, bank proof and (if given) the GSTIN against the uploaded documents. Approving makes the
// account a seller (ARV-SEL-… number); suspending stops their Seller Hub at once and takes their products off sale.
//
// Settlements: for a period, the seller's delivered order lines from orders still 'placed' (cancelled and returned
// excluded) that aren't settled yet; commission = the seller's rate. The admin records the transfer's UTR when paid.
import { syncSellerProducts } from './_seller.mjs';
import { audit, can, DATE_RE, fail, ID_RE, like, mask, need, pageOf, paging, text, where } from './_crm_core.mjs';

const STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
const REVIEW_CHECKS = { identity: 'Identity matches the PAN card', pan: 'PAN is valid and matches the business', bank: 'Bank proof matches the payout account holder', gst: 'GSTIN checked on the GST portal (if given)' };

const SELLER_STATS = `
  SELECT s.user_id AS id, s.seller_code, s.store_name, s.status, s.business_type, s.gstin, s.pan, s.phone AS business_phone, s.business_address,
         s.documents, s.review_note, s.reviewed_at, s.commission_rate::float, s.created_at, s.logo,
         u.name, u.email, u.phone, u.email_verified, u.phone_verified, u.disabled_at, r.name AS reviewed_by_name,
         (SELECT count(*)::int FROM seller_products p WHERE p.seller_id = s.user_id) AS products,
         (SELECT count(DISTINCT oi.order_id)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.seller_id = s.user_id AND o.status <> 'cancelled') AS orders,
         (SELECT COALESCE(SUM(oi.price * oi.qty), 0)::float FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.seller_id = s.user_id AND o.status = 'placed') AS sales
    FROM sellers s JOIN users u ON u.id = s.user_id LEFT JOIN users r ON r.id = s.reviewed_by`;

const shape = (staff) => (s) => ({ ...s, email: can(staff, 'customers.contact') ? s.email : mask(s.email), phone: can(staff, 'customers.contact') ? s.phone : mask(s.phone), pan: s.pan && !can(staff, 'sellers.manage') ? mask(s.pan) : s.pan });

export async function listSellers({ db, staff, params }) {
  const w = where();
  if (STATUSES.includes(params.status)) w.add('x.status = ?', params.status);
  const q = text(params.q, 80);
  if (q) w.add('(x.store_name ILIKE ? OR x.name ILIKE ? OR x.email ILIKE ? OR x.seller_code ILIKE ? OR x.gstin ILIKE ?)', ...Array(5).fill(like(q)));
  const p = paging(params);
  const [{ total }] = await db(`SELECT count(*)::int AS total FROM (${SELLER_STATS}) x ${w.sql()}`, w.args);
  const rows = await db(`SELECT * FROM (${SELLER_STATS}) x ${w.sql()} ORDER BY CASE x.status WHEN 'pending' THEN 0 ELSE 1 END, x.created_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.args);
  const counts = await db('SELECT status, count(*)::int AS n FROM sellers GROUP BY status');
  return { body: { ...pageOf(rows.map(shape(staff)), p, total), counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c.status === s)?.n ?? 0])), checks: REVIEW_CHECKS } };
}

async function sellerRow(db, id) {
  if (!ID_RE.test(String(id))) fail('Seller not found', 404);
  const [s] = await db(`${SELLER_STATS} WHERE s.user_id = $1`, [Number(id)]);
  if (!s) fail('Seller not found', 404);
  return s;
}

export async function getSeller({ db, staff, id }) {
  const s = await sellerRow(db, id);
  const [products, orders, settlements, unsettled, history] = await Promise.all([
    db(`SELECT id, data->>'name' AS name, data->>'status' AS status, (data->>'price')::float AS price, (data->>'stock')::int AS stock, (data->>'active')::boolean AS active, updated_at
          FROM seller_products WHERE seller_id = $1 ORDER BY updated_at DESC LIMIT 100`, [s.id]),
    db(`SELECT o.id, o.order_number, o.created_at, o.status, SUM(oi.price * oi.qty)::float AS amount,
               MIN(array_position(ARRAY['pending','packed','shipped','delivered'], oi.fulfilment::text)) AS step
          FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.seller_id = $1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 50`, [s.id]),
    db('SELECT * FROM seller_settlements WHERE seller_id = $1 ORDER BY period_to DESC', [s.id]),
    db(`SELECT count(*)::int AS lines, COALESCE(SUM(oi.price * oi.qty), 0)::float AS gross FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE oi.seller_id = $1 AND oi.fulfilment = 'delivered' AND o.status = 'placed' AND oi.settlement_id IS NULL`, [s.id]),
    db(`SELECT action, actor_name, details, created_at FROM crm_audit_log WHERE entity = 'seller' AND entity_id = $1 ORDER BY created_at DESC LIMIT 50`, [String(s.id)]),
  ]);
  const STEPS = ['pending', 'packed', 'shipped', 'delivered'];
  const delivered = orders.filter((o) => STEPS[(o.step || 1) - 1] === 'delivered').length;
  return {
    body: {
      ...shape(staff)(s), products, settlements, history,
      orders: orders.map(({ step, ...o }) => ({ ...o, fulfilment: STEPS[(step || 1) - 1] })),
      unsettled: { ...unsettled[0], commission: Math.round(unsettled[0].gross * s.commission_rate) / 100 },
      performance: { orders: s.orders, delivered, fulfilmentRate: s.orders ? Math.round((delivered / s.orders) * 1000) / 10 : null, sales: s.sales },
      checks: REVIEW_CHECKS,
    },
  };
}

export async function reviewSeller({ db, staff, id, body }) {
  need(staff, 'sellers.manage');
  const s = await sellerRow(db, id);
  const action = body.action;
  const note = text(body.note, 1000);
  let status;
  if (action === 'approve') {
    if (!['pending', 'rejected'].includes(s.status)) fail(`This seller is ${s.status}`, 409);
    if (!s.email_verified && !s.phone_verified) fail('The applicant hasn’t verified their email or mobile number yet', 409);
    if (!s.pan) fail('The application has no PAN', 409);
    const missing = Object.keys(REVIEW_CHECKS).filter((k) => k !== 'gst' && body.checks?.[k] !== true);
    if (s.gstin && body.checks?.gst !== true) missing.push('gst');
    if (missing.length) fail(`Confirm every check before approving: ${missing.map((k) => REVIEW_CHECKS[k]).join('; ')}`);
    if (!(s.documents || []).length) fail('No documents were uploaded to check', 409);
    status = 'approved';
  } else if (action === 'reject') {
    if (s.status !== 'pending') fail(`This seller is ${s.status}`, 409);
    if (note.length < 5) fail('Please tell the applicant why');
    status = 'rejected';
  } else if (action === 'suspend') {
    if (s.status !== 'approved') fail('Only an approved seller can be suspended', 409);
    if (note.length < 5) fail('Please give the reason');
    status = 'suspended';
  } else if (action === 'reinstate') {
    if (s.status !== 'suspended') fail('This seller isn’t suspended', 409);
    status = 'approved';
  } else fail('Unknown action');
  await db(
    `WITH changed AS (
       UPDATE sellers SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW() WHERE user_id = $1 RETURNING user_id
     )
     UPDATE users SET role = CASE WHEN role = 'admin' THEN role WHEN $2 = 'approved' THEN 'seller' ELSE role END WHERE id IN (SELECT user_id FROM changed)`,
    [s.id, status, note || null, staff.id],
  );
  if (status === 'suspended') await db('UPDATE users SET sessions_revoked_at = NOW() WHERE id = $1', [s.id]); // out of the hub now
  await syncSellerProducts(db, Date.now() + 60_000); // their products join or leave the catalog at once
  await audit(db, staff, `seller.${action}`, 'seller', s.id, { note: note || undefined, checks: body.checks });
  try {
    const { notify } = await import('./_messaging.mjs');
    if (['approve', 'reject', 'suspend'].includes(action)) await notify(db, `seller_${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'suspended'}`, { userId: s.id, reply: note });
  } catch (err) {
    console.error('seller notification skipped', err.message);
  }
  return getSeller({ db, staff, id: s.id });
}

export async function setCommission({ db, staff, id, body }) {
  need(staff, 'sellers.manage');
  const s = await sellerRow(db, id);
  const rate = Number(body.commissionRate);
  if (!(rate >= 0 && rate <= 50)) fail('Commission must be between 0% and 50%');
  await db('UPDATE sellers SET commission_rate = $2, updated_at = NOW() WHERE user_id = $1', [s.id, Math.round(rate * 100) / 100]);
  await audit(db, staff, 'seller.commission', 'seller', s.id, { from: s.commission_rate, to: rate });
  return getSeller({ db, staff, id: s.id });
}

/** Creates a settlement for a period from the seller's unsettled, delivered lines (each line is settled once) */
export async function createSettlement({ db, staff, id, body }) {
  need(staff, 'settlements.manage');
  const s = await sellerRow(db, id);
  const from = DATE_RE.test(body.from ?? '') ? body.from : fail('Choose the start date');
  const to = DATE_RE.test(body.to ?? '') ? body.to : fail('Choose the end date');
  if (from > to) fail('The start date must be before the end date');
  const [row] = await db(
    `WITH lines AS (
       SELECT oi.id, oi.price * oi.qty AS amount FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.seller_id = $1 AND oi.fulfilment = 'delivered' AND o.status = 'placed' AND oi.settlement_id IS NULL
          AND oi.fulfilled_at >= $2::date AND oi.fulfilled_at < $3::date + 1
        FOR UPDATE OF oi
     ), made AS (
       INSERT INTO seller_settlements (seller_id, period_from, period_to, gross, commission, net, lines, created_by)
       SELECT $1, $2::date, $3::date, SUM(amount), ROUND(SUM(amount) * $4 / 100, 2), SUM(amount) - ROUND(SUM(amount) * $4 / 100, 2), count(*), $5
         FROM lines HAVING count(*) > 0
       RETURNING *
     ), marked AS (
       UPDATE order_items SET settlement_id = (SELECT id FROM made) WHERE id IN (SELECT id FROM lines) AND EXISTS (SELECT 1 FROM made)
     )
     SELECT * FROM made`,
    [s.id, from, to, s.commission_rate, staff.id],
  );
  if (!row) fail('No delivered, unsettled sales in this period', 409);
  await audit(db, staff, 'settlement.create', 'seller', s.id, { settlementId: row.id, net: row.net, from, to });
  return { status: 201, body: row };
}

export async function paySettlement({ db, staff, id, body }) {
  need(staff, 'settlements.manage');
  const reference = text(body.reference, 60).toUpperCase();
  if (!/^[A-Z0-9-]{6,40}$/.test(reference)) fail('Enter the UTR or reference number of the transfer');
  const [row] = ID_RE.test(String(id)) ? await db("UPDATE seller_settlements SET status = 'paid', reference = $2, paid_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *", [Number(id), reference]) : [];
  if (!row) fail('Settlement not found or already paid', 404);
  await audit(db, staff, 'settlement.paid', 'seller', row.seller_id, { settlementId: row.id, reference, net: row.net });
  return { body: row };
}
