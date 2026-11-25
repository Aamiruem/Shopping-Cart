// Seller Hub dashboard for the store API: GET /api/seller/overview.
// Every figure is read from the database at request time: revenue and orders from orders/order_items, stock from the
// live catalog (admin) or the seller's own listings, the lead pipeline from leads. Nothing is estimated or sampled, so
// an empty store shows zeros rather than made-up numbers. Sellers see only their own items; the admin sees the store.
import { loadProducts } from './_catalog.mjs';

export const LOW_STOCK = 10; // the same line the product list's "Low stock" filter uses
const DAYS = 30;
const LEAD_STAGES = ['new', 'contacted', 'qualified', 'won', 'lost'];
const FULFILMENT = ['pending', 'packed', 'shipped', 'delivered'];

const change = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : now > 0 ? null : 0);

/** Stock health of a list of { stock, active } products. */
export function stockSummary(products) {
  const live = products.filter((p) => p.active !== false);
  return {
    total: products.length,
    active: live.length,
    inStock: live.filter((p) => p.stock >= LOW_STOCK).length,
    low: live.filter((p) => p.stock > 0 && p.stock < LOW_STOCK).length,
    out: live.filter((p) => p.stock <= 0).length,
    alerts: live
      .filter((p) => p.stock < LOW_STOCK)
      .sort((a, b) => a.stock - b.stock)
      .slice(0, 6)
      .map((p) => ({ id: p._id || p.id, name: p.name, image: p.image || null, stock: p.stock, category: p.category })),
  };
}

async function sellerProducts(db, userId) {
  const rows = await db('SELECT id, data FROM seller_products WHERE seller_id = $1', [userId]);
  return rows.map((r) => ({ _id: r.id, ...r.data, stock: Number(r.data.stock) || 0 }));
}

