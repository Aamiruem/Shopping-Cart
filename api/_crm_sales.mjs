// CRM dashboard, orders, refunds, invoices and reports, read straight from the store's own tables (orders, order_items,
// payments, order_returns, users, leads, support_tickets). Nothing is copied, so a CRM figure can never drift from the
// shop's, and nothing here creates an order or a payment.
//
// Definitions (also shown in the reports so anyone can check a number):
//   revenue           SUM(orders.total) of orders in status 'placed' (cancelled and returned orders excluded), by order date
//   completed order   'placed' and every line delivered
//   pending payment   cash-on-delivery order, 'placed', not yet fully delivered: cash still to collect
//   active customer   placed an order in the last 90 days
//   returning         2+ orders in total and one of them in the period
//   retention rate    of customers who ordered in the previous period of the same length, the share who ordered again
//   CLV               lifetime revenue / customers who ever paid (historic average, not a prediction)
import { getProduct } from './_catalog.mjs';
import { restockOrder } from './_inventory.mjs';
import { razorpayClient, refundPaidOrder } from './_payments.mjs';
import { actOnReturn, listReturns } from './_returns.mjs';
import { updateFulfilment } from './_seller.mjs';
import { leadFunnel, syncAutoLeads } from './_crm_leads.mjs';
import { SEGMENT_SQL, CUSTOMER_STATS, SEGMENTS } from './_crm_customers.mjs';
import { audit, can, dateRange, fail, getSettings, ID_RE, like, mask, need, num, pageOf, paging, pct, round1, text, where } from './_crm_core.mjs';

const STEPS = ['pending', 'packed', 'shipped', 'delivered'];
const change = (now, before) => (before > 0 ? round1(((now - before) / before) * 100) : now > 0 ? null : 0);

