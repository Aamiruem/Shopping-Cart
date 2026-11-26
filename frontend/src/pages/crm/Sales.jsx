import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Area, ComposedChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { crm } from '../../api/client';
import { NotesPanel } from '../../components/crm/shared';
import { Badge, dateTime, Drawer, ErrorBox, ExportMenu, Field, label, Loading, money, PageHead, Pager, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

const PAYMENT = { cod_pending: 'COD · to collect', collected: 'COD · collected', not_due: 'Not due', paid: 'Paid online', refunded: 'Refunded', refund_pending: 'Refund pending', failed: 'Failed', created: 'Awaiting payment' };
const STEPS = ['pending', 'packed', 'shipped', 'delivered'];

function OrderDrawer({ id, onClose, onChange }) {
  const { can, confirm } = useCrm();
  const { data: o, error, reload } = useCrmData(`/orders/${id}`);
  const { run, busy } = useAction();
  const [ship, setShip] = useState({ courier: '', trackingNumber: '' });
  const [box, setBox] = useState({ weightKg: '', lengthCm: '', breadthCm: '', heightCm: '' });
  const book = async (e) => {
    e.preventDefault();
    if (await run(() => crm.post(`/orders/${id}/shipment`, box), (s) => `Booked with ${s.courier}: AWB ${s.awb}`)) {
      reload();
      onChange();
    }
  };
  const move = async (fulfilment) => {
    if (fulfilment === 'shipped' && !ship.trackingNumber.trim()) return;
    if (await run(() => crm.patch(`/orders/${id}/fulfilment`, { fulfilment, ...(fulfilment === 'shipped' ? ship : {}) }), `Marked ${fulfilment}`)) {
      reload();
      onChange();
    }
  };
  const cancel = async () => {
    const reason = await confirm({ title: `Cancel order #${id}?`, message: 'Stock goes back, a coupon use is returned, and an online payment is refunded to where it came from.', input: 'Reason the customer will see', danger: true, confirmLabel: 'Cancel order' });
    if (reason && (await run(() => crm.post(`/orders/${id}/cancel`, { reason }), (r) => `Order cancelled${r.body?.refund ? `; refund ${r.body.refund}` : ''}`))) {
      reload();
      onChange();
    }
  };
  const step = o ? STEPS.indexOf(o.fulfilment) : 0;
  return (
    <Drawer title={o?.order_number ? `Order ${o.order_number}` : `Order #${id}`} onClose={onClose} actions={o && o.status !== 'cancelled' && <Link className="b sm" to={`/crm/invoice/${id}`} target="_blank">Invoice</Link>}>
      <ErrorBox error={error} onRetry={reload} />
      {!o ? <Loading /> : (
        <div className="stack">
          <div className="row"><Badge value={o.status} /><Badge value={o.status === 'placed' ? o.fulfilment : o.status} /><Badge value={o.payment}>{PAYMENT[o.payment] || label(o.payment)}</Badge><span className="muted small">{dateTime(o.created_at)}</span></div>
          <section className="card">
            <dl className="dl">
              <dt>Customer</dt><dd><Link to={`/crm/customers/${o.user_id}`}>{o.customer}</Link> · {o.email}{o.phone ? ` · ${o.phone}` : ''}</dd>
              <dt>Deliver to</dt><dd>{o.address}</dd>
              <dt>Payment</dt><dd>{o.payment_method === 'cod' ? 'Cash on delivery' : `Online (${o.payment_method})`}</dd>
              {o.coupon_code && <><dt>Coupon</dt><dd>{o.coupon_code} (−{money(o.coupon_discount)})</dd></>}
            </dl>
          </section>
          <section className="card flush">
            <table className="t">
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th>Status</th></tr></thead>
              <tbody>
                {o.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}{i.options && <span className="sub">{Object.values(i.options).join(' · ')}</span>}{i.tracking_number && <span className="sub">{i.courier} {i.tracking_number}</span>}</td>
                    <td className="num">{i.qty}</td><td className="num">{money(i.price * i.qty)}</td><td><Badge value={i.fulfilment} /></td>
                  </tr>
                ))}
                <tr><td colSpan={2}>Subtotal {money(o.subtotal)} · delivery {money(o.delivery_fee)}{Number(o.coupon_discount) ? ` · discount −${money(o.coupon_discount)}` : ''}</td><td className="num"><strong>{money(o.total)}</strong></td><td /></tr>
              </tbody>
            </table>
          </section>
          {can('orders.edit') && o.status === 'placed' && (
            <section className="card stack">
              <h3>Fulfilment</h3>
              {o.return && ['requested', 'approved'].includes(o.return.status) ? <p className="muted">A return is in progress: handle it under Refunds.</p> : (
                <>
                  <div className="row">
                    {step < 1 && <button type="button" className="b" disabled={busy} onClick={() => move('packed')}>Mark packed</button>}
                    {step >= 2 && step < 3 && <button type="button" className="b primary" disabled={busy} onClick={() => move('delivered')}>Mark delivered</button>}
                  </div>
                  {step < 2 && o.shippingConnected && can('shipping.manage') && (
                    <form className="stack" onSubmit={book}>
                      <strong className="small">Book with the courier (Shiprocket): the courier issues the tracking number</strong>
                      <div className="row">
                        <input type="number" step="0.01" min="0.01" required placeholder="Weight kg" value={box.weightKg} onChange={(e) => setBox({ ...box, weightKg: e.target.value })} style={{ width: 100 }} />
                        <input type="number" min="1" required placeholder="L cm" value={box.lengthCm} onChange={(e) => setBox({ ...box, lengthCm: e.target.value })} style={{ width: 80 }} />
                        <input type="number" min="1" required placeholder="B cm" value={box.breadthCm} onChange={(e) => setBox({ ...box, breadthCm: e.target.value })} style={{ width: 80 }} />
                        <input type="number" min="1" required placeholder="H cm" value={box.heightCm} onChange={(e) => setBox({ ...box, heightCm: e.target.value })} style={{ width: 80 }} />
                        <button type="submit" className="b primary" disabled={busy}>Book shipment</button>
                      </div>
                    </form>
                  )}
                  {step < 2 && (
                    <form className="row" onSubmit={(e) => { e.preventDefault(); move('shipped'); }}>
                      <input placeholder="Courier" value={ship.courier} onChange={(e) => setShip({ ...ship, courier: e.target.value })} />
                      <input placeholder="Tracking number" required value={ship.trackingNumber} onChange={(e) => setShip({ ...ship, trackingNumber: e.target.value })} />
                      <button type="submit" className="b primary" disabled={busy}>Mark shipped</button>
                    </form>
                  )}
                  <p className="muted small">Only enter a tracking number the courier actually issued. The customer sees it on their order page.</p>
                </>
              )}
              {o.canCancel && <div><button type="button" className="b danger" onClick={cancel} disabled={busy}>Cancel order</button></div>}
            </section>
          )}
          {o.payments.length > 0 && (
            <section className="card"><h3>Payments</h3>
              {o.payments.map((p) => <p key={p.id} className="small" style={{ margin: '0 0 6px' }}>{label(p.provider)} {p.provider_payment_id || ''} · {money(p.amount)} · <Badge value={p.status} /> · {p.method || ''} · {dateTime(p.updated_at)}{p.error && <span className="sub">{p.error}</span>}</p>)}
            </section>
          )}
          {o.shipment && (
            <section className="card"><h3>Shipment</h3>
              <p className="small">{o.shipment.courier || 'Courier'} · AWB <strong>{o.shipment.awb || 'not assigned yet'}</strong> · <Badge value={o.shipment.status}>{label(o.shipment.status)}</Badge>{o.shipment.eta ? ` · ETA ${o.shipment.eta.slice(0, 10)}` : ''}{o.shipment.tracking_url && <> · <a href={o.shipment.tracking_url} target="_blank" rel="noreferrer">Courier tracking</a></>}</p>
              {o.shipment.events?.length > 0 && <ul className="timeline">{o.shipment.events.map((e) => <li key={e.id}><div>{label(e.status)}{e.location ? ` · ${e.location}` : ''}<time>{dateTime(e.occurred_at)}</time></div></li>)}</ul>}
            </section>
          )}
          {o.deliveryCheck && <p className="muted small">At checkout: {o.deliveryCheck.checked ? (o.deliveryCheck.serviceable ? `courier delivery confirmed to ${o.deliveryCheck.pincode}` : 'not serviceable') : 'no courier connected, delivery to be confirmed by the team'}.</p>}
          {o.return && <section className="card"><h3>Return</h3><p className="small">{label(o.return.status)} · {o.return.reason}{o.return.refund ? ` · refund ${label(o.return.refund)}` : ''}</p></section>}
          <section className="card"><h3>Timeline</h3><ul className="timeline">{o.events.map((e, i) => <li key={i}><div>{e.note || label(e.status)}<time>{dateTime(e.created_at)}</time></div></li>)}</ul></section>
          <h3>Internal notes</h3>
          <NotesPanel entity="order" entityId={o.id} notes={o.notes} onChange={reload} />
        </div>
      )}
    </Drawer>
  );
}