export async function overview({ db, userId, role }) {
  const admin = role === 'admin';
  const own = admin ? 'TRUE' : 'oi.seller_id = $1';
  const args = admin ? [] : [userId];

  const [totals] = await db(
    `SELECT
       COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed' AND o.created_at > NOW() - INTERVAL '${DAYS} days'), 0)::float AS revenue,
       COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed' AND o.created_at <= NOW() - INTERVAL '${DAYS} days'
                                                AND o.created_at > NOW() - INTERVAL '${DAYS * 2} days'), 0)::float AS revenue_before,
       COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed'), 0)::float AS revenue_all,
       COUNT(DISTINCT o.id) FILTER (WHERE o.created_at > NOW() - INTERVAL '${DAYS} days')::int AS orders,
       COUNT(DISTINCT o.id) FILTER (WHERE o.created_at <= NOW() - INTERVAL '${DAYS} days' AND o.created_at > NOW() - INTERVAL '${DAYS * 2} days')::int AS orders_before,
       COUNT(DISTINCT o.id) FILTER (WHERE o.created_at >= date_trunc('day', NOW()))::int AS orders_today,
       COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'placed' AND o.created_at > NOW() - INTERVAL '${DAYS} days')::int AS placed,
       COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'cancelled' AND o.created_at > NOW() - INTERVAL '${DAYS} days')::int AS cancelled,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.status = 'placed')::int AS customers,
       COUNT(DISTINCT o.user_id) FILTER (WHERE o.status = 'placed' AND o.created_at > NOW() - INTERVAL '${DAYS} days')::int AS customers_recent
     FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${own}`,
    args,
  );

  // One point per day for the last 30 days, zero-filled so the chart has no gaps
  const daily = await db(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed'), 0)::float AS revenue,
            COUNT(DISTINCT o.id)::int AS orders
       FROM generate_series(date_trunc('day', NOW()) - INTERVAL '${DAYS - 1} days', date_trunc('day', NOW()), INTERVAL '1 day') AS d(day)
       LEFT JOIN orders o ON o.created_at >= d.day AND o.created_at < d.day + INTERVAL '1 day'
       LEFT JOIN order_items oi ON oi.order_id = o.id AND ${admin ? 'TRUE' : 'oi.seller_id = $1'}
      GROUP BY d.day ORDER BY d.day`,
    args,
  );

  const fulfilmentRows = await db(
    `SELECT oi.fulfilment AS stage, COUNT(DISTINCT o.id)::int AS orders
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${own} AND o.status = 'placed' GROUP BY 1`,
    args,
  );
  const [returns] = await db(
    `SELECT COUNT(*) FILTER (WHERE r.status = 'requested')::int AS requested,
            COUNT(*) FILTER (WHERE r.status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE r.refund IN ('refund_pending', 'cod_manual'))::int AS refunds_pending
       FROM order_returns r WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = r.order_id AND ${own})`,
    args,
  );

  const recent = await db(
    `SELECT o.id, o.created_at, o.status, o.payment_method, split_part(o.address, ',', 1) AS customer,
            SUM(oi.price * oi.qty)::float AS amount, SUM(oi.qty)::int AS items,
            MIN(array_position(ARRAY['pending','packed','shipped','delivered'], oi.fulfilment::text)) AS step,
            (array_agg(oi.image ORDER BY oi.id))[1] AS image, (array_agg(oi.name ORDER BY oi.id))[1] AS first_item
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${own} GROUP BY o.id ORDER BY o.created_at DESC LIMIT 6`,
    args,
  );

  const top = await db(
    `SELECT oi.product_id AS id, MAX(oi.name) AS name, MAX(oi.image) AS image, SUM(oi.qty)::int AS units, SUM(oi.price * oi.qty)::float AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${own} AND o.status = 'placed' AND o.created_at > NOW() - INTERVAL '${DAYS} days'
      GROUP BY oi.product_id ORDER BY revenue DESC LIMIT 5`,
    args,
  );

  const activity = await db(
    `SELECT e.order_id, e.status, e.note, e.created_at
       FROM order_events e
      WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = e.order_id AND ${own})
      ORDER BY e.created_at DESC, e.id DESC LIMIT 8`,
    args,
  );

  let leads = null;
  if (admin) {
    const rows = await db(
      `SELECT status, COUNT(*)::int AS count, COUNT(*) FILTER (WHERE intent = 'high')::int AS hot,
              COALESCE(SUM(budget), 0)::float AS budget
         FROM leads WHERE kind <> 'newsletter' GROUP BY status`,
    );
    const [{ subscribers, follow_ups: followUps }] = await db(
      `SELECT COUNT(*) FILTER (WHERE kind = 'newsletter' AND status <> 'unsubscribed')::int AS subscribers,
              COUNT(*) FILTER (WHERE follow_up_on IS NOT NULL AND follow_up_on <= CURRENT_DATE AND status NOT IN ('won', 'lost', 'unsubscribed'))::int AS follow_ups
         FROM leads`,
    );
    leads = {
      stages: LEAD_STAGES.map((stage) => {
        const r = rows.find((x) => x.status === stage);
        return { stage, count: r?.count || 0, hot: r?.hot || 0, budget: r?.budget || 0 };
      }),
      subscribers,
      followUpsDue: followUps,
    };
  }

  const placedRevenue = totals.revenue;
  return {
    scope: admin ? 'store' : 'seller',
    periodDays: DAYS,
    kpis: {
      revenue: placedRevenue,
      revenueChange: change(placedRevenue, totals.revenue_before),
      revenueAllTime: totals.revenue_all,
      orders: totals.orders,
      ordersChange: change(totals.orders, totals.orders_before),
      ordersToday: totals.orders_today,
      averageOrder: totals.placed ? Math.round(placedRevenue / totals.placed) : 0,
      cancelRate: totals.orders ? Math.round((totals.cancelled / totals.orders) * 1000) / 10 : 0,
      customers: totals.customers,
      customersRecent: totals.customers_recent,
    },
    daily,
    fulfilment: FULFILMENT.map((stage) => ({ stage, orders: fulfilmentRows.find((r) => r.stage === stage)?.orders || 0 })),
    returns,
    stock: stockSummary(admin ? loadProducts() : await sellerProducts(db, userId)),
    recent,
    top,
    activity,
    leads,
  };
}
