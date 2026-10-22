import { useEffect, useRef, useState } from 'react';
import Icon from '../common/Icon';

const RESEND_SECONDS = 30;

// 6-digit code entry shared by signup (email), phone (SMS / WhatsApp) and payout confirmation.
// `info` = what the API returned when it sent the code: { sentTo, channel, devCode? }
export default function CodeVerify({ title, info, onVerify, onResend, onBack, verifyLabel = 'Verify' }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(RESEND_SECONDS);
  const [sent, setSent] = useState(info);
  const inputRef = useRef(null);

  useEffect(() => setSent(info), [info]);
  useEffect(() => inputRef.current?.focus(), [sent]);
  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const via = { email: 'email', sms: 'SMS', whatsapp: 'WhatsApp' }[sent?.channel] || 'email';

  const submit = async (e) => {
    e.preventDefault();
    e.stopPropagation(); // never also submit a surrounding form (e.g. the profile form)
    if (!/^\d{6}$/.test(code)) return setError('Please enter the 6-digit code');
    setBusy(true);
    setError('');
    try {
      await onVerify(code);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const resend = async () => {
    setError('');
    try {
      setSent(await onResend());
      setCode('');
      setWait(RESEND_SECONDS);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className="code-verify" onSubmit={submit} noValidate>
      <div className="code-icon"><Icon name={via === 'email' ? 'mail' : via === 'WhatsApp' ? 'message' : 'phone'} size={26} /></div>
      <h2>{title}</h2>
      <p className="muted">We sent a 6-digit code by {via} to <strong>{sent?.sentTo}</strong>. It expires in 5 minutes.</p>
      {sent?.devCode && (
        <p className="otp-dev"><Icon name="zap" size={12} /> Dev mode ({via} not connected yet): your code is <code>{sent.devCode}</code></p>
      )}
      <input
        ref={inputRef}
        className="otp-input"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="••••••"
        aria-label="6-digit verification code"
      />
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-buy btn-lg btn-block" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : verifyLabel}</button>
      <p className="code-actions small">
        {wait > 0 ? <span className="muted">Resend code in {wait}s</span> : <button type="button" className="btn-link" onClick={resend}>Resend code</button>}
        {onBack && <button type="button" className="btn-link" onClick={onBack}>Change details</button>}
      </p>
    </form>
  );
}
