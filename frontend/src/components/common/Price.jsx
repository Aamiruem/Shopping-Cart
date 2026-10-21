import { discountPercent, formatPrice } from '../../utils/format';

// Selling price, struck-through MRP and "% off" in one line
export default function Price({ price, mrp, size = 'md' }) {
  const off = discountPercent(price, mrp);
  return (
    <div className={`price price-${size}`}>
      <span className="price-now">{formatPrice(price)}</span>
      {off > 0 && (
        <>
          <span className="price-mrp">{formatPrice(mrp)}</span>
          <span className="price-off">{off}% off</span>
        </>
      )}
    </div>
  );
}
