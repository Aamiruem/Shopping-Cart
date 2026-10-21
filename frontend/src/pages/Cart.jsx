import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PriceDetails from '../components/cart/PriceDetails';
import { EmptyState, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import Price from '../components/common/Price';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import useShopActions from '../hooks/useShopActions';
import { deliveryDate } from '../utils/format';
import { playSound } from '../utils/sound';

const MAX_QTY = 10;

function CartItem({ item }) {
  const { update, remove } = useCart();
  const toast = useToast();
  const { saveForLater } = useShopActions();
  const [busy, setBusy] = useState(false);

  const run = async (fn, message) => {
    setBusy(true);
    try {
      await fn();
      if (message) {
        toast.show(message, 'info');
        playSound('click');
      }
    } catch (err) {
      toast.show(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const maxQty = Math.min(MAX_QTY, item.stock);

  return (
    <li className={`cart-item ${busy ? 'busy' : ''}`}>
      <Link to={`/products/${item.productId}`} className="cart-item-img"><img src={item.image} alt={item.name} /></Link>
      <div className="cart-item-info">
        <Link to={`/products/${item.productId}`} className="cart-item-name">{item.name}</Link>
        {item.brand && <p className="muted small">Seller: {item.brand}</p>}
        <Price price={item.price} mrp={item.mrp} />
        {item.stock < item.qty && <p className="text-error small">Only {item.stock} left in stock</p>}
      </div>
      <p className="cart-item-delivery small">Delivery by {deliveryDate(3)} | <span className="text-success">{item.subtotal >= 499 ? 'Free' : '₹40'}</span></p>

      <div className="cart-item-actions">
        <div className="qty-stepper" aria-label={`Quantity for ${item.name}`}>
          <button type="button" disabled={busy || item.qty <= 1} onClick={() => run(() => update(item.productId, item.qty - 1))} aria-label="Decrease quantity"><Icon name="minus" size={14} /></button>
          <span>{item.qty}</span>
          <button type="button" disabled={busy || item.qty >= maxQty} onClick={() => run(() => update(item.productId, item.qty + 1))} aria-label="Increase quantity"><Icon name="plus" size={14} /></button>
        </div>
        <button type="button" className="btn-text" disabled={busy} onClick={() => run(() => saveForLater(item))}>Save for later</button>
        <button type="button" className="btn-text" disabled={busy} onClick={() => run(() => remove(item.productId), `Removed ${item.name} from cart`)}>Remove</button>
      </div>
    </li>
  );
}

export default function Cart() {
  const { cart, loading } = useCart();
  const navigate = useNavigate();

  if (loading && !cart.items.length) return <Spinner />;
  if (!cart.items.length) {
    return (
      <div className="container">
        <EmptyState icon="cart" title="Your cart is empty!" message="Add items to it now." action={{ to: '/products', label: 'Shop now' }} />
      </div>
    );
  }

  return (
    <div className="page-cart container">
      <section className="cart-main">
        <div className="panel cart-list">
          <header className="cart-head">
            <h1>My Cart ({cart.items.length})</h1>
            <span className="muted small"><Icon name="mapPin" size={14} /> Deliver to your saved address at checkout</span>
          </header>
          <ul>{cart.items.map((item) => <CartItem key={item.productId} item={item} />)}</ul>
          <div className="cart-footer">
            <button type="button" className="btn btn-buy btn-lg" onClick={() => navigate('/checkout')}>Place order</button>
          </div>
        </div>
      </section>
      <PriceDetails cart={cart} />
    </div>
  );
}
