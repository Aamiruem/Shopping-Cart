import { useState } from 'react';
import Icon from '../common/Icon';

// Building blocks shared by every dashboard chart

const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export const fmt = {
  inr: (v) => inr.format(Number(v) || 0),
  inrCompact: (v) => `₹${compact.format(Number(v) || 0)}`,
  num: (v) => new Intl.NumberFormat('en-IN').format(Math.round(Number(v) || 0)),
  compact: (v) => compact.format(Number(v) || 0),
  pct: (v, digits = 1) => (v == null ? '—' : `${Number(v).toFixed(digits)}%`),
  shortDate: (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
};

// A white card with title, optional subtitle and a chart / table toggle (the accessible view of every chart)
export function ChartCard({ title, subtitle, table, actions, children, className = '' }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className={`chart-card panel ${className}`}>
      <header className="chart-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="muted small">{subtitle}</p>}
        </div>
        <div className="chart-card-actions">
          {actions}
          {table && (
            <button type="button" className="btn-link small" onClick={() => setShowTable((s) => !s)} aria-pressed={showTable}>
              {showTable ? 'Chart' : 'Table'}
            </button>
          )}
        </div>
      </header>
      {showTable && table ? <DataTable {...table} /> : children}
    </section>
  );
}

export function DataTable({ columns, rows }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.numeric ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((c) => <td key={c.key} className={c.numeric ? 'num' : ''}>{c.format ? c.format(r[c.key], r) : r[c.key]}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Recharts tooltip with our styling: label on top, one row per series with its colour key
export function ChartTooltip({ active, payload, label, labelFormat, valueFormat }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      {label != null && <p className="chart-tooltip-label">{labelFormat ? labelFormat(label, payload) : label}</p>}
      {payload.filter((p) => p.value != null).map((p) => (
        <p key={p.dataKey || p.name} className="chart-tooltip-row">
          <span className="key" style={{ background: p.color || p.payload?.fill }} />
          <span>{p.name}</span>
          <strong>{valueFormat ? valueFormat(p.value, p) : p.value}</strong>
        </p>
      ))}
    </div>
  );
}

// Donut slice label in ink colour (the slice itself carries the colour)
export function donutLabel(total, nameKey) {
  return function Label({ cx, cy, midAngle, outerRadius, payload, value }) {
    const r = outerRadius + 14;
    const x = cx + r * Math.cos((-midAngle * Math.PI) / 180);
    const y = cy + r * Math.sin((-midAngle * Math.PI) / 180);
    return (
      <text x={x} y={y} fill="#52514e" fontSize={11} textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central">
        {payload[nameKey]} {total ? Math.round((value / total) * 100) : 0}%
      </text>
    );
  };
}

// Headline number with change versus the previous period
export function StatTile({ label, value, change, hint }) {
  const up = change > 0;
  return (
    <div className="stat-tile panel">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {change != null ? (
        <p className={`stat-change ${up ? 'up' : change < 0 ? 'down' : ''}`}>
          <span aria-hidden="true">{up ? '▲' : change < 0 ? '▼' : '•'}</span> {up ? '+' : change < 0 ? '−' : ''}
          {Math.abs(change).toFixed(1)}% vs previous period
        </p>
      ) : (
        hint && <p className="stat-change">{hint}</p>
      )}
    </div>
  );
}

// Small "how good is this model" strip shown under every ML chart
export function ModelNote({ model, metrics }) {
  return (
    <div className="model-note">
      <span className="model-chip"><Icon name="zap" size={12} /> {model}</span>
      {metrics.map((m) => (
        <span key={m.label} className="model-metric" title={m.help}>
          {m.label}: <strong>{m.value}</strong>
        </span>
      ))}
    </div>
  );
}

export function NotReady({ reason }) {
  return (
    <div className="not-ready">
      <Icon name="clock" size={28} strokeWidth={1.5} />
      <p>{reason || 'Not enough data yet.'}</p>
      <p className="muted small">Predictions appear automatically once your store has more sales history.</p>
    </div>
  );
}
