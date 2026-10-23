import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { EmptyState, ErrorMessage, Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import BulkImport from '../../components/seller/BulkImport';
import ProductForm from '../../components/seller/ProductForm';
import { categoryLabel } from '../../constants/catalog';
import { useToast } from '../../context/ToastContext';
import useApi from '../../hooks/useApi';
import { formatPrice } from '../../utils/format';

const FILTERS = [
  { id: '', label: 'All' },
  { id: 'active', label: 'Listed' },
  { id: 'inactive', label: 'Unlisted' },
  { id: 'low_stock', label: 'Low stock' },
];

// Inline quick edit for price / stock: saves on Enter or blur
function QuickEdit({ value, onSave, prefix = '', label }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => draft !== String(value) && onSave(Number(draft)).catch(() => setDraft(String(value)));
  return (
    <span className="quick-edit">
      {prefix}
      <input value={draft} inputMode="numeric" aria-label={label} onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
        onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </span>
  );
}

export default function SellerProducts() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new product
  const [importing, setImporting] = useState(false);
  const { data: products, error, loading, reload } = useApi(() => api.sellerProducts({ q: search, status }), [search, status]);
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(new Set());
  useEffect(() => {
    setRows(products || []);
    setSelected(new Set());
  }, [products]);

  const toggle = (id) => setSelected((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((p) => p._id)));

  const bulk = async (action) => {
    const ids = [...selected];
    let extra = {};
    if (action === 'delete' && !window.confirm(`Delete ${ids.length} product(s)? This cannot be undone.`)) return;
    if (action === 'stock') {
      const value = window.prompt(`New stock for ${ids.length} product(s):`, '10');
      if (value === null) return;
      if (!/^\d+$/.test(value.trim())) return toast.show('Stock must be a whole number', 'error');
      extra = { stock: Number(value) };
    }
    try {
      const { updated } = await api.sellerBulk(ids, action, extra);
      toast.show(`${updated} product(s) ${{ list: 'listed', unlist: 'unlisted', delete: 'deleted', stock: 'updated' }[action]}`);
      reload();
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  const duplicate = async (product) => {
    try {
      const copy = await api.sellerDuplicateProduct(product._id);
      setRows((list) => [copy, ...list]);
      toast.show('Copy created as an unlisted draft. Edit it, then list it.');
      setEditing(copy);
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  const patch = async (product, changes, message) => {
    try {
      const updated = await api.sellerPatchProduct(product._id, changes);
      setRows((list) => list.map((p) => (p._id === updated._id ? updated : p)));
      if (message) toast.show(message);
    } catch (err) {
      toast.show(err.message, 'error');
      throw err;
    }
  };

  const remove = async (product) => {
    if (!window.confirm(`Delete “${product.name}”? This cannot be undone.`)) return;
    try {
      await api.sellerDeleteProduct(product._id);
      setRows((list) => list.filter((p) => p._id !== product._id));
      toast.show('Product deleted', 'info');
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  const onSaved = (saved, isNew) => {
    setEditing(undefined);
    toast.show(isNew ? 'Product added to your store' : 'Product updated');
    isNew ? reload() : setRows((list) => list.map((p) => (p._id === saved._id ? saved : p)));
  };

  return (
    <div className="panel seller-products">
      <header className="seller-head">
        <div>
          <h1>Products</h1>
          <p className="muted small">{rows.length} products · edit price and stock in the table, tick rows for bulk actions</p>
        </div>
        <div className="seller-head-actions">
          <button type="button" className="btn btn-outline" onClick={() => setImporting(true)}><Icon name="upload" size={16} /> Bulk upload</button>
          <button type="button" className="btn btn-primary" onClick={() => setEditing(null)}><Icon name="plus" size={16} /> Add product</button>
        </div>
      </header>

      <div className="seller-toolbar">
        <form onSubmit={(e) => { e.preventDefault(); setSearch(q); }} className="toolbar-search">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your products" aria-label="Search products" />
        </form>
        <div className="segmented" role="group" aria-label="Filter">
          {FILTERS.map((f) => <button key={f.id} type="button" className={status === f.id ? 'active' : ''} onClick={() => setStatus(f.id)}>{f.label}</button>)}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
          <strong>{selected.size} selected</strong>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => bulk('list')}><Icon name="eye" size={14} /> List</button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => bulk('unlist')}><Icon name="eyeOff" size={14} /> Unlist</button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => bulk('stock')}><Icon name="package" size={14} /> Set stock</button>
          <button type="button" className="btn btn-outline btn-sm danger" onClick={() => bulk('delete')}><Icon name="trash" size={14} /> Delete</button>
          <button type="button" className="btn-link small" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <ErrorMessage message={error} onRetry={reload} />
      {loading ? <Spinner /> : rows.length ? (
        <div className="data-table-wrap">
          <table className="data-table product-table">
            <thead>
              <tr><th className="check-col"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all products" /></th><th>Product</th><th>Category</th><th className="num">Price</th><th className="num">MRP</th><th className="num">Stock</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p._id} className={`${p.active ? '' : 'inactive'} ${selected.has(p._id) ? 'selected' : ''}`}>
                  <td className="check-col"><input type="checkbox" checked={selected.has(p._id)} onChange={() => toggle(p._id)} aria-label={`Select ${p.name}`} /></td>
                  <td>
                    <div className="product-cell">
                      <img src={p.image} alt="" />
                      <div>
                        <Link to={`/products/${p._id}`} target="_blank">{p.name}</Link>
                        <span className="muted small">{p.brand}</span>
                        <span className="media-badges">
                          {p.images?.length > 1 && <span title="Photos"><Icon name="image" size={11} /> {p.images.length}</span>}
                          {p.videos?.length > 0 && <span title="Videos"><Icon name="video" size={11} /> {p.videos.length}</span>}
                          {p.audio && <span title="Audio"><Icon name="music" size={11} /></span>}
                          {p.images360?.length >= 4 && <span title="360° view"><Icon name="rotate" size={11} /> 360°</span>}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>{categoryLabel(p.category)}</td>
                  <td className="num"><QuickEdit value={p.price} prefix="₹" label={`Price of ${p.name}`} onSave={(price) => patch(p, { price }, 'Price updated')} /></td>
                  <td className="num muted">{p.mrp ? formatPrice(p.mrp) : '—'}</td>
                  <td className="num">
                    <QuickEdit value={p.stock} label={`Stock of ${p.name}`} onSave={(stock) => patch(p, { stock }, 'Stock updated')} />
                    {p.stock < 10 && <span className="low-stock" title="Low stock"><Icon name="clock" size={12} /> Low</span>}
                  </td>
                  <td>
                    <label className="switch">
                      <input type="checkbox" checked={p.active} onChange={(e) => patch(p, { active: e.target.checked }, e.target.checked ? 'Product listed' : 'Product unlisted')} />
                      <span>{p.active ? 'Listed' : 'Unlisted'}</span>
                    </label>
                  </td>
                  <td className="row-actions">
                    <button type="button" className="icon-btn" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`} title="Edit"><Icon name="edit" size={16} /></button>
                    <button type="button" className="icon-btn" onClick={() => duplicate(p)} aria-label={`Duplicate ${p.name}`} title="Duplicate"><Icon name="copy" size={16} /></button>
                    <button type="button" className="icon-btn danger" onClick={() => remove(p)} aria-label={`Delete ${p.name}`}><Icon name="trash" size={16} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon="tag" title={search || status ? 'No products match' : 'No products yet'} message="Add your first product to start selling." />
      )}

      {editing !== undefined && <ProductForm product={editing} onSaved={onSaved} onClose={() => setEditing(undefined)} />}
      {importing && (
        <BulkImport onClose={() => setImporting(false)} onImported={(n) => { toast.show(`${n} product(s) added to your store`); reload(); }} />
      )}
    </div>
  );
}
