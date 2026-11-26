import { PREVIEW } from '../../config';
import { discountPercent, formatPrice } from '../../utils/format';

// Selling price, struck-through MRP and "% off" in one line
export default function Price({ price, mrp, size = 'md' }) {
  // Unverified Coming Soon products have no confirmed price yet, so none is shown
  if (price === null || price === undefined) return <div className={`price price-${size}`}><span className="price-tba">Price at launch</span></div>;
  const off = PREVIEW ? 0 : discountPercent(price, mrp); // sample prices have no real discount to show
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
