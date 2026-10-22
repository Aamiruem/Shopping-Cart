import { useRef, useState } from 'react';
import { api } from '../../api/client';
import { AUDIENCES, CATEGORIES } from '../../constants/catalog';
import { discountPercent } from '../../utils/format';
import Icon from '../common/Icon';
import Spin360 from '../product/Spin360';

const EMPTY = { name: '', brand: '', category: 'electronics', audience: '', description: '', price: '', mrp: '', stock: '10', tags: '', images: [], images360: [], videos: [], audio: '', unit: '', active: true };
const MAX_IMAGES = { images: 8, images360: 36, videos: 4 };

const fromProduct = (p) => ({
  name: p.name, brand: p.brand || '', category: p.category, description: p.description || '',
  price: String(p.price), mrp: p.mrp ? String(p.mrp) : '', stock: String(p.stock ?? 0),
  tags: (p.tags || []).join(', '), images: p.images?.length ? p.images : p.image ? [p.image] : [], active: p.active !== false,
  audience: p.audience || '', images360: p.images360 || [], videos: p.videos || [], audio: p.audio || '', unit: p.unit || '',
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
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const [videoUrl, setVideoUrl] = useState('');
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const off = discountPercent(Number(form.price), Number(form.mrp));

  // key = 'images' (gallery) or 'images360' (turntable frames, uploaded in name order = rotation order)
  const addImages = async (files, key = 'images') => {
    setUploading(true);
    setError('');
    try {
      const urls = [];
      const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const kind = key === 'videos' ? 'video' : 'image';
      for (const file of ordered.slice(0, MAX_IMAGES[key] - form[key].length)) urls.push((await api.uploadMedia(file, kind)).url);
      setForm((f) => ({ ...f, [key]: [...f[key], ...urls] }));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      [fileRef, spinFileRef, videoRef].forEach((r) => r.current && (r.current.value = ''));
    }
  };

  // AI listing writer: drafts a search-friendly title, description and tags from what the seller typed
  const [ai, setAi] = useState({ busy: false, draft: null });
  const writeWithAi = async () => {
    if (form.name.trim().length < 2) return setError('Enter the product name first, then let AI write the rest');
    setAi({ busy: true, draft: null });
    setError('');
    try {
      const draft = await api.aiListing({
        name: form.name, brand: form.brand, category: form.category, audience: form.audience, unit: form.unit,
        price: form.price ? Number(form.price) : null, mrp: form.mrp ? Number(form.mrp) : null,
        description: form.description, tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setAi({ busy: false, draft });
    } catch (err) {
      setError(err.message);
      setAi({ busy: false, draft: null });
    }
  };
  const applyDraft = () => {
    const d = ai.draft;
    const highlights = d.highlights?.length ? `\n\nHighlights:\n${d.highlights.map((h) => `• ${h}`).join('\n')}` : '';
    setForm((f) => ({ ...f, name: d.title.slice(0, 200), description: `${d.description}${highlights}`.slice(0, 5000), tags: d.tags.join(', ') }));
    setAi({ busy: false, draft: null });
  };

  const addAudio = async (file) => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const { url } = await api.uploadMedia(file, 'audio');
      setForm((f) => ({ ...f, audio: url }));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (audioRef.current) audioRef.current.value = '';
    }
  };

  const addVideoUrl = () => {
    if (!/^https:\/\/\S+$/i.test(videoUrl.trim())) return setError('Enter a full video URL starting with https:// (an MP4 or WebM file)');
    setForm({ ...form, videos: [...form.videos, videoUrl.trim()].slice(0, MAX_IMAGES.videos) });
    setVideoUrl('');
    setError('');
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
      videos: form.videos, audio: form.audio, unit: form.unit.trim(),
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
          <div className="ai-writer">
            <div>
              <strong><Icon name="zap" size={15} /> AI listing writer</strong>
              <span className="muted small">Type the product name (and any notes), then get a search-friendly title, description and tags.</span>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={writeWithAi} disabled={ai.busy}>
              {ai.busy ? 'Writing…' : '✨ Write with AI'}
            </button>
          </div>
          {ai.draft && (
            <div className="ai-draft">
              <p className="ai-draft-label">Suggested listing {ai.draft.source === 'template' ? '(quick template: add an Anthropic API key for full AI writing)' : '(written by Claude)'}</p>
              <h3>{ai.draft.title}</h3>
              <p>{ai.draft.description}</p>
              {ai.draft.highlights?.length > 0 && <ul>{ai.draft.highlights.map((h) => <li key={h}>{h}</li>)}</ul>}
              <p className="ai-tags">{ai.draft.tags.map((t) => <span key={t}>{t}</span>)}</p>
              <p className="muted small">Search snippet: {ai.draft.metaDescription}</p>
              <div className="ai-draft-actions">
                <button type="button" className="btn btn-buy btn-sm" onClick={applyDraft}>Use this</button>
                <button type="button" className="btn-link small" onClick={writeWithAi}>Try again</button>
                <button type="button" className="btn-link small" onClick={() => setAi({ busy: false, draft: null })}>Dismiss</button>
              </div>
            </div>
          )}
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
            <label className="field">Pack size <span className="muted">(optional)</span><input value={form.unit} onChange={set('unit')} maxLength={40} placeholder="e.g. 500 g, 1 L, Pack of 2" /></label>
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
            <p className="field-label"><Icon name="video" size={15} /> Videos <span className="muted small">(optional · up to 4 · MP4 or WebM, 50 MB each)</span></p>
            <div className="media-grid">
              {form.videos.map((src, i) => (
                <figure key={src} className="media-item">
                  <video src={src} muted preload="metadata" controls />
                  <figcaption>Video {i + 1}</figcaption>
                  <button type="button" onClick={() => setForm({ ...form, videos: form.videos.filter((x) => x !== src) })} aria-label={`Remove video ${i + 1}`}><Icon name="x" size={14} /></button>
                </figure>
              ))}
              {form.videos.length < MAX_IMAGES.videos && (
                <button type="button" className="image-add media-add" onClick={() => videoRef.current?.click()} disabled={uploading}>
                  <Icon name="video" size={22} /> {uploading ? 'Uploading…' : 'Upload video'}
                </button>
              )}
            </div>
            <input ref={videoRef} type="file" accept="video/mp4,video/webm" multiple hidden onChange={(e) => addImages(e.target.files, 'videos')} />
            <div className="url-row">
              <input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="…or paste a video file URL (https://…mp4)" aria-label="Video URL" />
              <button type="button" className="btn btn-outline btn-sm" onClick={addVideoUrl}>Add</button>
            </div>
          </div>

          <div className="image-manager">
            <p className="field-label"><Icon name="music" size={15} /> Audio <span className="muted small">(optional · a sound sample or a spoken description · MP3, M4A, OGG or WAV, 10 MB)</span></p>
            {form.audio ? (
              <div className="audio-row">
                <audio src={form.audio} controls preload="metadata" />
                <button type="button" className="btn-link small" onClick={() => setForm({ ...form, audio: '' })}>Remove</button>
              </div>
            ) : (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => audioRef.current?.click()} disabled={uploading}>
                <Icon name="music" size={14} /> {uploading ? 'Uploading…' : 'Upload audio'}
              </button>
            )}
            <input ref={audioRef} type="file" accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg,audio/wav,audio/x-wav" hidden onChange={(e) => addAudio(e.target.files[0])} />
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
