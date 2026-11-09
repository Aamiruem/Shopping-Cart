import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ErrorMessage, Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import ReturnsQueue from '../../components/seller/ReturnsQueue';
import { useToast } from '../../context/ToastContext';
import useApi from '../../hooks/useApi';
import { formatDate, formatPrice } from '../../utils/format';
import { paymentStatus } from '../../utils/orders';
import { StatusBadge } from '../Orders';
import { PAYMENT_LABELS } from './SellerEarnings';

export const FULFILMENT = [
  { id: 'pending', label: 'Pending', icon: 'clock' },
  { id: 'packed', label: 'Packed', icon: 'package' },
  { id: 'shipped', label: 'Shipped', icon: 'truck' },
  { id: 'delivered', label: 'Delivered', icon: 'checkCircle' },
];

// The courier details shoppers see on their order page
function ShipmentForm({ order, onSubmit, onCancel }) {
  const [courier, setCourier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const submit = (e) => {
    e.preventDefault();
    onSubmit(order, 'shipped', { courier, trackingNumber });
  };
  return (
    <form className="shipment-form" onSubmit={submit}>
      <input value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="Courier" aria-label="Courier" required maxLength={60} />
      <input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="Tracking number" aria-label="Tracking number" required maxLength={60} />
      <button type="submit" className="btn btn-primary">Mark shipped</button>
      <button type="button" className="btn-text" onClick={onCancel}>Cancel</button>
    </form>
  );
}

export default function SellerOrders() {
  const toast = useToast();
  const [shipping, setShipping] = useState(null); // id of the order waiting for courier details
  const [status, setStatus] = useState('');
  const [fulfilment, setFulfilment] = useState('');
  const { data, error, loading, reload } = useApi(() => api.sellerOrders({ status, fulfilment, limit: 200 }), [status, fulfilment]);
  const [orders, setOrders] = useState([]);
  useEffect(() => setOrders(data || []), [data]);

  const move = async (order, next, shipment) => {
    if (next === 'shipped' && !shipment) return setShipping(order.id);
    setShipping(null);
    try {
      await api.sellerUpdateFulfilment(order.id, next, shipment);
      setOrders((list) => list.map((o) => (o.id === order.id ? { ...o, fulfilment: next } : o)));
      toast.show(`Order #${order.id} marked ${next}`);
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  return (
    <>
    <ReturnsQueue onChange={reload} />
    <div className="panel seller-products">
      <header className="seller-head">
        <div>
          <h1>Orders</h1>
          <p className="muted small">Orders that include your products (amounts are your items only). Move each order along as you pack and ship it.</p>
        </div>
        <div className="segmented" role="group" aria-label="Order status">
          {[['', 'All'], ['placed', 'Active'], ['cancelled', 'Cancelled'], ['returned', 'Returned']].map(([id, label]) => (
            <button key={id} type="button" className={status === id ? 'active' : ''} onClick={() => setStatus(id)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="seller-toolbar">
        <div className="segmented" role="group" aria-label="Fulfilment">
          <button type="button" className={!fulfilment ? 'active' : ''} onClick={() => setFulfilment('')}>Any stage</button>
          {FULFILMENT.map((f) => <button key={f.id} type="button" className={fulfilment === f.id ? 'active' : ''} onClick={() => setFulfilment(f.id)}>{f.label}</button>)}
        </div>
      </div>
      <ErrorMessage message={error} onRetry={reload} />
      {loading ? <Spinner /> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Payment</th><th>Fulfilment</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {orders.map((o) => {
                const step = FULFILMENT.findIndex((f) => f.id === o.fulfilment);
                const closed = o.status !== 'placed';
                return (
                  <tr key={o.id} className={closed ? 'inactive' : ''}>
                    <td><strong>#{o.id}</strong><span className="muted small block">{formatDate(o.created_at)}</span></td>
                    <td title={o.address}>{o.customer}<span className="muted small block">Customer ID {o.customer_id}</span></td>
                    <td>
                      <div className="order-items-cell">
                        {o.items.map((i) => <span key={i.productId + i.name} title={i.name}><img src={i.image} alt="" /> {i.qty}× {i.name.length > 28 ? `${i.name.slice(0, 27)}…` : i.name}</span>)}
                      </div>
                    </td>
                    <td>
                      {PAYMENT_LABELS[o.payment_method] || o.payment_method}
                      <span className={`pay-status ${o.payment_status || 'cod'} block`}>{paymentStatus(o, o.fulfilment === 'delivered')}</span>
                    </td>
                    <td>
                      {o.return_status && o.status === 'placed' && <span className="muted small block">Return {o.return_status}</span>}
                      {closed ? <StatusBadge status={o.status} /> : (
                        <div className="fulfil-steps" role="group" aria-label={`Fulfilment of order ${o.id}`}>
                          {FULFILMENT.map((f, i) => (
                            <button
                              key={f.id}
                              type="button"
                              className={`${i <= step ? 'done' : ''} ${i === step ? 'current' : ''}`}
                              onClick={() => i !== step && move(o, f.id)}
                              title={f.label}
                              aria-pressed={i === step}
                            >
                              <Icon name={f.icon} size={14} /> <span>{f.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {shipping === o.id && <ShipmentForm order={o} onSubmit={move} onCancel={() => setShipping(null)} />}
                    </td>
                    <td className="num"><strong>{formatPrice(o.amount)}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!orders.length && <p className="muted" style={{ padding: 16 }}>No orders here yet.</p>}
        </div>
      )}
    </div>
    </>
  );
}
