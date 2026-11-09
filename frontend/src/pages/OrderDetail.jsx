import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { PREVIEW } from '../config';
import { EmptyState, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import { ReturnForm, ReturnStatus } from '../components/orders/ReturnPanel';
import { useToast } from '../context/ToastContext';
import { deliveryDate, formatDate, formatPrice } from '../utils/format';
import { paymentStatus } from '../utils/orders';
import { RETURN_WINDOW_DAYS } from '../utils/returns';
import { StatusBadge } from './Orders';

// Opens the address in Google Maps (no API key needed); the phone number is left out of the search
const mapsLink = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.replace(/\. Phone: .*$/, ''))}`;

const PAYMENT_LABELS = { cod: 'Cash on Delivery', upi: 'UPI', card: 'Card', credit_card: 'Credit card', debit_card: 'Debit card', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI', paylater: 'Pay Later', online: 'Online payment' };
const TRACK_STEPS = ['Ordered', 'Packed', 'Shipped', 'Delivered'];
const STEP_OF = { pending: 0, packed: 1, shipped: 2, delivered: 3 };

export default function OrderDetail() {
  const { id } = useParams();
  const { state } = useLocation();
  const toast = useToast();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState(false);

  const load = useCallback(() => api.order(id).then(setOrder).catch((err) => setError(err.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const withdrawReturn = async () => {
    try {
      await api.withdrawReturn(id);
      toast.show('Return request withdrawn', 'info');
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
  const returnUntil = deliveredAt + RETURN_WINDOW_DAYS * 86400000;
  const canReturn = order.status === 'placed' && delivered && !order.return && Date.now() < returnUntil;
  // Paid online: a refund goes back to the same account. Cash: the shopper says where to send it.
  const paidOnline = ['paid', 'refund_pending', 'refunded'].includes(order.payment_status);
  const shipment = order.items.find((i) => i.tracking_number);

  return (
    <div className="page-orders container narrow">
      {state?.justPlaced && (
        <div className="order-success panel">
          <div className="success-check"><Icon name="check" size={36} strokeWidth={3} /></div>
          <div>
            <h1>Order placed successfully!</h1>
            <p>Thank you for shopping with Arvixa Store.{!PREVIEW && <> Expected delivery by <strong>{deliveryDate(4)}</strong>.</>}</p>
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
              <h2>Order ID #{order.id}</h2>
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

          {order.return && <ReturnStatus ret={order.return} onWithdraw={withdrawReturn} />}

          <ul className="summary-list">
            {order.items.map((i) => (
              <li key={i.id}>
                {i.image ? <img src={i.image} alt="" /> : <Icon name="package" size={40} />}
                <div>
                  <Link to={`/products/${i.product_id}`}>{i.name}</Link>
                  <p className="muted small">Qty: {i.qty} · {formatPrice(i.price)} each</p>
                  <p className="muted small id-line">Product ID: {i.product_id}</p>
                </div>
                <strong>{formatPrice(Number(i.price) * i.qty)}</strong>
              </li>
            ))}
          </ul>

          {order.status === 'placed' && shipped && !order.return && (
            <p className="muted small">
              {delivered
                ? canReturn ? `Delivered. You can return it until ${formatDate(returnUntil, { day: 'numeric', month: 'long' })}.` : 'Delivered. The return window for this order has closed.'
                : 'On its way, so it can no longer be cancelled.'}
            </p>
          )}
          {canReturn && !returning && (
            <button type="button" className="btn btn-outline" onClick={() => setReturning(true)}>
              <Icon name="returns" size={14} /> Return order
            </button>
          )}
          {returning && (
            <ReturnForm order={order} paidOnline={paidOnline} onCancel={() => setReturning(false)} onDone={() => { setReturning(false); load(); }} />
          )}
          <p className="muted small no-print">
            <Icon name="message" size={14} /> Problem with this order? <Link to={`/help?order=${order.id}#contact`}>Raise a complaint</Link>
          </p>
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
            <a className="map-link" href={mapsLink(order.address)} target="_blank" rel="noreferrer"><Icon name="mapPin" size={14} /> View on Google Maps</a>
          </div>
          <div className="panel side-box">
            <h3><Icon name="card" size={16} /> Payment</h3>
            <dl className="mini-dl">
              <div><dt>Items total</dt><dd>{formatPrice(itemsTotal)}</dd></div>
              <div><dt>Delivery</dt><dd>{Number(order.delivery_fee) ? formatPrice(order.delivery_fee) : 'FREE'}</dd></div>
              {Number(order.coupon_discount) > 0 && <div><dt>Coupon ({order.coupon_code})</dt><dd className="text-success">− {formatPrice(order.coupon_discount)}</dd></div>}
              <div className="total-row"><dt>Order total</dt><dd>{formatPrice(order.total)}</dd></div>
              <div><dt>Payment method</dt><dd>{PAYMENT_LABELS[order.payment_method] || order.payment_method}</dd></div>
              <div><dt>Payment status</dt><dd><strong>{paymentStatus(order, delivered)}</strong></dd></div>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}
