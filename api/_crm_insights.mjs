// CRM insights. Every number comes from the store's own data, and every method says what it is:
//
//   RFM segmentation      recency / frequency / monetary quintiles (1–5) over customers with orders; named segments
//   churn risk            days since last order ÷ the customer's own typical gap between orders (store median for
//                         one-order customers). A ratio with its explanation, not a probability: no confidence is shown
//                         because nothing here is calibrated
//   sales forecast        Holt's linear exponential smoothing on weekly revenue, parameters chosen by a rolling
//                         one-step backtest; the backtest error (MAE, MAPE) is reported with the forecast, and the
//                         band is ±1.96 × the backtest error's standard deviation. No forecast with < 8 weeks of data
//   purchase behaviour    category mix, repeat rate, gap between orders, payment mix, products bought together
//   product insights      views vs purchases (high interest / low conversion), fast sellers running low on stock
//   sentiment             ticket mood from the support triage lexicon (api/_support.mjs) and review star ratings
//   enquiry classes       the lead classifier's kinds and intents (api/_leads.mjs keyword rules)
// The full Python ML service (ai-service/, scikit-learn models) is not deployed, so these run in the store API itself.
import { getProduct } from './_catalog.mjs';
import { SEGMENT_SQL, CUSTOMER_STATS } from './_crm_customers.mjs';
import { scoreLead } from './_crm_leads.mjs';
import { KIND_LABELS } from './_leads.mjs';
import { can, mask, pct, round1 } from './_crm_core.mjs';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = (xs) => {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
};

// ---------- Forecast ----------
function holt(series, alpha, beta) {
  let level = series[0];
  let trend = series.length > 1 ? series[1] - series[0] : 0;
  const fitted = [null];
  for (let t = 1; t < series.length; t++) {
    fitted.push(level + trend);
    const prev = level;
    level = alpha * series[t] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return { level, trend, fitted };
}

/** Weekly revenue → the next `horizon` weeks, with the backtest that justifies (or doesn't) trusting it */
export function forecastSeries(series, horizon = 4) {
  if (series.length < 8) return { ok: false, reason: `Needs at least 8 weeks of sales history; the store has ${series.length}.` };
  let best = null;
  const test = Math.max(4, Math.floor(series.length / 4));
  for (const alpha of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const beta of [0, 0.05, 0.1, 0.2, 0.3]) {
      const errors = [];
      for (let cut = series.length - test; cut < series.length; cut++) {
        const { level, trend } = holt(series.slice(0, cut), alpha, beta);
        errors.push(series[cut] - Math.max(0, level + trend));
      }
      const mae = errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length;
      if (!best || mae < best.mae) best = { alpha, beta, mae, errors };
    }
  }
  const { level, trend } = holt(series, best.alpha, best.beta);
  const spread = 1.96 * std(best.errors);
  const actual = series.slice(-test);
  const mapeTerms = actual.map((a, i) => (a > 0 ? Math.abs(best.errors[i]) / a : null)).filter((x) => x !== null);
  // A naive "same as last week" forecast, so the model has to beat something simple to be worth showing
  const naive = actual.map((a, i) => Math.abs(a - series[series.length - test + i - 1]));
  const naiveMae = naive.reduce((s, e) => s + e, 0) / naive.length;
  return {
    ok: true,
    method: "Holt's linear exponential smoothing on weekly revenue",
    parameters: { alpha: best.alpha, beta: best.beta },
    backtest: {
      weeks: test,
      mae: Math.round(best.mae),
      mape: mapeTerms.length ? round1((mapeTerms.reduce((a, b) => a + b, 0) / mapeTerms.length) * 100) : null,
      naiveMae: Math.round(naiveMae),
      beatsNaive: best.mae < naiveMae,
    },
    points: Array.from({ length: horizon }, (_, h) => {
      const value = Math.max(0, level + trend * (h + 1));
      const band = spread * Math.sqrt(h + 1);
      return { step: h + 1, value: Math.round(value), low: Math.round(Math.max(0, value - band)), high: Math.round(value + band) };
    }),
  };
}

