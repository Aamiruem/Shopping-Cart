import { useCallback, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import CodeVerify from '../components/account/CodeVerify';
import GoogleButton from '../components/account/GoogleButton';
import Icon from '../components/common/Icon';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { playSound } from '../utils/sound';
import { passwordStrength, PASSWORD_MIN, validateEmail, validateName, validatePassword, validatePhone } from '../utils/validation';
import useSeo from '../hooks/useSeo';

const COPY = {
  login: {
    title: 'Login',
    blurb: 'Get access to your Orders, Wishlist and Recommendations',
    submit: 'Login',
    switchText: 'New to Arvixa?',
    switchLink: { to: '/register', label: 'Create an account' },
  },
  register: {
    title: 'Looks like you’re new here!',
    blurb: 'Sign up with your email or Google account to get started',
    submit: 'Create account',
    switchText: 'Existing user?',
    switchLink: { to: '/login', label: 'Log in' },
  },
};

function validate(form, isRegister) {
  const errors = {
    email: validateEmail(form.email),
    password: isRegister ? validatePassword(form.password) : form.password ? '' : 'Please enter your password',
  };
  if (isRegister) {
    errors.name = validateName(form.name);
    errors.phone = validatePhone(form.phone);
  }
  return Object.fromEntries(Object.entries(errors).filter(([, v]) => v));
}

function Field({ name, label, error, children }) {
  return (
    <div className={`field floating ${error ? 'invalid' : ''}`}>
      <label>
        {children}
        <span>{label}</span>
      </label>
      {error && <p className="field-error" id={`${name}-error`} role="alert">{error}</p>}
    </div>
  );
}

export default function Login({ mode = 'login' }) {
  useSeo({ title: 'Login', noindex: true });
  const { user, ready, login, register, verifySignup, googleLogin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // signup waiting for its email code

  const isRegister = mode === 'register';
  const copy = COPY[mode];
  const from = location.state?.from;
  const redirectTo = from ? `${from.pathname}${from.search || ''}` : '/';

  const finish = useCallback((signedIn, isNew) => {
    playSound('success');
    toast.show(isNew ? `Welcome to Arvixa, ${signedIn.name}!` : `Welcome back, ${signedIn.name}!`);
    navigate(redirectTo, { replace: true });
  }, [toast, navigate, redirectTo]);

  const onGoogle = useCallback(async (credential) => {
    setError('');
    setBusy(true);
    try {
      finish(await googleLogin(credential), false);
    } catch (err) {
      playSound('error');
      setError(err.message);
      setBusy(false);
    }
  }, [googleLogin, finish]);

  if (ready && user) return <Navigate to={redirectTo} replace />;

  const errors = validate(form, isRegister);
  // Show a field's error once the user has left it, or after a submit attempt
  const shown = (name) => (submitted || touched[name]) && errors[name];
  const blur = (e) => setTouched((t) => ({ ...t, [e.target.name]: true }));
  const onChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });
  const strength = passwordStrength(form.password);

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setError('');
    if (Object.keys(errors).length) {
      playSound('error');
      return;
    }
    setBusy(true);
    try {
      if (isRegister) {
        const sent = await register({ name: form.name.trim(), email: form.email.trim(), password: form.password, ...(form.phone ? { phone: form.phone } : {}) });
        setPending({ email: form.email.trim().toLowerCase(), ...sent });
        setBusy(false);
        return;
      }
      finish(await login(form.email.trim(), form.password), false);
    } catch (err) {
      playSound('error');
      setError(err.message);
      setBusy(false);
    }
  };

  const inputProps = (name) => ({
    name,
    value: form[name],
    onChange,
    onBlur: blur,
    placeholder: ' ',
    'aria-invalid': Boolean(shown(name)),
    'aria-describedby': shown(name) ? `${name}-error` : undefined,
  });

  return (
    <div className="page-auth container">
      <div className="auth-card">
        <div className="auth-aside">
          <h1>{copy.title}</h1>
          <p>{copy.blurb}</p>
          <div className="auth-art" aria-hidden="true">
            <Icon name="cart" size={64} strokeWidth={1.2} />
            <Icon name="heart" size={40} strokeWidth={1.2} />
            <Icon name="gift" size={48} strokeWidth={1.2} />
          </div>
        </div>

        {pending ? (
          <div className="auth-form">
            <CodeVerify
              title="Verify your email"
              info={pending}
              verifyLabel="Verify & create account"
              onVerify={async (code) => finish(await verifySignup(pending.email, code), true)}
              onResend={() => api.resendSignup(pending.email)}
              onBack={() => setPending(null)}
            />
          </div>
        ) : (
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          <img className="auth-logo" src="/brand/arvixa-logo.webp" alt="Arvixa — Shop Beyond Limits" width="240" height="96" />
          {isRegister && (
            <Field name="name" label="Full name" error={shown('name')}>
              <input {...inputProps('name')} autoComplete="name" />
            </Field>
          )}
          <Field name="email" label="Email address" error={shown('email')}>
            <input {...inputProps('email')} type="email" autoComplete="email" inputMode="email" />
          </Field>
          {isRegister && (
            <Field name="phone" label="Mobile number (optional)" error={shown('phone')}>
              <input
                {...inputProps('phone')}
                onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })}
                inputMode="numeric"
                autoComplete="tel-national"
              />
            </Field>
          )}
          <Field name="password" label={isRegister ? `Password (min. ${PASSWORD_MIN} characters)` : 'Password'} error={shown('password')}>
            <input
              {...inputProps('password')}
              type={showPassword ? 'text' : 'password'}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              className="has-toggle"
            />
            <button type="button" className="icon-btn password-toggle" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
              <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
            </button>
          </Field>

          {isRegister && form.password && (
            <div className={`strength strength-${strength.score}`} aria-live="polite">
              <div className="strength-bar"><span /><span /><span /><span /></div>
              <small>{strength.label} · use {PASSWORD_MIN}+ characters with letters and numbers</small>
            </div>
          )}

          <p className="auth-terms">By continuing, you agree to Arvixa’s <Link to="/help">Terms of Use</Link> and <Link to="/help">Privacy Policy</Link>.</p>
          {error && <p className="alert alert-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-buy btn-lg btn-block" disabled={busy}>{busy ? 'Please wait…' : copy.submit}</button>

          <GoogleButton onCredential={onGoogle} onError={setError} />

          {!isRegister && (
            <p className="demo-hint">
              <Icon name="zap" size={12} /> Demo account: <code>demo@shop.local</code> / <code>demo123</code>
            </p>
          )}

          <p className="auth-switch">
            {copy.switchText} <Link to={copy.switchLink.to} state={location.state}>{copy.switchLink.label}</Link>
          </p>
        </form>
        )}
      </div>
    </div>
  );
}
