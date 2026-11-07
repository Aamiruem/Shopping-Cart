import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import { useToast } from '../context/ToastContext';
import { deliveryDate, formatDate, formatPrice } from '../utils/format';
import { StatusBadge } from './Orders';

const PAYMENT_LABELS = { cod: 'Cash on Delivery', upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI' };
const TRACK_STEPS = ['Ordered', 'Packed', 'Shipped', 'Delivered'];
const STEP_OF = { pending: 0, packed: 1, shipped: 2, delivered: 3 };
const RETURN_WINDOW_DAYS = 7;
const RETURN_LABELS = { requested: 'Return requested. We’ll update you soon.', approved: 'Return approved.', rejected: 'This return wasn’t approved.' };
const REFUND_LABELS = { refunded: 'Your refund is on its way (usually 5–7 working days).', refund_pending: 'Your refund is being processed.', cod_manual: 'We’ll contact you to arrange your refund.' };

export default function OrderDetail() {
  const { id } = useParams();
  const { state } = useLocation();
  const toast = useToast();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(() => api.order(id).then(setOrder).catch((err) => setError(err.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const submitReturn = async (e) => {
    e.preventDefault();
    try {
      await api.requestReturn(id, reason);
      toast.show('Return requested');
      setReturning(false);
      load();
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  const cancel = async () => {
    if (!window.confirm('Cancel this order?')) return;
    setCancelling(true);
    try {
      const updated = await api.cancelOrder(id);
      setOrder({ ...order, ...updated });
      toast.show(
        updated.refund ? 'Order cancelled. Your refund is on its way to the account you paid from (usually 5–7 working days).' : 'Your order has been cancelled',
        'info',
      );
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
  // The order is as far along as its least-advanced item (items from several sellers ship separately)
  const step = Math.min(...order.items.map((i) => STEP_OF[i.fulfilment] ?? 0));
  const shipped = step >= STEP_OF.shipped;
  const delivered = step === STEP_OF.delivered;
  const deliveredAt = Math.max(...order.items.map((i) => new Date(i.fulfilled_at || 0).getTime()));
  const canReturn = order.status === 'placed' && delivered && !order.return && Date.now() - deliveredAt < RETURN_WINDOW_DAYS * 86400000;
  const shipment = order.items.find((i) => i.tracking_number);

  return (
    <div className="page-orders container narrow">
      {state?.justPlaced && (
        <div className="order-success panel">
          <div className="success-check"><Icon name="check" size={36} strokeWidth={3} /></div>
          <div>
            <h1>Order placed successfully!</h1>
            <p>Thank you for shopping with Arvixa Store. Expected delivery by <strong>{deliveryDate(4)}</strong>.</p>
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
              {TRACK_STEPS.map((s, i) => <li key={s} className={i <= step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span />{s}</li>)}
            </ol>
          )}

          {shipment && (
            <p className="tracking-line">
              <Icon name="truck" size={16} /> {shipment.courier || 'Courier'} · Tracking number <strong>{shipment.tracking_number}</strong>
            </p>
          )}

          {order.events?.length > 0 && (
            <ol className="order-timeline">
              {order.events.map((e) => (
                <li key={`${e.status}-${e.created_at}`}>
                  <strong>{e.note || e.status}</strong>
                  <span className="muted small">{formatDate(e.created_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </li>
              ))}
            </ol>
          )}

          {order.return && (
            <p className="alert">{RETURN_LABELS[order.return.status]} {REFUND_LABELS[order.return.refund] || ''}</p>
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

          {order.status === 'placed' && shipped && (
            <p className="muted small">{delivered ? 'Delivered.' : 'On its way, so it can no longer be cancelled.'} Need help? <Link to="/help">Contact support</Link></p>
          )}
          {canReturn && !returning && (
            <button type="button" className="btn btn-outline" onClick={() => setReturning(true)}>
              <Icon name="returns" size={14} /> Return order
            </button>
          )}
          {returning && (
            <form className="return-form" onSubmit={submitReturn}>
              <label className="field">Why are you returning this order?
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={500} rows={2} />
              </label>
              <div className="form-actions">
                <button type="submit" className="btn btn-buy">Request return</button>
                <button type="button" className="btn-text" onClick={() => setReturning(false)}>Cancel</button>
              </div>
            </form>
          )}
          <button type="button" className="btn-text no-print" onClick={() => window.print()}>
            <Icon name="package" size={14} /> Print order receipt
          </button>
          {order.status === 'placed' && !shipped && (
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