export async function salesForecast(db) {
  const weeks = await db(
    `WITH bounds AS (SELECT date_trunc('week', MIN(created_at)) AS first FROM orders)
     SELECT to_char(w.week, 'YYYY-MM-DD') AS week, COALESCE(SUM(o.total) FILTER (WHERE o.status = 'placed'), 0)::float AS revenue, count(o.id)::int AS orders
       FROM bounds, generate_series(GREATEST(bounds.first, date_trunc('week', NOW()) - INTERVAL '52 weeks'), date_trunc('week', NOW()) - INTERVAL '1 week', INTERVAL '1 week') AS w(week)
       LEFT JOIN orders o ON o.created_at >= w.week AND o.created_at < w.week + INTERVAL '1 week'
      WHERE bounds.first IS NOT NULL
      GROUP BY w.week ORDER BY w.week`,
  );
  const f = forecastSeries(weeks.map((w) => w.revenue));
  const last = weeks.at(-1)?.week;
  if (f.ok) {
    f.points = f.points.map((p) => ({ ...p, week: new Date(Date.parse(`${last}T00:00:00Z`) + p.step * 7 * 86_400_000).toISOString().slice(0, 10) }));
  }
  return { history: weeks, forecast: f };
}

// ---------- RFM and churn ----------
const RFM_NAMES = [
  ['champions', 'Champions', (r, f) => r >= 4 && f >= 4, 'Bought recently, often, and spend the most. Reward them; ask for reviews.'],
  ['loyal', 'Loyal', (r, f) => r >= 3 && f >= 4, 'Order regularly. Good candidates for early access and bundles.'],
  ['potential', 'Potential loyalists', (r, f) => r >= 4 && f >= 2, 'Recent customers with a second order. A follow-up can make them regulars.'],
  ['new', 'New customers', (r, f) => r >= 4 && f === 1, 'First order very recently. A welcome and a useful tip go a long way.'],
  ['at_risk', 'At risk', (r, f) => r <= 2 && f >= 3, 'Used to order often but haven’t lately. Worth a personal win-back.'],
  ['hibernating', 'Hibernating', (r, f) => r <= 2 && f <= 2 && r >= 2, 'Ordered a little, a while ago.'],
  ['lost', 'Lost', (r) => r === 1, 'Longest since their last order.'],
  ['needs_attention', 'Needs attention', () => true, 'Middling on every measure.'],
];

export async function customerInsights(db, staff) {
  const customers = await db(
    `SELECT u.id, u.name, u.email,
            array_agg(o.created_at ORDER BY o.created_at) AS dates,
            SUM(o.total) FILTER (WHERE o.status = 'placed')::float AS spent,
            EXTRACT(EPOCH FROM NOW() - MAX(o.created_at)) / 86400 AS days_since
       FROM users u JOIN orders o ON o.user_id = u.id AND o.status <> 'cancelled'
      WHERE u.role <> 'admin' GROUP BY u.id`,
  );
  if (!customers.length) return { rfm: { segments: [], customers: [] }, churn: { customers: [], storeMedianGapDays: null }, note: 'No orders yet.' };
  // Quintiles: 5 is best. Ties share a score.
  const quintile = (values, higherIsBetter) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (v) => {
      const rank = sorted.findIndex((x) => x >= v) / Math.max(sorted.length - 1, 1);
      const q = Math.min(5, Math.floor(rank * 5) + 1);
      return higherIsBetter ? q : 6 - q;
    };
  };
  const freq = customers.map((c) => c.dates.length);
  const qR = quintile(customers.map((c) => c.days_since), false);
  const qF = quintile(freq, true);
  const qM = quintile(customers.map((c) => c.spent || 0), true);
  const gaps = customers.flatMap((c) => c.dates.slice(1).map((d, i) => (new Date(d) - new Date(c.dates[i])) / 86_400_000));
  const storeGap = median(gaps);
  const contact = can(staff, 'customers.contact');
  const scored = customers.map((c) => {
    const r = qR(c.days_since);
    const f = Math.min(5, qF(c.dates.length));
    const m = qM(c.spent || 0);
    const [key, label, , advice] = RFM_NAMES.find(([, , test]) => test(r, f, m));
    const own = c.dates.slice(1).map((d, i) => (new Date(d) - new Date(c.dates[i])) / 86_400_000);
    const typical = own.length ? median(own) : storeGap;
    const ratio = typical ? c.days_since / Math.max(typical, 7) : null;
    const risk = ratio === null ? 'unknown' : ratio >= 2 ? 'high' : ratio >= 1 ? 'medium' : 'low';
    return {
      id: c.id, name: c.name, email: contact ? c.email : mask(c.email),
      orders: c.dates.length, spent: c.spent || 0, daysSinceLastOrder: Math.round(c.days_since),
      rfm: { r, f, m, code: `${r}${f}${m}`, segment: key, label, advice },
      churn: {
        risk, ratio: ratio === null ? null : round1(ratio),
        explanation: typical === null
          ? 'Not enough repeat orders in the store yet to judge.'
          : `${Math.round(c.days_since)} days since the last order; ${own.length ? 'this customer usually orders every' : 'customers usually reorder after'} ${Math.round(typical)} days.`,
      },
    };
  });
  const segments = RFM_NAMES.map(([key, label, , advice]) => {
    const group = scored.filter((c) => c.rfm.segment === key);
    return { key, label, advice, customers: group.length, revenue: Math.round(group.reduce((s, c) => s + c.spent, 0)) };
  }).filter((s) => s.customers);
  return {
    rfm: { method: 'Recency / frequency / monetary quintiles (5 = best) over customers with at least one order', segments, customers: scored.sort((a, b) => b.spent - a.spent).slice(0, 200) },
    churn: {
      method: 'Days since last order ÷ typical days between orders (own history, or the store median). High ≥ 2×, medium ≥ 1×. A rule of thumb, not a probability.',
      storeMedianGapDays: storeGap === null ? null : Math.round(storeGap),
      customers: scored.filter((c) => ['high', 'medium'].includes(c.churn.risk)).sort((a, b) => b.churn.ratio - a.churn.ratio || b.spent - a.spent).slice(0, 50),
      counts: { high: scored.filter((c) => c.churn.risk === 'high').length, medium: scored.filter((c) => c.churn.risk === 'medium').length, low: scored.filter((c) => c.churn.risk === 'low').length },
    },
  };
}