function Refunds() {
  const { can, confirm } = useCrm();
  const [view, setView] = useState('open');
  const { data, error, loading, reload } = useCrmData('/refunds', { view });
  const { run, busy } = useAction();
  const act = async (r, action) => {
    let body = { action };
    if (action === 'reject') {
      const note = await confirm({ title: 'Reject this return?', message: 'Tell the customer why.', input: 'Reason', danger: true, confirmLabel: 'Reject' });
      if (!note) return;
      body = { action, note };
    }
    if (action === 'refund' && r.refund === 'cod_manual') {
      const reference = await confirm({ title: 'Record the bank / UPI refund', message: `Send ${money(r.amount ?? r.total)} to the customer’s account, then enter the transfer’s UTR or reference number.`, input: 'UTR / reference', confirmLabel: 'Record refund' });
      if (!reference) return;
      body = { action, reference };
    }
    if (action === 'receive' && !(await confirm({ title: 'Item received?', message: 'Stock goes back and the refund starts (online payments automatically).', confirmLabel: 'Mark received' }))) return;
    if (await run(() => crm.patch(`/refunds/${r.order_id}`, body), 'Return updated')) reload();
  };
  return (
    <section className="card flush">
      <div className="toolbar"><select value={view} onChange={(e) => setView(e.target.value)} aria-label="Show"><option value="open">Needs action</option><option value="all">All returns</option></select></div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <Table rows={data} empty="No returns need action" columns={[
          { key: 'order_id', label: 'Order', render: (r) => <>#{r.order_id}<span className="sub">{r.customer}</span></> },
          { key: 'reason', label: 'Reason', render: (r) => <>{r.reasonLabel || label(r.reason_code)}<span className="sub">{r.reason}</span></> },
          { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount ?? r.total) },
          { key: 'status', label: 'Status', render: (r) => <><Badge value={r.status} />{r.refund && <span className="sub">Refund: {label(r.refund)}</span>}</> },
          { key: 'actions', label: '', render: (r) => can('refunds.manage') && (
            <span className="row">
              {r.status === 'requested' && <><button type="button" className="b sm" disabled={busy} onClick={() => act(r, 'approve')}>Approve</button><button type="button" className="b sm danger" disabled={busy} onClick={() => act(r, 'reject')}>Reject</button></>}
              {r.status === 'approved' && <button type="button" className="b sm" disabled={busy} onClick={() => act(r, 'receive')}>Item received</button>}
              {r.status === 'received' && r.refund !== 'refunded' && <button type="button" className="b sm primary" disabled={busy} onClick={() => act(r, 'refund')}>{r.refund === 'cod_manual' ? 'Record refund' : 'Retry refund'}</button>}
            </span>
          ) },
        ]} />
      )}
    </section>
  );
}

