import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useCart } from '../../context/CartContext';
import { formatDate, formatPrice } from '../../utils/format';
import Icon from '../common/Icon';

// "Apply coupon" on the cart and checkout. The server checks every rule again when the order is placed.
export default function CouponBox() {
  const { cart, applyCoupon, removeCoupon } = useCart();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offers, setOffers] = useState([]);

  useEffect(() => {
    let cancelled = false;
    api.coupons().then((list) => !cancelled && setOffers(list)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = async (value) => {
    setBusy(true);
    setError('');
    try {
      await applyCoupon(value.trim());
      setCode('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeCoupon();
    } finally {
      setBusy(false);
    }
  };

  if (cart.coupon) {
    return (
      <div className="coupon-box">
        <div className={`coupon-applied ${cart.couponError ? 'blocked' : ''}`}>
          <Icon name="tag" size={18} />
          <div>
            <strong>{cart.coupon.code}</strong>
            {cart.couponError ? <span className="text-error small">{cart.couponError}</span> : <span className="small">You save {formatPrice(cart.couponDiscount)} with this coupon</span>}
          </div>
          <button type="button" className="btn-link" onClick={remove} disabled={busy}>Remove</button>
        </div>
      </div>
    );
  }

  const usable = offers.filter((o) => !o.used);
  return (
    <div className="coupon-box">
      <form className="coupon-form" onSubmit={(e) => { e.preventDefault(); if (code.trim()) apply(code); }}>
        <Icon name="tag" size={18} />
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30))} placeholder="Enter coupon code" aria-label="Coupon code" autoCapitalize="characters" />
        <button type="submit" className="btn-link" disabled={busy || !code.trim()}>{busy ? 'Applying…' : 'Apply'}</button>
      </form>
      {error && <p className="text-error small" role="alert">{error}</p>}
      {usable.length > 0 && (
        <ul className="coupon-offers" aria-label="Available coupons">
          {usable.map((o) => {
            const short = cart.subtotal < o.min_order;
            return (
              <li key={o.code}>
                <div>
                  <span className="coupon-code">{o.code}</span>
                  <p>{o.description}</p>
                  <small className="muted">
                    {o.min_order > 0 && `Orders of ${formatPrice(o.min_order)}+ · `}
                    {o.ends_at ? `Valid till ${formatDate(o.ends_at, { day: 'numeric', month: 'short' })}` : 'No expiry'}
                  </small>
                  {short && <small className="text-warn">Add {formatPrice(o.min_order - cart.subtotal)} more to use this</small>}
                </div>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => apply(o.code)} disabled={busy || short}>Apply</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
