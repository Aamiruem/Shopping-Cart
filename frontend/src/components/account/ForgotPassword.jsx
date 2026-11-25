import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import Icon from '../common/Icon';
import CodeVerify from './CodeVerify';

const PASSWORD_MIN = 8;
const isMobile = (value) => /^[+\d\s-]+$/.test(value.trim()) && value.trim() !== '';
const toMobile = (value) => {
  const digits = value.replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
};
const passwordProblem = (p) => {
  if (p.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (!/[a-z]/i.test(p) || !/\d/.test(p)) return 'Password must contain at least one letter and one number';
  return '';
};

// Forgot password: a code by email (or SMS / WhatsApp to a verified mobile), then a new password. The server answers
// the same whether or not the account exists, so this screen never says "no such account".
export default function ForgotPassword({ channels, initialIdentifier = '', onDone, onBack }) {
  const { resetPassword } = useAuth();
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [channel, setChannel] = useState(channels.sms ? 'sms' : 'whatsapp');
  const [sent, setSent] = useState(null);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mobile = isMobile(identifier);
  const usable = mobile ? channels.mobile : channels.email;

  const request = async (e) => {
    e.preventDefault();
    setError('');
    const value = mobile ? toMobile(identifier) : identifier.trim().toLowerCase();
    if (!value) return setError('Please enter your email address or mobile number');
    if (!usable) return setError(mobile ? 'Codes by SMS or WhatsApp aren’t available right now. Please use your email.' : 'Email codes aren’t available right now.');
    setBusy(true);
    try {
      setSent({ identifier: value, ...(await api.forgotPassword(value, mobile ? channel : 'email')) });
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  if (sent) {
    return (
      <CodeVerify
        title="Set a new password"
        info={sent}
        verifyLabel="Save password & log in"
        note={(s) => <>If an Arvixa account uses <strong>{s?.sentTo}</strong>, we’ve sent it a 6-digit code.</>}
        onVerify={async (code) => {
          const problem = passwordProblem(password);
          if (problem) throw new Error(problem); // shown by CodeVerify; the code stays valid
          onDone(await resetPassword(sent.identifier, code, password));
        }}
        onResend={async () => ({ identifier: sent.identifier, ...(await api.forgotPassword(sent.identifier, sent.channel)) })}
        onBack={() => setSent(null)}
      >
        <label className="field reset-password">
          <span>New password</span>
          <span className="reset-password-input">
            <input type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN} />
            <button type="button" className="icon-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
              <Icon name={show ? 'eyeOff' : 'eye'} size={16} />
            </button>
          </span>
          <small className="muted">{PASSWORD_MIN}+ characters with letters and numbers. Type it before the code.</small>
        </label>
      </CodeVerify>
    );
  }

  return (
    <form className="code-verify" onSubmit={request} noValidate>
      <div className="code-icon"><Icon name="lock" size={26} /></div>
      <h2>Forgot your password?</h2>
      <p className="muted">Enter your email{channels.mobile ? ' or verified mobile number' : ''} and we’ll send you a code to set a new one.</p>
      <label className="field">
        <span>{channels.mobile ? 'Email or mobile number' : 'Email address'}</span>
        <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" autoFocus />
      </label>
      {mobile && channels.mobile && (
        <div className="otp-channel" role="radiogroup" aria-label="Send the code by">
          <span className="muted small">Send code by</span>
          {[['sms', 'SMS', 'message'], ['whatsapp', 'WhatsApp', 'phone']].filter(([id]) => channels[id]).map(([id, label, icon]) => (
            <button key={id} type="button" role="radio" aria-checked={channel === id} className={`otp-chip ${id} ${channel === id ? 'active' : ''}`} onClick={() => setChannel(id)}>
              <Icon name={icon} size={14} /> {label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-buy btn-lg btn-block" disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
      <p className="code-actions small"><button type="button" className="btn-link" onClick={onBack}>Back to login</button></p>
    </form>
  );
}
