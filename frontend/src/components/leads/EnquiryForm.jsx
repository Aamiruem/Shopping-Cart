import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import Icon from '../common/Icon';

// What the enquiry is about -> the form it's filed under (api/_leads.mjs SOURCES)
const TOPICS = [
  ['contact', 'A product question'],
  ['quote', 'A bulk or corporate order'],
  ['business', 'Working with us (suppliers, brands)'],
];

/**
 * Sends an enquiry the store team follows up. Works without an account; a signed-in shopper's name and email fill in.
 * `productId` files it as a question about that product. Nothing is sent without the consent box ticked.
 */
export default function EnquiryForm({ productId = null, productName = '', onSent }) {
  const { user } = useAuth();
  const [form, setForm] = useState({
    topic: 'contact',
    name: user?.name || '',
    email: user?.email || '',
    phone: user?.phone || '',
    message: '',
    quantity: '',
    budget: '',
    consent: false,
    marketingConsent: false,
    website: '', // hidden from people; bots fill it in
  });
  const [sent, setSent] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const bulk = form.topic === 'quote';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.name.trim().length < 2) return setError('Please enter your name');
    if (!form.email.trim() && !form.phone.trim()) return setError('Please give an email address or a mobile number so we can reply');
    if (form.message.trim().length < 10) return setError('Please tell us a little more (at least 10 characters)');
    if (!form.consent) return setError('Please tick the box so we can contact you about this enquiry');
    setBusy(true);
    try {
      const result = await api.sendEnquiry({
        source: productId ? 'product' : form.topic,
        productId: productId || undefined,
        name: form.name,
        email: form.email,
        phone: form.phone,
        message: form.message,
        quantity: bulk && form.quantity ? Number(form.quantity) : undefined,
        budget: form.budget ? Number(form.budget) : undefined,
        consent: form.consent,
        marketingConsent: form.marketingConsent,
        website: form.website,
      });
      setSent(result);
      onSent?.(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return sent.kind === 'support' ? (
      <div className="enquiry-done" role="status">
        <p className="text-success"><Icon name="check" size={16} /> Thanks, we’ve got your message.</p>
        <p className="muted small">It sounds like it’s about an order. The quickest way to get it sorted is a support ticket: open the order from <Link to="/orders" className="btn-link">My Orders</Link> and choose “Raise a complaint”, or use <Link to="/help#contact" className="btn-link">Contact support</Link>.</p>
      </div>
    ) : (
      <div className="enquiry-done" role="status">
        <p className="text-success"><Icon name="check" size={16} /> Thanks{form.name ? `, ${form.name.split(' ')[0]}` : ''}! Your enquiry has reached our team.</p>
        <p className="muted small">We reply within one working day, by {form.email && form.phone ? 'email or phone' : form.email ? 'email' : 'phone'}.</p>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => { setSent(null); setForm({ ...form, message: '', quantity: '', budget: '' }); }}>Send another</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="account-form enquiry-form" noValidate>
      <div className="form-grid">
        {!productId && (
          <label className="field span-2">What’s it about?
            <select value={form.topic} onChange={set('topic')}>
              {TOPICS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
        )}
        <label className="field">Your name<input value={form.name} maxLength={80} autoComplete="name" onChange={set('name')} /></label>
        <label className="field">Email<input type="email" value={form.email} maxLength={254} autoComplete="email" onChange={set('email')} /></label>
        <label className="field">Mobile (optional)<input type="tel" inputMode="numeric" value={form.phone} maxLength={16} autoComplete="tel" onChange={set('phone')} placeholder="10-digit number" /></label>
        {bulk ? (
          <label className="field">Quantity (units)<input type="number" min="1" inputMode="numeric" value={form.quantity} onChange={set('quantity')} /></label>
        ) : (
          <label className="field">Budget in ₹ (optional)<input type="number" min="1" inputMode="numeric" value={form.budget} onChange={set('budget')} /></label>
        )}
        <label className="field span-2">
          {productId ? `Your question about ${productName || 'this product'}` : 'Your message'}
          <textarea rows={4} maxLength={2000} value={form.message} onChange={set('message')}
            placeholder={productId ? 'e.g. Does it come with a warranty? Can I order 20 pieces?' : bulk ? 'Which products, where to deliver, and when you need them' : 'e.g. I need a phone for photography under ₹25,000'} />
        </label>
      </div>
      {/* A honeypot: invisible to people and screen readers, so only bots fill it */}
      <label className="hp-field" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} /></label>
      <label className="check-row consent-row"><input type="checkbox" checked={form.consent} onChange={set('consent')} /> Arvixa Store may contact me about this enquiry. <Link to="/privacy" className="btn-link">Privacy policy</Link></label>
      <label className="check-row consent-row"><input type="checkbox" checked={form.marketingConsent} onChange={set('marketingConsent')} /> Also send me offers and new arrivals by email (optional, unsubscribe any time)</label>
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send enquiry'}</button></div>
    </form>
  );
}

/** Footer sign-up: one email, its own explicit consent. */
export function NewsletterForm() {
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [state, setState] = useState({ busy: false, done: false, error: '' });

  const submit = async (e) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) return setState({ ...state, error: 'Please enter a valid email address' });
    if (!consent) return setState({ ...state, error: 'Please tick the box to agree to receive our emails' });
    setState({ busy: true, done: false, error: '' });
    try {
      await api.sendEnquiry({ source: 'newsletter', email, marketingConsent: true, website });
      setState({ busy: false, done: true, error: '' });
    } catch (err) {
      setState({ busy: false, done: false, error: err.message });
    }
  };

  if (state.done) return <p className="newsletter-done" role="status"><Icon name="check" size={14} /> You’re on the list. Thanks for subscribing!</p>;
  return (
    <form className="newsletter-form" onSubmit={submit} noValidate>
      <div className="newsletter-row">
        <label className="sr-only" htmlFor="newsletter-email">Email address</label>
        <input id="newsletter-email" type="email" autoComplete="email" placeholder="Your email address" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={state.busy}>{state.busy ? '…' : 'Subscribe'}</button>
      </div>
      <label className="hp-field" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
      <label className="check-row newsletter-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Email me offers and new arrivals. Unsubscribe any time.</label>
      {state.error && <p className="newsletter-error" role="alert">{state.error}</p>}
    </form>
  );
}
