const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// PostgreSQL NUMERIC columns arrive as strings, so always coerce first
export const formatPrice = (value) => inr.format(Number(value) || 0);

export const discountPercent = (price, mrp) => (mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0);

export const formatDate = (value, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(value).toLocaleDateString('en-IN', opts);

export const formatCount = (n) => new Intl.NumberFormat('en-IN').format(n || 0);

export function deliveryDate(daysFromNow = 3) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return formatDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
}
