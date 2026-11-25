import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api/client';
import { ChartTooltip, DataTable, fmt } from '../../components/charts/ChartParts';
import Icon from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';
import useApi from '../../hooks/useApi';
import { responsiveImage } from '../../utils/image';
import '../../styles/dashboard.css';

// Seller Hub dashboard on the store API (GET /api/seller/overview, api/_overview.mjs). Every number is read from the
// database when the page opens: an empty store shows zeros and empty states, never sample figures.

const STAGES = ['pending', 'packed', 'shipped', 'delivered'];
const STAGE_LABEL = { pending: 'To pack', packed: 'Packed', shipped: 'Shipped', delivered: 'Delivered' };
const LEAD_LABEL = { new: 'New leads', contacted: 'Contacted', qualified: 'Qualified', won: 'Won', lost: 'Lost' };
const EVENT_ICON = { placed: 'package', packed: 'package', shipped: 'truck', delivered: 'checkCircle', cancelled: 'x', return_requested: 'returns', return_approved: 'returns', refunded: 'wallet' };

// Chart colours come from the hub's CSS variables, so the chart follows the dark / light switch
function useThemeColors() {
  const read = () => {
    const css = getComputedStyle(document.body);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return { line: v('--brand', '#2563eb'), muted: v('--text-muted', '#6b7280'), grid: v('--border-light', '#e5e7eb'), surface: v('--surface', '#fff') };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

function Change({ value, suffix = '%' }) {
  if (value === null) return <span className="sd-change">New</span>;
  if (!value) return <span className="sd-change">No change</span>;
  const up = value > 0;
  return (
    <span className="sd-change" title="Compared with the 30 days before">
      {up ? '▲' : '▼'} {Math.abs(value)}{suffix}
    </span>
  );
}

function Kpi({ tone, icon, label, value, change, hint }) {
  return (
    <div className={`sd-kpi sd-kpi-${tone}`}>
      <div className="sd-kpi-top">
        <span className="sd-kpi-icon"><Icon name={icon} size={18} /></span>
        {change !== undefined && <Change value={change} />}
      </div>
      <strong>{value}</strong>
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function Card({ title, subtitle, action, children, className = '' }) {
  return (
    <section className={`sd-card ${className}`}>
      <header>
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function RevenueChart({ daily }) {
  const colors = useThemeColors();
  const [table, setTable] = useState(false);
  const total = daily.reduce((s, d) => s + d.revenue, 0);
  const toggle = (
    <button type="button" className="sd-link" onClick={() => setTable((t) => !t)} aria-pressed={table}>
      {table ? 'Chart' : 'Table'}
    </button>
  );
  return (
    <Card title="Revenue" subtitle={`${fmt.inr(total)} from placed orders in the last 30 days`} action={toggle} className="sd-span-2">
      {table ? (
        <DataTable
          columns={[{ key: 'day', label: 'Day', format: fmt.shortDate }, { key: 'orders', label: 'Orders', numeric: true }, { key: 'revenue', label: 'Revenue', numeric: true, format: fmt.inr }]}
          rows={[...daily].reverse()}
        />
      ) : (
        <div className="sd-chart" role="img" aria-label={`Daily revenue for the last 30 days, ${fmt.inr(total)} in total`}>
          {total === 0 && <p className="sd-chart-empty">No sales in the last 30 days yet. New orders appear here as they come in.</p>}
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="sd-revenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colors.line} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={colors.line} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={colors.grid} vertical={false} />
              <XAxis dataKey="day" tickFormatter={fmt.shortDate} tick={{ fill: colors.muted, fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28} />
              <YAxis tickFormatter={fmt.inrCompact} tick={{ fill: colors.muted, fontSize: 11 }} tickLine={false} axisLine={false} width={56} allowDecimals={false} />
              <Tooltip
                cursor={{ stroke: colors.muted, strokeDasharray: '3 3' }}
                content={<ChartTooltip labelFormat={(d) => new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} valueFormat={fmt.inr} />}
              />
              <Area type="monotone" dataKey="revenue" name="Revenue" stroke={colors.line} strokeWidth={2} fill="url(#sd-revenue)"
                activeDot={{ r: 5, stroke: colors.surface, strokeWidth: 2 }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function Pipeline({ fulfilment, returns }) {
  const total = fulfilment.reduce((s, f) => s + f.orders, 0);
  return (
    <Card title="Fulfilment" subtitle="Open and completed orders by step" action={<Link className="sd-link" to="/seller/orders">Orders <Icon name="arrowRight" size={12} /></Link>}>
      <ol className="sd-pipeline">
        {fulfilment.map((f, i) => (
          <li key={f.stage} className={`sd-stage-${i}`}>
            <span>{STAGE_LABEL[f.stage]}</span>
            <strong>{fmt.num(f.orders)}</strong>
            <span className="sd-bar" aria-hidden="true"><i style={{ width: `${total ? (f.orders / total) * 100 : 0}%` }} /></span>
          </li>
        ))}
      </ol>
      <div className="sd-returns">
        <span><Icon name="returns" size={14} /> {returns.requested} return{returns.requested === 1 ? '' : 's'} to review</span>
        <span><Icon name="wallet" size={14} /> {returns.refunds_pending} refund{returns.refunds_pending === 1 ? '' : 's'} pending</span>
      </div>
    </Card>
  );
}

function StockHealth({ stock, admin }) {
  const manage = admin ? '/seller/catalog' : '/seller/products';
  const tiles = [
    { key: 'total', label: 'Total products', value: stock.total, icon: 'package', tone: 'teal' },
    { key: 'inStock', label: 'In stock', value: stock.inStock, icon: 'checkCircle', tone: 'green' },
    { key: 'low', label: `Low stock (under 10)`, value: stock.low, icon: 'activity', tone: 'amber' },
    { key: 'out', label: 'Out of stock', value: stock.out, icon: 'x', tone: 'rose' },
  ];
  return (
    <Card title="Stock" subtitle={admin ? 'The whole store catalog, after sales and edits' : 'Your listings'} action={<Link className="sd-link" to={manage}>Manage stock <Icon name="arrowRight" size={12} /></Link>} className="sd-span-3">
      <div className="sd-stock">
        {tiles.map((t) => (
          <div key={t.key} className={`sd-stock-tile sd-tint-${t.tone}`}>
            <span className="sd-stock-icon"><Icon name={t.icon} size={20} /></span>
            <div><span>{t.label}</span><strong>{fmt.num(t.value)}</strong></div>
          </div>
        ))}
      </div>
      {stock.alerts.length > 0 ? (
        <div className="sd-table-wrap">
          <table className="sd-table">
            <thead><tr><th>Product</th><th>Category</th><th className="num">Stock</th><th>Status</th><th aria-label="Action" /></tr></thead>
            <tbody>
              {stock.alerts.map((p) => (
                <tr key={p.id}>
                  <td><span className="sd-product">{p.image ? <img {...responsiveImage(p.image, '40px')} alt="" loading="lazy" /> : <span className="sd-thumb" />}{p.name}</span></td>
                  <td className="sd-cap">{p.category}</td>
                  <td className="num">{p.stock} pcs</td>
                  <td>{p.stock <= 0 ? <span className="sd-pill sd-pill-critical">Out of stock</span> : <span className="sd-pill sd-pill-warning">Low stock</span>}</td>
                  <td className="num"><Link className="sd-btn" to={manage}>Restock</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="sd-empty"><Icon name="checkCircle" size={16} /> Everything is well stocked.</p>
      )}
    </Card>
  );
}

function orderStatus(o) {
  if (o.status !== 'placed') return { label: o.status === 'cancelled' ? 'Cancelled' : o.status, tone: 'critical' };
  const stage = STAGES[(o.step || 1) - 1];
  return { label: STAGE_LABEL[stage], tone: stage === 'delivered' ? 'good' : stage === 'pending' ? 'warning' : 'info' };
}

function RecentOrders({ orders }) {
  return (
    <Card title="Recent orders" action={<Link className="sd-link" to="/seller/orders">View all <Icon name="arrowRight" size={12} /></Link>} className="sd-span-2">
      {orders.length ? (
        <div className="sd-table-wrap">
          <table className="sd-table">
            <thead><tr><th>Order</th><th>Product</th><th>Customer</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {orders.map((o) => {
                const s = orderStatus(o);
                return (
                  <tr key={o.id}>
                    <td className="sd-mono">#{o.id}</td>
                    <td>
                      <span className="sd-product">
                        {o.image ? <img {...responsiveImage(o.image, '40px')} alt="" loading="lazy" /> : <span className="sd-thumb" />}
                        <span>{o.first_item}{o.items > 1 && <small> +{o.items - 1} more</small>}</span>
                      </span>
                    </td>
                    <td>{o.customer}</td>
                    <td className="sd-nowrap">{fmt.shortDate(o.created_at)}</td>
                    <td className="num">{fmt.inr(o.amount)}<small className="sd-sub">{o.payment_method === 'cod' ? 'Cash on delivery' : 'Paid online'}</small></td>
                    <td><span className={`sd-pill sd-pill-${s.tone}`}>{s.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="sd-empty"><Icon name="package" size={16} /> No orders yet. They show up here the moment a customer checks out.</p>
      )}
    </Card>
  );
}

function Activity({ events }) {
  return (
    <Card title="Recent activity">
      {events.length ? (
        <ul className="sd-activity">
          {events.map((e, i) => (
            <li key={`${e.order_id}-${i}`}>
              <span className="sd-activity-icon"><Icon name={EVENT_ICON[e.status] || 'activity'} size={15} /></span>
              <div>
                <p>{e.note || e.status} <span className="sd-muted">· order #{e.order_id}</span></p>
                <time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</time>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sd-empty"><Icon name="activity" size={16} /> Order updates will appear here.</p>
      )}
    </Card>
  );
}

function TopProducts({ top }) {
  const best = top[0]?.revenue || 0;
  return (
    <Card title="Top products" subtitle="By revenue, last 30 days">
      {top.length ? (
        <ol className="sd-top">
          {top.map((p) => (
            <li key={p.id}>
              {p.image ? <img {...responsiveImage(p.image, '40px')} alt="" loading="lazy" /> : <span className="sd-thumb" />}
              <div>
                <span className="sd-top-name">{p.name}</span>
                <span className="sd-bar" aria-hidden="true"><i style={{ width: `${best ? (p.revenue / best) * 100 : 0}%` }} /></span>
              </div>
              <span className="num"><strong>{fmt.inr(p.revenue)}</strong><small className="sd-sub">{p.units} sold</small></span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="sd-empty"><Icon name="barChart" size={16} /> Best sellers appear after the first sales.</p>
      )}
    </Card>
  );
}

function Leads({ leads }) {
  const open = leads.stages.filter((s) => ['new', 'contacted', 'qualified'].includes(s.stage)).reduce((n, s) => n + s.count, 0);
  return (
    <Card
      title="Leads pipeline"
      subtitle={`${open} open enquir${open === 1 ? 'y' : 'ies'} · ${leads.subscribers} newsletter subscriber${leads.subscribers === 1 ? '' : 's'}${leads.followUpsDue ? ` · ${leads.followUpsDue} follow-up${leads.followUpsDue === 1 ? '' : 's'} due` : ''}`}
      action={<Link className="sd-link" to="/seller/leads">Open CRM <Icon name="arrowRight" size={12} /></Link>}
      className="sd-span-3"
    >
      <div className="sd-leads">
        {leads.stages.map((s, i) => (
          <Link key={s.stage} to="/seller/leads" className={`sd-lead sd-lead-${i}`}>
            <span className="sd-lead-head">{LEAD_LABEL[s.stage]}</span>
            <div>
              <strong>{fmt.num(s.count)}</strong>
              <span>{s.hot ? `${s.hot} hot` : 'enquiries'}</span>
            </div>
            {s.budget > 0 && <small>{fmt.inrCompact(s.budget)} stated budget</small>}
          </Link>
        ))}
      </div>
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="sd" aria-busy="true" aria-label="Loading dashboard">
      <div className="sd-kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="sd-kpi sd-skeleton" />)}</div>
      <div className="sd-grid"><div className="sd-card sd-span-2 sd-skeleton sd-skeleton-tall" /><div className="sd-card sd-skeleton sd-skeleton-tall" /></div>
    </div>
  );
}

export default function StoreDashboard() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi(() => api.sellerOverview(), []);
  if (loading && !data) return <Skeleton />;
  if (error) {
    return (
      <div className="sd-card sd-error" role="alert">
        <p>{error}</p>
        <button type="button" className="sd-btn" onClick={reload}>Try again</button>
      </div>
    );
  }
  const { kpis } = data;
  const admin = data.scope === 'store';
  return (
    <div className="sd">
      <header className="sd-head">
        <div>
          <h1>Dashboard</h1>
          <p>{admin ? 'Whole store' : user.storeName || 'Your store'} · last 30 days · live from your orders</p>
        </div>
        <div className="sd-head-actions">
          <button type="button" className="sd-btn sd-btn-ghost" onClick={reload} disabled={loading}><Icon name="rotate" size={14} /> {loading ? 'Refreshing…' : 'Refresh'}</button>
          <Link className="sd-btn" to="/seller/products"><Icon name="plus" size={14} /> Add product</Link>
        </div>
      </header>

      <div className="sd-kpis">
        <Kpi tone="indigo" icon="wallet" label="Revenue" value={fmt.inr(kpis.revenue)} change={kpis.revenueChange} hint={`${fmt.inr(kpis.revenueAllTime)} all time`} />
        <Kpi tone="teal" icon="package" label="Orders" value={fmt.num(kpis.orders)} change={kpis.ordersChange} hint={`${kpis.ordersToday} today · ${fmt.pct(kpis.cancelRate)} cancelled`} />
        <Kpi tone="amber" icon="users" label="Customers" value={fmt.num(kpis.customers)} hint={`${kpis.customersRecent} ordered in the last 30 days`} />
        <Kpi tone="violet" icon="tag" label="Average order" value={fmt.inr(kpis.averageOrder)} hint="Placed orders, last 30 days" />
      </div>

      <div className="sd-grid">
        <RevenueChart daily={data.daily} />
        <Pipeline fulfilment={data.fulfilment} returns={data.returns} />
        {data.leads && <Leads leads={data.leads} />}
        <StockHealth stock={data.stock} admin={admin} />
        <RecentOrders orders={data.recent} />
        <div className="sd-stack">
          <TopProducts top={data.top} />
          <Activity events={data.activity} />
        </div>
      </div>
    </div>
  );
}
