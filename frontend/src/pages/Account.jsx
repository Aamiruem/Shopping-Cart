import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import AddressForm from '../components/account/AddressForm';
import { Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import useApi from '../hooks/useApi';
import { formatDate } from '../utils/format';
import { PASSWORD_MIN, validatePassword } from '../utils/validation';

const TABS = [
  { id: 'profile', label: 'Profile information', icon: 'user' },
  { id: 'addresses', label: 'Manage addresses', icon: 'mapPin' },
  { id: 'security', label: 'Change password', icon: 'lock' },
  { id: 'support', label: 'Support tickets', icon: 'message' },
];

const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };

function SupportTab() {
  const { data: tickets, loading } = useApi(() => api.tickets(), []);
  if (loading) return <Spinner />;
  return (
    <div>
      <div className="tab-head"><h2>Support tickets</h2><Link to="/help#contact" className="btn-link"><Icon name="plus" size={14} /> New ticket</Link></div>
      {!tickets?.length && <p className="muted">You haven't raised any tickets.</p>}
      <ul className="address-list">
        {(tickets || []).map((t) => (
          <li key={t.id}>
            <span className="chip">{STATUS_LABEL[t.status]}</span>
            <p><strong>#{t.id} {t.subject}</strong> <span className="muted small">· {t.categoryLabel} · {formatDate(t.created_at)}</span></p>
            <p className="muted small">{t.message}</p>
            <details><summary className="small">Our reply</summary><p className="small">{t.suggested_reply}</p></details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProfileTab() {
  const { user, updateProfile } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ name: user.name, phone: user.phone || '' });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await updateProfile({ name: form.name, phone: form.phone || null });
      toast.show('Profile updated');
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="account-form">
      <div className="tab-head">
        <h2>Personal information</h2>
        {!editing && <button type="button" className="btn-link" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Edit</button>}
      </div>
      <div className="form-grid">
        <label className="field">Full name<input value={form.name} disabled={!editing} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label className="field">Mobile number<input value={form.phone} disabled={!editing} inputMode="numeric" placeholder="Not added" onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></label>
        <label className="field span-2">
          <span className="label-row">
            Email address
            {user.emailVerified ? <span className="verified"><Icon name="check" size={12} /> Verified{user.googleLinked ? ' by Google' : ''}</span> : <span className="unverified">Not verified</span>}
          </span>
          <input value={user.email} disabled />
        </label>
      </div>
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {editing && (
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn-text" onClick={() => { setEditing(false); setForm({ name: user.name, phone: user.phone || '' }); }}>Cancel</button>
        </div>
      )}
      {user.createdAt && <p className="muted small">Member since {formatDate(user.createdAt, { month: 'long', year: 'numeric' })}</p>}
    </form>
  );
}

function AddressesTab() {
  const toast = useToast();
  const [addresses, setAddresses] = useState(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.addresses().then(setAddresses).catch(() => setAddresses([]));
  }, []);

  const remove = async (id) => {
    if (!window.confirm('Delete this address?')) return;
    try {
      await api.removeAddress(id);
      setAddresses(addresses.filter((a) => a.id !== id));
      toast.show('Address deleted', 'info');
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  if (!addresses) return <Spinner />;

  return (
    <div>
      <div className="tab-head"><h2>Manage addresses</h2></div>
      {adding ? (
        <AddressForm onSaved={(a) => { setAddresses([a, ...addresses]); setAdding(false); toast.show('Address saved'); }} onCancel={() => setAdding(false)} />
      ) : (
        <button type="button" className="add-new" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add a new address</button>
      )}
      <ul className="address-list">
        {addresses.map((a) => (
          <li key={a.id}>
            <span className="chip">{a.type}</span>
            <p><strong>{a.name}</strong> &nbsp; <strong>{a.phone}</strong></p>
            <p className="muted">{a.line1}, {a.city}, {a.state} — <strong>{a.pincode}</strong></p>
            <button type="button" className="icon-btn" onClick={() => remove(a.id)} aria-label="Delete address"><Icon name="trash" size={16} /></button>
          </li>
        ))}
      </ul>
      {!addresses.length && !adding && <p className="muted">No saved addresses yet.</p>}
    </div>
  );
}

function SecurityTab() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (e) => setForm({ ...form, [e.target.name]: e.target.value });
  // Accounts created with Google have no password yet and can set one without the "current" field
  const settingFirst = !user.hasPassword;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const problem = validatePassword(form.newPassword) || (form.newPassword !== form.confirm ? 'New passwords do not match' : '');
    if (problem) return setError(problem);
    setBusy(true);
    try {
      setUser(await api.changePassword({ currentPassword: form.currentPassword, newPassword: form.newPassword }));
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      toast.show(settingFirst ? 'Password set. You can now also log in with email.' : 'Password changed successfully');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="account-form narrow-form" noValidate>
      <div className="tab-head"><h2>{settingFirst ? 'Set a password' : 'Change password'}</h2></div>
      {settingFirst && <p className="muted small">You signed up with Google. Add a password to also log in with your email.</p>}
      {!settingFirst && <label className="field">Current password<input type="password" name="currentPassword" value={form.currentPassword} onChange={set} required autoComplete="current-password" /></label>}
      <label className="field">New password<input type="password" name="newPassword" value={form.newPassword} onChange={set} required autoComplete="new-password" /></label>
      <label className="field">Confirm new password<input type="password" name="confirm" value={form.confirm} onChange={set} required autoComplete="new-password" /></label>
      <p className="muted small">At least {PASSWORD_MIN} characters, including a letter and a number.</p>
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : settingFirst ? 'Set password' : 'Update password'}</button></div>
    </form>
  );
}

export default function Account() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'profile';

  return (
    <div className="page-account container">
      <aside className="account-side">
        <div className="panel account-hello">
          <span className="avatar">{user.name[0]?.toUpperCase()}</span>
          <div><span className="muted small">Hello,</span><strong>{user.name}</strong></div>
        </div>
        <nav className="panel account-nav">
          <Link to="/orders"><Icon name="package" size={18} /> My orders <Icon name="chevronRight" size={16} /></Link>
          <Link to="/wishlist"><Icon name="heart" size={18} /> My wishlist <Icon name="chevronRight" size={16} /></Link>
          <p className="nav-group">Account settings</p>
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => setParams({ tab: t.id })}>
              <Icon name={t.icon} size={18} /> {t.label}
            </button>
          ))}
          <button type="button" onClick={() => { logout(); navigate('/'); }}><Icon name="logout" size={18} /> Logout</button>
        </nav>
      </aside>
      <section className="panel account-content">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'addresses' && <AddressesTab />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'support' && <SupportTab />}
      </section>
    </div>
  );
}
