import { useState } from 'react';
import { Link } from 'react-router-dom';
import { crm } from '../../api/client';
import { Badge, count, dateTime, ErrorBox, Kpi, label, Loading, money, PageHead, Pager, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

const TONE = { paid: 'good', refunded: 'good', failed: 'bad', created: 'warn', processing: 'warn', refund_pending: 'warn' };

// Every payment attempt as the gateway reported it. Paid comes only from a verified signature or a signed webhook.
export default function Payments() {
  const { can } = useCrm();
  const [params, setParams] = useState({ q: '', status: '', page: 1 });
  const { data, error, loading, reload } = useCrmData('/payments', params);
  const { run, busy } = useAction();
  const [findings, setFindings] = useState(null);
  const reconcile = async () => {
    const out = await run(() => crm.post('/payments/reconcile'), (r) => `Checked ${r.checked} unfinished payments with Razorpay`);
    if (out) {
      setFindings(out.findings);
      reload();
    }
  };
  const g = data?.gateway;
  return (
    <>
      <PageHead title="Payments" subtitle="Online payments (Razorpay) and cash on delivery">
        {can('payments.manage') && <button type="button" className="b" disabled={busy || !g?.configured} onClick={reconcile}>Reconcile with Razorpay</button>}
      </PageHead>
      {g && !g.configured && (
        <div className="alert warn">
          Online payments are off: {g.modeMismatch ? `the Razorpay key doesn’t match the payment mode (${g.mode}). Live keys need PAYMENTS_MODE=live, set on purpose after test-mode checks.` : 'add RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET in Vercel (test keys first).'} Customers can still choose cash on delivery.
        </div>
      )}
      {g?.configured && <div className="alert info">Gateway connected in <strong>{g.mode}</strong> mode.</div>}
      {data && (
        <div className="kpis">
          {data.summary.filter((s) => s.n > 0 || ['paid', 'failed'].includes(s.status)).map((s) => <Kpi key={s.status} label={`${s.label} (30 days)`} value={count(s.n)} sub={money(s.amount)} />)}
          <Kpi label="Cash on delivery to collect" value={money(data.codToCollect.amount)} sub={`${data.codToCollect.orders} orders not yet delivered`} />
        </div>
      )}
      {findings && (
        <section className="card" style={{ marginBottom: 14 }}>
          <h2>Reconciliation</h2>
          {findings.length ? findings.map((f) => <p key={f.paymentId} className="small">Payment #{f.paymentId}: <strong>{label(f.issue)}</strong> · {f.action}</p>) : <p className="muted">No differences: every unfinished attempt matches the gateway.</p>}
        </section>
      )}
      <section className="card flush">
        <div className="toolbar">
          <input type="search" placeholder="Customer, email, order number, Razorpay order or payment id" value={params.q} onChange={(e) => setParams({ ...params, q: e.target.value, page: 1 })} aria-label="Search payments" />
          <select value={params.status} onChange={(e) => setParams({ ...params, status: e.target.value, page: 1 })} aria-label="Status">
            <option value="">Every status</option>{data?.summary.map((s) => <option key={s.status} value={s.status}>{s.label}</option>)}
          </select>
        </div>
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : (
          <Table rows={data?.items} empty="No online payments yet" columns={[
            { key: 'created_at', label: 'When', render: (p) => dateTime(p.created_at) },
            { key: 'customer', label: 'Customer', render: (p) => <>{p.customer}<span className="sub">{p.email}</span></> },
            { key: 'order', label: 'Order', render: (p) => (p.order_id ? <Link to={`/crm/sales?order=${p.order_id}`}>{p.order_number || `#${p.order_id}`}</Link> : <span className="muted">No order</span>) },
            { key: 'ref', label: 'Gateway', hideSm: true, render: (p) => <><code>{p.provider_payment_id || p.provider_order_id}</code><span className="sub">{label(p.method || '')}</span></> },
            { key: 'amount', label: 'Amount', num: true, render: (p) => money(p.amount) },
            { key: 'status', label: 'Status', render: (p) => <><Badge tone={TONE[p.status]}>{p.statusLabel}</Badge>{p.error && <span className="sub">{p.error}</span>}</> },
          ]} />
        )}
        <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
      </section>
    </>
  );
}
