import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import useOtpChannels from '../../hooks/useOtpChannels';
import Icon from '../common/Icon';
import CodeVerify from './CodeVerify';

const PHONE_RE = /^[6-9]\d{9}$/;
const digits = (v) => v.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '').slice(0, 10);

// The first-visit popup and the checkout sign-in: mobile number + one-time code (SMS, or WhatsApp where set up),
// which signs in or creates the account. Email login and sign-up stay one tap away; browsing never needs an account.
// A channel only appears when its provider is connected: nothing pretends to send a code.
export default function WelcomeSheet({ onDone, onEmail, reason }) {
  const channels = useOtpChannels();
  const { mobileLogin, mobileComplete } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState('phone'); // phone | code | profile
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState('sms');
  const [sent, setSent] = useState(null);
  const [signup, setSignup] = useState(null);
  const [profile, setProfile] = useState({ name: '', email: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const via = channel === 'whatsapp' && channels.whatsapp ? 'whatsapp' : channels.sms ? 'sms' : 'whatsapp';

  const start = async (e) => {
    e?.preventDefault();
    setError('');
    if (!PHONE_RE.test(phone)) return setError('Please enter a valid 10-digit mobile number');
    setBusy(true);
    try {
      setSent(await api.mobileStart(phone, via));
      setStep('code');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };
  const verify = async (code) => {
    const result = await mobileLogin(phone, code);
    if (result.user) {
      toast.show(`Welcome back, ${result.user.name.split(' ')[0]}`);
      onDone();
    } else {
      setSignup(result);
      setStep('profile');
    }
  };
  const finish = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await mobileComplete({ ...profile, signupToken: signup.signupToken });
      toast.show(`Welcome to Arvixa, ${user.name.split(' ')[0]}! Your customer ID is ${user.customerId || 'ready'}.`);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="welcome-sheet">
      <h2 className="auth-title">Welcome to Arvixa</h2>
      <p className="muted">{reason || 'Sign in or create an account to enjoy a secure shopping experience.'}</p>

      {step === 'phone' && (
        channels.ready && channels.mobile ? (
          <form className="stack-sm" onSubmit={start} noValidate>
            <label className="field">
              Mobile number
              <span className="phone-input"><span className="prefix">+91</span>
                <input value={phone} onChange={(e) => setPhone(digits(e.target.value))} inputMode="numeric" autoComplete="tel-national" placeholder="10-digit mobile number" aria-invalid={Boolean(error)} />
              </span>
            </label>
            {channels.sms && channels.whatsapp && (
              <div className="row" role="radiogroup" aria-label="Send the code by">
                <label className="check"><input type="radio" name="via" checked={via === 'sms'} onChange={() => setChannel('sms')} /> SMS</label>
                <label className="check"><input type="radio" name="via" checked={via === 'whatsapp'} onChange={() => setChannel('whatsapp')} /> WhatsApp</label>
              </div>
            )}
            {error && <p className="alert alert-error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Sending…' : `Get code by ${via === 'whatsapp' ? 'WhatsApp' : 'SMS'}`}</button>
            <p className="muted small">New here? The same code creates your account. We never share your number.</p>
          </form>
        ) : channels.ready ? (
          <p className="alert alert-info">Mobile sign-in isn’t available yet. Please use your email below.</p>
        ) : null
      )}

      {step === 'code' && (
        <CodeVerify
          title={`Enter the code sent to +91 ${phone}`}
          info={sent}
          onVerify={verify}
          onResend={() => api.mobileStart(phone, via)}
          onBack={() => setStep('phone')}
          verifyLabel="Continue"
        />
      )}

      {step === 'profile' && (
        <form className="stack-sm" onSubmit={finish}>
          <p><Icon name="check" size={14} /> +91 {phone} is verified. Just your name and email to create the account:</p>
          <label className="field">Full name<input required minLength={2} value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} autoComplete="name" /></label>
          <label className="field">Email<input type="email" required value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} autoComplete="email" /></label>
          <p className="muted small">For order confirmations and invoices.</p>
          {error && <p className="alert alert-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        </form>
      )}

      {step === 'phone' && (
        <div className="welcome-alt">
          <button type="button" className="btn btn-outline btn-block" onClick={() => onEmail('login')}>Log in with email</button>
          <button type="button" className="btn btn-outline btn-block" onClick={() => onEmail('register')}>Create account with email</button>
          <button type="button" className="btn-link" onClick={onDone}>Continue browsing as a guest</button>
        </div>
      )}
    </div>
  );
}
