import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { crm } from '../api/client';
import useSeo from '../hooks/useSeo';

// The link at the bottom of every marketing email. The signed link is the proof: no login needed.
export default function Unsubscribe() {
  useSeo({ title: 'Unsubscribe', noindex: true });
  const [params] = useSearchParams();
  const link = { c: params.get('c') || '', a: params.get('a') || '', t: params.get('t') || '' };
  const [state, setState] = useState({ step: 'checking' });
  useEffect(() => {
    crm.get('/unsubscribe', link).then((r) => setState({ step: 'ready', ...r })).catch((err) => setState({ step: 'error', error: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the link is read once
  }, []);
  const confirm = async () => {
    setState((s) => ({ ...s, step: 'saving' }));
    try {
      setState({ step: 'done', ...(await crm.post('/unsubscribe', link)) });
    } catch (err) {
      setState({ step: 'error', error: err.message });
    }
  };
  const channel = { email: 'marketing emails', sms: 'marketing text messages', whatsapp: 'WhatsApp offers' }[state.channel] || 'marketing messages';
  return (
    <div className="container" style={{ maxWidth: 520, padding: '48px 16px' }}>
      <div className="panel" style={{ padding: 28 }}>
        <h1 style={{ marginTop: 0 }}>Unsubscribe</h1>
        {state.step === 'checking' && <p>Checking your link…</p>}
        {state.step === 'error' && <p className="alert alert-error">{state.error}</p>}
        {(state.step === 'ready' || state.step === 'saving') && (
          <>
            <p>Stop {channel} to <strong>{state.address}</strong>? You’ll still get messages about your orders and account.</p>
            <button type="button" className="btn btn-primary" onClick={confirm} disabled={state.step === 'saving'}>{state.step === 'saving' ? 'Saving…' : 'Unsubscribe'}</button>
          </>
        )}
        {state.step === 'done' && <p>Done. <strong>{state.address}</strong> won’t receive {channel} from us again. If you change your mind, sign up again from the footer of the store.</p>}
        <p style={{ marginTop: 24 }}><Link to="/">Back to the store</Link></p>
      </div>
    </div>
  );
}
