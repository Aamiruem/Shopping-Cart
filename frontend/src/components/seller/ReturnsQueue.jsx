import { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import useApi from '../../hooks/useApi';
import { formatDate, formatPrice } from '../../utils/format';
import { RETURN_STEPS, refundDestination, returnStep } from '../../utils/returns';
import Icon from '../common/Icon';

const REFUND_STATE = {
  refunded: ['Refunded', 'ok'],
  refund_pending: ['Refund failed: retry', 'warn'],
  processing: ['Refund sending…', 'warn'],
  cod_manual: ['Bank / UPI transfer due', 'warn'],
};

// The next thing to do with a return, for whoever handles it
function Actions({ r, onAct }) {
  const [mode, setMode] = useState(null); // 'reject' | 'refund' while its form is open
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (action, extra = {}) => {
    setBusy(true);
    const ok = await onAct(r.order_id, { action, ...extra });
    setBusy(false);
    if (ok) setMode(null);
  };

  if (!r.canManage) return <p className="muted small">Has other sellers’ items: the store team handles it.</p>;
  if (r.status === 'rejected' || r.refund === 'refunded') return null;

  if (mode) {
    const reject = mode === 'reject';
    return (
      <form
        className="return-action-form"
        onSubmit={(e) => {
          e.preventDefault();
          act(reject ? 'reject' : 'refund', reject ? { note: value } : { reference: value });
        }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={reject ? 'Reason the customer will see' : 'UTR / transaction reference'}
          aria-label={reject ? 'Reason for rejecting' : 'Transfer reference'}
          required
          minLength={reject ? 5 : 6}
          maxLength={reject ? 500 : 30}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{reject ? 'Reject return' : 'Mark refunded'}</button>
        <button type="button" className="btn-text" onClick={() => setMode(null)}>Cancel</button>
      </form>
    );
  }

  return (
    <div className="form-actions">
      {r.status === 'requested' && (
        <>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('approve')}>Approve &amp; book pickup</button>
          <button type="button" className="btn-text" onClick={() => setMode('reject')}>Reject</button>
        </>
      )}
      {r.status === 'approved' && (
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('receive')}>
          <Icon name="package" size={14} /> Item picked up: refund {formatPrice(r.amount ?? r.total)}
        </button>
      )}
      {r.status === 'received' && r.refund_to === 'original' && (
        <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => act('refund')}>Retry refund</button>
      )}
      {r.status === 'received' && r.refund === 'cod_manual' && (r.canRecordRefund
        ? <button type="button" className="btn btn-primary btn-sm" onClick={() => setMode('refund')}>I’ve sent the transfer</button>
        : <span className="muted small">The store admin sends this refund.</span>)}
    </div>
  );
}

// Return requests on the seller's orders (every order for the admin), oldest decisions first
export default function ReturnsQueue({ onChange }) {
  const toast = useToast();
  const [view, setView] = useState('open');
  const { data, error, reload } = useApi(() => api.sellerReturns({ view }), [view]);
  if (error) return null; // the full API has no such list

  const onAct = async (orderId, body) => {
    try {
      await api.sellerReturnAction(orderId, body);
      toast.show({ approve: 'Return approved', reject: 'Return rejected', receive: 'Marked picked up. Refund started.', refund: 'Refund recorded' }[body.action]);
      reload();
      onChange?.();
      return true;
    } catch (err) {
      toast.show(err.message, 'error');
      return false;
    }
  };

  return (
    <section className="panel returns-queue">
      <header className="seller-head">
        <h2><Icon name="returns" size={18} /> Return requests</h2>
        <div className="segmented" role="group" aria-label="Returns shown">
          {[['open', 'Needs action'], ['all', 'All']].map(([id, label]) => (
            <button key={id} type="button" className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
      </header>
      {data && !data.length && <p className="muted small">{view === 'open' ? 'No returns waiting for you.' : 'No returns yet.'}</p>}
      <ul>
        {(data || []).map((r) => {
          const [refundLabel, tone] = REFUND_STATE[r.refund] || [];
          return (
            <li key={r.id} className="return-row">
              <div className="return-main">
                <p>
                  <strong>Order #{r.order_id}</strong> · {r.customer} · {formatPrice(r.amount ?? r.total)}
                  <span className="muted small"> · {formatDate(r.created_at)}</span>
                </p>
                <p className="small">{r.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</p>
                <p className="small"><strong>Reason:</strong> {r.reason}</p>
                <p className="small muted">
                  Refund to {refundDestination(r)}
                  {r.refund_bank?.number && <> · <strong className="mono">{r.refund_bank.name}, A/c {r.refund_bank.number}, IFSC {r.refund_bank.ifsc}</strong></>}
                  {r.refund_reference && <> · Ref {r.refund_reference}</>}
                </p>
              </div>
              <div className="return-side">
                {r.status === 'rejected' ? <span className="status-pill tone-error">Rejected</span> : (
                  <span className="status-pill">{RETURN_STEPS[returnStep(r)]}</span>
                )}
                {refundLabel && <span className={`status-pill tone-${tone}`}>{refundLabel}</span>}
                <Actions r={r} onAct={onAct} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
