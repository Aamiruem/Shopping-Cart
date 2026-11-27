import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, crm } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useCrm, useCrmData } from '../../components/crm/ui';

const CARD = { maxWidth: 640 };

// The admin-portal sign-in: the email it uses. The current password confirms the change.
function EmailCard() {
  const { user, changeEmail } = useAuth();
  const { run, busy } = useAction();
  const [form, setForm] = useState({ newEmail: '', currentPassword: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    const done = await run(() => changeEmail(form.newEmail.trim(), form.currentPassword), (u) => `Your sign-in email is now ${u.email}`);
    if (done) setForm({ newEmail: '', currentPassword: '' });
  };
  return (
    <form className="card stack" style={CARD} onSubmit={submit}>
      <div className="row"><strong>Sign-in email</strong><span className="muted small">{user?.email}</span></div>
      <p className="muted" style={{ margin: 0 }}>The address you use at /admin/login. It must not belong to another account.</p>
      <Field label="New email"><input type="email" autoComplete="email" required value={form.newEmail} onChange={set('newEmail')} /></Field>
      <Field label="Current password"><input type="password" autoComplete="current-password" required value={form.currentPassword} onChange={set('currentPassword')} /></Field>
      <div><button type="submit" className="b primary" disabled={busy || !form.newEmail.trim() || !form.currentPassword}>Change email</button></div>
    </form>
  );
}

// Same rules as sign-up (api/_auth.mjs): 8+ characters with a letter and a number
const passwordProblem = (p) => (p.length < 8 ? 'At least 8 characters' : !/[a-z]/i.test(p) || !/\d/.test(p) ? 'Use at least one letter and one number' : '');

function PasswordCard() {
  const { run, busy } = useAction();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const problem = form.newPassword && passwordProblem(form.newPassword);
  const mismatch = form.confirm && form.confirm !== form.newPassword;
  const submit = async (e) => {
    e.preventDefault();
    const done = await run(() => api.changePassword({ currentPassword: form.currentPassword, newPassword: form.newPassword }), 'Password changed. Use the new one next time you sign in.');
    if (done) setForm({ currentPassword: '', newPassword: '', confirm: '' });
  };
  return (
    <form className="card stack" style={CARD} onSubmit={submit}>
      <strong>Password</strong>
      <Field label="Current password"><input type="password" autoComplete="current-password" required value={form.currentPassword} onChange={set('currentPassword')} /></Field>
      <Field label="New password" hint={problem || 'At least 8 characters, with a letter and a number'}>
        <input type="password" autoComplete="new-password" required value={form.newPassword} onChange={set('newPassword')} />
      </Field>
      <Field label="Confirm new password" hint={mismatch ? 'The passwords do not match' : ''}>
        <input type="password" autoComplete="new-password" required value={form.confirm} onChange={set('confirm')} />
      </Field>
      <div><button type="submit" className="b primary" disabled={busy || !form.currentPassword || !form.newPassword || Boolean(problem) || form.confirm !== form.newPassword}>Change password</button></div>
    </form>
  );
}

// My security: sign-in email, password and authenticator-app MFA for this admin account
export default function Security() {
  const { confirm } = useCrm();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { data, error, reload } = useCrmData('/mfa');
  const { run, busy } = useAction();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const start = async () => {
    const out = await run(() => crm.post('/mfa/setup'));
    if (out) setSetup(out);
  };
  const enable = async (e) => {
    e.preventDefault();
    if (await run(() => crm.post('/mfa/enable', { code }), 'MFA is on. Please sign in again with your code.')) {
      logout();
      navigate('/admin/login', { replace: true });
    }
  };
  const disable = async () => {
    const c = await confirm({ title: 'Turn MFA off?', message: 'Your account will be protected by your password only.', input: 'Current authenticator code', danger: true, confirmLabel: 'Turn off' });
    if (c && (await run(() => crm.post('/mfa/disable', { code: c }), 'MFA turned off'))) reload();
  };
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  return (
    <>
      <PageHead title="My security" subtitle="Your sign-in email and password, and two-step sign-in with an authenticator app" />
      <div className="stack">
      <EmailCard />
      <PasswordCard />
      <section className="card stack" style={CARD}>
        <div className="row"><strong>Authenticator MFA</strong>{data.enabled ? <Badge tone="good">On</Badge> : <Badge tone="warn">Off</Badge>}</div>
        {data.enabled ? (
          <>
            <p className="muted" style={{ margin: 0 }}>Every admin sign-in asks for a fresh 6-digit code, and each code works once.</p>
            <div><button type="button" className="b danger" onClick={disable} disabled={busy}>Turn off</button></div>
          </>
        ) : setup ? (
          <form className="stack" onSubmit={enable}>
            <p style={{ margin: 0 }}>1. In your authenticator app, add an account and enter this setup key (or open the link on your phone):</p>
            <code style={{ fontSize: 16, letterSpacing: 2, padding: 10 }}>{setup.secret.match(/.{1,4}/g).join(' ')}</code>
            <a href={setup.otpauthUrl} className="small">Open in authenticator app</a>
            <p style={{ margin: 0 }}>2. Enter the 6-digit code it shows:</p>
            <Field label="Code"><input inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 160 }} /></Field>
            <p className="muted small" style={{ margin: 0 }}>Turning it on signs you out everywhere; sign in again with your password and a code.</p>
            <div><button type="submit" className="b primary" disabled={busy || code.length !== 6}>Turn on MFA</button></div>
          </form>
        ) : (
          <>
            <p className="muted" style={{ margin: 0 }}>Protects the CRM even if your password leaks. The setup key is stored encrypted.</p>
            <div><button type="button" className="b primary" onClick={start} disabled={busy}>Set up MFA</button></div>
          </>
        )}
      </section>
      </div>
    </>
  );
}
