import { useState } from 'react';
import { api } from '../../api/client';
import Icon from '../common/Icon';

const STATES = [
  'Andhra Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jammu & Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Odisha', 'Punjab',
  'Rajasthan', 'Tamil Nadu', 'Telangana', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

const EMPTY = { name: '', phone: '', pincode: '', line1: '', city: '', state: '', type: 'home' };

// Saves a new address and hands it back via onSaved
export default function AddressForm({ defaults = {}, onSaved, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...defaults });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (e) => setForm({ ...form, [e.target.name]: e.target.value });
  const digits = (max) => (e) => setForm({ ...form, [e.target.name]: e.target.value.replace(/\D/g, '').slice(0, max) });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onSaved(await api.addAddress(form));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="address-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">Full name<input name="name" value={form.name} onChange={set} required autoComplete="name" /></label>
        <label className="field">10-digit mobile number<input name="phone" value={form.phone} onChange={digits(10)} required inputMode="numeric" autoComplete="tel-national" /></label>
        <label className="field">Pincode<input name="pincode" value={form.pincode} onChange={digits(6)} required inputMode="numeric" autoComplete="postal-code" /></label>
        <label className="field">City / District / Town<input name="city" value={form.city} onChange={set} required autoComplete="address-level2" /></label>
        <label className="field span-2">Address (house no, building, street, area)<textarea name="line1" value={form.line1} onChange={set} required rows={3} autoComplete="street-address" /></label>
        <label className="field">
          State
          <select name="state" value={form.state} onChange={set} required>
            <option value="">— Select state —</option>
            {STATES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <fieldset className="field address-type">
          <legend>Address type</legend>
          <label><input type="radio" name="type" value="home" checked={form.type === 'home'} onChange={set} /> <Icon name="home" size={14} /> Home</label>
          <label><input type="radio" name="type" value="work" checked={form.type === 'work'} onChange={set} /> <Icon name="briefcase" size={14} /> Work</label>
        </fieldset>
      </div>
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-buy" disabled={busy}>{busy ? 'Saving…' : 'Save address'}</button>
        {onCancel && <button type="button" className="btn-text" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
