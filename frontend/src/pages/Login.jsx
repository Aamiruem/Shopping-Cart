import { useCallback, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { PREVIEW } from '../config';
import CodeVerify from '../components/account/CodeVerify';
import GoogleButton from '../components/account/GoogleButton';
import Icon from '../components/common/Icon';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { playSound } from '../utils/sound';
import { passwordStrength, PASSWORD_MIN, validateEmail, validateName, validatePassword, validatePhone } from '../utils/validation';
import { trackLogin } from '../utils/analytics';
import useSeo from '../hooks/useSeo';

const COPY = {
  login: {
    title: 'Login',
    blurb: PREVIEW ? 'Get access to your orders, wishlist and saved addresses.' : 'Log in to track orders, save your wishlist and get picks made for you.',
    submit: 'Login',
    switchText: 'New to Arvixa Store?',
    switchLink: { to: '/register', label: 'Create an account' },
  },
  register: {
    title: 'Looks like you’re new here!',
    blurb: PREVIEW ? 'Create your account in a minute and start shopping.' : 'Create your account in a minute and start shopping with India’s best prices.',
    submit: 'Create account',
    switchText: 'Existing user?',
    switchLink: { to: '/login', label: 'Log in' },
  },
};

// Why shop here, shown beside the form
const BENEFITS = [
  { icon: 'truck', title: 'Free delivery', text: 'On orders above ₹499' },
  { icon: 'returns', title: '7-day easy returns', text: 'No questions asked' },
  { icon: 'shield', title: '100% secure payments', text: 'UPI, cards & cash on delivery' },
  { icon: 'headphones', title: '24×7 customer care', text: 'Real help whenever you need it' },
];

// "98765 43210", "+91-98765-43210" -> "9876543210"; anything with letters is treated as an email
const toMobile = (value) => {
  const digits = value.replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
};
const looksLikeMobile = (value) => /^[+\d\s-]+$/.test(value.trim()) && value.trim() !== '';

function identifierError(value) {
  if (!value.trim()) return 'Please enter your email address or mobile number';
  return looksLikeMobile(value) ? validatePhone(toMobile(value), { required: true }) : validateEmail(value);
}

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

function AuthAside({ copy }) {
  return (
    <aside className="auth-aside">
      <div>
        <h1>{copy.title}</h1>
        <p>{copy.blurb}</p>
      </div>
      {!PREVIEW && (
        <>
          <ul className="auth-benefits">
            {BENEFITS.map((b) => (
              <li key={b.title}>
                <span className="auth-benefit-icon"><Icon name={b.icon} size={18} /></span>
                <span><strong>{b.title}</strong><small>{b.text}</small></span>
              </li>
            ))}
          </ul>
          <p className="auth-trust"><Icon name="lock" size={14} /> Your details are encrypted and never shared</p>
        </>
      )}
    </aside>
  );
}

// The /login and /register pages
export default function Login({ mode = 'login' }) {
  useSeo({ title: mode === 'register' ? 'Create account' : 'Login', noindex: true });
  return <LoginForm mode={mode} />;
}

// The form itself. `embedded` = inside the login dialog (AuthModalContext): it closes instead of navigating,
// switches between login and sign-up in place, and leaves the page's title alone.
export function LoginForm({ mode = 'login', embedded = false, onDone, onSwitch }) {
  const { user, ready, login, otpLogin, register, verifySignup, googleLogin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // signup waiting for its email code
  // Login: one-time code (default, like Flipkart) or password. One-time codes need the full API.
  const [method, setMethod] = useState(PREVIEW ? 'password' : 'otp');
  const [identifier, setIdentifier] = useState('');
  const [channel, setChannel] = useState('sms');
  const [otpSent, setOtpSent] = useState(null); // { identifier, sentTo, channel, devCode? }

  const isRegister = mode === 'register';
  const copy = COPY[mode];
  const from = location.state?.from;
  const redirectTo = from ? `${from.pathname}${from.search || ''}` : '/';

  const finish = useCallback((signedIn, isNew) => {
    playSound('success');
    toast.show(isNew ? `Welcome to Arvixa Store, ${signedIn.name}!` : `Welcome back, ${signedIn.name}!`);
    if (embedded) onDone?.();
    else navigate(redirectTo, { replace: true });
  }, [toast, navigate, redirectTo, embedded, onDone]);

  const onGoogle = useCallback(async (credential) => {
    setError('');
    setBusy(true);
    try {
      finish(await googleLogin(credential), false);
      trackLogin('google');
    } catch (err) {
      playSound('error');
      setError(err.message);
      setBusy(false);
    }
  }, [googleLogin, finish]);

  if (ready && user) return embedded ? null : <Navigate to={redirectTo} replace />;

  const usingOtp = !isRegister && method === 'otp';
  const errors = usingOtp ? {} : validate(form, isRegister);
  const idError = usingOtp ? identifierError(identifier) : '';
  // Show a field's error once the user has left it, or after a submit attempt
  const shown = (name) => (submitted || touched[name]) && (name === 'identifier' ? idError : errors[name]);
  // Only once something was typed: leaving an empty field (to switch to sign-up, say) mustn't flash an error that
  // moves the button being clicked. Submitting still shows every error.
  const blur = (e) => e.target.value && setTouched((t) => ({ ...t, [e.target.name]: true }));
  const onChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });
  const strength = passwordStrength(form.password);
  const mobile = looksLikeMobile(identifier);

  const switchMethod = (next, message = '') => {
    setMethod(next);
    setError('');
    setNotice(message);
    setSubmitted(false);
    setTouched({});
    if (next === 'otp' && !identifier && form.email) setIdentifier(form.email);
    if (next === 'password' && !form.email && identifier.includes('@')) setForm((f) => ({ ...f, email: identifier.trim() }));
  };

  const requestOtp = async () => {
    const value = mobile ? toMobile(identifier) : identifier.trim();
    const sent = await api.otpLogin(value, channel);
    setOtpSent({ identifier: value, ...sent });
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setError('');
    if (usingOtp ? idError : Object.keys(errors).length) {
      playSound('error');
      return;
    }
    setBusy(true);
    try {
      if (usingOtp) {
        await requestOtp();
      } else if (isRegister) {
        const sent = await register({ name: form.name.trim(), email: form.email.trim(), password: form.password, ...(form.phone ? { phone: form.phone } : {}) });
        if (sent.user) {
          finish(sent.user, true); // no email step: the account already exists
          return;
        }
        setPending({ email: form.email.trim().toLowerCase(), ...sent });
      } else {
        finish(await login(form.email.trim(), form.password), false);
        return;
      }
    } catch (err) {
      playSound('error');
      setError(err.message);
    }
    setBusy(false);
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

  const codeStep = pending ? (
    <CodeVerify
      title="Verify your email"
      info={pending}
      verifyLabel="Verify & create account"
      onVerify={async (code) => finish(await verifySignup(pending.email, code), true)}
      onResend={() => api.resendSignup(pending.email)}
      onBack={() => setPending(null)}
    />
  ) : otpSent ? (
    <CodeVerify
      title="Enter verification code"
      info={otpSent}
      verifyLabel="Verify & login"
      onVerify={async (code) => finish(await otpLogin(otpSent.identifier, code), false)}
      onResend={async () => ({ identifier: otpSent.identifier, ...(await api.otpLogin(otpSent.identifier, otpSent.channel)) })}
      onBack={() => { setOtpSent(null); setBusy(false); }}
    />
  ) : null;

  const card = (
      <div className={`auth-card ${embedded ? 'auth-card-embedded' : ''}`}>
        <AuthAside copy={copy} />

        {codeStep ? (
          <div className="auth-form">
            <img className="auth-logo" src="/brand/arvixa-logo.webp" alt="Arvixa — Shop Beyond Limits" width="240" height="96" />
            {codeStep}
          </div>
        ) : (
          <form className="auth-form" onSubmit={onSubmit} noValidate>
            <img className="auth-logo" src="/brand/arvixa-logo.webp" alt="Arvixa — Shop Beyond Limits" width="240" height="96" />

            {!isRegister && !PREVIEW && (
              <div className="auth-tabs" role="tablist" aria-label="How do you want to log in?">
                <button type="button" role="tab" aria-selected={method === 'otp'} className={method === 'otp' ? 'active' : ''} onClick={() => switchMethod('otp')}>
                  <Icon name="phone" size={16} /> Login with OTP
                </button>
                <button type="button" role="tab" aria-selected={method === 'password'} className={method === 'password' ? 'active' : ''} onClick={() => switchMethod('password')}>
                  <Icon name="lock" size={16} /> Use password
                </button>
              </div>
            )}
            {notice && <p className="alert alert-info" role="status">{notice}</p>}

            {usingOtp ? (
              <>
                <Field name="identifier" label="Email or mobile number" error={shown('identifier')}>
                  <input
                    name="identifier"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    onBlur={blur}
                    placeholder=" "
                    autoComplete="username"
                    autoFocus
                    aria-invalid={Boolean(shown('identifier'))}
                    aria-describedby={shown('identifier') ? 'identifier-error' : undefined}
                  />
                </Field>
                {mobile && (
                  <div className="otp-channel" role="radiogroup" aria-label="Send the code by">
                    <span className="muted small">Send code by</span>
                    {[['sms', 'SMS', 'message'], ['whatsapp', 'WhatsApp', 'phone']].map(([id, label, icon]) => (
                      <button key={id} type="button" role="radio" aria-checked={channel === id} className={`otp-chip ${id} ${channel === id ? 'active' : ''}`} onClick={() => setChannel(id)}>
                        <Icon name={icon} size={14} /> {label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="auth-hint muted small">
                  {mobile ? 'Mobile login works once you have verified your number in My Profile.' : 'We’ll send a 6-digit code — no password needed.'}
                </p>
              </>
            ) : (
              <>
                {isRegister && (
                  <Field name="name" label="Full name" error={shown('name')}>
                    <input {...inputProps('name')} autoComplete="name" />
                  </Field>
                )}
                <Field name="email" label="Email address" error={shown('email')}>
                  <input {...inputProps('email')} type="email" autoComplete={isRegister ? 'email' : 'username'} inputMode="email" />
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
                {!isRegister && !PREVIEW && (
                  <button type="button" className="btn-link auth-forgot" onClick={() => switchMethod('otp', 'No problem — log in with a one-time code instead, then set a new password in My Profile.')}>
                    Forgot password?
                  </button>
                )}
              </>
            )}

            {isRegister && form.password && (
              <div className={`strength strength-${strength.score}`} aria-live="polite">
                <div className="strength-bar"><span /><span /><span /><span /></div>
                <small>{strength.label} · use {PASSWORD_MIN}+ characters with letters and numbers</small>
              </div>
            )}

            {error && <p className="alert alert-error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-buy btn-lg btn-block" disabled={busy}>
              {busy ? 'Please wait…' : usingOtp ? 'Request OTP' : copy.submit}
            </button>
            <p className="auth-terms">By continuing, you agree to Arvixa Store’s <Link to="/terms">Terms of Use</Link> and <Link to="/privacy">Privacy Policy</Link>.</p>

            <GoogleButton onCredential={onGoogle} onError={setError} />

            {!isRegister && !PREVIEW && (
              <p className="demo-hint">
                <Icon name="zap" size={12} /> Demo account: <code>demo@shop.local</code> / <code>demo123</code>
              </p>
            )}

            <p className="auth-switch">
              {copy.switchText}{' '}
              {embedded ? (
                <button type="button" className="btn-link" onClick={() => onSwitch?.(isRegister ? 'login' : 'register')}>{copy.switchLink.label}</button>
              ) : (
                <Link to={copy.switchLink.to} state={location.state}>{copy.switchLink.label}</Link>
              )}
            </p>
          </form>
        )}
      </div>
  );
  return embedded ? card : <div className="page-auth container">{card}</div>;
}
