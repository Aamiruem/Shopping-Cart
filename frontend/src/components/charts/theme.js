// Chart colour roles. Categorical slots are used in this fixed order (never cycled) - the order
// itself is what keeps adjacent series distinguishable for colour-blind readers. Validated against
// the white panel surface (#ffffff); slot 3 is below 3:1, so charts using it always show labels.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];

// Single-hue blue ramp for magnitude (heatmaps) and ordered stages (funnel)
export const SEQUENTIAL = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281'];
export const ORDINAL = ['#86b6ef', '#3987e5', '#1c5cab'];

// Reserved for state (always paired with an icon + label, never used as a series colour)
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };

export const INK = {
  primary: '#0b0b0b',
  secondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  goodText: '#006300',
};

// Shared Recharts props for recessive axes and hairline grids
export const axisProps = {
  stroke: INK.axis,
  tick: { fill: INK.muted, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: INK.axis },
};
export const gridProps = { stroke: INK.grid, strokeDasharray: '0', vertical: false };

// Picks a sequential step for a value in [0, max]
export function sequential(value, max) {
  if (!max || value <= 0) return '#f3f4f6';
  const i = Math.min(SEQUENTIAL.length - 1, Math.floor((value / max) * (SEQUENTIAL.length - 1)));
  return SEQUENTIAL[i];
}