function Forecast() {
  const { data, error, loading, reload } = useCrmData('/insights', { section: 'forecast' });
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />;
  const f = data.forecast;
  const chart = [...data.history.map((h) => ({ week: h.week, actual: h.revenue })), ...(f.ok ? f.points.map((p) => ({ week: p.week, forecast: p.value, band: [p.low, p.high] })) : [])];
  return (
    <section className="card">
      <div className="card-head"><h2>Weekly revenue and the next 4 weeks</h2></div>
      {!f.ok ? <div className="alert info">{f.reason} The forecast appears once there’s enough history to test it against.</div> : (
        <p className="muted small" style={{ marginTop: 0 }}>{f.method}. Tested on the last {f.backtest.weeks} weeks: off by {money(f.backtest.mae)} a week on average{f.backtest.mape !== null ? ` (${f.backtest.mape}%)` : ''}; a plain “same as last week” guess was off by {money(f.backtest.naiveMae)}. {f.backtest.beatsNaive ? 'The model did better than that.' : 'The model did not beat it, so treat the forecast with care.'} The shaded band is the likely range.</p>
      )}
      <div className="chart-box muted" style={{ height: 300 }}>
        <ResponsiveContainer>
          <ComposedChart data={chart} margin={{ left: 0, right: 8, top: 6 }}>
            <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
            <XAxis dataKey="week" stroke="currentColor" tick={{ fill: 'currentColor', fontSize: 11 }} tickFormatter={(d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} minTickGap={20} />
            <YAxis stroke="currentColor" tick={{ fill: 'currentColor', fontSize: 11 }} tickFormatter={(v) => `₹${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`} width={52} />
            <Tooltip formatter={(v) => (Array.isArray(v) ? `${money(v[0])} – ${money(v[1])}` : money(v))} contentStyle={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)' }} />
            <Area dataKey="band" name="Likely range" stroke="none" fill="#eb6834" fillOpacity={0.15} />
            <Line dataKey="actual" name="Actual" stroke="#2f5bff" strokeWidth={2} dot={false} />
            <Line dataKey="forecast" name="Forecast" stroke="#eb6834" strokeWidth={2} strokeDasharray="5 4" dot />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

const EXPORT = [{ key: 'order_number', label: 'Order' }, { key: 'created_at', label: 'Date' }, { key: 'customer', label: 'Customer' }, { key: 'email', label: 'Email' }, { key: 'status', label: 'Status' }, { key: 'fulfilment', label: 'Fulfilment' }, { key: 'payment', label: 'Payment' }, { key: 'payment_method', label: 'Method' }, { key: 'units', label: 'Units' }, { key: 'total', label: 'Total (₹)' }, { key: 'coupon_code', label: 'Coupon' }];

export default function Sales() {
  const { can } = useCrm();
  const [search, setSearch] = useSearchParams();
  const tab = search.get('tab') || 'orders';
  const [params, setParams] = useState({ q: '', status: '', fulfilment: '', payment: '', from: '', to: '', sort: '', page: 1 });
  const { data, error, loading, reload } = useCrmData('/orders', params, { skip: tab !== 'orders' });
  const set = (k) => (e) => setParams({ ...params, [k]: e.target.value, page: 1 });
  const openId = search.get('order');
  return (
    <>
      <PageHead title="Sales & orders" subtitle="The store’s own orders, payments and returns: changes here are the real thing">
        {can('reports.export') && tab === 'orders' && <ExportMenu name="orders" title="Orders" columns={EXPORT} load={async () => (await crm.get('/orders/export', params)).items} />}
      </PageHead>
      <div className="tabs">
        {[['orders', 'Orders'], ['refunds', 'Returns & refunds'], ...(can('insights.view') ? [['forecast', 'Forecast']] : [])].map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setSearch({ tab: k })}>{l}</button>)}
      </div>
      {tab === 'orders' && (
        <section className="card flush">
          <div className="toolbar">
            <input type="search" placeholder="Order number, customer name or email" value={params.q} onChange={set('q')} aria-label="Search orders" />
            <select value={params.status} onChange={set('status')} aria-label="Status"><option value="">All statuses</option><option value="placed">Placed</option><option value="cancelled">Cancelled</option><option value="returned">Returned</option></select>
            <select value={params.fulfilment} onChange={set('fulfilment')} aria-label="Fulfilment"><option value="">Any fulfilment</option>{STEPS.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
            <select value={params.payment} onChange={set('payment')} aria-label="Payment"><option value="">Any payment</option><option value="cod">Cash on delivery</option><option value="online">Online</option></select>
            <Field label="From"><input type="date" value={params.from} onChange={set('from')} /></Field>
            <Field label="To"><input type="date" value={params.to} onChange={set('to')} /></Field>
          </div>
          <ErrorBox error={error} onRetry={reload} />
          {loading && !data ? <Loading /> : (
            <Table rows={data?.items} onRow={(o) => setSearch({ tab, order: o.id })} sort={params.sort} onSort={(sort) => setParams({ ...params, sort })} empty="No orders match"
              columns={[
                { key: 'id', label: 'Order', render: (o) => <>{o.order_number || `#${o.id}`}<span className="sub">{dateTime(o.created_at)}</span></> },
                { key: 'customer', label: 'Customer', render: (o) => <>{o.customer}<span className="sub">{o.email}</span></> },
                { key: 'first_item', label: 'Items', hideSm: true, render: (o) => <>{o.first_item}{o.lines > 1 && <span className="sub">+{o.lines - 1} more</span>}</> },
                { key: 'status', label: 'Status', render: (o) => <>{o.status === 'placed' ? <Badge value={o.fulfilment} /> : <Badge value={o.status} />}{o.return_status && <span className="sub">Return {o.return_status}</span>}</> },
                { key: 'payment', label: 'Payment', hideSm: true, render: (o) => <Badge value={o.payment}>{PAYMENT[o.payment] || label(o.payment)}</Badge> },
                { key: 'total', label: 'Total', num: true, sort: 'amount', render: (o) => money(o.total) },
              ]} />
          )}
          <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
        </section>
      )}
      {tab === 'refunds' && <Refunds />}
      {tab === 'forecast' && <Forecast />}
      {openId && <OrderDrawer id={openId} onClose={() => setSearch({ tab })} onChange={reload} />}
    </>
  );
}
