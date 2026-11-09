import { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { formatDate, formatPrice } from '../../utils/format';
import { RETURN_REASONS, RETURN_STEPS, returnMessage, returnStep } from '../../utils/returns';
import Icon from '../common/Icon';

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

// The shopper asks for a return. Paid online: the money goes back where it came from, so nothing else is needed.
// Cash on delivery: we need a UPI ID or bank account to send the refund to.
export function ReturnForm({ order, paidOnline, onDone, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState({ reasonCode: '', details: '', refundTo: 'upi', upi: '', accountName: '', accountNumber: '', confirmNumber: '', ifsc: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.reasonCode) return setError('Please choose a reason');
    if (form.reasonCode === 'other' && form.details.trim().length < 3) return setError('Please tell us why you are returning this order');
    const body = { reasonCode: form.reasonCode, details: form.details.trim() };
    if (!paidOnline) {
      body.refundTo = form.refundTo;
      if (form.refundTo === 'upi') {
        if (!form.upi.includes('@')) return setError('Please enter your UPI ID, like name@okhdfcbank');
        body.upi = form.upi.trim();
      } else {
        const number = form.accountNumber.replace(/\s/g, '');
        if (!/^\d{9,18}$/.test(number)) return setError('Please enter a valid bank account number (9 to 18 digits)');
        if (number !== form.confirmNumber.replace(/\s/g, '')) return setError('The account numbers don’t match');
        if (!IFSC_RE.test(form.ifsc.trim().toUpperCase())) return setError('Please enter a valid IFSC code, like HDFC0001234');
        Object.assign(body, { accountName: form.accountName.trim(), accountNumber: number, ifsc: form.ifsc.trim().toUpperCase() });
      }
    }
    setBusy(true);
    try {
      await api.requestReturn(order.id, body);
      toast.show('Return requested. We’ll update you here.');
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="return-form panel-inset" onSubmit={submit} noValidate>
      <h3>Return this order</h3>
      <fieldset className="reason-grid">
        <legend className="field">Why are you returning it?</legend>
        {RETURN_REASONS.map(([code, label]) => (
          <label key={code} className={`choice ${form.reasonCode === code ? 'active' : ''}`}>
            <input type="radio" name="reason" value={code} checked={form.reasonCode === code} onChange={set('reasonCode')} /> {label}
          </label>
        ))}
      </fieldset>
      <label className="field">Tell us more {form.reasonCode !== 'other' && '(optional)'}
        <textarea value={form.details} onChange={set('details')} maxLength={500} rows={2} placeholder="e.g. The box was crushed and the screen is cracked" />
      </label>

      <div className="refund-to">
        <h4><Icon name="wallet" size={16} /> Your refund: {formatPrice(order.total)}</h4>
        {paidOnline ? (
          <p className="muted small">It goes back to the UPI app, bank account or card you paid with, once the item is picked up. Banks usually show it within 5–7 working days.</p>
        ) : (
          <>
            <p className="muted small">You paid cash on delivery, so tell us where to send the money. We send it within 2 working days of pickup.</p>
            <div className="segmented" role="group" aria-label="Refund to">
              {[['upi', 'UPI ID'], ['bank', 'Bank account']].map(([id, label]) => (
                <button key={id} type="button" className={form.refundTo === id ? 'active' : ''} onClick={() => setForm({ ...form, refundTo: id })}>{label}</button>
              ))}
            </div>
            {form.refundTo === 'upi' ? (
              <label className="field">UPI ID<input value={form.upi} onChange={set('upi')} placeholder="name@okhdfcbank" autoComplete="off" maxLength={100} /></label>
            ) : (
              <div className="form-grid">
                <label className="field span-2">Account holder’s name<input value={form.accountName} onChange={set('accountName')} autoComplete="name" maxLength={120} /></label>
                <label className="field">Account number<input value={form.accountNumber} onChange={set('accountNumber')} inputMode="numeric" autoComplete="off" maxLength={22} /></label>
                <label className="field">Confirm account number<input value={form.confirmNumber} onChange={set('confirmNumber')} inputMode="numeric" autoComplete="off" maxLength={22} onPaste={(e) => e.preventDefault()} /></label>
                <label className="field">IFSC code<input value={form.ifsc} onChange={set('ifsc')} placeholder="HDFC0001234" autoComplete="off" maxLength={11} style={{ textTransform: 'uppercase' }} /></label>
              </div>
            )}
            <p className="muted small"><Icon name="lock" size={12} /> Stored encrypted and deleted once your refund is sent.</p>
          </>
        )}
      </div>

      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-buy" disabled={busy}>{busy ? 'Sending…' : 'Request return'}</button>
        <button type="button" className="btn-text" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// Where the return and the refund are, for the shopper
export function ReturnStatus({ ret, onWithdraw }) {
  const [busy, setBusy] = useState(false);
  const rejected = ret.status === 'rejected';
  const step = returnStep(ret);
  const withdraw = async () => {
    setBusy(true);
    try {
      await onWithdraw();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`return-status ${rejected ? 'rejected' : ''}`} aria-label="Return status">
      <h3><Icon name="returns" size={16} /> Return {rejected ? 'not approved' : step === 3 ? 'complete' : 'in progress'}</h3>
      {!rejected && (
        <ol className="tracker">
          {RETURN_STEPS.map((s, i) => <li key={s} className={i <= step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span />{s}</li>)}
        </ol>
      )}
      <p>{returnMessage(ret)}</p>
      <p className="muted small">Reason: {ret.reason} · Requested {formatDate(ret.created_at, { day: 'numeric', month: 'short' })}</p>
      {ret.status === 'requested' && (
        <button type="button" className="btn-text" disabled={busy} onClick={withdraw}>{busy ? 'Withdrawing…' : 'Withdraw return request'}</button>
      )}
    </section>
  );
}
