import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import useOtpChannels from '../../hooks/useOtpChannels';
import { trackLogin } from '../../utils/analytics';
import { playSound } from '../../utils/sound';
import Icon from '../common/Icon';
import CodeVerify from './CodeVerify';
import ForgotPassword from './ForgotPassword';
import GoogleButton from './GoogleButton';

const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CHANNEL = { email: 'email', sms: 'SMS', whatsapp: 'WhatsApp' };

// "98765 43210", "+91 98765-43210", "09876543210" -> "9876543210"
function asMobile(value) {
  const d = value.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  return d;
}

// What was typed in the one field: an email or an Indian mobile number
function parse(raw) {
  const v = raw.trim();
  if (!v) return { error: 'Enter your email or mobile number' };
  if (v.includes('@')) return EMAIL_RE.test(v) ? { kind: 'email', value: v.toLowerCase() } : { error: 'That email address doesn’t look right' };
  if (/^[+\d\s()-]+$/.test(v)) {
    const m = asMobile(v);
    return PHONE_RE.test(m) ? { kind: 'mobile', value: m } : { error: 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9' };
  }
  return { error: 'Enter a valid email address or mobile number' };
}

const shown = (who) => (who.kind === 'mobile' ? `+91 ${who.value.slice(0, 5)} ${who.value.slice(5)}` : who.value);

function ErrorLine({ error }) {
  if (!error) return null;
  return (
    <p className="alert alert-error" role="alert">
      {error}
      {/admin portal/i.test(error) && <> <Link to="/admin/login">Go to the admin portal</Link></>}
    </p>
  );
}

/**
 * Login and sign-up in one simple form: one field for an email or a mobile number, then a one-time code by email,
 * SMS or WhatsApp (only the channels that are really connected), or a password. A code signs in an existing account
 * or creates a new one with just a name. Used by the login popup and the /login and /register pages.
 */
export default function QuickAuth({ initial = 'login', reason = '', onDone, onGuest }) {
  const channels = useOtpChannels();
  const { login, register, verifySignup, mobileLogin, mobileComplete, googleLogin } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState('start'); // start | code | profile | password | register | signup-code | forgot
  const [field, setField] = useState('');
  const [who, setWho] = useState(null); // { kind: 'email' | 'mobile', value }
  const [mobileVia, setMobileVia] = useState('sms');
  const [sent, setSent] = useState(null);
  const [signup, setSignup] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const typed = parse(field);
  const typedMobile = typed.kind === 'mobile';
  const mobileChannels = ['sms', 'whatsapp'].filter((c) => channels[c]);
  // The code channel for an address, or null when nothing can send one (then the password is the way in)
  const codeChannel = (w) => (w.kind === 'email' ? (channels.email ? 'email' : null) : channels[mobileVia] ? mobileVia : mobileChannels[0] || null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const run = async (fn) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      playSound('error');
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const finish = (user, isNew, method) => {
    playSound('success');
    trackLogin(method);
    toast.show(isNew ? `Welcome to Arvixa, ${user.name.split(' ')[0]}!` : `Welcome back, ${user.name.split(' ')[0]}!`);
    onDone?.(user);
  };

  // Prefill the password / sign-up forms with whatever was typed in the one field
  const toPassword = (w, why = '') => {
    setNotice(why);
    setForm((f) => ({ ...f, email: w?.kind === 'email' ? w.value : f.email, phone: w?.kind === 'mobile' ? w.value : f.phone }));
    setStep('password');
  };
  const toRegister = () => {
    setNotice('');
    setError('');
    setForm((f) => ({ ...f, email: who?.kind === 'email' ? who.value : f.email, phone: who?.kind === 'mobile' ? who.value : f.phone }));
    setStep('register');
  };

  const start = (e) => {
    e.preventDefault();
    if (typed.error) return setError(typed.error);
    const w = { kind: typed.kind, value: typed.value };
    setWho(w);
    const via = codeChannel(w);
    if (!via) {
      const label = w.kind === 'email' ? 'Email codes' : 'Codes by SMS or WhatsApp';
      return initial === 'register' ? toRegister() : toPassword(w, `${label} aren’t set up yet, so please use your password.`);
    }
    return run(async () => {
      setSent(await api.mobileStart(w.value, via));
      setStep('code');
    });
  };

  const verify = async (code) => {
    const result = await mobileLogin(who.value, code);
    if (result.user) return finish(result.user, false, 'otp');
    setSignup(result);
    setStep('profile');
    return undefined;
  };

  const createFromCode = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { signupToken: signup.signupToken, name: form.name.trim() };
      if (who.kind === 'mobile') body.email = form.email.trim();
      else if (form.phone) body.phone = form.phone;
      finish(await mobileComplete(body), true, 'otp');
    });
  };

  const passwordLogin = (e) => {
    e.preventDefault();
    run(async () => finish(await login(form.email.trim(), form.password), false, 'password'));
  };

  const passwordSignup = (e) => {
    e.preventDefault();
    run(async () => {
      const result = await register({ name: form.name.trim(), email: form.email.trim(), password: form.password, ...(form.phone ? { phone: form.phone } : {}) });
      if (result.user) return finish(result.user, true, 'password');
      setSent({ email: form.email.trim().toLowerCase(), ...result });
      setStep('signup-code');
      return undefined;
    });
  };

  const onGoogle = (credential) => run(async () => finish(await googleLogin(credential), false, 'google'));
  const back = () => {
    setError('');
    setNotice('');
    setStep('start');
  };

  const passwordInput = (autoComplete) => (
    <span className="qa-password">
      <input type={showPassword ? 'text' : 'password'} required value={form.password} onChange={set('password')} autoComplete={autoComplete} placeholder={autoComplete === 'new-password' ? 'At least 8 characters, with a letter and a number' : 'Your password'} />
      <button type="button" className="qa-eye" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
        <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
      </button>
    </span>
  );

  let body;
  if (step === 'code') {
    body = (
      <CodeVerify
        title={`Enter the code sent to ${shown(who)}`}
        info={sent}
        verifyLabel="Continue"
        onVerify={verify}
        onResend={() => api.mobileStart(who.value, sent?.channel || codeChannel(who))}
        onBack={back}
      />
    );
  } else if (step === 'signup-code') {
    body = (
      <CodeVerify
        title={`Enter the code sent to ${sent.email}`}
        info={sent}
        verifyLabel="Verify & create account"
        onVerify={async (code) => finish(await verifySignup(sent.email, code), true, 'password')}
        onResend={() => api.resendSignup(sent.email)}
        onBack={() => setStep('register')}
      />
    );
  } else if (step === 'forgot') {
    body = <ForgotPassword channels={channels} initialIdentifier={who?.value || form.email} onDone={(u) => finish(u, false, 'reset')} onBack={() => setStep('password')} />;
  } else if (step === 'profile') {
    body = (
      <form className="qa-form" onSubmit={createFromCode}>
        <p className="qa-verified"><Icon name="checkCircle" size={16} /> {shown(who)} is verified. You’re new here, so just one more step.</p>
        <label className="qa-label">Your name<input required minLength={2} value={form.name} onChange={set('name')} autoComplete="name" autoFocus /></label>
        {who.kind === 'mobile' ? (
          <label className="qa-label">Email <small>for order updates and invoices</small><input type="email" required value={form.email} onChange={set('email')} autoComplete="email" /></label>
        ) : (
          <label className="qa-label">Mobile number <small>optional, for delivery updates</small><input inputMode="numeric" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }))} autoComplete="tel-national" /></label>
        )}
        <ErrorLine error={error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create my account'}</button>
      </form>
    );
  } else if (step === 'password') {
    body = (
      <form className="qa-form" onSubmit={passwordLogin}>
        {notice && <p className="alert alert-info" role="status">{notice}</p>}
        <label className="qa-label">Email<input type="email" required value={form.email} onChange={set('email')} autoComplete="username" autoFocus={!form.email} /></label>
        {who?.kind === 'mobile' && <p className="muted small qa-tip">Password login uses the email on your account.</p>}
        <label className="qa-label">Password{passwordInput('current-password')}</label>
        {channels.any && <button type="button" className="btn-link qa-forgot" onClick={() => setStep('forgot')}>Forgot password?</button>}
        <ErrorLine error={error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Please wait…' : 'Log in'}</button>
        <p className="qa-switch">New to Arvixa? <button type="button" className="btn-link" onClick={toRegister}>Create an account</button></p>
        <button type="button" className="btn-link qa-back" onClick={back}><Icon name="chevronLeft" size={14} /> Use a one-time code instead</button>
      </form>
    );
  } else if (step === 'register') {
    body = (
      <form className="qa-form" onSubmit={passwordSignup}>
        <label className="qa-label">Your name<input required minLength={2} value={form.name} onChange={set('name')} autoComplete="name" autoFocus /></label>
        <label className="qa-label">Email<input type="email" required value={form.email} onChange={set('email')} autoComplete="email" /></label>
        <label className="qa-label">Mobile number <small>optional</small><input inputMode="numeric" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }))} autoComplete="tel-national" /></label>
        <label className="qa-label">Create a password{passwordInput('new-password')}</label>
        <ErrorLine error={error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="qa-switch">Already have an account? <button type="button" className="btn-link" onClick={() => toPassword(who)}>Log in</button></p>
      </form>
    );
  } else {
    const via = typedMobile ? codeChannel({ kind: 'mobile' }) : channels.email ? 'email' : null;
    body = (
      <form className="qa-form" onSubmit={start} noValidate>
        <label className="qa-label">
          Email or mobile number
          <input
            value={field}
            onChange={(e) => { setField(e.target.value); setError(''); }}
            autoComplete="username"
            inputMode={typedMobile ? 'tel' : 'email'}
            placeholder="you@gmail.com or 98765 43210"
            aria-invalid={Boolean(error)}
            autoFocus
          />
        </label>
        {typedMobile && mobileChannels.length > 1 && (
          <div className="qa-channels" role="radiogroup" aria-label="Get the code on">
            <span>Get the code on</span>
            {mobileChannels.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={codeChannel({ kind: 'mobile' }) === c} className={`qa-chip qa-chip-${c} ${codeChannel({ kind: 'mobile' }) === c ? 'on' : ''}`} onClick={() => setMobileVia(c)}>
                <Icon name={c === 'sms' ? 'message' : 'phone'} size={14} /> {CHANNEL[c]}
              </button>
            ))}
          </div>
        )}
        <ErrorLine error={error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !channels.ready}>
          {busy ? 'Sending code…' : typed.kind && via ? `Get code by ${CHANNEL[via]}` : 'Continue'}
        </button>
        <button type="button" className="btn-link qa-alt" onClick={() => (typed.kind ? (setWho(typed), toPassword(typed)) : toPassword(null))}>
          <Icon name="lock" size={14} /> Log in with password instead
        </button>
        <GoogleButton onCredential={onGoogle} onError={setError} />
        <p className="qa-hint muted small">New here? The same code creates your account, no password needed.</p>
      </form>
    );
  }

  const title = { start: initial === 'register' ? 'Create your account' : 'Login or sign up', code: 'Check your messages', 'signup-code': 'Verify your email', profile: 'Almost done', password: 'Log in with password', register: 'Create your account', forgot: 'Reset your password' }[step];
  return (
    <div className="quick-auth">
      <div className="qa-head">
        <img className="qa-logo" src="/brand/arvixa-mark-192.png" alt="" width="44" height="44" />
        <div>
          <h2 className="qa-title">{title}</h2>
          <p className="qa-sub">{step === 'start' && reason ? reason : 'Shop, track orders and save your wishlist.'}</p>
        </div>
      </div>
      {body}
      <p className="qa-terms">By continuing you agree to our <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy Policy</Link>.</p>
      {onGuest && step === 'start' && <button type="button" className="btn-link qa-guest" onClick={onGuest}>Continue as a guest</button>}
    </div>
  );
}
