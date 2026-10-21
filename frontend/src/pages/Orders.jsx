import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, ErrorMessage, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import { formatDate, formatPrice } from '../utils/format';

export function StatusBadge({ status }) {
  return <span className={`status status-${status}`}><span className="dot" />{status === 'placed' ? 'Order placed' : status[0].toUpperCase() + status.slice(1)}</span>;
}

export default function Orders() {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.orders().then(setOrders).catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="container"><ErrorMessage message={error} /></div>;
  if (!orders) return <Spinner />;
  if (!orders.length) {
    return <div className="container"><EmptyState icon="package" title="No orders yet" message="When you place an order, it will show up here." action={{ to: '/products', label: 'Start shopping' }} /></div>;
  }

  return (
    <div className="page-orders container narrow">
      <h1 className="page-title">My Orders</h1>
      <ul className="order-list">
        {orders.map((o) => (
          <li key={o.id}>
            <Link to={`/orders/${o.id}`} className="order-card panel">
              <div className="order-thumbs">
                {o.items.slice(0, 3).map((i) => (i.image ? <img key={i.id} src={i.image} alt="" /> : <Icon key={i.id} name="package" size={32} />))}
              </div>
              <div className="order-main">
                <p className="order-title">{o.items[0]?.name}{o.items.length > 1 && <span className="muted"> + {o.items.length - 1} more</span>}</p>
                <p className="muted small">Order #{o.id} · {formatDate(o.created_at)}</p>
              </div>
              <strong className="order-total">{formatPrice(o.total)}</strong>
              <StatusBadge status={o.status} />
              <Icon name="chevronRight" size={18} className="muted" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
