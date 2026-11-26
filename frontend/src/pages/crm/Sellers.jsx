import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { crm } from '../../api/client';
import { Badge, count, date, dateTime, Drawer, ErrorBox, Field, label, Loading, money, PageHead, Pager, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

const STATUS = { pending: 'Pending review', approved: 'Approved', rejected: 'Rejected', suspended: 'Suspended' };
const TONE = { pending: 'warn', approved: 'good', rejected: 'bad', suspended: 'bad' };

function SellerDrawer({ id, onClose, onChange }) {
  const { can, confirm } = useCrm();
  const { data: s, error, reload, setData } = useCrmData(`/sellers/${id}`);
  const { run, busy } = useAction();
  const [checks, setChecks] = useState({});
  const [period, setPeriod] = useState({ from: '', to: new Date().toISOString().slice(0, 10) });
  const act = async (action) => {
    let note;
    if (['reject', 'suspend'].includes(action)) {
      note = await confirm({ title: action === 'reject' ? 'Reject the application?' : 'Suspend this seller?', message: action === 'suspend' ? 'Their Seller Hub stops at once and their products go off sale.' : 'They’ll see your reason and can apply again.', input: 'Reason (shown to the seller)', danger: true, confirmLabel: action === 'reject' ? 'Reject' : 'Suspend' });
      if (!note) return;
    } else if (!(await confirm({ title: action === 'approve' ? 'Approve this seller?' : 'Reinstate this seller?', message: action === 'approve' ? 'They can list products (each still needs product verification).' : 'Their hub and approved products come back.', confirmLabel: 'Confirm' }))) return;
    const out = await run(() => crm.post(`/sellers/${id}/review`, { action, note, checks }), `Seller ${action === 'approve' ? 'approved' : action === 'reinstate' ? 'reinstated' : action === 'reject' ? 'rejected' : 'suspended'}`);
    if (out) {
      setData(out);
      onChange();
    }
  };
  const commission = async (e) => {
    e.preventDefault();
    const out = await run(() => crm.patch(`/sellers/${id}/commission`, { commissionRate: Number(e.target.rate.value) }), 'Commission saved');
    if (out) setData(out);
  };
  const settle = async (e) => {
    e.preventDefault();
    if (await run(() => crm.post(`/sellers/${id}/settlements`, period), (r) => `Settlement of ${money(r.net)} created`)) reload();
  };
  const paid = async (row) => {
    const reference = await confirm({ title: `Record the payout of ${money(row.net)}`, message: 'Transfer the money first, then enter the UTR.', input: 'UTR / reference', confirmLabel: 'Record' });
    if (reference && (await run(() => crm.post(`/settlements/${row.id}/paid`, { reference }), 'Payout recorded'))) reload();
  };
  return (
    <Drawer title={s ? `${s.store_name} · ${s.seller_code}` : 'Seller'} onClose={onClose}>
      <ErrorBox error={error} onRetry={reload} />
      {!s ? <Loading /> : (
        <div className="stack">
          <div className="row"><Badge tone={TONE[s.status]}>{STATUS[s.status]}</Badge><span className="muted small">Applied {date(s.created_at)}{s.reviewed_at ? ` · reviewed ${date(s.reviewed_at)} by ${s.reviewed_by_name || '—'}` : ''}</span></div>
          {s.review_note && <p className="alert warn">{s.review_note}</p>}
          <section className="card">
            <dl className="dl">
              <dt>Owner</dt><dd>{s.name} · {s.email} {s.email_verified && <Badge tone="good">email verified</Badge>} · {s.phone} {s.phone_verified && <Badge tone="good">mobile verified</Badge>}</dd>
              <dt>Business</dt><dd>{label(s.business_type)}{s.business_address ? ` · ${s.business_address}` : ''}</dd>
              <dt>PAN</dt><dd>{s.pan || '—'}</dd>
              <dt>GSTIN</dt><dd>{s.gstin || 'Not registered'}</dd>
              <dt>Commission</dt><dd>{s.commission_rate}%</dd>
            </dl>
          </section>
          {can('sellers.manage') && ['pending', 'rejected'].includes(s.status) && (
            <section className="card stack">
              <h3 style={{ margin: 0 }}>Review</h3>
              {!s.email_verified && !s.phone_verified && <p className="alert warn">The applicant hasn’t verified their email or mobile yet: approval waits for that.</p>}
              {Object.entries(s.checks).map(([k, t]) => (k !== 'gst' || s.gstin) && <label key={k} className="check"><input type="checkbox" checked={Boolean(checks[k])} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} /> {t}</label>)}
              <p className="muted small">Check on the official portals; nothing is uploaded or stored apart from your confirmation, which is recorded in the audit log.</p>
              <div className="row"><button type="button" className="b primary" disabled={busy} onClick={() => act('approve')}>Approve</button>{s.status === 'pending' && <button type="button" className="b danger" disabled={busy} onClick={() => act('reject')}>Reject</button>}</div>
            </section>
          )}
          {can('sellers.manage') && s.status === 'approved' && <div className="row"><button type="button" className="b danger" onClick={() => act('suspend')}>Suspend seller</button></div>}
          {can('sellers.manage') && s.status === 'suspended' && <div className="row"><button type="button" className="b primary" onClick={() => act('reinstate')}>Reinstate</button></div>}

          <div className="kpis">
            <div className="kpi"><span className="label">Sales (placed)</span><span className="value">{money(s.performance.sales)}</span></div>
            <div className="kpi"><span className="label">Orders</span><span className="value">{count(s.performance.orders)}</span><span className="sub">{s.performance.delivered} delivered ({s.performance.fulfilmentRate ?? '—'}%)</span></div>
            <div className="kpi"><span className="label">Unsettled</span><span className="value">{money(s.unsettled.gross)}</span><span className="sub">{s.unsettled.lines} delivered lines · commission {money(s.unsettled.commission)}</span></div>
          </div>
          {can('sellers.manage') && s.status === 'approved' && (
            <form className="row" onSubmit={commission}><Field label="Commission %"><input name="rate" type="number" step="0.5" min="0" max="50" defaultValue={s.commission_rate} style={{ width: 90 }} /></Field><button type="submit" className="b" style={{ alignSelf: 'end' }}>Save</button></form>
          )}
          <section className="card flush">
            <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Settlements</h2></div>
            {can('settlements.manage') && (
              <form className="toolbar" onSubmit={settle}>
                <Field label="From"><input type="date" required value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} /></Field>
                <Field label="To"><input type="date" required value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} /></Field>
                <button type="submit" className="b primary" disabled={busy} style={{ alignSelf: 'end' }}>Create settlement</button>
              </form>
            )}
            <Table rows={s.settlements} empty="No settlements yet" columns={[
              { key: 'period', label: 'Period', render: (r) => `${date(r.period_from)} – ${date(r.period_to)}` },
              { key: 'gross', label: 'Sales', num: true, render: (r) => money(r.gross) },
              { key: 'commission', label: 'Commission', num: true, render: (r) => money(r.commission) },
              { key: 'net', label: 'Payout', num: true, render: (r) => <strong>{money(r.net)}</strong> },
              { key: 'status', label: 'Status', render: (r) => (r.status === 'paid' ? <><Badge tone="good">Paid</Badge><span className="sub">{r.reference} · {date(r.paid_at)}</span></> : can('settlements.manage') ? <button type="button" className="b sm" onClick={() => paid(r)}>Record payout</button> : <Badge tone="warn">Pending</Badge>) },
            ]} />
          </section>
          <section className="card flush">
            <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Products ({s.products.length})</h2></div>
            <Table rows={s.products} empty="No products yet" columns={[
              { key: 'name', label: 'Product' }, { key: 'status', label: 'Verification', render: (p) => <Badge value={p.status || 'pending'}>{label(p.status || 'pending_verification')}</Badge> },
              { key: 'price', label: 'Price', num: true, render: (p) => money(p.price) }, { key: 'stock', label: 'Stock', num: true },
            ]} />
          </section>
          <section className="card flush">
            <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Recent orders</h2></div>
            <Table rows={s.orders} empty="No orders yet" columns={[{ key: 'order_number', label: 'Order' }, { key: 'created_at', label: 'Date', render: (o) => dateTime(o.created_at) }, { key: 'fulfilment', label: 'Status', render: (o) => <Badge value={o.status === 'placed' ? o.fulfilment : o.status} /> }, { key: 'amount', label: 'Amount', num: true, render: (o) => money(o.amount) }]} />
          </section>
          {s.history.length > 0 && <section className="card"><h3>History</h3><ul className="timeline">{s.history.map((h, i) => <li key={i}><div>{label(h.action.replace('seller.', '').replace('settlement.', 'settlement '))} by {h.actor_name}{h.details?.note ? `: ${h.details.note}` : ''}<time>{dateTime(h.created_at)}</time></div></li>)}</ul></section>}
        </div>
      )}
    </Drawer>
  );
}

