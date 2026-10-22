import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorMessage, Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import useApi from '../../hooks/useApi';
import { formatDate, formatPrice } from '../../utils/format';

export const PAYMENT_LABELS = {
  cod: 'Cash on delivery',
  upi: 'UPI',
  card: 'Card',
  netbanking: 'Net banking',
  wallet: 'Wallet',
  emi: 'EMI',
};
const PAYMENT_STATUS = { paid: 'Paid', refunded: 'Refunded', refund_pending: 'Refund pending', failed: 'Failed', created: 'Started' };

const CARDS = [
  { key: 'gross', label: 'Total sales', icon: 'barChart', tone: 'blue', note: 'All orders not cancelled' },
  { key: 'delivered', label: 'Delivered', icon: 'checkCircle', tone: 'green', note: 'Ready for payout' },
  { key: 'in_progress', label: 'In progress', icon: 'truck', tone: 'orange', note: 'Not delivered yet' },
  { key: 'last30', label: 'Last 30 days', icon: 'clock', tone: 'purple', note: 'Sales this month' },
];

export default function SellerEarnings() {
  const { data, error, loading, reload } = useApi(() => api.sellerEarnings(), []);
  if (loading) return <div className="panel"><Spinner /></div>;
  if (error) return <div className="panel"><ErrorMessage message={error} onRetry={reload} /></div>;

  const { totals, byMethod, recentPayments, payout } = data;
  const methodTotal = byMethod.reduce((sum, m) => sum + Number(m.amount), 0) || 1;

  return (
    <div className="seller-earnings">
      <section className="panel seller-card">
        <header className="seller-head">
          <div><h1>Payments &amp; Earnings</h1><p className="muted small">{totals.orders} orders · your products only</p></div>
          <span className="cancelled-note muted small">Cancelled: {formatPrice(totals.cancelled)}</span>
        </header>
        <div className="stat-cards">
          {CARDS.map((c) => (
            <div key={c.key} className={`stat-card tone-${c.tone}`}>
              <span className="nav-chip"><Icon name={c.icon} size={18} /></span>
              <div><span>{c.label}</span><strong>{formatPrice(totals[c.key])}</strong><small>{c.note}</small></div>
            </div>
          ))}
        </div>
      </section>

      <div className="earnings-grid">
        <section className="panel seller-card">
          <h2 className="card-title">How customers paid</h2>
          {byMethod.length ? (
            <ul className="method-bars">
              {byMethod.map((m) => (
                <li key={m.method}>
                  <div><strong>{PAYMENT_LABELS[m.method] || m.method}</strong><span>{formatPrice(m.amount)} · {m.orders} orders</span></div>
                  <span className="bar"><i style={{ width: `${(Number(m.amount) / methodTotal) * 100}%` }} /></span>
                </li>
              ))}
            </ul>
          ) : <p className="muted">No sales yet.</p>}
        </section>

        <section className="panel seller-card">
          <h2 className="card-title">Payout account</h2>
          {payout.upi || payout.bank ? (
            <ul className="payout-list">
              {payout.upi && <li><Icon name="phone" size={16} /> UPI: <strong>{payout.upi}</strong></li>}
              {payout.bank && <li><Icon name="bank" size={16} /> Bank: <strong>{payout.bank}</strong></li>}
            </ul>
          ) : <p className="muted">No payout account yet.</p>}
          <Link to="/seller/settings" className="btn btn-outline btn-sm"><Icon name="settings" size={14} /> {payout.upi || payout.bank ? 'Change' : 'Add'} payout details</Link>
        </section>
      </div>

      <section className="panel seller-card">
        <h2 className="card-title">Recent online payments</h2>
        {recentPayments.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Date</th><th>Order</th><th>Method</th><th>Payment ID</th><th>Status</th><th className="num">Your amount</th></tr></thead>
              <tbody>
                {recentPayments.map((p) => (
                  <tr key={p.id}>
                    <td>{formatDate(p.created_at)}</td>
                    <td>#{p.order_id}</td>
                    <td>{PAYMENT_LABELS[p.method] || p.method || '—'}</td>
                    <td className="mono">{p.provider_payment_id || '—'}</td>
                    <td><span className={`pay-status ${p.status}`}>{PAYMENT_STATUS[p.status] || p.status}</span></td>
                    <td className="num"><strong>{formatPrice(p.amount)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">Online payments (UPI, net banking, cards, wallets) will appear here.</p>}
      </section>
    </div>
  );
}
