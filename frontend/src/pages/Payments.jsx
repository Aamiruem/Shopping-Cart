import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, ErrorMessage, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import useApi from '../hooks/useApi';
import useSeo from '../hooks/useSeo';
import { formatDate, formatPrice } from '../utils/format';

const METHODS = {
  cod: 'Cash on delivery', upi: 'UPI', card: 'Card', credit_card: 'Credit card', debit_card: 'Debit card', netbanking: 'Net banking',
  wallet: 'Wallet', emi: 'EMI', paylater: 'Pay Later', online: 'Online payment', bank: 'Bank transfer',
};
const METHOD_ICONS = { cod: 'truck', upi: 'phone', credit_card: 'card', debit_card: 'card', card: 'card', netbanking: 'bank', wallet: 'wallet', emi: 'clock', paylater: 'zap', bank: 'bank' };
const STATUS = {
  paid: ['Paid', 'ok'],
  paid_on_delivery: ['Paid on delivery', 'ok'],
  due_on_delivery: ['Pay on delivery', 'info'],
  not_charged: ['Not charged', 'muted'],
  refunded: ['Refunded', 'ok'],
  processing: ['Refund in progress', 'warn'],
  failed: ['Failed · not charged', 'error'],
  created: ['Not completed', 'muted'],
};
const FILTERS = [['all', 'All'], ['payment', 'Payments'], ['refund', 'Refunds'], ['pending', 'Pending']];

function title(e) {
  if (e.kind === 'failed') return 'Payment attempt';
  if (e.kind === 'refund') {
    if (e.reason === 'cancelled') return `Refund · order #${e.order.id} cancelled`;
    if (e.reason === 'return') return `Refund · order #${e.order.id} returned`;
    return 'Refund · order not placed';
  }
  return `Payment · order #${e.order.id}`;
}

function Entry({ e }) {
  const [label, tone] = STATUS[e.status] || [e.status, 'muted'];
  const incoming = e.kind === 'refund';
  const method = e.to && e.to !== 'original' ? e.to : METHODS[e.method] || e.method;
  const inner = (
    <>
      <span className={`txn-icon ${incoming ? 'in' : e.kind === 'failed' ? 'failed' : 'out'}`} aria-hidden="true">
        <Icon name={incoming ? 'returns' : METHOD_ICONS[e.method] || 'card'} size={18} />
      </span>
      <span className="txn-main">
        <strong>{title(e)}</strong>
        <span className="muted small block">
          {e.order ? `${e.order.item}${e.order.items > 1 ? ` + ${e.order.items - 1} more` : ''}` : e.note}
        </span>
        <span className="muted small block">
          {formatDate(e.date, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · {incoming ? `To ${e.to === 'original' ? `your ${METHODS[e.method] || 'original payment method'}` : method}` : method}
          {e.reference && <> · Ref {e.reference}</>}
        </span>
      </span>
      <span className="txn-side">
        <strong className={`txn-amount ${incoming ? 'in' : ''} ${['not_charged', 'failed'].includes(e.status) ? 'void' : ''}`}>
          {incoming ? '+ ' : ''}{formatPrice(e.amount)}
        </strong>
        <span className={`txn-status tone-${tone}`}>{label}</span>
      </span>
    </>
  );
  return <li>{e.order ? <Link to={`/orders/${e.order.id}`} className="txn">{inner}</Link> : <div className="txn">{inner}</div>}</li>;
}

// Every payment and refund on the account, newest first, grouped by month
export default function Payments() {
  useSeo({ title: 'Payment history', noindex: true });
  const { data, error, loading, reload } = useApi(() => api.paymentHistory(), []);
  const [filter, setFilter] = useState('all');

  if (loading && !data) return <Spinner />;
  if (error) return <div className="container"><ErrorMessage message={error} onRetry={reload} /></div>;
  if (!data.entries.length) {
    return <div className="container"><EmptyState icon="wallet" title="No payments yet" message="Payments and refunds for your orders will show up here." action={{ to: '/products', label: 'Start shopping' }} /></div>;
  }

  const shown = data.entries.filter((e) =>
    filter === 'all' ? true : filter === 'pending' ? ['processing', 'due_on_delivery'].includes(e.status) : filter === 'payment' ? e.kind !== 'refund' : e.kind === 'refund',
  );
  const months = [];
  for (const e of shown) {
    const month = formatDate(e.date, { month: 'long', year: 'numeric' });
    if (months.at(-1)?.month !== month) months.push({ month, entries: [] });
    months.at(-1).entries.push(e);
  }
  const { summary } = data;
  const cards = [
    { label: 'Total paid', value: summary.paid, icon: 'wallet', tone: 'blue', note: `${summary.orders} order${summary.orders === 1 ? '' : 's'}` },
    { label: 'Refunded', value: summary.refunded, icon: 'returns', tone: 'green', note: 'Back in your account' },
    { label: 'Refunds on the way', value: summary.refundPending, icon: 'clock', tone: 'orange', note: 'Usually 5–7 working days' },
    { label: 'To pay on delivery', value: summary.dueOnDelivery, icon: 'truck', tone: 'purple', note: 'Cash on delivery orders' },
  ];

  return (
    <div className="page-orders container narrow payments-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">Home</Link> <Icon name="chevronRight" size={12} /> <Link to="/account">My Account</Link> <Icon name="chevronRight" size={12} /> <span>Payments</span>
      </nav>
      <h1 className="page-title">Payment history</h1>
      <ul className="txn-cards">
        {cards.map((c) => (
          <li key={c.label} className={`panel tone-${c.tone}`}>
            <span className="txn-card-icon"><Icon name={c.icon} size={18} /></span>
            <span className="muted small">{c.label}</span>
            <strong>{formatPrice(c.value)}</strong>
            <span className="muted small">{c.note}</span>
          </li>
        ))}
      </ul>

      <div className="segmented txn-filter" role="group" aria-label="Show">
        {FILTERS.map(([id, label]) => <button key={id} type="button" className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>)}
      </div>

      {!shown.length && <p className="muted panel txn-none">Nothing here.</p>}
      {months.map(({ month, entries }) => (
        <section key={month} className="panel txn-month">
          <h2>{month}</h2>
          <ul className="txn-list">{entries.map((e) => <Entry key={e.id} e={e} />)}</ul>
        </section>
      ))}
      <p className="muted small txn-help">
        <Icon name="help" size={14} /> A refund missing? Banks can take up to 7 working days. Still not there? <Link to="/help#contact">Raise a complaint</Link> and pick the order.
      </p>
    </div>
  );
}