export default function Sellers() {
  const [search, setSearch] = useSearchParams();
  const [params, setParams] = useState({ q: '', status: 'pending', page: 1 });
  const { data, error, loading, reload } = useCrmData('/sellers', params);
  return (
    <>
      <PageHead title="Sellers" subtitle="Applications, verification, approval, commission and payouts" />
      {data && (
        <div className="kpis">
          {Object.entries(STATUS).map(([k, v]) => (
            <button key={k} type="button" className="kpi" style={{ textAlign: 'left', cursor: 'pointer', outline: params.status === k ? '2px solid var(--c-brand)' : 'none' }} onClick={() => setParams({ ...params, status: k, page: 1 })}>
              <span className="label">{v}</span><span className="value">{count(data.counts[k])}</span>
            </button>
          ))}
        </div>
      )}
      <section className="card flush">
        <div className="toolbar">
          <input type="search" placeholder="Store, owner, email, seller ID or GSTIN" value={params.q} onChange={(e) => setParams({ ...params, q: e.target.value, page: 1 })} aria-label="Search sellers" />
          <select value={params.status} onChange={(e) => setParams({ ...params, status: e.target.value, page: 1 })} aria-label="Status"><option value="">Every status</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : (
          <Table rows={data?.items} onRow={(s) => setSearch({ seller: s.id })} empty="No sellers here" columns={[
            { key: 'store_name', label: 'Store', render: (s) => <>{s.store_name}<span className="sub">{s.seller_code} · {s.name}</span></> },
            { key: 'status', label: 'Status', render: (s) => <Badge tone={TONE[s.status]}>{STATUS[s.status]}</Badge> },
            { key: 'verified', label: 'Contact', hideSm: true, render: (s) => (s.email_verified || s.phone_verified ? <Badge tone="good">Verified</Badge> : <Badge tone="warn">Not verified</Badge>) },
            { key: 'products', label: 'Products', num: true },
            { key: 'sales', label: 'Sales', num: true, hideSm: true, render: (s) => money(s.sales) },
            { key: 'created_at', label: 'Applied', render: (s) => date(s.created_at) },
          ]} />
        )}
        <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
      </section>
      {search.get('seller') && <SellerDrawer id={search.get('seller')} onClose={() => setSearch({})} onChange={reload} />}
    </>
  );
}
