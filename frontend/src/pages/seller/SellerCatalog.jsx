import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorMessage, Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import useApi from '../../hooks/useApi';
import { formatPrice } from '../../utils/format';

const PAGE = 50;
const FILTERS = [['', 'All'], ['low_stock', 'Low stock'], ['hidden', 'Hidden'], ['edited', 'Edited']];

// One product's edit form: price, MRP, stock on the shelf, name, description, listed or hidden
function EditRow({ product, onSaved, onClose }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: product.name, price: product.price, mrp: product.mrp ?? '', stock: product.stock, description: product.description || '', active: product.active,
  });
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const save = async (e) => {
    e.preventDefault();
    const changes = {};
    for (const [key, value] of Object.entries(form)) {
      const before = key === 'mrp' ? product.mrp ?? '' : product[key] ?? '';
      if (String(value) !== String(before)) changes[key] = ['price', 'mrp', 'stock'].includes(key) && value !== '' ? Number(value) : value;
    }
    if (!Object.keys(changes).length) return onClose();
    setBusy(true);
    try {
      onSaved(await api.catalogUpdate(product._id, changes));
      toast.show('Saved. Shoppers see it within a minute.');
    } catch (err) {
      toast.show(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      onSaved(await api.catalogReset(product._id));
      toast.show('Back to the original details', 'info');
    } catch (err) {
      toast.show(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="catalog-edit">
      <td colSpan={6}>
        <form className="form-grid" onSubmit={save}>
          <label className="field span-2">Name<input value={form.name} onChange={set('name')} maxLength={200} required minLength={3} /></label>
          <label className="field">Price (₹)<input type="number" min="1" step="0.01" value={form.price} onChange={set('price')} required /></label>
          <label className="field">MRP (₹, optional)<input type="number" min="1" step="0.01" value={form.mrp} onChange={set('mrp')} /></label>
          <label className="field">Stock on the shelf<input type="number" min="0" step="1" value={form.stock} onChange={set('stock')} required /></label>
          <label className="field checkbox-field"><span><input type="checkbox" checked={form.active} onChange={set('active')} /> Listed in the store</span></label>
          <label className="field span-2">Description<textarea rows={3} maxLength={5000} value={form.description} onChange={set('description')} /></label>
          <div className="form-actions span-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn-text" onClick={onClose}>Close</button>
            {product.edited.length > 0 && <button type="button" className="btn-text" disabled={busy} onClick={reset}>Undo my edits</button>}
          </div>
        </form>
      </td>
    </tr>
  );
}

// Admin only: the store's own catalog. Edits are saved in the database over the product file; stock goes down with
// every order and back up with cancellations and returns.
export default function SellerCatalog() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const [editing, setEditing] = useState(null);
  const [saved, setSaved] = useState({}); // id -> product, for rows edited since the page loaded
  const { data, error, loading, reload } = useApi(() => api.catalog({ q: search, status, skip, limit: PAGE }), [search, status, skip]);
  if (user.role !== 'admin') return <Navigate to="/seller/products" replace />;

  const items = (data?.items || []).map((p) => saved[p._id] || p);
  return (
    <div className="panel seller-products">
      <header className="seller-head">
        <div>
          <h1>Store catalog</h1>
          <p className="muted small">The store’s own {data?.total ?? ''} products. Change price, stock or details, or hide a product. Stock updates by itself as orders come in, are cancelled or are returned.</p>
        </div>
      </header>
      <div className="seller-toolbar">
        <form onSubmit={(e) => { e.preventDefault(); setSkip(0); setSearch(q.trim()); }} className="catalog-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, brand or product ID" aria-label="Search the catalog" />
          <button type="submit" className="btn btn-outline btn-sm"><Icon name="search" size={14} /> Search</button>
        </form>
        <div className="segmented" role="group" aria-label="Show">
          {FILTERS.map(([id, label]) => <button key={id} type="button" className={status === id ? 'active' : ''} onClick={() => { setSkip(0); setStatus(id); }}>{label}</button>)}
        </div>
      </div>
      <ErrorMessage message={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Product</th><th className="num">Price</th><th className="num">Stock</th><th>Rating</th><th>Status</th><th /></tr></thead>
            <tbody>
              {items.map((p) => [
                <tr key={p._id} className={p.active ? '' : 'inactive'}>
                  <td>
                    <div className="catalog-product">
                      <img src={p.image} alt="" loading="lazy" />
                      <span><strong>{p.name}</strong><span className="muted small block">{p.brand} · {p.category}{p.edited.length ? ` · edited: ${p.edited.join(', ')}` : ''}</span></span>
                    </div>
                  </td>
                  <td className="num">{formatPrice(p.price)}{p.mrp > p.price && <span className="muted small block"><s>{formatPrice(p.mrp)}</s></span>}</td>
                  <td className={`num ${p.stock < 10 ? 'text-error' : ''}`}>{p.stock}</td>
                  <td>{p.reviewCount ? <>{p.reviewRating} ★ <span className="muted small">({p.reviewCount})</span></> : <span className="muted small">No reviews</span>}</td>
                  <td>{p.active ? 'Listed' : 'Hidden'}</td>
                  <td><button type="button" className="btn-text" onClick={() => setEditing(editing === p._id ? null : p._id)}><Icon name="edit" size={14} /> Edit</button></td>
                </tr>,
                editing === p._id && (
                  <EditRow key={`${p._id}-edit`} product={p} onClose={() => setEditing(null)} onSaved={(next) => { setSaved({ ...saved, [next._id]: next }); setEditing(null); }} />
                ),
              ])}
            </tbody>
          </table>
          {!items.length && <p className="muted" style={{ padding: 16 }}>No products match.</p>}
        </div>
      )}
      {data && data.total > PAGE && (
        <div className="form-actions pager">
          <button type="button" className="btn btn-outline btn-sm" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>Previous</button>
          <span className="muted small">{skip + 1}–{Math.min(skip + PAGE, data.total)} of {data.total}</span>
          <button type="button" className="btn btn-outline btn-sm" disabled={skip + PAGE >= data.total} onClick={() => setSkip(skip + PAGE)}>Next</button>
        </div>
      )}
    </div>
  );
}