// ---------- Dashboard ----------
export async function dashboard({ db, staff, params }) {
  await syncAutoLeads(db).catch((err) => console.error('auto leads', err.message));
  const { from, to, days } = dateRange(params, Number(params.days) || 30);
  const prevFrom = new Date(Date.parse(from) - days * 86_400_000).toISOString().slice(0, 10);
  const R = [from, to, prevFrom];
  const inRange = `o.created_at >= $1::date AND o.created_at < $2::date + 1`;
  const inPrev = `o.created_at >= $3::date AND o.created_at < $1::date`;

  const [orders] = await db(
    `WITH lines AS (SELECT order_id, bool_and(fulfilment = 'delivered') AS delivered FROM order_items GROUP BY order_id)
     SELECT count(*) FILTER (WHERE ${inRange})::int AS orders,
            count(*) FILTER (WHERE ${inPrev})::int AS orders_prev,
            count(*) FILTER (WHERE ${inRange} AND o.status = 'placed' AND l.delivered)::int AS completed,
            count(*) FILTER (WHERE ${inRange} AND o.status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE ${inRange} AND o.status = 'returned')::int AS returned,
            COALESCE(SUM(o.total) FILTER (WHERE ${inRange} AND o.status = 'placed'), 0)::float AS revenue,
            COALESCE(SUM(o.total) FILTER (WHERE ${inPrev} AND o.status = 'placed'), 0)::float AS revenue_prev,
            count(*) FILTER (WHERE ${inRange} AND o.status = 'placed')::int AS paid_orders,
            COALESCE(SUM(o.total) FILTER (WHERE o.status = 'placed'), 0)::float AS revenue_all,
            COALESCE(SUM(o.total) FILTER (WHERE o.status = 'placed' AND o.created_at >= date_trunc('month', NOW())), 0)::float AS revenue_month,
            count(DISTINCT o.user_id) FILTER (WHERE o.status = 'placed')::int AS paying_customers,
            count(*) FILTER (WHERE o.status = 'placed' AND o.payment_method = 'cod' AND NOT l.delivered)::int AS cod_pending,
            COALESCE(SUM(o.total) FILTER (WHERE o.status = 'placed' AND o.payment_method = 'cod' AND NOT l.delivered), 0)::float AS cod_pending_amount
       FROM orders o JOIN lines l ON l.order_id = o.id`,
    R,
  );
  const [customers] = await db(
    `WITH c AS (
       SELECT u.id, u.created_at,
              count(o.id) FILTER (WHERE o.status <> 'cancelled') AS orders,
              bool_or(o.status <> 'cancelled' AND ${inRange}) AS bought_now,
              bool_or(o.status <> 'cancelled' AND ${inPrev}) AS bought_before,
              max(o.created_at) FILTER (WHERE o.status <> 'cancelled') AS last_order
         FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.role <> 'admin' GROUP BY u.id)
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE created_at >= $1::date AND created_at < $2::date + 1)::int AS new,
            count(*) FILTER (WHERE created_at >= $3::date AND created_at < $1::date)::int AS new_prev,
            count(*) FILTER (WHERE last_order > NOW() - INTERVAL '90 days')::int AS active,
            count(*) FILTER (WHERE orders >= 2 AND bought_now)::int AS returning,
            count(*) FILTER (WHERE bought_before)::int AS cohort,
            count(*) FILTER (WHERE bought_before AND bought_now)::int AS retained
       FROM c`,
    R,
  );
  const [leads] = await db(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE created_at >= $1::date AND created_at < $2::date + 1)::int AS new,
            count(*) FILTER (WHERE status = 'won')::int AS converted,
            count(*) FILTER (WHERE status = 'won' AND created_at >= $1::date AND created_at < $2::date + 1)::int AS converted_period,
            count(*) FILTER (WHERE status IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation'))::int AS pending,
            count(*) FILTER (WHERE follow_up_on <= CURRENT_DATE AND status IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation'))::int AS follow_ups_due
       FROM leads WHERE source <> 'newsletter'`,
    [from, to],
  );
  const [refunds] = await db(
    `SELECT count(*) FILTER (WHERE status = 'requested')::int AS requests,
            count(*) FILTER (WHERE status = 'approved')::int AS approved,
            count(*) FILTER (WHERE status = 'received' AND refund IS DISTINCT FROM 'refunded')::int AS to_refund,
            COALESCE(SUM(COALESCE(amount, 0)) FILTER (WHERE status = 'received' AND refund IS DISTINCT FROM 'refunded'), 0)::float AS to_refund_amount
       FROM order_returns`,
  );
  const [payments] = await db(
    `SELECT count(*) FILTER (WHERE status = 'refund_pending')::int AS refund_pending,
            count(*) FILTER (WHERE status = 'failed' AND created_at >= $1::date AND created_at < $2::date + 1)::int AS failed
       FROM payments`,
    [from, to],
  );
  const [tickets] = await db(
    `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress', 'waiting'))::int AS open,
            count(*) FILTER (WHERE status IN ('open', 'in_progress') AND priority = 'high')::int AS urgent
       FROM support_tickets`,
  );

  const trend = await db(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(o.total) FILTER (WHERE o.status = 'placed'), 0)::float AS revenue,
            count(o.id)::int AS orders,
            count(o.id) FILTER (WHERE o.status = 'cancelled')::int AS cancelled
       FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS d(day)
       LEFT JOIN orders o ON o.created_at >= d.day AND o.created_at < d.day + INTERVAL '1 day'
      GROUP BY d.day ORDER BY d.day`,
    [from, to],
  );
  const growth = await db(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM users u WHERE u.role <> 'admin' AND u.created_at >= d.day AND u.created_at < d.day + INTERVAL '1 day')::int AS new,
            (SELECT count(*) FROM users u WHERE u.role <> 'admin' AND u.created_at < d.day + INTERVAL '1 day')::int AS total
       FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS d(day) ORDER BY d.day`,
    [from, to],
  );
  const categories = await db(
    `SELECT COALESCE(oi.category, 'other') AS category, SUM(oi.price * oi.qty)::float AS revenue, SUM(oi.qty)::int AS units
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'placed' AND ${inRange.replace(/o\.created_at/g, 'o.created_at')}
      GROUP BY 1 ORDER BY revenue DESC LIMIT 8`,
    [from, to],
  );
  const recentOrders = await db(
    `SELECT o.id, o.order_number, o.created_at, o.status, o.total::float, o.payment_method, u.name AS customer, u.id AS customer_id,
            MIN(array_position(ARRAY['pending','packed','shipped','delivered'], oi.fulfilment::text)) AS step, count(oi.id)::int AS lines
       FROM orders o JOIN users u ON u.id = o.user_id JOIN order_items oi ON oi.order_id = o.id
      GROUP BY o.id, u.id ORDER BY o.created_at DESC LIMIT 8`,
  );
  const latestLeads = await db(
    `SELECT id, name, source, kind, intent, status, summary, created_at FROM leads WHERE source <> 'newsletter' ORDER BY created_at DESC LIMIT 6`,
  );
  const myTasks = await db(
    `SELECT id, title, priority, status, due_at, (due_at < NOW()) AS overdue FROM crm_tasks
      WHERE assigned_to = $1 AND status IN ('pending', 'in_progress') AND deleted_at IS NULL ORDER BY due_at NULLS LAST, id LIMIT 8`,
    [staff.id],
  );
  const { funnel, lost } = await leadFunnel(db);
  const avg = orders.paid_orders ? Math.round(orders.revenue / orders.paid_orders) : 0;
  const contact = can(staff, 'customers.contact');
  return {
    body: {
      range: { from, to, days, previousFrom: prevFrom },
      kpis: {
        customers: { total: customers.total, new: customers.new, newChange: change(customers.new, customers.new_prev), active: customers.active, returning: customers.returning },
        leads: { total: leads.total, new: leads.new, converted: leads.converted, pending: leads.pending, followUpsDue: leads.follow_ups_due },
        orders: { total: orders.orders, change: change(orders.orders, orders.orders_prev), completed: orders.completed, cancelled: orders.cancelled, returned: orders.returned },
        revenue: { period: orders.revenue, change: change(orders.revenue, orders.revenue_prev), month: orders.revenue_month, allTime: orders.revenue_all },
        averageOrder: avg,
        lifetimeValue: orders.paying_customers ? Math.round(orders.revenue_all / orders.paying_customers) : 0,
        conversionRate: pct(leads.converted_period, leads.new),
        retentionRate: pct(customers.retained, customers.cohort),
        pendingPayments: { codOrders: orders.cod_pending, codAmount: orders.cod_pending_amount, refundsPending: payments.refund_pending, failedPayments: payments.failed },
        refunds: { requests: refunds.requests, approved: refunds.approved, toRefund: refunds.to_refund, toRefundAmount: refunds.to_refund_amount },
        tickets,
      },
      trend, growth, categories,
      funnel, lostLeads: lost,
      recentOrders: recentOrders.map(({ step, ...o }) => ({ ...o, fulfilment: STEPS[(step || 1) - 1] })),
      latestLeads: latestLeads.map((l) => ({ ...l, name: l.name || (contact ? null : 'Lead') })),
      myTasks,
    },
  };
}

// ---------- Orders ----------
const ORDER_LIST = `
  SELECT o.id, o.order_number, o.created_at, o.status, o.total::float, o.payment_method, o.delivery_fee::float, o.coupon_code, o.coupon_discount::float,
         o.user_id, u.name AS customer, u.email,
         count(oi.id)::int AS lines, SUM(oi.qty)::int AS units,
         MIN(array_position(ARRAY['pending','packed','shipped','delivered'], oi.fulfilment::text)) AS step,
         (array_agg(oi.name ORDER BY oi.id))[1] AS first_item,
         (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status,
         (SELECT r.status FROM order_returns r WHERE r.order_id = o.id AND r.status <> 'withdrawn') AS return_status
    FROM orders o JOIN users u ON u.id = o.user_id JOIN order_items oi ON oi.order_id = o.id`;

export function paymentState(o) {
  if (o.payment_method === 'cod') return o.status === 'cancelled' ? 'not_due' : o.fulfilment === 'delivered' ? 'collected' : 'cod_pending';
  return o.payment_status || 'paid';
}

export async function listOrders({ db, staff, params }, { max = 100 } = {}) {
  const w = where();
  if (['placed', 'cancelled', 'returned'].includes(params.status)) w.add('o.status = ?', params.status);
  if (['cod', 'online'].includes(params.payment)) w.raw(params.payment === 'cod' ? "o.payment_method = 'cod'" : "o.payment_method <> 'cod'");
  if (/^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '')) w.add('o.created_at >= ?::date', params.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '')) w.add('o.created_at < ?::date + 1', params.to);
  if (ID_RE.test(params.customer ?? '')) w.add('o.user_id = ?', Number(params.customer));
  const q = text(params.q, 80).replace(/^#/, '');
  if (q) w.add(`(u.name ILIKE ? OR u.email ILIKE ? OR o.order_number ILIKE ? ${ID_RE.test(q) ? 'OR o.id = ?' : ''})`, like(q), like(q), like(q), ...(ID_RE.test(q) ? [Number(q)] : []));
  const having = STEPS.includes(params.fulfilment) ? `HAVING MIN(array_position(ARRAY['pending','packed','shipped','delivered'], oi.fulfilment::text)) = ${STEPS.indexOf(params.fulfilment) + 1}` : '';
  const p = paging(params, max);
  const [{ total }] = await db(`SELECT count(*)::int AS total FROM (${ORDER_LIST} ${w.sql()} GROUP BY o.id, u.id ${having}) x`, w.args);
  const sort = { amount: 'o.total DESC', oldest: 'o.created_at ASC' }[params.sort] || 'o.created_at DESC';
  const rows = await db(`${ORDER_LIST} ${w.sql()} GROUP BY o.id, u.id ${having} ORDER BY ${sort}, o.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.args);
  const contact = can(staff, 'customers.contact');
  const items = rows.map(({ step, ...o }) => {
    const fulfilment = STEPS[(step || 1) - 1];
    return { ...o, email: contact ? o.email : mask(o.email), fulfilment, payment: paymentState({ ...o, fulfilment }) };
  });
  return { body: pageOf(items, p, total) };
}

async function orderRow(db, id) {
  if (!ID_RE.test(String(id))) fail('Order not found', 404);
  const [o] = await db(`SELECT o.*, o.total::float AS total, u.name AS customer, u.email, u.phone, u.customer_code FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [Number(id)]);
  if (!o) fail('Order not found', 404);
  return o;
}

export async function getOrder({ db, staff, id }) {
  const o = await orderRow(db, id);
  const [items, events, pays, ret, notes] = await Promise.all([
    db('SELECT id, product_id, name, price::float, qty, image, category, seller_id, fulfilment, courier, tracking_number, fulfilled_at, options FROM order_items WHERE order_id = $1 ORDER BY id', [o.id]),
    db('SELECT status, note, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at, id', [o.id]),
    db('SELECT id, provider, provider_payment_id, method, amount::float, status, error, created_at, updated_at FROM payments WHERE order_id = $1 ORDER BY id', [o.id]),
    db("SELECT order_id, status, reason, reason_code, refund, refund_to, amount::float, note, created_at, resolved_at, refunded_at FROM order_returns WHERE order_id = $1", [o.id]),
    db(`SELECT n.id, n.kind, n.body, n.happened_at, u.name AS author FROM crm_notes n LEFT JOIN users u ON u.id = n.author_id
         WHERE n.entity = 'order' AND n.entity_id = $1 AND n.deleted_at IS NULL ORDER BY n.happened_at DESC`, [String(o.id)]),
  ]);
  const step = Math.min(...items.map((i) => STEPS.indexOf(i.fulfilment) + 1));
  const fulfilment = STEPS[(step || 1) - 1];
  const contact = can(staff, 'customers.contact');
  return {
    body: {
      ...o, email: contact ? o.email : mask(o.email), phone: contact ? o.phone : mask(o.phone), address: contact ? o.address : `${o.address.split(',')[0]}, ••••`,
      items, events, payments: pays, return: ret[0] ?? null, notes, fulfilment,
      payment: paymentState({ ...o, payment_status: pays.at(-1)?.status, fulfilment }),
      subtotal: items.reduce((s, i) => s + i.price * i.qty, 0),
      canCancel: o.status === 'placed' && !items.some((i) => ['shipped', 'delivered'].includes(i.fulfilment)) && can(staff, 'orders.edit'),
    },
  };
}

export async function setFulfilment({ db, staff, id, body }) {
  need(staff, 'orders.edit');
  const result = await updateFulfilment({ db, userId: staff.id, role: 'admin', id, body });
  await audit(db, staff, 'order.fulfilment', 'order', id, { fulfilment: body.fulfilment, courier: body.courier ?? null, trackingNumber: body.trackingNumber ?? null });
  return result;
}

/** The team cancels an order: same rules as the shopper's own cancel (not after shipping), stock back, online refund. */
export async function cancelOrder({ db, staff, id, body, rz = razorpayClient() }) {
  need(staff, 'orders.edit');
  const reason = text(body.reason, 300);
  if (reason.length < 3) fail('Please give the reason the customer will see');
  const [order] = ID_RE.test(String(id))
    ? await db(
        `WITH cancelled AS (
           UPDATE orders SET status = 'cancelled'
            WHERE id = $1 AND status = 'placed'
              AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = $1 AND fulfilment IN ('shipped', 'delivered'))
           RETURNING *
         ), timeline AS (
           INSERT INTO order_events (order_id, status, note) SELECT id, 'cancelled', 'Cancelled by the store: ' || $2 FROM cancelled
         ), coupon_back AS (
           DELETE FROM coupon_redemptions WHERE order_id IN (SELECT id FROM cancelled)
         )
         SELECT * FROM cancelled`,
        [Number(id), reason],
      )
    : [];
  if (!order) fail('This order can’t be cancelled: it has shipped, or was already cancelled or returned', 409);
  await restockOrder(db, order.id);
  const refund = await refundPaidOrder(db, order.id, rz);
  if (refund) {
    await db('INSERT INTO order_events (order_id, status, note) VALUES ($1, $2, $3)', [order.id, refund === 'refunded' ? 'refunded' : 'refund_initiated',
      `Refund of ₹${Number(order.total).toLocaleString('en-IN')} ${refund === 'refunded' ? 'sent' : 'is being sent'} to the original payment method.`]);
  }
  await audit(db, staff, 'order.cancel', 'order', order.id, { reason, refund: refund ?? 'none (cash on delivery)' });
  return { body: { id: order.id, status: 'cancelled', refund } };
}

export async function invoice({ db, id }) {
  const o = await orderRow(db, id);
  if (o.status === 'cancelled') fail('A cancelled order has no invoice', 409);
  const items = await db('SELECT name, product_id, price::float, qty, options FROM order_items WHERE order_id = $1 ORDER BY id', [o.id]);
  const settings = await getSettings(db);
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const year = new Date(o.created_at).getFullYear();
  return {
    body: {
      number: `${settings.company.invoicePrefix || 'ARV'}/${year}/${String(o.id).padStart(6, '0')}`,
      orderId: o.id, orderNumber: o.order_number, customerId: o.customer_code, date: o.created_at, status: o.status, paymentMethod: o.payment_method,
      seller: settings.company,
      buyer: { name: o.customer, email: o.email, phone: o.phone, address: o.address },
      items: items.map((i) => ({ ...i, amount: i.price * i.qty })),
      subtotal, deliveryFee: Number(o.delivery_fee), discount: Number(o.coupon_discount || 0), couponCode: o.coupon_code, total: o.total,
      // Prices on the store include GST; a tax breakdown needs each product's HSN code and rate, which the catalog doesn't hold
      taxNote: settings.company.gstin ? 'Prices include GST.' : 'Prices include applicable taxes.',
    },
  };
}

// ---------- Refunds (returns) ----------
export const refundsList = ({ db, staff, params }) => listReturns({ db, userId: staff.id, role: 'admin', params });
export async function refundAction({ db, staff, id, body, rz = razorpayClient() }) {
  const result = await actOnReturn({ db, userId: staff.id, role: 'admin', id, body, rz });
  await audit(db, staff, `refund.${body.action}`, 'order', id, { action: body.action, note: body.note ?? null, reference: body.reference ?? null });
  return result;
}

// ---------- Reports ----------
const range = (alias = 'o') => `${alias}.created_at >= $1::date AND ${alias}.created_at < $2::date + 1`;
export const REPORTS = {
  sales: 'Sales by day',
  revenue: 'Revenue by month',
  products: 'Product performance',
  customers: 'Customers',
  leads: 'Leads',
  conversion: 'Lead conversion by source',
  employees: 'Team performance',
  campaigns: 'Campaign performance',
  retention: 'Customer retention (monthly cohorts)',
  refunds: 'Refunds and cancellations',
};

export async function report({ db, staff, id, params }) {
  if (!Object.hasOwn(REPORTS, id)) fail('Unknown report', 404);
  const { from, to } = dateRange(params, 90);
  const args = [from, to];
  let columns;
  let rows;
  let definition;
  switch (id) {
    case 'sales':
      definition = 'Every day in the range. Orders = all orders placed that day; revenue = total of those still in "placed" status.';
      columns = ['day', 'orders', 'cancelled', 'returned', 'revenue', 'averageOrder'];
      rows = (await db(
        `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, count(o.id)::int AS orders,
                count(o.id) FILTER (WHERE o.status = 'cancelled')::int AS cancelled, count(o.id) FILTER (WHERE o.status = 'returned')::int AS returned,
                COALESCE(SUM(o.total) FILTER (WHERE o.status = 'placed'), 0)::float AS revenue,
                COALESCE(ROUND(AVG(o.total) FILTER (WHERE o.status = 'placed')), 0)::float AS "averageOrder"
           FROM generate_series($1::date, $2::date, INTERVAL '1 day') d(day)
           LEFT JOIN orders o ON o.created_at >= d.day AND o.created_at < d.day + INTERVAL '1 day'
          GROUP BY d.day ORDER BY d.day`, args));
      break;
    case 'revenue':
      definition = 'Calendar months. Revenue = total of orders in "placed" status; coupon discounts and delivery fees as charged.';
      columns = ['month', 'orders', 'revenue', 'deliveryFees', 'couponDiscounts', 'customers', 'averageOrder'];
      rows = await db(
        `SELECT to_char(date_trunc('month', o.created_at), 'YYYY-MM') AS month, count(*)::int AS orders,
                SUM(o.total)::float AS revenue, SUM(o.delivery_fee)::float AS "deliveryFees", SUM(o.coupon_discount)::float AS "couponDiscounts",
                count(DISTINCT o.user_id)::int AS customers, ROUND(AVG(o.total))::float AS "averageOrder"
           FROM orders o WHERE o.status = 'placed' AND ${range()} GROUP BY 1 ORDER BY 1`, args);
      break;
    case 'products': {
      definition = 'Units and revenue from order lines of "placed" orders; views from product pages (one per visitor per day); conversion = buyers / viewers.';
      columns = ['product', 'productId', 'category', 'units', 'revenue', 'orders', 'views', 'conversion', 'stock'];
      const sold = await db(
        `SELECT oi.product_id, MAX(oi.name) AS name, MAX(oi.category) AS category, SUM(oi.qty)::int AS units, SUM(oi.price * oi.qty)::float AS revenue,
                count(DISTINCT o.id)::int AS orders, count(DISTINCT o.user_id)::int AS buyers
           FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'placed' AND ${range()} GROUP BY 1 ORDER BY revenue DESC LIMIT 500`, args);
      const views = await db(`SELECT product_id, count(DISTINCT visitor)::int AS viewers FROM product_views WHERE day >= $1::date AND day <= $2::date GROUP BY 1`, args);
      const v = new Map(views.map((x) => [x.product_id, x.viewers]));
      rows = sold.map((s) => ({ product: s.name, productId: s.product_id, category: s.category, units: s.units, revenue: s.revenue, orders: s.orders,
        views: v.get(s.product_id) ?? 0, conversion: v.get(s.product_id) ? pct(s.buyers, v.get(s.product_id)) : null, stock: getProduct(s.product_id)?.stock ?? null }));
      break;
    }
    case 'customers':
      definition = 'Customers who joined in the range, with their lifetime orders and spend (placed orders only).';
      columns = ['id', 'name', 'email', 'joined', 'orders', 'spent', 'lastOrder', 'segment'];
      rows = (await db(`SELECT s.*, ${SEGMENT_SQL} AS segment FROM (${CUSTOMER_STATS}) s WHERE ${range('s')} ORDER BY s.created_at`, args))
        .map((c) => ({ id: c.id, name: c.name, email: can(staff, 'customers.contact') ? c.email : mask(c.email), joined: c.created_at, orders: c.orders, spent: c.spent, lastOrder: c.last_order, segment: SEGMENTS[c.segment] }));
      break;
    case 'leads':
      definition = 'Leads received in the range (newsletter sign-ups excluded), with stage and owner.';
      columns = ['id', 'received', 'name', 'source', 'kind', 'intent', 'status', 'budget', 'assignedTo', 'followUp'];
      rows = (await db(
        `SELECT l.id, l.created_at AS received, l.name, l.source, l.kind, l.intent, l.status, l.budget, a.name AS "assignedTo", to_char(l.follow_up_on, 'YYYY-MM-DD') AS "followUp"
           FROM leads l LEFT JOIN users a ON a.id = l.assigned_to WHERE l.source <> 'newsletter' AND ${range('l')} ORDER BY l.created_at`, args));
      break;
    case 'conversion': {
      definition = 'Leads received in the range by source. Converted = moved to "Converted" (an order was placed, or marked by the team).';
      columns = ['source', 'leads', 'converted', 'lost', 'open', 'conversionRate'];
      const { bySource } = await leadFunnel(db, { from, to });
      rows = bySource.map((s) => ({ source: s.source, leads: s.leads, converted: s.converted, lost: s.lost, open: s.leads - s.converted - s.lost, conversionRate: pct(s.converted, s.leads) }));
      break;
    }
    case 'employees':
      definition = 'Per team member, for work in the range: leads assigned and converted, tasks completed / overdue, tickets resolved, median first response (hours).';
      columns = ['name', 'role', 'leadsAssigned', 'leadsConverted', 'tasksCompleted', 'tasksOverdue', 'ticketsAssigned', 'ticketsResolved', 'medianFirstResponseHours'];
      rows = await db(
        `SELECT u.name, CASE WHEN u.role = 'admin' THEN 'super_admin' ELSE s.role_key END AS role,
                (SELECT count(*) FROM leads l WHERE l.assigned_to = u.id AND ${range('l')})::int AS "leadsAssigned",
                (SELECT count(*) FROM leads l WHERE l.assigned_to = u.id AND l.status = 'won' AND ${range('l')})::int AS "leadsConverted",
                (SELECT count(*) FROM crm_tasks t WHERE t.assigned_to = u.id AND t.completed_at >= $1::date AND t.completed_at < $2::date + 1 AND t.deleted_at IS NULL)::int AS "tasksCompleted",
                (SELECT count(*) FROM crm_tasks t WHERE t.assigned_to = u.id AND t.status IN ('pending', 'in_progress') AND t.due_at < NOW() AND t.deleted_at IS NULL)::int AS "tasksOverdue",
                (SELECT count(*) FROM support_tickets t WHERE t.assigned_to = u.id AND ${range('t')})::int AS "ticketsAssigned",
                (SELECT count(*) FROM support_tickets t WHERE t.assigned_to = u.id AND t.resolved_at >= $1::date AND t.resolved_at < $2::date + 1)::int AS "ticketsResolved",
                (SELECT ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM t.first_response_at - t.created_at) / 3600))::numeric, 1)
                   FROM support_tickets t WHERE t.assigned_to = u.id AND t.first_response_at IS NOT NULL AND ${range('t')})::float AS "medianFirstResponseHours"
           FROM users u LEFT JOIN crm_staff s ON s.user_id = u.id
          WHERE u.role = 'admin' OR s.user_id IS NOT NULL ORDER BY u.name`, args);
      break;
    case 'campaigns':
      definition = 'Campaigns created in the range. Accepted = taken by the provider; delivered / opened / clicked only as the provider reported them.';
      columns = ['campaign', 'channel', 'status', 'sentAt', 'recipients', 'accepted', 'delivered', 'opened', 'clicked', 'failed', 'couponOrders', 'couponRevenue'];
      rows = await db(
        `SELECT c.name AS campaign, c.channel, c.status, c.sent_at AS "sentAt", count(m.id)::int AS recipients,
                count(m.id) FILTER (WHERE m.status IN ('accepted', 'delivered', 'opened', 'clicked'))::int AS accepted,
                count(m.id) FILTER (WHERE m.status IN ('delivered', 'opened', 'clicked'))::int AS delivered,
                count(m.id) FILTER (WHERE m.status IN ('opened', 'clicked'))::int AS opened,
                count(m.id) FILTER (WHERE m.status = 'clicked')::int AS clicked,
                count(m.id) FILTER (WHERE m.status IN ('failed', 'bounced'))::int AS failed,
                (SELECT count(*) FROM orders o WHERE c.coupon_code IS NOT NULL AND o.coupon_code = c.coupon_code AND o.created_at >= c.sent_at AND o.status = 'placed')::int AS "couponOrders",
                (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE c.coupon_code IS NOT NULL AND o.coupon_code = c.coupon_code AND o.created_at >= c.sent_at AND o.status = 'placed')::float AS "couponRevenue"
           FROM crm_campaigns c LEFT JOIN crm_messages m ON m.campaign_id = c.id
          WHERE c.deleted_at IS NULL AND ${range('c')} GROUP BY c.id ORDER BY c.created_at`, args);
      break;
    case 'retention':
      definition = 'Customers grouped by the month of their first order; each column is the share of that group who ordered again N months later.';
      columns = ['cohort', 'customers', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'];
      rows = (await db(
        `WITH firsts AS (SELECT user_id, date_trunc('month', MIN(created_at)) AS cohort FROM orders WHERE status <> 'cancelled' GROUP BY user_id),
              activity AS (SELECT DISTINCT o.user_id, (EXTRACT(YEAR FROM age(date_trunc('month', o.created_at), f.cohort)) * 12 + EXTRACT(MONTH FROM age(date_trunc('month', o.created_at), f.cohort)))::int AS n
                             FROM orders o JOIN firsts f ON f.user_id = o.user_id WHERE o.status <> 'cancelled')
         SELECT to_char(f.cohort, 'YYYY-MM') AS cohort, count(DISTINCT f.user_id)::int AS customers,
                ${[1, 2, 3, 4, 5, 6].map((n) => `count(DISTINCT a.user_id) FILTER (WHERE a.n = ${n})::int AS m${n}`).join(', ')}
           FROM firsts f LEFT JOIN activity a ON a.user_id = f.user_id
          WHERE f.cohort >= date_trunc('month', $1::date) AND f.cohort <= $2::date GROUP BY f.cohort ORDER BY f.cohort`, args))
        .map((r) => ({ ...r, ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`m${n}`, pct(r[`m${n}`], r.customers)])) }));
      break;
    case 'refunds':
      definition = 'Cancellations (orders cancelled in the range, by order date) and returns requested in the range, with refund state.';
      columns = ['type', 'orderId', 'date', 'customer', 'amount', 'status', 'refund', 'reason'];
      rows = [
        ...(await db(`SELECT 'cancellation' AS type, o.id AS "orderId", o.created_at AS date, u.name AS customer, o.total::float AS amount, o.status,
                             (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS refund,
                             (SELECT e.note FROM order_events e WHERE e.order_id = o.id AND e.status = 'cancelled' LIMIT 1) AS reason
                        FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'cancelled' AND ${range()}`, args)),
        ...(await db(`SELECT 'return' AS type, r.order_id AS "orderId", r.created_at AS date, u.name AS customer, COALESCE(r.amount, o.total)::float AS amount,
                             r.status, r.refund, COALESCE(r.reason_code, '') || ': ' || r.reason AS reason
                        FROM order_returns r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = r.user_id WHERE ${range('r')}`, args)),
      ].sort((a, b) => new Date(a.date) - new Date(b.date));
      break;
    default:
      fail('Unknown report', 404);
  }
  if (params.export === '1') {
    need(staff, 'reports.export');
    await audit(db, staff, 'report.export', 'report', id, { from, to, rows: rows.length });
  }
  const totals = {};
  for (const c of columns) {
    if (['revenue', 'orders', 'units', 'leads', 'converted', 'recipients', 'accepted', 'failed', 'cancelled', 'returned', 'amount', 'couponRevenue'].includes(c)) {
      totals[c] = Math.round(rows.reduce((s, r) => s + num(r[c]), 0) * 100) / 100;
    }
  }
  return { body: { id, title: REPORTS[id], from, to, definition, columns, rows, totals } };
}
