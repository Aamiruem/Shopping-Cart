import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, LabelList, Legend, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { categoryLabel } from '../../constants/catalog';
import Icon from '../common/Icon';
import { ChartCard, ChartTooltip, fmt, ModelNote, NotReady } from '../charts/ChartParts';
import { axisProps, gridProps, INK, SERIES, STATUS } from '../charts/theme';

const shortName = (name) => (name.length > 22 ? `${name.slice(0, 21)}…` : name);

function StockStatus({ days }) {
  if (days < 1) return <span className="status-pill" style={{ '--status': STATUS.critical }}><Icon name="x" size={12} /> Out of stock</span>;
  const level = days < 7 ? { label: 'Critical', color: STATUS.critical, icon: 'zap' } : { label: 'Low', color: STATUS.serious, icon: 'clock' };
  return (
    <span className="status-pill" style={{ '--status': level.color }}>
      <Icon name={level.icon} size={12} /> {level.label} · {Math.round(days)} days left
    </span>
  );
}

export default function ProductsTab({ data }) {
  if (!data.ready) return <NotReady reason={data.reason} />;
  const { top, rising, restock, featureImportance, priceVsUnits, metrics, model, horizonDays } = data;
  const top10 = top.slice(0, 10).map((p) => ({ ...p, label: shortName(p.name) }));
  const features = featureImportance.slice(0, 8).map((f) => ({ ...f, pct: f.importance * 100 }));
  const scatter = priceVsUnits.filter((p) => p.units > 0);

  return (
    <div className="dash-grid">
      <ChartCard
        className="span-2"
        title={`Predicted best sellers · next ${horizonDays} days`}
        subtitle="Units sold in the last 30 days vs units the model expects next"
        table={{
          columns: [
            { key: 'name', label: 'Product' },
            { key: 'last30Units', label: 'Last 30 days', numeric: true },
            { key: 'predictedUnits', label: 'Predicted', numeric: true, format: (v) => v.toFixed(1) },
            { key: 'stock', label: 'Stock', numeric: true },
          ],
          rows: top,
        }}
      >
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={top10} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }} barGap={2}>
            <CartesianGrid {...gridProps} horizontal={false} vertical />
            <XAxis type="number" {...axisProps} />
            <YAxis type="category" dataKey="label" width={160} {...axisProps} axisLine={false} interval={0} />
            <Tooltip content={<ChartTooltip labelFormat={(_, p) => p?.[0]?.payload?.name} valueFormat={(v) => `${Number(v).toFixed(1)} units`} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Legend wrapperStyle={{ fontSize: 12, color: INK.secondary }} />
            <Bar dataKey="last30Units" name="Sold, last 30 days" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={9} />
            <Bar dataKey="predictedUnits" name={`Predicted, next ${horizonDays} days`} fill={SERIES[1]} radius={[0, 4, 4, 0]} barSize={9}>
              <LabelList dataKey="predictedUnits" position="right" formatter={(v) => v.toFixed(0)} fill={INK.secondary} fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <ModelNote
          model={model}
          metrics={[
            { label: 'R²', value: metrics.r2, help: 'Share of the variation in future sales the model explains (1 = perfect)' },
            { label: 'Top-10 hit rate', value: fmt.pct(metrics.top10HitRate * 100, 0), help: 'How many of the real top 10 it predicted' },
            { label: 'vs. “same as last month”', value: `${metrics.improvementPct > 0 ? '+' : ''}${fmt.pct(metrics.improvementPct)}` },
            { label: 'Trained on', value: `${fmt.num(metrics.trainingSamples)} samples` },
          ]}
        />
      </ChartCard>

      <ChartCard title="What drives the prediction" subtitle="Feature importance in the model">
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={features} layout="vertical" margin={{ top: 4, right: 44, left: 8, bottom: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="feature" width={150} {...axisProps} axisLine={false} interval={0} />
            <Tooltip content={<ChartTooltip valueFormat={(v) => fmt.pct(v)} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Bar dataKey="pct" name="Importance" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={12}>
              <LabelList dataKey="pct" position="right" formatter={(v) => fmt.pct(v, 0)} fill={INK.secondary} fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Trending up" subtitle="Biggest expected growth vs last 30 days">
        {rising.length ? (
          <ul className="insight-list">
            {rising.map((p) => (
              <li key={p.productId}>
                <img src={p.image} alt="" />
                <Link to={`/products/${p.productId}`} className="insight-name">{p.name}<small>{categoryLabel(p.category)}</small></Link>
                <span className="growth-up">▲ {fmt.pct(p.growthPct, 0)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No product is growing sharply right now.</p>}
      </ChartCard>

      <ChartCard title="Restock soon" subtitle="Stock will run out within 3 weeks at the predicted pace">
        {restock.length ? (
          <ul className="insight-list">
            {restock.map((p) => (
              <li key={p.productId}>
                <img src={p.image} alt="" />
                <span className="insight-name">{p.name}<small>{p.stock} in stock · ~{p.predictedUnits.toFixed(0)} expected sales</small></span>
                <StockStatus days={p.daysOfStock} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="ok-note"><Icon name="check" size={16} /> All fast-moving products have enough stock.</p>
        )}
      </ChartCard>

      <ChartCard title="Price vs units sold" subtitle="Each dot is a product (last 30 days, log price scale)"
        table={{ columns: [{ key: 'name', label: 'Product' }, { key: 'price', label: 'Price', numeric: true, format: fmt.inr }, { key: 'units', label: 'Units', numeric: true }], rows: scatter }}>
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
            <CartesianGrid {...gridProps} vertical />
            <XAxis type="number" dataKey="price" name="Price" scale="log" domain={['auto', 'auto']} tickFormatter={fmt.inrCompact} {...axisProps} />
            <YAxis type="number" dataKey="units" name="Units sold" {...axisProps} />
            <ZAxis range={[60, 60]} />
            <Tooltip content={({ active, payload }) => active && payload?.length ? (
              <div className="chart-tooltip">
                <p className="chart-tooltip-label">{payload[0].payload.name}</p>
                <p className="chart-tooltip-row"><span>{categoryLabel(payload[0].payload.category)}</span></p>
                <p className="chart-tooltip-row"><span>Price</span><strong>{fmt.inr(payload[0].payload.price)}</strong></p>
                <p className="chart-tooltip-row"><span>Units sold</span><strong>{payload[0].payload.units}</strong></p>
              </div>
            ) : null} />
            <Scatter data={scatter} fill={SERIES[0]} fillOpacity={0.7} stroke="#fff" strokeWidth={1} />
          </ScatterChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
