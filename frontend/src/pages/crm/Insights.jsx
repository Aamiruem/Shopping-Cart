import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, count, ErrorBox, label, Loading, money, PageHead, pctText, Table, useCrmData } from '../../components/crm/ui';

const SECTIONS = [['customers', 'Segments & churn'], ['enquiries', 'Lead scoring'], ['behaviour', 'Purchase behaviour'], ['products', 'Product insights'], ['sentiment', 'Sentiment']];

function Method({ children }) {
  return <p className="muted small" style={{ marginTop: 0 }}><strong>Method:</strong> {children}</p>;
}

function Customers({ d }) {
  if (d.note) return <p className="muted">{d.note}</p>;
  const max = Math.max(1, ...d.rfm.segments.map((s) => s.customers));
  return (
    <>
      <section className="card" style={{ marginBottom: 14 }}>
        <h2>RFM segments</h2>
        <Method>{d.rfm.method}</Method>
        {d.rfm.segments.map((s) => (
          <div key={s.key} style={{ marginBottom: 10 }}>
            <div className="bar-row" style={{ marginBottom: 2 }}><span><strong>{s.label}</strong></span><span className="track"><span className="fill" style={{ width: `${(s.customers / max) * 100}%` }} /></span><span className="num">{s.customers}</span></div>
            <span className="muted small">{money(s.revenue)} lifetime · {s.advice}</span>
          </div>
        ))}
      </section>
      <section className="card flush">
        <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Churn risk</h2><span className="muted small">{d.churn.counts.high} high · {d.churn.counts.medium} medium · {d.churn.counts.low} low</span></div>
        <div style={{ padding: '0 16px' }}><Method>{d.churn.method}</Method></div>
        <Table rows={d.churn.customers} empty="No customers at risk" columns={[
          { key: 'name', label: 'Customer', render: (c) => <><Link to={`/crm/customers/${c.id}`}>{c.name}</Link><span className="sub">{c.email}</span></> },
          { key: 'risk', label: 'Risk', render: (c) => <Badge value={c.churn.risk}>{c.churn.risk} ({c.churn.ratio}×)</Badge> },
          { key: 'why', label: 'Why', render: (c) => c.churn.explanation },
          { key: 'spent', label: 'Lifetime', num: true, render: (c) => money(c.spent) },
          { key: 'rfm', label: 'RFM', hideSm: true, render: (c) => <span title={c.rfm.label}>{c.rfm.code}</span> },
        ]} />
      </section>
    </>
  );
}

function Enquiries({ d }) {
  return (
    <>
      <div className="kpis">{Object.entries(d.bands).map(([k, v]) => <div className="kpi" key={k}><span className="label">{label(k)} open leads</span><span className="value">{v}</span></div>)}</div>
      <section className="card flush" style={{ marginBottom: 14 }}>
        <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Best open leads</h2></div>
        <div style={{ padding: '0 16px' }}><Method>{d.method}</Method></div>
        <Table rows={d.topLeads} empty="No open leads" columns={[
          { key: 'name', label: 'Lead', render: (l) => <><Link to={`/crm/leads?open=${l.id}`}>{l.name || `Lead #${l.id}`}</Link><span className="sub">{l.summary}</span></> },
          { key: 'score', label: 'Score', num: true, render: (l) => <Badge value={l.band}>{l.score}</Badge> },
          { key: 'reasons', label: 'Top reasons', render: (l) => l.reasons.filter((r) => r.points > 0).sort((a, b) => b.points - a.points).slice(0, 3).map((r) => r.why).join(' · ') },
        ]} />
      </section>
      <section className="card flush">
        <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Enquiries by type and intent (90 days)</h2></div>
        <Table rows={d.kinds} empty="No enquiries yet" columns={[{ key: 'label', label: 'Type' }, { key: 'high', label: 'Hot', num: true }, { key: 'medium', label: 'Warm', num: true }, { key: 'low', label: 'Cold', num: true }]} />
      </section>
    </>
  );
}

