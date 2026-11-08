import { useState } from 'react';
import { api } from '../../api/client';
import { PREVIEW } from '../../config';
import Icon from '../common/Icon';

const STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

// Address services spell some states differently, e.g. "Jammu & Kashmir"
const matchState = (name = '') => STATES.find((s) => s.toLowerCase() === name.replace('&', 'and').toLowerCase()) || '';

const EMPTY = { name: '', phone: '', pincode: '', line1: '', city: '', state: '', type: 'home' };

// Saves a new address and hands it back via onSaved
export default function AddressForm({ defaults = {}, onSaved, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...defaults });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);

  const set = (e) => setForm({ ...form, [e.target.name]: e.target.value });
  const digits = (max) => (e) => setForm({ ...form, [e.target.name]: e.target.value.replace(/\D/g, '').slice(0, max) });

  // A complete pincode fills in the city and state. If the lookup fails the shopper just types them.
  const onPincode = async (e) => {
    const pincode = e.target.value.replace(/\D/g, '').slice(0, 6);
    setForm((f) => ({ ...f, pincode }));
    if (pincode.length !== 6) return;
    const place = await api.pincode(pincode).catch(() => null);
    if (place?.found) setForm((f) => ({ ...f, city: f.city || place.city, state: matchState(place.state) || f.state }));
    else if (place?.found === false) setError('We couldn’t find this pincode. Please check it.');
  };

  const useMyLocation = () => {
    setError('');
    if (!navigator.geolocation) return setError('Your browser can’t share your location. Please type your address.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const found = await api.reverseGeocode(coords.latitude, coords.longitude);
          setForm((f) => ({ ...f, ...found, line1: f.line1 || found.line1, state: matchState(found.state) || f.state }));
        } catch (err) {
          setError(err.message);
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setError('We couldn’t get your location. Please allow access or type your address.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

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
      {!PREVIEW && (
        <button type="button" className="btn btn-outline locate-btn" onClick={useMyLocation} disabled={locating}>
          <Icon name="mapPin" size={16} /> {locating ? 'Finding your location…' : 'Use my current location'}
        </button>
      )}
      <div className="form-grid">
        <label className="field">Full name<input name="name" value={form.name} onChange={set} required autoComplete="name" /></label>
        <label className="field">10-digit mobile number<input name="phone" value={form.phone} onChange={digits(10)} required inputMode="numeric" autoComplete="tel-national" /></label>
        <label className="field">Pincode<input name="pincode" value={form.pincode} onChange={onPincode} required inputMode="numeric" autoComplete="postal-code" /></label>
        <label className="field">City / District / Town<input name="city" value={form.city} onChange={set} required autoComplete="address-level2" /></label>
        <label className="field span-2">Address (house no, building, street, area)<textarea name="line1" value={form.line1} onChange={set} required rows={3} autoComplete="street-address" /></label>
        <label className="field">
          State
          <select name="state" value={form.state} onChange={set} required autoComplete="address-level1">
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
