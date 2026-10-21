import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorMessage, Spinner } from '../../components/common/Feedback';
import useApi from '../../hooks/useApi';
import { formatDate, formatPrice } from '../../utils/format';
import { StatusBadge } from '../Orders';

const PAYMENT = { cod: 'Cash on delivery', upi: 'UPI', card: 'Card' };

export default function SellerOrders() {
  const [status, setStatus] = useState('');
  const { data: orders, error, loading, reload } = useApi(() => api.sellerOrders({ status, limit: 200 }), [status]);

  return (
    <div className="panel seller-products">
      <header className="seller-head">
        <div>
          <h1>Orders</h1>
          <p className="muted small">Orders that include your products (amounts are your items only)</p>
        </div>
        <div className="segmented" role="group" aria-label="Status">
          {[['', 'All'], ['placed', 'Placed'], ['cancelled', 'Cancelled']].map(([id, label]) => (
            <button key={id} type="button" className={status === id ? 'active' : ''} onClick={() => setStatus(id)}>{label}</button>
          ))}
        </div>
      </header>
      <ErrorMessage message={error} onRetry={reload} />
      {loading ? <Spinner /> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Payment</th><th>Status</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {(orders || []).map((o) => (
                <tr key={o.id}>
                  <td>#{o.id}</td>
                  <td>{formatDate(o.created_at)}</td>
                  <td>{o.customer}</td>
                  <td>
                    <div className="order-items-cell">
                      {o.items.map((i) => <span key={i.productId + i.name} title={i.name}><img src={i.image} alt="" /> {i.qty}× {i.name.length > 28 ? `${i.name.slice(0, 27)}…` : i.name}</span>)}
                    </div>
                  </td>
                  <td>{PAYMENT[o.payment_method] || o.payment_method}</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td className="num"><strong>{formatPrice(o.amount)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!orders?.length && <p className="muted" style={{ padding: 16 }}>No orders yet.</p>}
        </div>
      )}
    </div>
  );
}
