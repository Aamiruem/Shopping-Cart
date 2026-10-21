import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartCard, ChartTooltip, fmt, ModelNote, NotReady, StatTile } from '../charts/ChartParts';
import { axisProps, gridProps, INK, SERIES } from '../charts/theme';

export default function ForecastTab({ data }) {
  if (!data.ready) return <NotReady reason={data.reason} />;
  const { history, forecast, summary, metrics, model } = data;

  // One row per day: actual revenue for the past, forecast + interval for the future
  const rows = [
    ...history.map((h) => ({ date: h.date, actual: h.revenue })),
    ...forecast.map((f) => ({ date: f.date, forecast: f.yhat, band: [f.lo, f.hi] })),
  ];
  const beatsBaseline = metrics.improvementPct > 0;

  return (
    <div className="dash-grid">
      <div className="stat-row span-all">
        <StatTile label="Forecast · next 30 days" value={fmt.inr(summary.next30Revenue)} change={summary.expectedGrowthPct} />
        <StatTile label="Actual · last 30 days" value={fmt.inr(summary.last30Revenue)} hint="Completed orders only" />
        <StatTile label="Typical daily error" value={fmt.inr(metrics.mae)} hint={`Mean absolute error over the last ${metrics.holdoutDays} days`} />
        <StatTile
          label="vs. simple guess"
          value={beatsBaseline ? `${fmt.pct(metrics.improvementPct)} better` : `${fmt.pct(-metrics.improvementPct)} worse`}
          hint="Compared with “same weekday last week”"
        />
      </div>

      <ChartCard
        className="span-all"
        title="Revenue forecast"
        subtitle="Last 120 days of actual revenue and the next 30 days predicted, with a 95% range"
        table={{
          columns: [
            { key: 'date', label: 'Date' },
            { key: 'yhat', label: 'Forecast', numeric: true, format: fmt.inr },
            { key: 'lo', label: 'Low', numeric: true, format: fmt.inr },
            { key: 'hi', label: 'High', numeric: true, format: fmt.inr },
          ],
          rows: forecast,
        }}
      >
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" tickFormatter={fmt.shortDate} minTickGap={32} {...axisProps} />
            <YAxis tickFormatter={fmt.inrCompact} width={64} {...axisProps} />
            <Tooltip
              content={<ChartTooltip labelFormat={(d) => new Date(d).toDateString()}
                valueFormat={(v) => (Array.isArray(v) ? `${fmt.inrCompact(v[0])} – ${fmt.inrCompact(v[1])}` : fmt.inr(v))} />}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: INK.secondary }} />
            <ReferenceLine x={forecast[0].date} stroke={INK.axis} strokeDasharray="4 4" label={{ value: 'Today', fill: INK.muted, fontSize: 11, position: 'insideTopLeft' }} />
            <Area dataKey="band" name="95% range" stroke="none" fill={SERIES[1]} fillOpacity={0.15} isAnimationActive={false} />
            <Line dataKey="actual" name="Actual" stroke={SERIES[0]} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} />
            <Line dataKey="forecast" name="Forecast" stroke={SERIES[1]} strokeWidth={2} strokeDasharray="6 3" dot={false} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
        <ModelNote
          model={model}
          metrics={[
            { label: 'MAPE', value: fmt.pct(metrics.mape), help: 'Average % error per day on the last 28 days (lower is better)' },
            { label: 'Baseline error', value: fmt.inr(metrics.baselineMae), help: '“Same weekday last week” error' },
            { label: 'Validated on', value: `${metrics.holdoutDays} unseen days` },
          ]}
        />
      </ChartCard>
    </div>
  );
}
