import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { crm } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useCrm, useCrmData } from '../../components/crm/ui';

// My security: authenticator-app MFA for this admin account
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
      <PageHead title="My security" subtitle="Two-step sign-in with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy)" />
      <section className="card stack" style={{ maxWidth: 640 }}>
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
    </>
  );
}
