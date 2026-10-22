import { useRef, useState } from 'react';
import { api } from '../../api/client';
import { AUDIENCES, CATEGORIES } from '../../constants/catalog';
import { discountPercent } from '../../utils/format';
import Icon from '../common/Icon';
import Spin360 from '../product/Spin360';

const EMPTY = { name: '', brand: '', category: 'electronics', audience: '', description: '', price: '', mrp: '', stock: '10', tags: '', images: [], images360: [], active: true };
const MAX_IMAGES = { images: 8, images360: 36 };

const fromProduct = (p) => ({
  name: p.name, brand: p.brand || '', category: p.category, description: p.description || '',
  price: String(p.price), mrp: p.mrp ? String(p.mrp) : '', stock: String(p.stock ?? 0),
  tags: (p.tags || []).join(', '), images: p.images?.length ? p.images : p.image ? [p.image] : [], active: p.active !== false,
  audience: p.audience || '', images360: p.images360 || [],
});

function validate(f) {
  if (f.name.trim().length < 2) return 'Product name must be at least 2 characters';
  if (!(Number(f.price) > 0)) return 'Enter a selling price greater than 0';
  if (f.mrp && Number(f.mrp) < Number(f.price)) return 'MRP cannot be lower than the selling price';
  if (!(Number(f.stock) >= 0) || !Number.isInteger(Number(f.stock))) return 'Stock must be a whole number';
  if (!f.images.length) return 'Add at least one product image';
  if (f.category === 'fashion' && !f.audience) return 'Choose who this fashion item is for (Women, Men or Unisex)';
  if (f.images360.length > 0 && f.images360.length < 4) return 'A 360° view needs at least 4 frames (or remove them)';
  return '';
}

