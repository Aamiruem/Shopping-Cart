import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useCart } from '../../context/CartContext';
import useShopActions from '../../hooks/useShopActions';
import { deliveryDate, formatPrice } from '../../utils/format';
import Icon from '../common/Icon';
import { useOnlinePayments } from './StoreFacts';

const PINCODE_KEY = 'arvixa:pincode';
const savedPincode = () => {
  try {
    return localStorage.getItem(PINCODE_KEY) || '';
  } catch {
    return '';
  }
};

// "Deliver to": remembers the shopper's pincode across products, checked against India Post data
function DeliverTo() {
  const [pincode, setPincode] = useState(savedPincode);
  const [editing, setEditing] = useState(!savedPincode());
  const [place, setPlace] = useState(null);
  const [busy, setBusy] = useState(false);

  const look = async (pin) => {
    setBusy(true);
    try {
      setPlace(await api.pincode(pin));
      try {
        localStorage.setItem(PINCODE_KEY, pin);
      } catch { /* private window: just don't remember it */ }
      setEditing(false);
    } catch (err) {
      setPlace({ error: err.message });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const pin = savedPincode();
    if (pin) look(pin);
  }, []);

  const submit = (e) => {
    e.preventDefault();
    if (!/^[1-9]\d{5}$/.test(pincode)) return setPlace({ error: 'Please enter a valid 6-digit pincode' });
    look(pincode);
  };

  return (
    <div className="deliver-to">
      {editing ? (
        <form onSubmit={submit} className="deliver-to-form">
          <Icon name="mapPin" size={16} />
          <input value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Enter delivery pincode" inputMode="numeric" autoComplete="postal-code" aria-label="Delivery pincode" />
          <button type="submit" className="btn-link" disabled={busy}>{busy ? 'Checking…' : 'Check'}</button>
        </form>
      ) : (
        <button type="button" className="deliver-to-current" onClick={() => setEditing(true)}>
          <Icon name="mapPin" size={16} />
          <span>Deliver to <strong>{place?.city ? `${place.city} ${pincode}` : pincode}</strong></span>
          <span className="btn-link">Change</span>
        </button>
      )}
      {place?.error && <p className="text-error small" role="alert">{place.error}</p>}
      {place && !place.error && (
        place.found === false ? <p className="text-error small" role="status">We couldn’t find this pincode. Please check it.</p>
          : place.deliverable === false ? <p className="text-error small" role="status">India Post doesn’t deliver to this pincode yet.</p>
            : <p className="small deliver-to-eta" role="status"><Icon name="truck" size={14} /> Estimated delivery by <strong>{deliveryDate(place.days.max)}</strong></p>
      )}
    </div>
  );
}

// The right-hand panel on a product page: price, stock, quantity, buttons, delivery and who sells it
export default function BuyBox({ product }) {
  const [qty, setQty] = useState(1);
  const { has: inCart } = useCart();
  const { addToCart, buyNow } = useShopActions();
  const online = useOnlinePayments();
  const outOfStock = !product.stock;
  const most = Math.min(10, product.stock || 0);

  return (
    <aside className="buy-box" aria-label="Buy this product">
      <p className="buy-box-price">{formatPrice(product.price)}</p>
      <p className="muted small">{product.price >= 499 ? 'Free delivery on this item' : 'Free delivery on orders of ₹499 or more'}</p>
      <DeliverTo />
      <p className={`buy-box-stock ${outOfStock ? 'text-error' : 'text-success'}`}>{outOfStock ? 'Currently out of stock' : 'In stock'}</p>
      {!outOfStock && (
        <label className="buy-box-qty">
          Quantity
          <select value={qty} onChange={(e) => setQty(Number(e.target.value))}>
            {Array.from({ length: most }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      {inCart(product._id) ? (
        <Link to="/cart" className="btn btn-cart btn-block"><Icon name="cart" size={18} /> Go to cart</Link>
      ) : (
        <button type="button" className="btn btn-cart btn-block" disabled={outOfStock} onClick={() => addToCart(product, qty)}>
          <Icon name="cart" size={18} /> Add to cart
        </button>
      )}
      <button type="button" className="btn btn-buy btn-block" disabled={outOfStock} onClick={() => buyNow(product, qty)}>
        <Icon name="zap" size={18} filled /> Buy now
      </button>
      <dl className="buy-box-meta">
        <div><dt>Sold by</dt><dd>Arvixa Store</dd></div>
        <div><dt>Payment</dt><dd>{online ? 'Secure online payment or cash on delivery' : 'Cash on delivery'}</dd></div>
        <div><dt>Cancel</dt><dd>Free, any time before it ships</dd></div>
      </dl>
    </aside>
  );
}
