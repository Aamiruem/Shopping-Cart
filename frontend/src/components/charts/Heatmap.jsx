import { useState } from 'react';
import { sequential } from './theme';

// Grid heatmap (rows x columns) with a single-hue sequential scale and a hover readout.
// cells: [{ row, col, value }]
export default function Heatmap({ rows, cols, cells, formatValue = (v) => v, colLabel = (c) => c, rowLabel = (r) => r, labelEvery = 3, describe }) {
  const [hover, setHover] = useState(null);
  const lookup = new Map(cells.map((c) => [`${c.row}|${c.col}`, c.value]));
  const max = Math.max(0, ...cells.map((c) => c.value ?? 0));

  return (
    <div className="heatmap">
      <div className="heatmap-grid" style={{ gridTemplateColumns: `56px repeat(${cols.length}, minmax(14px, 1fr))` }} role="img" aria-label={describe}>
        <span />
        {cols.map((c, i) => <span key={c} className="heatmap-col">{i % labelEvery === 0 ? colLabel(c) : ''}</span>)}
        {rows.map((r) => (
          <div key={r} className="heatmap-row" style={{ display: 'contents' }}>
            <span className="heatmap-rowlabel">{rowLabel(r)}</span>
            {cols.map((c) => {
              const v = lookup.get(`${r}|${c}`);
              return (
                <span
                  key={c}
                  className="heatmap-cell"
                  style={{ background: v == null ? 'transparent' : sequential(v, max) }}
                  onMouseEnter={() => setHover({ r, c, v })}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="heatmap-foot">
        <span className="muted small">{hover ? `${rowLabel(hover.r)} · ${colLabel(hover.c)}: ${hover.v == null ? '—' : formatValue(hover.v)}` : 'Hover a cell for details'}</span>
        <span className="heatmap-scale">
          <span className="muted small">Less</span>
          {[0.05, 0.25, 0.5, 0.75, 1].map((f) => <span key={f} style={{ background: sequential(f * max, max) }} />)}
          <span className="muted small">More</span>
        </span>
      </div>
    </div>
  );
}