// Create / edit dialog. `product` = null for a new product.
export default function ProductForm({ product, onSaved, onClose }) {
  const [form, setForm] = useState(product ? fromProduct(product) : EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const fileRef = useRef(null);
  const spinFileRef = useRef(null);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const off = discountPercent(Number(form.price), Number(form.mrp));

  // key = 'images' (gallery) or 'images360' (turntable frames, uploaded in name order = rotation order)
  const addImages = async (files, key = 'images') => {
    setUploading(true);
    setError('');
    try {
      const urls = [];
      const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const file of ordered.slice(0, MAX_IMAGES[key] - form[key].length)) urls.push((await api.uploadImage(file)).url);
      setForm((f) => ({ ...f, [key]: [...f[key], ...urls] }));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      [fileRef, spinFileRef].forEach((r) => r.current && (r.current.value = ''));
    }
  };

  const addUrl = () => {
    if (!/^https?:\/\/\S+$/i.test(imageUrl.trim())) return setError('Enter a full image URL starting with https://');
    setForm({ ...form, images: [...form.images, imageUrl.trim()] });
    setImageUrl('');
    setError('');
  };

  const submit = async (e) => {
    e.preventDefault();
    const problem = validate(form);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    const body = {
      name: form.name, brand: form.brand, category: form.category, description: form.description,
      audience: form.category === 'fashion' ? form.audience : '', images360: form.images360,
      price: Number(form.price), mrp: form.mrp ? Number(form.mrp) : null, stock: Number(form.stock),
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean), images: form.images, image: form.images[0], active: form.active,
    };
    try {
      onSaved(product ? await api.sellerUpdateProduct(product._id, body) : await api.sellerCreateProduct(body), !product);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="otp-overlay" role="dialog" aria-modal="true" aria-labelledby="product-form-title">
      <form className="panel product-form" onSubmit={submit} noValidate>
        <header>
          <h2 id="product-form-title">{product ? 'Edit product' : 'Add a new product'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>

        <div className="product-form-body">
          <div className="form-grid">
            <label className="field span-2">Product name<input value={form.name} onChange={set('name')} maxLength={200} required /></label>
            <label className="field">Brand<input value={form.brand} onChange={set('brand')} maxLength={80} /></label>
            <label className="field">Category
              <select value={form.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
            </label>
            {form.category === 'fashion' && (
              <label className="field">Shop for
                <select value={form.audience} onChange={set('audience')} required>
                  <option value="">Choose…</option>
                  {AUDIENCES.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  <option value="unisex">Unisex</option>
                </select>
              </label>
            )}
            <label className="field">Selling price (₹)<input type="number" min="1" step="1" value={form.price} onChange={set('price')} required /></label>
            <label className="field">MRP (₹) <span className="muted">{off > 0 ? `· ${off}% off` : ''}</span><input type="number" min="1" step="1" value={form.mrp} onChange={set('mrp')} /></label>
            <label className="field">Stock<input type="number" min="0" step="1" value={form.stock} onChange={set('stock')} required /></label>
            <label className="field">Tags <span className="muted">(comma separated)</span><input value={form.tags} onChange={set('tags')} placeholder="5g, android, dual sim" /></label>
            <label className="field span-2">Description<textarea rows={4} value={form.description} onChange={set('description')} maxLength={5000} /></label>
          </div>

          <div className="image-manager">
            <p className="field-label">Images <span className="muted small">(first image is the cover · JPEG/PNG/WebP up to 5 MB)</span></p>
            <div className="image-grid">
              {form.images.map((src, i) => (
                <figure key={src}>
                  <img src={src} alt="" />
                  {i === 0 && <span className="cover">Cover</span>}
                  <button type="button" onClick={() => setForm({ ...form, images: form.images.filter((x) => x !== src) })} aria-label="Remove image"><Icon name="x" size={14} /></button>
                </figure>
              ))}
              {form.images.length < 8 && (
                <button type="button" className="image-add" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  <Icon name="upload" size={22} /> {uploading ? 'Uploading…' : 'Upload'}
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => addImages(e.target.files)} />
            <div className="url-row">
              <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="…or paste an image URL" aria-label="Image URL" />
              <button type="button" className="btn btn-outline btn-sm" onClick={addUrl}>Add</button>
            </div>
          </div>

          <div className="image-manager">
            <p className="field-label">360° view <span className="muted small">(optional · 4–36 photos taken while turning the product, uploaded in rotation order)</span></p>
            <div className="spin-editor">
              <div className="image-grid">
                {form.images360.map((src, i) => (
                  <figure key={src}>
                    <img src={src} alt="" />
                    <span className="cover">{i + 1}</span>
                    <button type="button" onClick={() => setForm({ ...form, images360: form.images360.filter((x) => x !== src) })} aria-label={`Remove frame ${i + 1}`}><Icon name="x" size={14} /></button>
                  </figure>
                ))}
                {form.images360.length < MAX_IMAGES.images360 && (
                  <button type="button" className="image-add" onClick={() => spinFileRef.current?.click()} disabled={uploading}>
                    <Icon name="rotate" size={22} /> {uploading ? 'Uploading…' : 'Add frames'}
                  </button>
                )}
              </div>
              {form.images360.length >= 4 && (
                <div className="spin-preview" aria-label="360° preview"><Spin360 frames={form.images360} alt={form.name || 'your product'} /></div>
              )}
            </div>
            <input ref={spinFileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => addImages(e.target.files, 'images360')} />
            {!form.images360.length && form.images.length >= 4 && (
              <button type="button" className="btn-link small" onClick={() => setForm({ ...form, images360: form.images.slice(0, MAX_IMAGES.images360) })}>
                My photos above already go all the way around the product, so use them as the 360° view
              </button>
            )}
          </div>

          <label className="check-row"><input type="checkbox" checked={form.active} onChange={set('active')} /> Listed in the store</label>
        </div>

        {error && <p className="alert alert-error" role="alert">{error}</p>}
        <footer>
          <button type="button" className="btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || uploading}>{busy ? 'Saving…' : product ? 'Save changes' : 'Add product'}</button>
        </footer>
      </form>
    </div>
  );
}
