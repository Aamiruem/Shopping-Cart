import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { validatePhone } from '../../utils/validation';

const PERKS = [
  { icon: 'tag', title: 'List products', text: 'Add photos, prices and stock. Each product is checked by our team before it goes on sale.' },
  { icon: 'truck', title: 'Sell across India', text: 'Shoppers anywhere in India can order your products.' },
  { icon: 'wallet', title: 'Clear payouts', text: 'Settlements for delivered orders, with the commission shown up front.' },
];
const TYPES = [['individual', 'Individual'], ['proprietorship', 'Sole proprietorship'], ['partnership', 'Partnership'], ['llp', 'LLP'], ['private_limited', 'Private limited company'], ['other', 'Other']];

// /seller/register: the seller application and its status. Selling starts only when an admin approves it.
export default function SellerOnboarding() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [app, setApp] = useState(undefined);
  const [form, setForm] = useState({ storeName: '', gstin: '', pan: '', phone: user?.phone || '', businessType: 'individual', businessAddress: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.sellerApplication().then(setApp).catch((err) => {
      setApp(null);
      setError(err.message);
    });
  }, []);

  if (user?.role === 'admin' || app?.status === 'approved') return <Navigate to="/seller/dashboard" replace />;
  if (app === undefined) return <Spinner />;

  const set = (k) => (e) => setForm({ ...form, [k]: ['gstin', 'pan'].includes(k) ? e.target.value.toUpperCase() : e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const problem = form.storeName.trim().length < 3 ? 'Store name must be at least 3 characters'
      : !/^[A-Z]{5}\d{4}[A-Z]$/.test(form.pan) ? 'Please enter a valid PAN, e.g. ABCDE1234F' : validatePhone(form.phone);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const saved = await api.becomeSeller({ ...form, storeName: form.storeName.trim(), gstin: form.gstin || null });
      setApp(saved);
      setUser((u) => ({ ...u, seller: { status: saved.status, sellerId: saved.seller_code } }));
      toast.show('Application sent. We’ll review it shortly.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  if (app && ['pending', 'suspended'].includes(app.status)) {
    return (
      <div className="container portal-page">
        <div className="portal-card">
          <p className="portal-kicker">Seller application · {app.seller_code}</p>
          <h1>{app.status === 'pending' ? 'Your application is being reviewed' : 'Your seller account is suspended'}</h1>
          {app.status === 'suspended' && app.review_note && <p className="alert alert-error">{app.review_note}</p>}
          <dl className="portal-facts">
            <div><dt>Store</dt><dd>{app.store_name}</dd></div>
            <div><dt>Submitted</dt><dd>{new Date(app.created_at).toLocaleDateString('en-IN')}</dd></div>
            <div><dt>PAN</dt><dd>{app.pan || '—'}</dd></div>
            {app.gstin && <div><dt>GSTIN</dt><dd>{app.gstin}</dd></div>}
          </dl>
          {app.missing?.length > 0 && (
            <>
              <p><strong>Still needed before we can approve:</strong></p>
              <ul>{app.missing.map((m) => <li key={m}>{m}</li>)}</ul>
              {app.missing.some((m) => m.startsWith('Verify')) && <Link className="btn btn-outline" to="/account">Verify in your account</Link>}
            </>
          )}
          <p className="muted small">Our team checks your PAN and GSTIN on the government portals and confirms your bank account with you. You’ll get an email when there’s a decision.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container page-onboard">
      <div className="auth-card">
        <div className="auth-aside">
          <h1>Sell on Arvixa</h1>
          <p>Tell us about your business. Every application is reviewed before selling starts.</p>
          <ul className="perk-list">
            {PERKS.map((p) => <li key={p.title}><Icon name={p.icon} size={20} /><div><strong>{p.title}</strong><span>{p.text}</span></div></li>)}
          </ul>
        </div>
        <form className="auth-form" onSubmit={submit} noValidate>
          <h2>{app?.status === 'rejected' ? 'Apply again' : 'Seller application'}</h2>
          {app?.status === 'rejected' && app.review_note && <p className="alert alert-error">Not approved last time: {app.review_note}</p>}
          <label className="field">Store name<input value={form.storeName} onChange={set('storeName')} maxLength={120} required placeholder="e.g. Aamir Electronics" /></label>
          <label className="field">Business type<select value={form.businessType} onChange={set('businessType')}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">PAN (of the business or owner)<input value={form.pan} onChange={set('pan')} maxLength={10} required placeholder="ABCDE1234F" /></label>
          <label className="field">GSTIN (if registered)<input value={form.gstin} onChange={set('gstin')} maxLength={15} placeholder="29ABCDE1234F1Z5" /></label>
          <label className="field">Business phone<input value={form.phone} inputMode="numeric" onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></label>
          <label className="field">Business address<textarea rows={2} value={form.businessAddress} onChange={set('businessAddress')} maxLength={400} /></label>
          {error && <p className="alert alert-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-buy btn-lg btn-block" disabled={busy}>{busy ? 'Sending…' : 'Submit application'}</button>
          <p className="muted small">Applying as {user?.name} ({user?.email}). We never ask you to upload identity documents here.</p>
        </form>
      </div>
    </div>
  );
}
