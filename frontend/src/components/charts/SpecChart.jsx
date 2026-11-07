import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ChartCard, ChartTooltip, donutLabel, fmt } from './ChartParts';
import Heatmap from './Heatmap';
import { axisProps, gridProps, INK, SERIES } from './theme';

// Draws a chart spec from the AI service - { type, title, x, y: [series], data } - with the store's chart
// rules: at most 3 series in the fixed colour order (never cycled), one y axis, legend for 2+ series,
// hover tooltips, and a table view. Wider data (more than 3 series) becomes a heatmap instead.
const MONEY = /revenue|total|value|price|sales|amount|aov|trend|rolling/i;
const RADIUS_TOP = [4, 4, 0, 0];
const RADIUS_RIGHT = [0, 4, 4, 0];

const label = (key) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?/.test(v);
const formatter = (key) => (MONEY.test(key) ? fmt.inr : (v) => (typeof v === 'number' ? fmt.num(v) : v));
const compact = (key) => (MONEY.test(key) ? fmt.inrCompact : (v) => fmt.num(v));
const dateTick = (v) => (isDate(v) && v.length >= 10 ? fmt.shortDate(v) : v);

function Plot({ spec, height }) {
  const { type, x, y, data } = spec;
  const series = y.slice(0, SERIES.length);
  const valueFormat = (v, entry) => formatter(entry?.dataKey || series[0])(v);
  const tooltip = <Tooltip content={<ChartTooltip labelFormat={(l) => (isDate(l) && l.length >= 10 ? new Date(l).toDateString() : l)} valueFormat={valueFormat} />} />;
  const legend = series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: INK.secondary }} />;

  if (type === 'line' || type === 'area') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={x} tickFormatter={dateTick} minTickGap={28} {...axisProps} />
          <YAxis tickFormatter={compact(series[0])} width={64} {...axisProps} />
          {tooltip}
          {legend}
          {series.map((s, i) => (
            <Line key={s} dataKey={s} name={label(s)} stroke={SERIES[i]} strokeWidth={2} dot={false} connectNulls
              strokeDasharray={/forecast|trend|backtest/.test(s) ? '6 3' : undefined} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'pie' && data.length <= SERIES.length) {
    const total = data.reduce((sum, r) => sum + (Number(r[series[0]]) || 0), 0);
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey={series[0]} nameKey={x} innerRadius="45%" outerRadius="65%" paddingAngle={2} stroke="#fff" strokeWidth={2}
            label={donutLabel(total, x)} labelLine={false} isAnimationActive={false}>
            {data.map((r, i) => <Cell key={r[x]} fill={SERIES[i]} />)}
          </Pie>
          <Tooltip content={<ChartTooltip valueFormat={(v) => formatter(series[0])(v)} />} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'scatter') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid {...gridProps} vertical />
          <XAxis type="number" dataKey={x} name={label(x)} tickFormatter={compact(x)} {...axisProps} />
          <YAxis type="number" dataKey={series[0]} name={label(series[0])} tickFormatter={compact(series[0])} width={56} {...axisProps} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<ChartTooltip valueFormat={(v, entry) => formatter(entry?.dataKey === x ? x : series[0])(v)} />} />
          <Scatter data={data} fill={SERIES[0]} fillOpacity={0.7} stroke="#fff" strokeWidth={1} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  // Bars (and pies with too many slices for distinct colours): horizontal when labels are long or many
  // ...unless the spec asks for columns (e.g. a histogram, whose ranges read left to right)
  const horizontal = spec.orientation !== 'vertical' && (data.length > 8 || data.some((r) => String(r[x]).length > 12));
  return (
    <ResponsiveContainer width="100%" height={horizontal ? Math.max(height, data.length * 26 + 40) : height}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 16, left: 4, bottom: 0 }} barGap={2}>
        <CartesianGrid {...gridProps} vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tickFormatter={compact(series[0])} {...axisProps} />
            <YAxis type="category" dataKey={x} width={150} interval={0} tickFormatter={(v) => (String(v).length > 22 ? `${String(v).slice(0, 21)}…` : v)} {...axisProps} />
          </>
        ) : (
          <>
            <XAxis dataKey={x} tickFormatter={dateTick} interval={data.length > 16 ? 'preserveStartEnd' : 0} {...axisProps} />
            <YAxis tickFormatter={compact(series[0])} width={64} {...axisProps} />
          </>
        )}
        {tooltip}
        {legend}
        {series.map((s, i) => (
          <Bar key={s} dataKey={s} name={label(s)} fill={SERIES[i]} radius={horizontal ? RADIUS_RIGHT : RADIUS_TOP} maxBarSize={36} stroke="#fff" strokeWidth={series.length > 1 ? 2 : 0} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function SpecChart({ spec, subtitle, height = 300, className = '', footer }) {
  if (!spec?.data?.length) return null;
  const columns = [spec.x, ...spec.y].map((key, i) => ({ key, label: label(key), numeric: i > 0, format: i > 0 ? formatter(key) : undefined }));
  const wide = spec.y.length > SERIES.length;

  return (
    <ChartCard className={className} title={spec.title} subtitle={subtitle} table={{ columns, rows: spec.data }}>
      {wide ? (
        <Heatmap
          rows={spec.data.map((r) => r[spec.x])}
          cols={spec.y}
          cells={spec.data.flatMap((r) => spec.y.map((c) => ({ row: r[spec.x], col: c, value: r[c] })))}
          formatValue={(v) => fmt.num(v)}
          labelEvery={1}
          describe={spec.title}
        />
      ) : (
        <Plot spec={spec} height={height} />
      )}
      {footer}
    </ChartCard>
  );
}