// ---------- Behaviour, products, sentiment, enquiries ----------
export async function behaviour(db) {
  const categories = await db(
    `SELECT COALESCE(oi.category, 'other') AS category, SUM(oi.price * oi.qty)::float AS revenue, count(DISTINCT o.user_id)::int AS buyers
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'placed' AND o.created_at > NOW() - INTERVAL '180 days' GROUP BY 1 ORDER BY revenue DESC`,
  );
  const [repeat] = await db(
    `WITH c AS (SELECT user_id, count(*) AS n FROM orders WHERE status <> 'cancelled' GROUP BY user_id)
     SELECT count(*)::int AS buyers, count(*) FILTER (WHERE n >= 2)::int AS repeaters FROM c`,
  );
  const payments = await db(`SELECT CASE WHEN payment_method = 'cod' THEN 'Cash on delivery' ELSE 'Online (' || payment_method || ')' END AS method, count(*)::int AS orders FROM orders WHERE status <> 'cancelled' GROUP BY 1 ORDER BY orders DESC`);
  const hours = await db(`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, count(*)::int AS orders FROM orders GROUP BY 1 ORDER BY 1`);
  const pairs = await db(
    `SELECT a.product_id AS a, b.product_id AS b, count(DISTINCT a.order_id)::int AS together
       FROM order_items a JOIN order_items b ON a.order_id = b.order_id AND a.product_id < b.product_id
       JOIN orders o ON o.id = a.order_id WHERE o.status <> 'cancelled'
      GROUP BY 1, 2 HAVING count(DISTINCT a.order_id) >= 2 ORDER BY together DESC LIMIT 10`,
  );
  const total = categories.reduce((s, c) => s + c.revenue, 0);
  return {
    categories: categories.map((c) => ({ ...c, share: pct(c.revenue, total) })),
    repeatRate: pct(repeat.repeaters, repeat.buyers), buyers: repeat.buyers,
    payments, hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: hours.find((x) => x.hour === h)?.orders ?? 0 })),
    boughtTogether: pairs.map((p) => ({ a: getProduct(p.a)?.name ?? p.a, b: getProduct(p.b)?.name ?? p.b, orders: p.together })),
  };
}

export async function productInsights(db) {
  const rows = await db(
    `WITH v AS (SELECT product_id, count(DISTINCT visitor)::int AS viewers FROM product_views WHERE day > CURRENT_DATE - 30 GROUP BY 1),
          s AS (SELECT oi.product_id, SUM(oi.qty)::int AS units, count(DISTINCT o.user_id)::int AS buyers
                  FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status <> 'cancelled' AND o.created_at > NOW() - INTERVAL '30 days' GROUP BY 1)
     SELECT COALESCE(v.product_id, s.product_id) AS id, COALESCE(v.viewers, 0) AS viewers, COALESCE(s.units, 0) AS units, COALESCE(s.buyers, 0) AS buyers
       FROM v FULL JOIN s ON s.product_id = v.product_id`,
  );
  const withProduct = rows.map((r) => ({ ...r, product: getProduct(r.id) })).filter((r) => r.product);
  const brief = (r) => ({ id: r.id, name: r.product.name, price: r.product.price, stock: r.product.stock, viewers: r.viewers, units: r.units, conversion: pct(r.buyers, r.viewers) });
  return {
    window: 'Last 30 days',
    lowConversion: withProduct.filter((r) => r.viewers >= 10 && r.buyers / r.viewers < 0.02).sort((a, b) => b.viewers - a.viewers).slice(0, 10).map((r) => ({ ...brief(r), why: `${r.viewers} people viewed it, ${r.buyers} bought. Check price, photos and description.` })),
    restock: withProduct.filter((r) => r.units > 0 && r.product.stock < Math.max(10, r.units)).sort((a, b) => a.product.stock / a.units - b.product.stock / b.units).slice(0, 10).map((r) => ({ ...brief(r), why: `Sold ${r.units} in 30 days with ${r.product.stock} left: about ${Math.max(0, Math.round((r.product.stock / r.units) * 30))} days of stock.` })),
    topConverting: withProduct.filter((r) => r.viewers >= 5 && r.buyers > 0).sort((a, b) => b.buyers / b.viewers - a.buyers / a.viewers).slice(0, 10).map(brief),
  };
}

