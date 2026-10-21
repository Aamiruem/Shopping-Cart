import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import Icon from '../components/common/Icon';
import { useAuth } from '../context/AuthContext';
import useApi from '../hooks/useApi';

const SECTIONS = [
  {
    id: 'payments',
    icon: 'card',
    title: 'Payments',
    items: [
      ['Which payment methods are accepted?', 'UPI, credit/debit cards and Cash on Delivery. In this demo store, UPI and card payments are simulated and nothing is charged.'],
      ['Is it safe to pay online?', 'Payments are processed over encrypted connections and card details are never stored on our servers.'],
    ],
  },
  {
    id: 'shipping',
    icon: 'truck',
    title: 'Shipping',
    items: [
      ['How much does delivery cost?', 'Delivery is free on orders of ₹499 or more. A flat ₹40 is charged below that.'],
      ['When will my order arrive?', 'Most orders arrive within 2–4 working days. You can check an estimate on any product page using your pincode.'],
    ],
  },
  {
    id: 'returns',
    icon: 'returns',
    title: 'Cancellation & Returns',
    items: [
      ['Can I cancel my order?', 'Yes — open the order from My Orders and choose “Cancel order” any time before it ships.'],
      ['What is the return policy?', 'Most items can be returned within 7 days of delivery in their original condition.'],
    ],
  },
];

const PRIORITY_COPY = {
  high: 'Marked urgent - our team will reply within 2 hours.',
  medium: 'Our team will reply within 12 hours.',
  low: 'Our team will reply within 24 hours.',
};

// Raises a support ticket. The server's ML model picks the team (category), urgency and a first answer.
function ContactForm() {
  const { user } = useAuth();
  const location = useLocation();
  const { data: orders } = useApi(() => (user ? api.orders() : Promise.resolve([])), [user?.id]);
  const [form, setForm] = useState({ subject: '', message: '', orderId: '' });
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!user) {
    return (
      <section className="panel help-section">
        <h2><Icon name="message" size={20} /> Contact support</h2>
        <p className="muted"><Link to="/login" state={{ from: location }} className="btn-link">Log in</Link> to raise a ticket about an order or your account.</p>
      </section>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.subject.trim().length < 3) return setError('Please add a short subject');
    if (form.message.trim().length < 10) return setError('Please describe the issue in a little more detail');
    setBusy(true);
    try {
      setTicket(await api.createTicket({ subject: form.subject, message: form.message, orderId: form.orderId ? Number(form.orderId) : null }));
      setForm({ subject: '', message: '', orderId: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="contact" className="panel help-section">
      <h2><Icon name="message" size={20} /> Contact support</h2>
      {ticket ? (
        <div className="ticket-result">
          <p className="text-success"><Icon name="check" size={16} /> Ticket #{ticket.id} created and routed to <strong>{ticket.categoryLabel}</strong>.</p>
          <p className="muted small">{PRIORITY_COPY[ticket.priority]}</p>
          <div className="suggested-reply">
            <p className="small"><Icon name="zap" size={12} /> <strong>Instant answer</strong> (while you wait)</p>
            <p>{ticket.suggested_reply}</p>
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setTicket(null)}>Raise another ticket</button>
        </div>
      ) : (
        <form onSubmit={submit} className="account-form" noValidate>
          <div className="form-grid">
            <label className="field">Subject<input value={form.subject} maxLength={200} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="e.g. Refund not received" /></label>
            <label className="field">Related order (optional)
              <select value={form.orderId} onChange={(e) => setForm({ ...form, orderId: e.target.value })}>
                <option value="">Not about an order</option>
                {(orders || []).slice(0, 20).map((o) => <option key={o.id} value={o.id}>#{o.id} · {o.items[0]?.name}</option>)}
              </select>
            </label>
            <label className="field span-2">How can we help?<textarea rows={4} maxLength={4000} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></label>
          </div>
          {error && <p className="alert alert-error" role="alert">{error}</p>}
          <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Submit ticket'}</button></div>
        </form>
      )}
    </section>
  );
}

export default function Help() {
  return (
    <div className="page-orders container narrow">
      <h1 className="page-title">Help Center</h1>
      <ContactForm />
      {SECTIONS.map((s) => (
        <section key={s.id} id={s.id} className="panel help-section">
          <h2><Icon name={s.icon} size={20} /> {s.title}</h2>
          {s.items.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}
