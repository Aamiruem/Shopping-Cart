import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { formatPrice } from '../../utils/format';
import Icon from '../common/Icon';

const RESEND_SECONDS = 30;

// Emails a one-time code and asks for it before an online (UPI / card) payment is confirmed.
// `onConfirm(code)` places the order and throws if the server rejects the code.
export default function PaymentOtp({ amount, onConfirm, onCancel }) {
  const [code, setCode] = useState('');
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [wait, setWait] = useState(0);
  const inputRef = useRef(null);

  const send = useCallback(async () => {
    setSending(true);
    setError('');
    try {
      setInfo(await api.requestPaymentOtp());
      setWait(RESEND_SECONDS);
      setCode('');
      inputRef.current?.focus();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }, []);

  // Send once per dialog; the ref stops React StrictMode's double effect from hitting the resend limit
  const sentOnce = useRef(false);
  useEffect(() => {
    if (sentOnce.current) return;
    sentOnce.current = true;
    send();
  }, [send]);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const submit = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError('Please enter the 6-digit code');
    setVerifying(true);
    setError('');
    try {
      await onConfirm(code);
    } catch (err) {
      setError(err.message);
      setVerifying(false);
    }
  };

  return (
    <div className="otp-overlay" role="dialog" aria-modal="true" aria-labelledby="otp-title">
      <form className="otp-card panel" onSubmit={submit}>
        <button type="button" className="icon-btn otp-close" onClick={onCancel} aria-label="Cancel payment"><Icon name="x" /></button>
        <div className="otp-icon"><Icon name="lock" size={28} /></div>
        <h2 id="otp-title">Verify your payment</h2>
        <p className="muted">
          {info ? <>Enter the 6-digit code sent to <strong>{info.sentTo}</strong> to pay <strong>{formatPrice(amount)}</strong>.</> : 'Sending a verification code to your email…'}
        </p>

        {info?.devCode && (
          <p className="otp-dev"><Icon name="zap" size={12} /> Dev mode (no SMTP configured): your code is <code>{info.devCode}</code></p>
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
          disabled={!info}
        />
        {error && <p className="alert alert-error" role="alert">{error}</p>}

        <button type="submit" className="btn btn-buy btn-lg btn-block" disabled={!info || verifying || code.length !== 6}>
          {verifying ? 'Verifying…' : `Verify & pay ${formatPrice(amount)}`}
        </button>
        <p className="otp-resend small">
          Didn’t get it?{' '}
          {wait > 0 ? <span className="muted">Resend in {wait}s</span> : <button type="button" className="btn-link" disabled={sending} onClick={send}>{sending ? 'Sending…' : 'Resend code'}</button>}
        </p>
        <p className="muted small otp-note"><Icon name="shield" size={12} /> Never share this code. Arvixa will never ask for it by phone.</p>
      </form>
    </div>
  );
}
