import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { categoryLabel } from '../../constants/catalog';
import { ChartCard, ChartTooltip, donutLabel, fmt, StatTile } from '../charts/ChartParts';
import Heatmap from '../charts/Heatmap';
import { axisProps, gridProps, INK, ORDINAL, SERIES } from '../charts/theme';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
const BAR_RADIUS_RIGHT = [0, 4, 4, 0];
const BAR_RADIUS_TOP = [4, 4, 0, 0];

export default function OverviewTab({ data }) {
  const { kpis, trend, categories, heatmap, funnel, newVsReturning, orderValueDistribution, paymentMix, topProducts, cities } = data;
  const categoryRows = categories.map((c) => ({ ...c, label: categoryLabel(c.category) }));
  const funnelRows = funnel.map((f, i) => ({ ...f, rate: i === 0 || !funnel[0].users ? 100 : (f.users / funnel[0].users) * 100 }));
  const paymentTotal = paymentMix.reduce((s, p) => s + p.orders, 0);
  const paymentRows = paymentMix.map((p) => ({ ...p, short: p.method === 'Cash on delivery' ? 'COD' : p.method }));

  return (
    <div className="dash-grid">
      <div className="stat-row span-all">
        <StatTile label="Revenue" value={fmt.inr(kpis.revenue)} change={kpis.changes.revenue} />
        <StatTile label="Orders" value={fmt.num(kpis.orders)} change={kpis.changes.orders} />
        <StatTile label="Avg. order value" value={fmt.inr(kpis.avgOrderValue)} change={kpis.changes.avgOrderValue} />
        <StatTile label="Customers" value={fmt.num(kpis.customers)} change={kpis.changes.customers} />
        <StatTile label="New customers" value={fmt.num(kpis.newCustomers)} hint="First order in this period" />
        <StatTile label="Cancellation rate" value={fmt.pct(kpis.cancelRate)} hint="Share of orders cancelled" />
      </div>

      <ChartCard
        className="span-2"
        title="Revenue per day"
        subtitle="Daily revenue (bars) with the 7-day moving average (line)"
        table={{ columns: [{ key: 'date', label: 'Date' }, { key: 'orders', label: 'Orders', numeric: true }, { key: 'revenue', label: 'Revenue', numeric: true, format: fmt.inr }], rows: trend }}
      >
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={trend} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" tickFormatter={fmt.shortDate} minTickGap={24} {...axisProps} />
            <YAxis tickFormatter={fmt.inrCompact} width={64} {...axisProps} />
            <Tooltip content={<ChartTooltip labelFormat={(d) => new Date(d).toDateString()} valueFormat={fmt.inr} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: INK.secondary }} />
            <Bar dataKey="revenue" name="Daily revenue" fill={SERIES[0]} fillOpacity={0.35} radius={BAR_RADIUS_TOP} maxBarSize={18} />
            <Line dataKey="avg7" name="7-day average" stroke={SERIES[1]} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Revenue by category" table={{ columns: [{ key: 'label', label: 'Category' }, { key: 'units', label: 'Units', numeric: true }, { key: 'revenue', label: 'Revenue', numeric: true, format: fmt.inr }], rows: categoryRows }}>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={categoryRows} layout="vertical" margin={{ top: 4, right: 56, left: 8, bottom: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="label" width={110} {...axisProps} axisLine={false} />
            <Tooltip content={<ChartTooltip valueFormat={fmt.inr} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Bar dataKey="revenue" name="Revenue" fill={SERIES[0]} radius={BAR_RADIUS_RIGHT} barSize={14}>
              <LabelList dataKey="revenue" position="right" formatter={fmt.inrCompact} fill={INK.secondary} fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard className="span-2" title="When customers order" subtitle="Orders by weekday and hour (store time)">
        <Heatmap
          rows={DAYS.map((_, i) => i)}
          cols={HOURS}
          cells={heatmap.map((h) => ({ row: h.dayIndex, col: h.hour, value: h.orders }))}
          rowLabel={(r) => DAYS[r]}
          colLabel={hourLabel}
          formatValue={(v) => `${v} orders`}
          describe="Heatmap of orders by weekday and hour"
        />
      </ChartCard>

      <ChartCard title="Conversion funnel" subtitle="Shoppers at each step in this period" table={{ columns: [{ key: 'stage', label: 'Stage' }, { key: 'users', label: 'Shoppers', numeric: true }, { key: 'rate', label: '% of viewers', numeric: true, format: (v) => fmt.pct(v) }], rows: funnelRows }}>
        {funnelRows.length ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={funnelRows} layout="vertical" margin={{ top: 4, right: 76, left: 0, bottom: 0 }}>
              <XAxis type="number" hide domain={[0, 'dataMax']} />
              <YAxis type="category" dataKey="stage" width={96} {...axisProps} axisLine={false} />
              <Tooltip content={<ChartTooltip valueFormat={fmt.num} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
              <Bar dataKey="users" name="Shoppers" radius={BAR_RADIUS_RIGHT} barSize={28}>
                {funnelRows.map((f, i) => <Cell key={f.stage} fill={ORDINAL[i]} />)}
                <LabelList dataKey="users" position="right" fill={INK.secondary} fontSize={11}
                  content={({ x, y, width, height, index }) => (
                    <text x={x + width + 6} y={y + height / 2} fill={INK.secondary} fontSize={11} dominantBaseline="central">
                      {fmt.num(funnelRows[index].users)} · {fmt.pct(funnelRows[index].rate, 0)}
                    </text>
                  )} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : <p className="muted">No shopper activity yet.</p>}
        {funnelRows.length > 2 && (
          <p className="chart-footnote">{fmt.pct(funnelRows[2].rate)} of shoppers who viewed a product went on to buy.</p>
        )}
      </ChartCard>

      <ChartCard title="New vs returning orders" subtitle="Orders per week" table={{ columns: [{ key: 'week', label: 'Week of' }, { key: 'new', label: 'New', numeric: true }, { key: 'returning', label: 'Returning', numeric: true }], rows: newVsReturning }}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={newVsReturning} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="week" {...axisProps} minTickGap={8} />
            <YAxis {...axisProps} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Legend wrapperStyle={{ fontSize: 12, color: INK.secondary }} />
            <Bar dataKey="returning" name="Returning" stackId="a" fill={SERIES[0]} stroke="#fff" strokeWidth={2} maxBarSize={36} />
            <Bar dataKey="new" name="New" stackId="a" fill={SERIES[1]} stroke="#fff" strokeWidth={2} radius={BAR_RADIUS_TOP} maxBarSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Order value distribution" subtitle="How much customers spend per order" table={{ columns: [{ key: 'range', label: 'Order value' }, { key: 'orders', label: 'Orders', numeric: true }], rows: orderValueDistribution }}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={orderValueDistribution} margin={{ top: 16, right: 8, left: -12, bottom: 0 }} barCategoryGap={2}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="range" {...axisProps} interval={0} angle={-30} textAnchor="end" height={48} />
            <YAxis {...axisProps} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Bar dataKey="orders" name="Orders" fill={SERIES[0]} radius={BAR_RADIUS_TOP} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Payment methods" table={{ columns: [{ key: 'method', label: 'Method' }, { key: 'orders', label: 'Orders', numeric: true }], rows: paymentMix }}>
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={paymentRows} dataKey="orders" nameKey="method" innerRadius="45%" outerRadius="65%" paddingAngle={2} stroke="#fff" strokeWidth={2}
              label={donutLabel(paymentTotal, 'short')} labelLine={false}>
              {paymentMix.map((p, i) => <Cell key={p.method} fill={SERIES[i % SERIES.length]} />)}
            </Pie>
            <Tooltip content={<ChartTooltip valueFormat={(v) => `${fmt.num(v)} orders`} />} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Top cities" table={{ columns: [{ key: 'city', label: 'City' }, { key: 'orders', label: 'Orders', numeric: true }], rows: cities }}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={cities} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="city" width={84} {...axisProps} axisLine={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Bar dataKey="orders" name="Orders" fill={SERIES[0]} radius={BAR_RADIUS_RIGHT} barSize={12}>
              <LabelList dataKey="orders" position="right" fill={INK.secondary} fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard className="span-2" title="Top products by revenue">
        <ol className="rank-list">
          {topProducts.map((p, i) => (
            <li key={p.productId}>
              <span className="rank">{i + 1}</span>
              <span className="rank-name">{p.name}</span>
              <span className="rank-bar"><span style={{ width: `${(p.revenue / topProducts[0].revenue) * 100}%` }} /></span>
              <span className="num">{fmt.num(p.units)} sold</span>
              <strong className="num">{fmt.inr(p.revenue)}</strong>
            </li>
          ))}
        </ol>
      </ChartCard>
    </div>
  );
}
