import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import Icon from '../common/Icon';

// "Ask about this product": a question, or a request for a bulk quote, goes to the store team as a lead.
// Contact details are optional and used only with the consent box ticked.
export default function ProductEnquiry({ product }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ message: '', name: user?.name || '', email: user?.email || '', phone: '', consent: false, quote: false });
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => {
    setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
    setError(''); // an old message shouldn't stay up once the form changes
  };

  const submit = async (e) => {
    e.preventDefault();
    const contact = form.email.trim() || form.phone.trim();
    if (form.message.trim().length < 5) return setError('Please write your question');
    if (form.quote && !contact) return setError('Please give an email or mobile number so we can send the quote');
    if (contact && !form.consent) return setError('Please tick the box so we can reply to you');
    setBusy(true);
    setError('');
    try {
      const { message } = await api.sendLead({
        source: form.quote ? 'quote' : 'product',
        productId: product._id,
        message: form.message.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        consent: form.consent,
      });
      setDone(message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <p className="alert alert-success product-enquiry" role="status">{done}</p>;
  if (!open) {
    return (
      <button type="button" className="btn-link product-enquiry-open" onClick={() => setOpen(true)}>
        <Icon name="message" size={16} /> Ask a question or request a bulk quote
      </button>
    );
  }
  return (
    <form className="detail-section product-enquiry" onSubmit={submit} noValidate>
      <h3>Ask about this product</h3>
      <label className="field">Your question
        <textarea rows={3} maxLength={2000} value={form.message} onChange={set('message')} placeholder="e.g. Is this available in blue? I need 20 pieces for my office." />
      </label>
      <div className="enquiry-contact">
        <label className="field">Name<input value={form.name} maxLength={100} onChange={set('name')} autoComplete="name" /></label>
        <label className="field">Email<input type="email" value={form.email} maxLength={254} onChange={set('email')} autoComplete="email" /></label>
        <label className="field">Mobile<input type="tel" value={form.phone} maxLength={15} onChange={set('phone')} autoComplete="tel" inputMode="tel" /></label>
      </div>
      <label className="check-row"><input type="checkbox" checked={form.quote} onChange={set('quote')} /> I need a quote for a larger quantity</label>
      <label className="check-row"><input type="checkbox" checked={form.consent} onChange={set('consent')} /> Arvixa Store may contact me about this enquiry</label>
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <div className="enquiry-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
        <button type="button" className="btn-link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
