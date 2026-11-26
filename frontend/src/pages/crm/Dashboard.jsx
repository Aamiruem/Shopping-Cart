import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, count, DateRange, dateTime, defaultRange, ErrorBox, Kpi, Loading, money, PageHead, pctText, useCrm, useCrmData, ago, label } from '../../components/crm/ui';

// Axes and labels use currentColor, so the charts follow the CRM's light and dark themes
const axis = { stroke: 'currentColor', tick: { fill: 'currentColor', fontSize: 11 }, tickLine: false };
const short = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const BRAND = '#2f5bff';
const ORANGE = '#eb6834';

function Tip({ active, payload, label: l, money: isMoney }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <strong>{short(l)}</strong>
      {payload.map((p) => <div key={p.dataKey}>{p.name}: {isMoney && p.dataKey === 'revenue' ? money(p.value) : count(p.value)}</div>)}
    </div>
  );
}

const STAGE = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', proposal: 'Proposal sent', negotiation: 'Negotiation', won: 'Converted' };

export default function Dashboard() {
  const { can } = useCrm();
  const [range, setRange] = useState(defaultRange(30));
  const { data, error, loading, reload } = useCrmData('/dashboard', range);
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />;
  const k = data.kpis;
  const maxFunnel = Math.max(1, ...data.funnel.map((f) => f.reached));
  return (
    <>
      <PageHead title="Dashboard" subtitle={`Live figures from the store’s database · ${short(data.range.from)} – ${short(data.range.to)}, compared with the ${data.range.days} days before`}>
        <DateRange value={range} onChange={setRange} />
      </PageHead>
      <ErrorBox error={error} onRetry={reload} />

      <div className="kpis">
        <Kpi label="Revenue (period)" value={money(k.revenue.period)} delta={k.revenue.change} sub="vs previous period" />
        <Kpi label="Revenue this month" value={money(k.revenue.month)} sub={`All time ${money(k.revenue.allTime)}`} />
        <Kpi label="Orders" value={count(k.orders.total)} delta={k.orders.change} sub={`${k.orders.completed} completed · ${k.orders.cancelled} cancelled`} />
        <Kpi label="Average order value" value={money(k.averageOrder)} sub="Placed orders in the period" />
        <Kpi label="Customer lifetime value" value={money(k.lifetimeValue)} sub="Lifetime revenue ÷ paying customers" />
        <Kpi label="Customers" value={count(k.customers.total)} sub={`${k.customers.new} new · ${k.customers.active} active · ${k.customers.returning} returning`} delta={k.customers.newChange} />
        <Kpi label="Retention rate" value={pctText(k.retentionRate)} sub="Previous period’s buyers who bought again" />
        <Kpi label="Leads" value={count(k.leads.total)} sub={`${k.leads.new} new · ${k.leads.pending} open · ${k.leads.converted} converted`} />
        <Kpi label="Lead conversion" value={pctText(k.conversionRate)} sub="Of leads received in the period" />
        <Kpi label="Pending payments" value={money(k.pendingPayments.codAmount)} sub={`${k.pendingPayments.codOrders} cash-on-delivery orders to collect${k.pendingPayments.failedPayments ? ` · ${k.pendingPayments.failedPayments} failed online` : ''}`} />
        <Kpi label="Refund requests" value={count(k.refunds.requests)} sub={`${k.refunds.toRefund} to refund (${money(k.refunds.toRefundAmount)})${k.pendingPayments.refundsPending ? ` · ${k.pendingPayments.refundsPending} online refunds pending` : ''}`} />
        <Kpi label="Open tickets" value={count(k.tickets.open)} sub={`${k.tickets.urgent} urgent`} />
        <Kpi label="Verified customers" value={count(k.verifiedCustomers)} sub="Email or mobile verified" />
        <Kpi label="Sellers" value={count(k.sellers.total)} sub={`${k.sellers.approved} approved · ${k.sellers.pending} applications waiting`} />
        <Kpi label="Products" value={count(k.products.total)} sub={`${k.products.verified} verified · ${k.products.pending} pending · ${k.products.comingSoon} coming soon · ${k.products.outOfStock} out of stock`} />
        <Kpi label="Paid / pending orders" value={`${count(k.paidOrders)} / ${count(k.pendingOrders)}`} sub="Pending = cash on delivery not yet delivered" />
        <Kpi label="OTP success rate" value={pctText(k.otp.successRate)} sub={`${k.otp.sent} codes · ${k.otp.deliveredConfirmed} confirmed delivered · ${pctText(k.otp.failureRate)} failed`} />
      </div>

      <div className="cards wide">
        <section className="card">
          <div className="card-head"><h2>Revenue and orders</h2><span className="muted small">Daily</span></div>
          <div className="chart-box muted">
            <ResponsiveContainer>
              <AreaChart data={data.trend} margin={{ left: 0, right: 8, top: 6 }}>
                <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
                <XAxis dataKey="day" tickFormatter={short} {...axis} minTickGap={24} />
                <YAxis yAxisId="r" {...axis} tickFormatter={(v) => `₹${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`} width={52} />
                <YAxis yAxisId="o" orientation="right" {...axis} allowDecimals={false} width={30} />
                <Tooltip content={<Tip money />} />
                <Area yAxisId="r" type="monotone" dataKey="revenue" name="Revenue" stroke={BRAND} fill={BRAND} fillOpacity={0.14} strokeWidth={2} />
                <Line yAxisId="o" type="monotone" dataKey="orders" name="Orders" stroke={ORANGE} dot={false} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Lead funnel</h2>{can('leads.view') && <Link to="/crm/leads" className="small">Open pipeline</Link>}</div>
          {data.funnel.map((f) => (
            <div className="bar-row" key={f.stage}>
              <span>{STAGE[f.stage]}</span>
              <span className="track"><span className="fill" style={{ width: `${(f.reached / maxFunnel) * 100}%` }} /></span>
              <span className="num">{f.reached}</span>
            </div>
          ))}
          <p className="muted small">Each bar counts leads that reached that stage or a later one. Lost: {data.lostLeads}.</p>
        </section>
      </div>

      <div className="cards">
        <section className="card">
          <div className="card-head"><h2>Customer growth</h2><span className="muted small">Total accounts</span></div>
          <div className="chart-box muted" style={{ height: 200 }}>
            <ResponsiveContainer>
              <LineChart data={data.growth} margin={{ left: 0, right: 8, top: 6 }}>
                <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
                <XAxis dataKey="day" tickFormatter={short} {...axis} minTickGap={24} />
                <YAxis {...axis} allowDecimals={false} width={36} />
                <Tooltip content={<Tip />} />
                <Line type="monotone" dataKey="total" name="Customers" stroke={BRAND} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="new" name="New that day" stroke={ORANGE} dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Sales by category</h2><span className="muted small">Placed orders in the period</span></div>
          {data.categories.length ? (
            <div className="chart-box muted" style={{ height: 200 }}>
              <ResponsiveContainer>
                <BarChart data={data.categories} layout="vertical" margin={{ left: 10, right: 12 }}>
                  <XAxis type="number" {...axis} tickFormatter={(v) => `₹${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`} />
                  <YAxis type="category" dataKey="category" {...axis} width={90} tickFormatter={label} />
                  <Tooltip formatter={(v) => money(v)} contentStyle={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)' }} />
                  <Bar dataKey="revenue" name="Revenue" fill={BRAND} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="muted">No sales in this period.</p>}
        </section>
      </div>

      <div className="cards">
        {can('sales.view') && (
          <section className="card flush">
            <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Recent orders</h2><Link to="/crm/sales" className="small">All orders</Link></div>
            <table className="t">
              <tbody>
                {data.recentOrders.map((o) => (
                  <tr key={o.id}>
                    <td><Link to={`/crm/sales?order=${o.id}`}>#{o.id}</Link><span className="sub">{o.customer}</span></td>
                    <td><Badge value={o.status === 'placed' ? o.fulfilment : o.status} /><span className="sub">{o.payment_method === 'cod' ? 'Cash on delivery' : 'Online'}</span></td>
                    <td className="num">{money(o.total)}<span className="sub">{ago(o.created_at)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.recentOrders.length && <p className="empty">No orders yet</p>}
          </section>
        )}
        {can('leads.view') && (
          <section className="card flush">
            <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Latest enquiries</h2><Link to="/crm/leads" className="small">All leads</Link></div>
            <table className="t">
              <tbody>
                {data.latestLeads.map((l) => (
                  <tr key={l.id}>
                    <td><Link to={`/crm/leads?open=${l.id}`}>{l.name || 'Lead'} </Link><span className="sub">{l.summary}</span></td>
                    <td><Badge value={l.intent === 'high' ? 'hot' : l.status} /><span className="sub">{label(l.source)} · {ago(l.created_at)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.latestLeads.length && <p className="empty">No enquiries yet</p>}
          </section>
        )}
        <section className="card flush">
          <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>My pending tasks</h2><Link to="/crm/tasks" className="small">All tasks</Link></div>
          <table className="t">
            <tbody>
              {data.myTasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}<span className="sub">{t.due_at ? `Due ${dateTime(t.due_at)}` : 'No due date'}</span></td>
                  <td><Badge value={t.overdue ? 'overdue' : t.priority} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.myTasks.length && <p className="empty">Nothing pending. Nice.</p>}
        </section>
      </div>
    </>
  );
}
