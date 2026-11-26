import { useState } from 'react';
import { Link } from 'react-router-dom';
import { crm } from '../../api/client';
import { Badge, dateTime, ErrorBox, Kpi, label, Loading, PageHead, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

const STATE = {
  working: ['good', 'Working'], failing: ['bad', 'Failing'], not_configured: ['warn', 'Not configured'],
  never_used: ['info', 'Configured, never used'], switched_off: ['warn', 'Switched off'],
};
const STATUS_LABEL = { accepted: 'Sent to provider', delivered: 'Delivered', failed: 'Failed', not_sent_dev: 'Dev mode (not sent)' };

function TestOtp({ channel, onDone }) {
  const { run, busy } = useAction();
  const [sent, setSent] = useState(null);
  const [code, setCode] = useState('');
  const send = async () => {
    const out = await run(() => crm.post('/otp/test', { channel }), (r) => `Code sent to ${r.sentTo}: check it arrived, then enter it`);
    if (out) setSent(out);
    onDone();
  };
  const verify = async (e) => {
    e.preventDefault();
    if (await run(() => crm.post('/otp/test/verify', { channel, code }), 'Delivered and verified: this channel works end to end')) {
      setSent(null);
      setCode('');
      onDone();
    }
  };
  return sent ? (
    <form className="row" onSubmit={verify}>
      <input inputMode="numeric" maxLength={6} placeholder="Code you received" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ width: 150 }} />
      <button type="submit" className="b primary" disabled={busy || code.length !== 6}>Confirm</button>
    </form>
  ) : <button type="button" className="b sm" disabled={busy} onClick={send}>Send test code to myself</button>;
}

// Notifications: OTP diagnostics (admin only) and the log of every message the store sent or received
export default function Notifications() {
  const { can } = useCrm();
  const otp = useCrmData('/otp', null, { skip: !can('otp.diagnostics') });
  const d = otp.data;
  return (
    <>
      <PageHead title="Notifications & OTP" subtitle="Whether codes and messages really reach people. “Sent to provider” is not “Delivered”: only the provider’s report, or the person typing the code in, confirms delivery." />
      {can('otp.diagnostics') && (
        <>
          <ErrorBox error={otp.error} onRetry={otp.reload} />
          {!d ? <Loading /> : (
            <>
              {d.devCodes && <div className="alert warn">Development mode: codes are shown on screen and not sent. This never happens in production.</div>}
              <div className="kpis">
                <Kpi label="Codes requested (7 days)" value={d.funnel.requested} />
                <Kpi label="Sent to provider" value={d.funnel.sentToProvider} />
                <Kpi label="Delivered (confirmed)" value={d.funnel.delivered} />
                <Kpi label="Failed" value={d.funnel.failed} />
                <Kpi label="Verified" value={d.funnel.verified} sub={`${d.funnel.expired} expired unused`} />
              </div>
              <section className="card flush" style={{ marginBottom: 14 }}>
                <div className="table-wrap">
                  <table className="t">
                    <thead><tr><th>Channel</th><th>Status</th><th>Last request</th><th>Last sent to provider</th><th>Last confirmed delivery</th><th>Last failure</th><th>Delivery reports</th><th /></tr></thead>
                    <tbody>
                      {Object.entries(d.channels).map(([ch, c]) => (
                        <tr key={ch}>
                          <td><strong>{ch === 'sms' ? 'SMS' : label(ch)}</strong><span className="sub">{label(c.provider)}</span></td>
                          <td><Badge tone={STATE[c.state][0]}>{STATE[c.state][1]}</Badge>{c.missing.length > 0 && <span className="sub">Missing: {c.missing.join(', ')}</span>}</td>
                          <td>{dateTime(c.lastRequest)}</td>
                          <td>{dateTime(c.lastAccepted)}</td>
                          <td>{dateTime(c.lastDelivered)}</td>
                          <td>{c.lastFailure ? <>{dateTime(c.lastFailure.at)}<span className="sub">{c.lastFailure.code ? `Code ${c.lastFailure.code} · ` : ''}{c.lastFailure.reason}</span></> : '—'}</td>
                          <td>{c.webhook ? <Badge tone="good">Webhook set</Badge> : <Badge tone="warn">No webhook</Badge>}</td>
                          <td>{c.state !== 'not_configured' && c.state !== 'switched_off' && <TestOtp channel={ch} onDone={otp.reload} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <p className="muted small">Test codes go only to your own verified email or mobile number and are recorded in the audit log. Code length {6}, expiry {Math.round(d.settings.expirySeconds / 60)} min, {d.settings.maxAttempts} attempts, {d.settings.cooldownSeconds} s between resends. Provider keys are never shown here. <Link to="/crm/settings?tab=integrations">Integration setup</Link></p>
              <section className="card flush" style={{ marginBottom: 14 }}>
                <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Recent code deliveries</h2></div>
                <Table rows={d.recent} empty="No codes requested yet" columns={[
                  { key: 'created_at', label: 'When', render: (r) => dateTime(r.created_at) },
                  { key: 'purpose', label: 'For', render: (r) => label(r.purpose) },
                  { key: 'channel', label: 'Channel', render: (r) => `${r.channel === 'sms' ? 'SMS' : label(r.channel)} · ${r.provider || ''}` },
                  { key: 'target_masked', label: 'To' },
                  { key: 'status', label: 'Status', render: (r) => <><Badge value={r.status === 'accepted' ? 'queued' : r.status}>{STATUS_LABEL[r.status] || label(r.status)}</Badge>{r.error && <span className="sub">{r.error}</span>}</> },
                ]} />
              </section>
            </>
          )}
        </>
      )}
      <p><Link className="b" to="/crm/marketing?tab=log">All messages (order updates, campaigns, replies) →</Link></p>
    </>
  );
}
