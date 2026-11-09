import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { PREVIEW, SHOPPING } from '../config';
import Icon from '../components/common/Icon';
import { useAuth } from '../context/AuthContext';
import useSeo from '../hooks/useSeo';
import useApi from '../hooks/useApi';

const SECTIONS = [
  {
    id: 'payments',
    icon: 'card',
    title: 'Payments',
    items: [
      ['Which payment methods are accepted?', PREVIEW ? 'Cash on Delivery, and where available UPI, cards, net banking, wallets and EMI through Razorpay.' : 'UPI, credit/debit cards and Cash on Delivery. In this demo store, UPI and card payments are simulated and nothing is charged.'],
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
      ['Can I cancel my order?', 'Yes — open the order from My Orders and choose “Cancel order” any time before it ships. If you paid online, the full amount goes back to the account you paid from.'],
      ['What is the return policy?', 'Most items can be returned within 7 days of delivery in their original condition. Open the order in My Orders, choose “Return order” and pick a reason. Once we approve it, our courier picks the item up in 2–3 days.'],
      ['Where does my refund go?', 'Paid online (UPI, card, net banking, wallet or EMI): back to the same account or card you paid from, usually within 5–7 working days after pickup. Paid cash on delivery: to the UPI ID or bank account you give when you ask for the return, within 2 working days of pickup. Your order page shows every step.'],
      ['My refund hasn’t arrived', 'Check your order page first: it shows when the refund was sent and any reference number. Banks can take up to 7 working days. If it’s later than that, raise a ticket below and choose the order: refund problems are always handled first.'],
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
  // "Raise a complaint" on an order page opens this form with that order chosen
  const [form, setForm] = useState({ subject: '', message: '', orderId: new URLSearchParams(location.search).get('order') || '' });
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
          <p className="muted small">{PRIORITY_COPY[ticket.priority]} Follow it and reply in <Link to="/account?tab=support" className="btn-link">My Account → Support tickets</Link>.</p>
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
  useSeo({ title: 'Help Center - Orders, Payments, Returns & Refunds', description: 'Get help with Arvixa Store orders, delivery, UPI and card payments, cancellations, returns and refunds, or contact 24x7 customer support.', path: '/help' });
  return (
    <div className="page-orders container narrow">
      <h1 className="page-title">Help Center</h1>
      {SHOPPING && <ContactForm />}
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
