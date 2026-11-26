import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { crm } from '../../api/client';
import { DateRange, defaultRange, ErrorBox, ExportMenu, label, Loading, money, PageHead, useCrm, useCrmData } from '../../components/crm/ui';

const MONEY = ['revenue', 'spent', 'amount', 'averageOrder', 'deliveryFees', 'couponDiscounts', 'budget', 'couponRevenue'];
const PCT = ['conversion', 'conversionRate', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'];
const DATES = ['joined', 'lastOrder', 'received', 'date', 'sentAt'];
// The column each report charts, if any
const CHART = { sales: ['day', 'revenue'], revenue: ['month', 'revenue'], products: ['product', 'revenue'], conversion: ['source', 'conversionRate'], employees: ['name', 'leadsConverted'], campaigns: ['campaign', 'delivered'], refunds: null, customers: null, leads: null, retention: ['cohort', 'm1'] };

const show = (key, v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (MONEY.includes(key)) return money(v);
  if (PCT.includes(key)) return `${v}%`;
  if (DATES.includes(key)) return new Date(v).toLocaleDateString('en-IN');
  if (typeof v === 'number') return v.toLocaleString('en-IN');
  return ['source', 'status', 'kind', 'type', 'role', 'refund', 'channel', 'intent'].includes(key) ? label(v) : String(v);
};

export default function Reports() {
  const { me, can } = useCrm();
  const [id, setId] = useState('sales');
  const [range, setRange] = useState(defaultRange(90));
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(null);
  const { data, error, loading, reload } = useCrmData(`/reports/${id}`, range);
  const rows = useMemo(() => {
    let r = data?.rows || [];
    if (q) r = r.filter((x) => Object.values(x).some((v) => String(v ?? '').toLowerCase().includes(q.toLowerCase())));
    if (sort) r = [...r].sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : a[sort.key] < b[sort.key] ? -1 : 0) * (sort.dir === 'asc' ? 1 : -1));
    return r;
  }, [data, q, sort]);
  const columns = (data?.columns || []).map((c) => ({ key: c, label: label(c.replace(/([A-Z])/g, ' $1')) }));
  const chart = CHART[id];
  const exportRows = async () => (await crm.get(`/reports/${id}`, { ...range, export: '1' })).rows;
  return (
    <>
      <PageHead title="Reports" subtitle="Every figure is a documented query on the live database; the definition is shown with each report">
        {can('reports.export') && data && <ExportMenu name={`${id}-report-${range.from}-to-${range.to}`} title={`${data.title} · ${range.from} to ${range.to}`} columns={columns} load={exportRows} />}
      </PageHead>
      <div className="toolbar card" style={{ marginBottom: 12 }}>
        <select value={id} onChange={(e) => { setId(e.target.value); setSort(null); }} aria-label="Report">{Object.entries(me.reports).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <DateRange value={range} onChange={setRange} />
        <input type="search" placeholder="Search in this report" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search report" />
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {!data ? (loading ? <Loading /> : null) : (
        <>
          <p className="muted small"><strong>How it’s counted:</strong> {data.definition}</p>
          {chart && rows.length > 0 && (
            <section className="card" style={{ marginBottom: 14 }}>
              <div className="chart-box muted">
                <ResponsiveContainer>
                  <BarChart data={rows.slice(0, 60)} margin={{ left: 0, right: 8, top: 6 }}>
                    <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
                    <XAxis dataKey={chart[0]} stroke="currentColor" tick={{ fill: 'currentColor', fontSize: 11 }} minTickGap={12} tickFormatter={(v) => String(v).slice(0, 14)} />
                    <YAxis stroke="currentColor" tick={{ fill: 'currentColor', fontSize: 11 }} width={56} tickFormatter={(v) => (MONEY.includes(chart[1]) ? `₹${v >= 1000 ? `${Math.round(v / 1000)}k` : v}` : v)} />
                    <Tooltip formatter={(v) => show(chart[1], v)} contentStyle={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)' }} />
                    <Bar dataKey={chart[1]} name={label(chart[1])} fill="#2f5bff" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}
          <section className="card flush">
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>{columns.map((c) => <th key={c.key} className={typeof rows[0]?.[c.key] === 'number' ? 'num' : ''}><button type="button" onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>{c.label}{sort?.key === c.key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}</button></th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c.key} className={typeof r[c.key] === 'number' ? 'num' : ''}>{show(c.key, r[c.key])}</td>)}</tr>)}
                  {Object.keys(data.totals).length > 0 && rows.length > 0 && !q && (
                    <tr><td><strong>Total</strong></td>{columns.slice(1).map((c) => <td key={c.key} className="num"><strong>{c.key in data.totals ? show(c.key, data.totals[c.key]) : ''}</strong></td>)}</tr>
                  )}
                </tbody>
              </table>
            </div>
            {!rows.length && <p className="empty">No data in this range</p>}
          </section>
        </>
      )}
    </>
  );
}