function Behaviour({ d }) {
  const maxHour = Math.max(1, ...d.hours.map((h) => h.orders));
  return (
    <div className="cards">
      <section className="card"><h2>Category mix (180 days)</h2>
        {d.categories.map((c) => <div key={c.category} className="bar-row"><span>{label(c.category)}</span><span className="track"><span className="fill" style={{ width: `${c.share}%` }} /></span><span className="num">{pctText(c.share)}</span></div>)}
        {!d.categories.length && <p className="muted">No sales yet.</p>}
      </section>
      <section className="card"><h2>Repeat buying</h2>
        <p style={{ fontSize: 28, margin: '4px 0' }}><strong>{pctText(d.repeatRate)}</strong></p>
        <p className="muted small">of {count(d.buyers)} buyers ordered more than once.</p>
        <h3>How people pay</h3>
        {d.payments.map((p) => <p key={p.method} className="small" style={{ margin: '0 0 4px' }}>{p.method}: {count(p.orders)} orders</p>)}
      </section>
      <section className="card"><h2>When orders come in (IST)</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 2, alignItems: 'end', height: 120 }}>
          {d.hours.map((h) => <div key={h.hour} title={`${h.hour}:00 · ${h.orders} orders`} style={{ height: `${(h.orders / maxHour) * 100}%`, minHeight: 2, background: 'var(--c-brand)', borderRadius: 2 }} />)}
        </div>
        <div className="row small muted" style={{ justifyContent: 'space-between' }}><span>0:00</span><span>12:00</span><span>23:00</span></div>
      </section>
      <section className="card"><h2>Often bought together</h2>
        {d.boughtTogether.length ? d.boughtTogether.map((p, i) => <p key={i} className="small" style={{ margin: '0 0 6px' }}>{p.a} + {p.b} <span className="muted">({p.orders} orders)</span></p>) : <p className="muted">Needs at least two orders with the same pair.</p>}
      </section>
    </div>
  );
}

function Products({ d }) {
  const cols = (extra) => [{ key: 'name', label: 'Product', render: (p) => <a href={`/products/${p.id}`} target="_blank" rel="noreferrer">{p.name}</a> }, { key: 'viewers', label: 'Viewers', num: true }, { key: 'units', label: 'Sold', num: true }, { key: 'conversion', label: 'Conversion', num: true, render: (p) => pctText(p.conversion) }, ...extra];
  return (
    <>
      <p className="muted small">{d.window}. Views are product-page visits, one per visitor per day.</p>
      <section className="card flush" style={{ marginBottom: 14 }}><div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Lots of interest, few sales</h2></div><Table rows={d.lowConversion} empty="Nothing stands out" columns={cols([{ key: 'why', label: 'Suggestion' }])} /></section>
      <section className="card flush" style={{ marginBottom: 14 }}><div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Selling fast, running low</h2></div><Table rows={d.restock} empty="Stock looks fine" columns={cols([{ key: 'stock', label: 'Stock', num: true }, { key: 'why', label: 'Why' }])} /></section>
      <section className="card flush"><div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Best converting</h2></div><Table rows={d.topConverting} empty="Not enough data yet" columns={cols([])} /></section>
    </>
  );
}

function Sentiment({ d }) {
  return (
    <>
      <Method>{d.method}</Method>
      <div className="kpis">
        <div className="kpi"><span className="label">Tickets (90 days)</span><span className="value">{d.tickets.total}</span></div>
        <div className="kpi"><span className="label">Upset</span><span className="value">{d.tickets.negative}</span></div>
        <div className="kpi"><span className="label">Positive</span><span className="value">{d.tickets.positive}</span></div>
        <div className="kpi"><span className="label">Average mood</span><span className="value">{d.tickets.average ?? '—'}</span></div>
      </div>
      <div className="cards">
        <section className="card flush"><div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Upset customers waiting</h2></div>
          <Table rows={d.angriest} empty="None right now" columns={[{ key: 'subject', label: 'Ticket', render: (t) => <Link to={`/crm/support?ticket=${t.id}`}>#{t.id} {t.subject}</Link> }, { key: 'sentiment', label: 'Mood', num: true }, { key: 'status', label: 'Status', render: (t) => <Badge value={t.status} /> }]} />
        </section>
        <section className="card"><h2>Mood by topic</h2>{d.byCategory.map((c) => <p key={c.category} className="small" style={{ margin: '0 0 4px' }}>{label(c.category)}: {c.mood} <span className="muted">({c.tickets} tickets)</span></p>)}</section>
        <section className="card"><h2>Review ratings</h2>{d.reviews.slice().reverse().map((r) => <p key={r.rating} className="small" style={{ margin: '0 0 4px' }}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} {r.reviews}</p>)}</section>
      </div>
    </>
  );
}

export default function Insights() {
  const [section, setSection] = useState('customers');
  const { data, error, loading, reload } = useCrmData('/insights', { section });
  const View = { customers: Customers, enquiries: Enquiries, behaviour: Behaviour, products: Products, sentiment: Sentiment }[section];
  return (
    <>
      <PageHead title="AI insights" subtitle="Statistical and rule-based analysis of the store’s own data. Each section says how it works; no probability is shown unless it has been checked against outcomes." />
      <div className="alert info">These insights only suggest. Nothing here sends messages, issues refunds or changes accounts on its own: a person always decides. The sales forecast (with its tested error) is under Sales → Forecast.</div>
      <div className="tabs">{SECTIONS.map(([k, l]) => <button key={k} type="button" className={section === k ? 'on' : ''} onClick={() => setSection(k)}>{l}</button>)}</div>
      <ErrorBox error={error} onRetry={reload} />
      {loading || !data ? <Loading text="Analysing…" /> : <View d={data} />}
    </>
  );
}
