import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import { useToast } from '../../context/ToastContext';
import { useSellerProfile } from './SellerLayout';

const fromProfile = (p) => ({
  storeName: p.store_name || '',
  description: p.description || '',
  logo: p.logo || '',
  gstin: p.gstin || '',
  phone: p.phone || '',
  payoutUpi: p.payout_upi || '',
  bankAccountName: p.bank_account_name || '',
  bankAccountNumber: p.bank_account_number || '', // masked (••••1234) - left as is, the server keeps the saved number
  bankIfsc: p.bank_ifsc || '',
});

// Same rules as the API, so mistakes show up before saving
function validate(f) {
  if (f.storeName.trim().length < 3) return 'Store name must be at least 3 characters';
  if (f.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(f.gstin)) return 'GSTIN should look like 29ABCDE1234F1Z5';
  if (f.phone && !/^[6-9]\d{9}$/.test(f.phone)) return 'Enter a valid 10-digit mobile number';
  if (f.payoutUpi && !/^[\w.-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(f.payoutUpi)) return 'UPI ID should look like yourstore@okhdfcbank';
  const number = f.bankAccountNumber.replace(/\s/g, '');
  if (number && !number.includes('•') && !/^\d{9,18}$/.test(number)) return 'Bank account number must be 9 to 18 digits';
  if (f.bankIfsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(f.bankIfsc)) return 'IFSC should look like HDFC0001234';
  if (number && !f.bankIfsc) return 'Add the IFSC code of your bank branch';
  return '';
}

export default function SellerSettings() {
  const { profile, reload } = useSellerProfile();
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const logoRef = useRef(null);
  useEffect(() => {
    if (profile) setForm(fromProfile(profile));
  }, [profile]);

  if (!form) return <div className="panel"><Spinner /></div>;
  const set = (key, transform = (v) => v) => (e) => setForm({ ...form, [key]: transform(e.target.value) });

  const uploadLogo = async (file) => {
    if (!file) return;
    try {
      const { url } = await api.uploadMedia(file, 'image');
      setForm((f) => ({ ...f, logo: url }));
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  const save = async (e) => {
    e.preventDefault();
    const problem = validate(form);
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      await api.sellerUpdateProfile(form);
      reload();
      toast.show('Store settings saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="seller-settings" onSubmit={save} noValidate>
      <section className="panel seller-card">
        <header className="seller-head">
          <div><h1>Store Settings</h1><p className="muted small">How your store appears to shoppers</p></div>
        </header>
        <div className="settings-grid">
          <div className="logo-picker">
            {form.logo ? <img src={form.logo} alt="Store logo" /> : <span className="avatar big">{form.storeName[0]?.toUpperCase() || 'S'}</span>}
            <button type="button" className="btn btn-outline btn-sm" onClick={() => logoRef.current?.click()}><Icon name="upload" size={14} /> {form.logo ? 'Change logo' : 'Upload logo'}</button>
            {form.logo && <button type="button" className="btn-link small" onClick={() => setForm({ ...form, logo: '' })}>Remove</button>}
            <input ref={logoRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => uploadLogo(e.target.files[0])} />
          </div>
          <div className="form-grid">
            <label className="field span-2">Store name<input value={form.storeName} onChange={set('storeName')} maxLength={120} required /></label>
            <label className="field span-2">About your store <span className="muted">(shown to shoppers)</span>
              <textarea rows={3} value={form.description} onChange={set('description')} maxLength={1000} placeholder="What you sell, where you ship from, your promise to customers" />
            </label>
            <label className="field">GSTIN <span className="muted">(optional)</span><input value={form.gstin} onChange={set('gstin', (v) => v.toUpperCase().slice(0, 15))} placeholder="29ABCDE1234F1Z5" /></label>
            <label className="field">Business phone<input value={form.phone} inputMode="numeric" onChange={set('phone', (v) => v.replace(/\D/g, '').slice(0, 10))} placeholder="9876543210" /></label>
          </div>
        </div>
      </section>

      <section className="panel seller-card">
        <header className="seller-head">
          <div><h2><Icon name="bank" size={18} /> Payout details</h2><p className="muted small">Where your earnings are sent. Add a UPI ID, a bank account, or both.</p></div>
        </header>
        <div className="payout-grid">
          <div className="payout-box">
            <p className="payout-title"><Icon name="phone" size={16} /> UPI</p>
            <label className="field">UPI ID<input value={form.payoutUpi} onChange={set('payoutUpi', (v) => v.trim())} placeholder="yourstore@okhdfcbank" /></label>
            <p className="muted small">Works with every UPI app: Google Pay, PhonePe, Paytm, BHIM and your bank's app.</p>
          </div>
          <div className="payout-box">
            <p className="payout-title"><Icon name="bank" size={16} /> Bank account (NEFT / IMPS)</p>
            <label className="field">Account holder name<input value={form.bankAccountName} onChange={set('bankAccountName')} maxLength={120} /></label>
            <label className="field">Account number<input value={form.bankAccountNumber} inputMode="numeric" onChange={set('bankAccountNumber', (v) => v.replace(/[^\d•]/g, '').slice(0, 18))} placeholder="9 to 18 digits" /></label>
            <label className="field">IFSC code<input value={form.bankIfsc} onChange={set('bankIfsc', (v) => v.toUpperCase().slice(0, 11))} placeholder="HDFC0001234" /></label>
          </div>
        </div>
        <p className="secure-note"><Icon name="lock" size={14} /> Only the last 4 digits of your account number are ever shown, here or anywhere else in the app.</p>
      </section>

      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <div className="settings-actions">
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
      </div>
    </form>
  );
}
