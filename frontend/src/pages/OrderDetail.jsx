import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import { useToast } from '../context/ToastContext';
import { deliveryDate, formatDate, formatPrice } from '../utils/format';
import { StatusBadge } from './Orders';

const PAYMENT_LABELS = { cod: 'Cash on Delivery', upi: 'UPI', card: 'Card' };
const TRACK_STEPS = ['Ordered', 'Packed', 'Shipped', 'Delivered'];

export default function OrderDetail() {
  const { id } = useParams();
  const { state } = useLocation();
  const toast = useToast();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    api.order(id).then(setOrder).catch((err) => setError(err.message));
  }, [id]);

  const cancel = async () => {
    if (!window.confirm('Cancel this order?')) return;
    setCancelling(true);
    try {
      const updated = await api.cancelOrder(id);
      setOrder({ ...order, ...updated });
      toast.show('Your order has been cancelled', 'info');
    } catch (err) {
      toast.show(err.message, 'error');
    } finally {
      setCancelling(false);
    }
  };

  if (error) return <div className="container"><EmptyState title="Order not found" message={error} action={{ to: '/orders', label: 'Back to orders' }} /></div>;
  if (!order) return <Spinner />;

  const itemsTotal = order.items.reduce((s, i) => s + Number(i.price) * i.qty, 0);
  const cancelled = order.status === 'cancelled';

  return (
    <div className="page-orders container narrow">
      {state?.justPlaced && (
        <div className="order-success panel">
          <div className="success-check"><Icon name="check" size={36} strokeWidth={3} /></div>
          <div>
            <h1>Order placed successfully!</h1>
            <p>Thank you for shopping with Veyra. Expected delivery by <strong>{deliveryDate(4)}</strong>.</p>
          </div>
        </div>
      )}

      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">Home</Link> <Icon name="chevronRight" size={12} /> <Link to="/orders">My Orders</Link> <Icon name="chevronRight" size={12} /> <span>#{order.id}</span>
      </nav>

      <div className="order-detail-grid">
        <section className="panel order-detail">
          <header className="order-detail-head">
            <div>
              <h2>Order #{order.id}</h2>
              <p className="muted small">Placed on {formatDate(order.created_at, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
            </div>
            <StatusBadge status={order.status} />
          </header>

          {!cancelled && (
            <ol className="tracker">
              {TRACK_STEPS.map((s, i) => <li key={s} className={i === 0 ? 'done' : ''}><span />{s}</li>)}
            </ol>
          )}

          <ul className="summary-list">
            {order.items.map((i) => (
              <li key={i.id}>
                {i.image ? <img src={i.image} alt="" /> : <Icon name="package" size={40} />}
                <div>
                  <Link to={`/products/${i.product_id}`}>{i.name}</Link>
                  <p className="muted small">Qty: {i.qty} · {formatPrice(i.price)} each</p>
                </div>
                <strong>{formatPrice(Number(i.price) * i.qty)}</strong>
              </li>
            ))}
          </ul>

          {order.status === 'placed' && (
            <button type="button" className="btn btn-outline" disabled={cancelling} onClick={cancel}>
              <Icon name="x" size={14} /> {cancelling ? 'Cancelling…' : 'Cancel order'}
            </button>
          )}
        </section>

        <aside className="order-side">
          <div className="panel side-box">
            <h3><Icon name="mapPin" size={16} /> Delivery address</h3>
            <p>{order.address}</p>
          </div>
          <div className="panel side-box">
            <h3><Icon name="card" size={16} /> Payment</h3>
            <dl className="mini-dl">
              <div><dt>Items total</dt><dd>{formatPrice(itemsTotal)}</dd></div>
              <div><dt>Delivery</dt><dd>{Number(order.delivery_fee) ? formatPrice(order.delivery_fee) : 'FREE'}</dd></div>
              <div className="total-row"><dt>Order total</dt><dd>{formatPrice(order.total)}</dd></div>
              <div><dt>Paid by</dt><dd>{PAYMENT_LABELS[order.payment_method] || order.payment_method}</dd></div>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}
