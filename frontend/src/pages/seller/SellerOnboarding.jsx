import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, TOKEN_KEY } from '../../api/client';
import Icon from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { validatePhone } from '../../utils/validation';

const PERKS = [
  { icon: 'tag', title: 'List products in minutes', text: 'Add, edit and manage stock from one place.' },
  { icon: 'zap', title: 'AI sales insights', text: 'Forecasts, predicted best sellers and restock alerts.' },
  { icon: 'user', title: 'Know your customers', text: 'Segments, churn risk and cohort retention.' },
];

export default function SellerOnboarding() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState({ storeName: '', gstin: '', phone: user.phone || '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (['seller', 'admin'].includes(user.role)) return <Navigate to="/seller/dashboard" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const problem = form.storeName.trim().length < 3 ? 'Store name must be at least 3 characters' : validatePhone(form.phone);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const { token, user: updated } = await api.becomeSeller({ storeName: form.storeName.trim(), gstin: form.gstin || null, phone: form.phone || null });
      localStorage.setItem(TOKEN_KEY, token); // the role changed, so the token did too
      setUser(updated);
      toast.show(`Welcome aboard, ${updated.storeName}!`);
      navigate('/seller/products', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="container page-onboard">
      <div className="auth-card">
        <div className="auth-aside">
          <h1>Sell on Arvixa</h1>
          <p>Reach shoppers across India and grow with built-in analytics.</p>
          <ul className="perk-list">
            {PERKS.map((p) => <li key={p.title}><Icon name={p.icon} size={20} /><div><strong>{p.title}</strong><span>{p.text}</span></div></li>)}
          </ul>
        </div>
        <form className="auth-form" onSubmit={submit} noValidate>
          <h2>Create your store</h2>
          <label className="field">Store name<input value={form.storeName} onChange={(e) => setForm({ ...form, storeName: e.target.value })} maxLength={120} required placeholder="e.g. Aamir Electronics" /></label>
          <label className="field">GSTIN (optional)<input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase().slice(0, 15) })} placeholder="29ABCDE1234F1Z5" /></label>
          <label className="field">Business phone (optional)<input value={form.phone} inputMode="numeric" onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></label>
          {error && <p className="alert alert-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-buy btn-lg btn-block" disabled={busy}>{busy ? 'Creating…' : 'Start selling'}</button>
          <p className="muted small">Selling as {user.name} ({user.email})</p>
        </form>
      </div>
    </div>
  );
}
