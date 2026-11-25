import { api } from '../../api/client';
import useApi from '../../hooks/useApi';
import Icon from '../common/Icon';

// Admin: are verification codes really going out? Per channel: connected or not (and which settings are missing),
// and health from the last real delivery. Counts for 24 hours and recent events, with masked addresses, never codes.
const CHANNEL = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };
const PROVIDER = { resend: 'Resend', msg91: 'MSG91', twilio: 'Twilio', meta: 'WhatsApp Cloud API' };
const HEALTH = {
  healthy: { label: 'Working', tone: 'good', icon: 'checkCircle' },
  unused: { label: 'Connected, not used yet', tone: 'info', icon: 'clock' },
  failing: { label: 'Last send failed', tone: 'critical', icon: 'x' },
  not_configured: { label: 'Not connected', tone: 'warning', icon: 'lock' },
};
const PURPOSE = { signup: 'Sign-up', login: 'Login', reset: 'Password reset', phone: 'Phone check' };
const STATUS = { accepted: 'Sent', failed: 'Failed', not_sent_dev: 'Dev only, not sent' };

export default function OtpStatus() {
  const { data, error, loading } = useApi(() => api.otpStatus(), []);
  if (loading && !data) return null;
  if (error) return <section className="sd-card sd-span-3"><p className="sd-empty"><Icon name="lock" size={16} /> Verification status unavailable: {error}</p></section>;
  const { channels, last24h, recent, devCodes } = data;
  const failures = (last24h.delivery || []).filter((d) => d.status === 'failed').reduce((n, d) => n + d.count, 0);

  return (
    <section className="sd-card sd-span-3">
      <header>
        <div>
          <h2>Verification codes</h2>
          <p>
            Last 24 hours: {last24h.requested} requested · {last24h.verified} verified · {last24h.expired} expired unused ·
            {' '}{last24h.wrong_attempts} wrong tries · {failures} failed to send
          </p>
        </div>
      </header>
      {devCodes && <p className="alert alert-info small">Development mode: codes are shown on screen and nothing is sent.</p>}
      <div className="otp-channels">
        {Object.entries(channels).map(([id, c]) => {
          const h = HEALTH[c.health] || HEALTH.not_configured;
          return (
            <div key={id} className="otp-channel-card">
              <div className="otp-channel-head">
                <strong>{CHANNEL[id]}</strong>
                <span className={`sd-pill sd-pill-${h.tone}`}><Icon name={h.icon} size={12} /> {h.label}</span>
              </div>
              <p className="muted small">{PROVIDER[c.provider] || c.provider}{c.switchedOff ? ' · switched off' : ''}</p>
              {!c.configured && c.missing.length > 0 && (
                <p className="small">Missing settings: {c.missing.map((m) => <code key={m}>{m}</code>).reduce((a, b) => [a, ', ', b])}</p>
              )}
              {c.lastError && <p className="small text-error">Provider said: {c.lastError}</p>}
            </div>
          );
        })}
      </div>
      {recent.length > 0 && (
        <div className="sd-table-wrap">
          <table className="sd-table">
            <thead><tr><th>When</th><th>Purpose</th><th>Channel</th><th>To</th><th>Result</th></tr></thead>
            <tbody>
              {recent.slice(0, 8).map((r, i) => (
                <tr key={i}>
                  <td className="sd-nowrap">{new Date(r.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</td>
                  <td>{PURPOSE[r.purpose] || r.purpose}</td>
                  <td>{CHANNEL[r.channel]}</td>
                  <td className="sd-mono">{r.target_masked}</td>
                  <td><span className={`sd-pill sd-pill-${r.status === 'accepted' ? 'good' : r.status === 'failed' ? 'critical' : 'info'}`}>{STATUS[r.status] || r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
