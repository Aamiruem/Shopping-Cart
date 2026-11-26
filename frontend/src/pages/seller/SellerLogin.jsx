import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import useSeo from '../../hooks/useSeo';
import { validatePhone } from '../../utils/validation';

// The seller portal's own sign-in and sign-up (/seller/login, /seller/register), separate from customer login.
// Signing up creates an account; selling starts only after an admin approves the application.
export default function SellerLogin({ mode = 'login' }) {
  useSeo({ title: mode === 'login' ? 'Seller sign-in' : 'Sell on Arvixa', noindex: true });
  const { user, sellerLogin, sellerSignup, logout } = useAuth();
  const navigate = useNavigate();
  const [signup, setSignup] = useState(mode === 'register');
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (['seller', 'admin'].includes(user?.portal)) return <Navigate to="/seller/register" replace />;

  const set = (k) => (e) => setForm({ ...form, [k]: k === 'phone' ? e.target.value.replace(/\D/g, '').slice(0, 10) : e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (signup) {
      const problem = form.name.trim().length < 2 ? 'Please enter your full name' : validatePhone(form.phone) || (!form.phone && 'Please enter your mobile number');
      if (problem) return setError(problem);
    }
    setBusy(true);
    try {
      if (user) logout(); // a customer session is replaced by a seller-portal one
      if (signup) await sellerSignup({ name: form.name.trim(), email: form.email.trim(), phone: form.phone, password: form.password });
      else await sellerLogin(form.email.trim(), form.password);
      navigate('/seller/register', { replace: true }); // the application, or the hub once approved
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div className="container portal-page">
      <form className="portal-card" onSubmit={submit} noValidate>
        <p className="portal-kicker">Arvixa · Seller portal</p>
        <h1>{signup ? 'Start selling on Arvixa' : 'Seller sign-in'}</h1>
        <p className="muted small">{signup ? 'Create your seller account, then tell us about your business. Our team reviews every application before you can sell.' : 'Manage your products, orders and payouts.'}</p>
        {signup && <label className="field">Your full name<input required autoComplete="name" value={form.name} onChange={set('name')} /></label>}
        <label className="field">Email<input type="email" required autoComplete="username" value={form.email} onChange={set('email')} /></label>
        {signup && <label className="field">Mobile number<input inputMode="numeric" required autoComplete="tel-national" value={form.phone} onChange={set('phone')} placeholder="10-digit mobile" /></label>}
        <label className="field">Password<input type="password" required autoComplete={signup ? 'new-password' : 'current-password'} value={form.password} onChange={set('password')} />{signup && <span className="muted small">At least 8 characters, with a letter and a number</span>}</label>
        {error && <p className="alert alert-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-buy btn-block" disabled={busy}>{busy ? 'Please wait…' : signup ? 'Create seller account' : 'Sign in'}</button>
        <button type="button" className="btn-link" onClick={() => { setSignup(!signup); setError(''); }}>{signup ? 'Already selling with us? Sign in' : 'New seller? Create an account'}</button>
        <p className="muted small">Shopping instead? <Link to="/login">Customer sign-in</Link></p>
      </form>
    </div>
  );
}