export async function sentiment(db) {
  const [tickets] = await db(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE sentiment < -0.2)::int AS negative, count(*) FILTER (WHERE sentiment > 0.2)::int AS positive,
            ROUND(AVG(sentiment)::numeric, 2)::float AS average FROM support_tickets WHERE created_at > NOW() - INTERVAL '90 days'`,
  );
  const angriest = await db(`SELECT id, subject, sentiment::float, status, priority, created_at FROM support_tickets WHERE sentiment < -0.2 AND status IN ('open', 'in_progress', 'waiting') ORDER BY sentiment, created_at DESC LIMIT 8`);
  const reviews = await db('SELECT rating, count(*)::int AS n FROM product_reviews GROUP BY rating ORDER BY rating');
  const byCategory = await db(`SELECT category, count(*)::int AS tickets, ROUND(AVG(sentiment)::numeric, 2)::float AS mood FROM support_tickets WHERE created_at > NOW() - INTERVAL '90 days' GROUP BY 1 ORDER BY mood`);
  return {
    method: 'Ticket mood from the support triage word lists (−1 angry … +1 happy); reviews by star rating. Lexicon-based, not a trained model.',
    tickets, angriest, byCategory,
    reviews: [1, 2, 3, 4, 5].map((r) => ({ rating: r, reviews: reviews.find((x) => x.rating === r)?.n ?? 0 })),
  };
}

export async function enquiryInsights(db) {
  const kinds = await db(`SELECT kind, intent, count(*)::int AS n FROM leads WHERE source <> 'newsletter' AND created_at > NOW() - INTERVAL '90 days' GROUP BY 1, 2`);
  const open = await db(
    `SELECT l.*, EXISTS (SELECT 1 FROM orders o WHERE o.user_id = l.user_id AND l.user_id IS NOT NULL AND o.created_at < l.created_at) AS is_customer,
            (SELECT count(*)::int FROM crm_notes n WHERE n.entity = 'lead' AND n.entity_id = l.id::text AND n.deleted_at IS NULL) AS activities
       FROM leads l WHERE l.status IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation') AND l.source <> 'newsletter'`,
  );
  const scored = open.map((l) => ({ id: l.id, name: l.name, source: l.source, status: l.status, summary: l.summary, ...scoreLead(l) })).sort((a, b) => b.score - a.score);
  return {
    method: 'Kinds and intents from the lead classifier (keyword rules); scores from transparent points (reasons listed).',
    kinds: Object.entries(KIND_LABELS).map(([kind, label]) => ({
      kind, label, high: kinds.find((k) => k.kind === kind && k.intent === 'high')?.n ?? 0,
      medium: kinds.find((k) => k.kind === kind && k.intent === 'medium')?.n ?? 0, low: kinds.find((k) => k.kind === kind && k.intent === 'low')?.n ?? 0,
    })).filter((k) => k.high + k.medium + k.low),
    topLeads: scored.slice(0, 15),
    bands: { hot: scored.filter((l) => l.band === 'hot').length, warm: scored.filter((l) => l.band === 'warm').length, cold: scored.filter((l) => l.band === 'cold').length },
  };
}

export async function insights({ db, staff, params }) {
  const section = params.section || 'overview';
  const map = {
    customers: () => customerInsights(db, staff),
    forecast: () => salesForecast(db),
    behaviour: () => behaviour(db),
    products: () => productInsights(db),
    sentiment: () => sentiment(db),
    enquiries: () => enquiryInsights(db),
  };
  if (section === 'overview') {
    const [c, f, b, p, s, e] = await Promise.all(Object.values(map).map((fn) => fn()));
    return { body: { customers: c, forecast: f, behaviour: b, products: p, sentiment: s, enquiries: e } };
  }
  if (!Object.hasOwn(map, section)) return { status: 404, body: { error: 'Unknown section' } };
  return { body: await map[section]() };
}

export { SEGMENT_SQL, CUSTOMER_STATS };
