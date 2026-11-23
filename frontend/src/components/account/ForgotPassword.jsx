import { useState } from 'react';
import { api } from '../../api/client';
import { validateEmail } from '../../utils/validation';

// "Forgot password?" on the login form: emails a one-time reset link. The answer is the same whether or not the
// address has an account, so this form can't be used to find out who shops here.
export function ForgotPassword({ initialEmail = '', onBack }) {
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const problem = validateEmail(email.trim());
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      setSent((await api.forgotPassword(email.trim())).message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <h2>Reset your password</h2>
      {sent ? (
        <p className="alert alert-success" role="status">{sent}</p>
      ) : (
        <>
          <p className="muted small">Enter the email you signed up with and we’ll send you a link to choose a new password.</p>
          <label className="field">Email
            <input type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          {error && <p className="alert alert-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </>
      )}
      <button type="button" className="btn-link" onClick={onBack}>Back to login</button>
    </form>
  );
}
