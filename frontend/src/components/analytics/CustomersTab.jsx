import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { ChartCard, ChartTooltip, DataTable, fmt, ModelNote, NotReady, StatTile } from '../charts/ChartParts';
import Heatmap from '../charts/Heatmap';
import { axisProps, gridProps, INK, SERIES, STATUS } from '../charts/theme';

const SEGMENT_ORDER = ['Champions', 'Loyal', 'Needs attention', 'At risk'];

// One small scatter per segment (same axes) instead of four colours on one plot
function SegmentScatter({ name, points, maxRecency, maxSpend }) {
  return (
    <div className="mini-chart">
      <p className="mini-title">{name} <span className="muted">· {points.length} shown</span></p>
      <ResponsiveContainer width="100%" height={150}>
        <ScatterChart margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid {...gridProps} vertical />
          <XAxis type="number" dataKey="recency" domain={[0, maxRecency]} name="Days since last order" {...axisProps} />
          <YAxis type="number" dataKey="monetary" domain={[0, maxSpend]} scale="sqrt" tickFormatter={fmt.inrCompact} {...axisProps} width={56} />
          <ZAxis dataKey="frequency" range={[16, 90]} name="Orders" />
          <Tooltip content={({ active, payload }) => active && payload?.length ? (
            <div className="chart-tooltip">
              <p className="chart-tooltip-row"><span>Last order</span><strong>{payload[0].payload.recency} days ago</strong></p>
              <p className="chart-tooltip-row"><span>Orders</span><strong>{payload[0].payload.frequency}</strong></p>
              <p className="chart-tooltip-row"><span>Total spend</span><strong>{fmt.inr(payload[0].payload.monetary)}</strong></p>
            </div>
          ) : null} />
          <Scatter data={points} fill={SERIES[0]} fillOpacity={0.55} stroke="#fff" strokeWidth={1} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function CustomersTab({ data }) {
  const { segments, churn, cohorts } = data;

  return (
    <div className="dash-grid">
      {segments.ready ? (
        <>
          <ChartCard
            className="span-2"
            title="Customer segments"
            subtitle="Grouped by how recently, how often and how much they buy (RFM)"
            table={{
              columns: [
                { key: 'segment', label: 'Segment' },
                { key: 'customers', label: 'Customers', numeric: true },
                { key: 'avgOrders', label: 'Avg. orders', numeric: true },
                { key: 'avgSpend', label: 'Avg. spend', numeric: true, format: fmt.inr },
                { key: 'avgRecencyDays', label: 'Days since last order', numeric: true },
              ],
              rows: segments.segments,
            }}
          >
            <div className="segment-cards">
              {segments.segments.map((s) => (
                <div key={s.segment} className="segment-card">
                  <p className="segment-name">{s.segment}</p>
                  <p className="segment-count">{fmt.num(s.customers)} <span className="muted small">customers</span></p>
                  <dl>
                    <div><dt>Revenue</dt><dd>{fmt.inrCompact(s.revenue)}</dd></div>
                    <div><dt>Avg. spend</dt><dd>{fmt.inr(s.avgSpend)}</dd></div>
                    <div><dt>Avg. orders</dt><dd>{s.avgOrders}</dd></div>
                    <div><dt>Last order</dt><dd>{Math.round(s.avgRecencyDays)} days ago</dd></div>
                  </dl>
                  <p className="segment-advice">{s.advice}</p>
                </div>
              ))}
            </div>
            <ModelNote model={segments.model} metrics={[{ label: 'Silhouette', value: segments.silhouette, help: 'Cluster separation: -1 (poor) to 1 (perfect); 0.25+ is reasonable for customer data' }]} />
          </ChartCard>

          <ChartCard title="Revenue by segment">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={segments.segments} margin={{ top: 20, right: 8, left: -4, bottom: 0 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="segment" {...axisProps} interval={0} tick={{ ...axisProps.tick, fontSize: 10 }} />
                <YAxis tickFormatter={fmt.inrCompact} {...axisProps} width={56} />
                <Tooltip content={<ChartTooltip valueFormat={fmt.inr} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
                <Bar dataKey="revenue" name="Revenue" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={44}>
                  <LabelList dataKey="revenue" position="top" formatter={fmt.inrCompact} fill={INK.secondary} fontSize={11} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard className="span-all" title="Recency, frequency & spend by segment" subtitle="Each dot is a customer; bigger dots ordered more often">
            <div className="small-multiples">
              {SEGMENT_ORDER.filter((name) => segments.points.some((p) => p.segment === name)).map((name) => (
                <SegmentScatter
                  key={name}
                  name={name}
                  points={segments.points.filter((p) => p.segment === name)}
                  maxRecency={Math.max(...segments.points.map((p) => p.recency))}
                  maxSpend={Math.max(...segments.points.map((p) => p.monetary))}
                />
              ))}
            </div>
          </ChartCard>
        </>
      ) : <div className="span-all"><NotReady reason={segments.reason} /></div>}

      {churn.ready ? (
        <>
          <div className="stat-row span-all">
            <StatTile label="Customers likely to churn" value={fmt.num(churn.atRiskCustomers)} hint="Churn probability ≥ 50%" />
            <StatTile label="Lifetime revenue at risk" value={fmt.inr(churn.atRiskRevenue)} hint="What these customers have spent so far" />
            <StatTile label="Historical churn rate" value={fmt.pct(churn.metrics.historicalChurnRate)} hint="No order within 45 days" />
            <StatTile label="Model accuracy (AUC)" value={churn.metrics.auc} hint="0.5 = guessing, 1.0 = perfect" />
          </div>

          <ChartCard title="Churn risk distribution" subtitle="Customers by predicted probability of not ordering in the next 45 days"
            table={{ columns: [{ key: 'bucket', label: 'Probability' }, { key: 'customers', label: 'Customers', numeric: true }], rows: churn.distribution }}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={churn.distribution} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap={2}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="bucket" {...axisProps} interval={1} />
                <YAxis {...axisProps} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
                <Bar dataKey="customers" name="Customers" radius={[4, 4, 0, 0]}>
                  {churn.distribution.map((d, i) => <Cell key={d.bucket} fill={i >= 5 ? STATUS.serious : SERIES[0]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="chart-footnote"><span className="legend-key" style={{ background: STATUS.serious }} /> At risk (≥ 50%) &nbsp; <span className="legend-key" style={{ background: SERIES[0] }} /> Likely to stay</p>
          </ChartCard>

          <ChartCard title="What predicts churn" subtitle="Feature importance in the random forest">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={churn.featureImportance.slice(0, 7).map((f) => ({ ...f, pct: f.importance * 100 }))} layout="vertical" margin={{ top: 4, right: 44, left: 8, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="feature" width={160} {...axisProps} axisLine={false} interval={0} />
                <Tooltip content={<ChartTooltip valueFormat={(v) => fmt.pct(v)} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
                <Bar dataKey="pct" name="Importance" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={12}>
                  <LabelList dataKey="pct" position="right" formatter={(v) => fmt.pct(v, 0)} fill={INK.secondary} fontSize={11} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <ModelNote model={churn.model} metrics={[
              { label: 'Precision', value: fmt.pct(churn.metrics.precision * 100, 0), help: 'Of customers flagged, how many really lapsed' },
              { label: 'Recall', value: fmt.pct(churn.metrics.recall * 100, 0), help: 'Of customers who lapsed, how many were flagged' },
            ]} />
          </ChartCard>

          <ChartCard className="span-all" title="Win these customers back" subtitle="Highest-value customers most likely to churn - send them an offer">
            <DataTable
              columns={[
                { key: 'name', label: 'Customer' },
                { key: 'email', label: 'Email', format: (v) => v || '—' },
                { key: 'segment', label: 'Segment', format: (v) => v || '—' },
                { key: 'orders', label: 'Orders', numeric: true },
                { key: 'lifetimeValue', label: 'Lifetime value', numeric: true, format: fmt.inr },
                { key: 'lastOrderDays', label: 'Last order', numeric: true, format: (v) => `${v} days ago` },
                { key: 'churnProbability', label: 'Churn risk', numeric: true, format: (v) => <span className="risk" style={{ '--risk': `${v * 100}%` }}>{fmt.pct(v * 100, 0)}</span> },
              ]}
              rows={churn.atRisk}
            />
          </ChartCard>
        </>
      ) : <div className="span-all"><NotReady reason={churn.reason} /></div>}

      {cohorts.length > 0 && (
        <ChartCard className="span-all" title="Cohort retention" subtitle="Of customers whose first order was in a month, the % who ordered again in later months"
          table={{ columns: [{ key: 'cohort', label: 'First order' }, { key: 'size', label: 'Customers', numeric: true },
            ...[1, 2, 3, 4, 5].map((m) => ({ key: `m${m}`, label: `Month ${m}`, numeric: true, format: (v) => fmt.pct(v, 0) }))],
          rows: cohorts.map((c) => ({ ...c, ...Object.fromEntries(c.retention.map((v, i) => [`m${i}`, v])) })) }}>
          <Heatmap
            rows={cohorts.map((c) => c.cohort)}
            cols={[1, 2, 3, 4, 5]}
            cells={cohorts.flatMap((c) => c.retention.slice(1).map((v, i) => ({ row: c.cohort, col: i + 1, value: v })))}
            rowLabel={(r) => new Date(`${r}-01`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })}
            colLabel={(c) => `Month +${c}`}
            labelEvery={1}
            formatValue={(v) => `${v}% came back`}
            describe="Cohort retention heatmap"
          />
        </ChartCard>
      )}
    </div>
  );
}
