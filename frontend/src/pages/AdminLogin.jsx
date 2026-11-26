import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import useSeo from '../hooks/useSeo';

// The admin portal's own sign-in (/admin/login). Linked from the header's Admin button and the footer; search engines are told to skip it.
// Only the store admin and CRM team members get in; accounts are provisioned in CRM → Team, never signed up here.
// With MFA on, the authenticator code is asked after the password.
export default function AdminLogin() {
  useSeo({ title: 'Admin sign-in', noindex: true });
  const { user, adminLogin, logout } = useAuth();
  const navigate = useNavigate();
  const { state } = useLocation();
  const [form, setForm] = useState({ email: '', password: '', code: '' });
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = state?.from?.pathname?.startsWith('/crm') ? state.from.pathname : '/crm';

  if (user?.portal === 'admin') return <Navigate to={next} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (user) logout(); // a store or seller session is replaced, never upgraded
      const result = await adminLogin(form.email.trim(), form.password, mfa ? form.code : undefined);
      if (result.mfaRequired) {
        setMfa(true);
        return;
      }
      navigate(next, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container portal-page">
      <form className="portal-card" onSubmit={submit} noValidate>
        <p className="portal-kicker">Arvixa · Admin portal</p>
        <h1>Sign in to the CRM</h1>
        <p className="muted small">For the store team only. Every sign-in is recorded.</p>
        {!mfa ? (
          <>
            <label className="field">Work email<input type="email" autoComplete="username" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="field">Password<input type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          </>
        ) : (
          <label className="field">Authenticator code
            <input inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={6} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} placeholder="6-digit code from your authenticator app" />
          </label>
        )}
        {error && <p className="alert alert-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Checking…' : mfa ? 'Verify and sign in' : 'Sign in'}</button>
        <p className="muted small">No account? An administrator adds team members in CRM → Team &amp; roles.</p>
      </form>
    </div>
  );
}
