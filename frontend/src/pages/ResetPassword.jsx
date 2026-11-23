import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import useSeo from '../hooks/useSeo';
import { PASSWORD_MIN, validatePassword } from '../utils/validation';

// Opened from the emailed reset link (/reset-password?token=…): choose a new password, then you're signed in
export default function ResetPassword() {
  useSeo({ title: 'Choose a new password', noindex: true });
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { resetPassword } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const problem = validatePassword(password) || (password !== confirm ? 'The two passwords don’t match' : '');
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      const user = await resetPassword(token, password);
      toast.show(`Password changed. Welcome back, ${user.name}!`);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="container narrow-form reset-page">
      <form className="panel auth-form" onSubmit={submit} noValidate>
        <h1>Choose a new password</h1>
        {!token ? (
          <p className="alert alert-error" role="alert">This link is incomplete. Please open the link from the email again, or <Link to="/login">ask for a new one</Link>.</p>
        ) : (
          <>
            <label className="field">New password (min. {PASSWORD_MIN} characters, with a letter and a number)
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <label className="field">Type it again
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            {error && <p className="alert alert-error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Save and sign in'}</button>
            <p className="muted small">Link expired? <Link to="/login">Ask for a new one</Link> from the login page.</p>
          </>
        )}
      </form>
    </div>
  );
}
