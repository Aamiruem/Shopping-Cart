import Icon from '../common/Icon';
import { formatPrice } from '../../utils/format';

// Right-hand "PRICE DETAILS" summary used on cart and checkout
export default function PriceDetails({ cart, children }) {
  const count = cart.items.reduce((n, i) => n + i.qty, 0);
  return (
    <aside className="price-details panel">
      <h3>Price details</h3>
      <dl>
        <div><dt>Price ({count} item{count === 1 ? '' : 's'})</dt><dd>{formatPrice(cart.totalMrp)}</dd></div>
        <div><dt>Discount</dt><dd className="text-success">− {formatPrice(cart.discount)}</dd></div>
        <div>
          <dt>Delivery charges</dt>
          <dd className={cart.deliveryFee ? '' : 'text-success'}>{cart.deliveryFee ? formatPrice(cart.deliveryFee) : 'FREE'}</dd>
        </div>
        <div className="total-row"><dt>Total amount</dt><dd>{formatPrice(cart.total)}</dd></div>
      </dl>
      {cart.discount > 0 && <p className="savings">You will save {formatPrice(cart.discount)} on this order</p>}
      {children}
      <p className="safe-note"><Icon name="shield" size={16} /> Safe and secure payments. Easy returns. 100% authentic products.</p>
    </aside>
  );
}
