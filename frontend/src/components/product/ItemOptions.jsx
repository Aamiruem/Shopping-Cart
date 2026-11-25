// The size and colour a shopper chose, shown on cart, checkout and order lines. Accepts either the cart's
// { size, color } or an order item's `options` object; renders nothing for products without options.
export default function ItemOptions({ size, color, options, className = 'muted small' }) {
  const s = size ?? options?.size;
  const c = color ?? options?.color;
  if (!s && !c) return null;
  return (
    <p className={`item-options ${className}`}>
      {s && <span>Size <strong>{s}</strong></span>}
      {s && c && ' · '}
      {c && <span>Colour <strong>{c}</strong></span>}
    </p>
  );
}
