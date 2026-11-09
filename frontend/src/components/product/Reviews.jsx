import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { formatDate } from '../../utils/format';
import Icon from '../common/Icon';
import Rating from '../common/Rating';

const STARS = [5, 4, 3, 2, 1];
const MIN_FOR_SUMMARY = 3;
const MAX_PHOTOS = 3;
const SORTS = [['recent', 'Most recent'], ['helpful', 'Most detailed'], ['critical', 'Lowest rated']];

function StarPicker({ value, onChange }) {
  return (
    <div className="star-picker" role="radiogroup" aria-label="Your rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={n <= value ? 'on' : ''} onClick={() => onChange(n)}>
          <Icon name="star" size={26} filled={n <= value} />
        </button>
      ))}
    </div>
  );
}

// Up to 3 photos of the product as it arrived, uploaded one by one
function PhotoPicker({ photos, onChange }) {
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const add = async (e) => {
    const files = [...e.target.files].slice(0, MAX_PHOTOS - photos.length);
    e.target.value = '';
    if (!files.length) return;
    setUploading(true);
    const added = [];
    for (const file of files) {
      try {
        added.push((await api.uploadReviewPhoto(file)).url);
      } catch (err) {
        toast.show(err.message, 'error');
        break;
      }
    }
    setUploading(false);
    onChange([...photos, ...added]);
  };
  return (
    <div className="review-photos-edit">
      {photos.map((src) => (
        <span key={src} className="review-photo">
          <img src={src} alt="Your photo" />
          <button type="button" aria-label="Remove photo" onClick={() => onChange(photos.filter((p) => p !== src))}><Icon name="x" size={12} /></button>
        </span>
      ))}
      {photos.length < MAX_PHOTOS && (
        <label className={`review-photo-add ${uploading ? 'busy' : ''}`}>
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={add} disabled={uploading} />
          <Icon name="camera" size={18} />
          <span>{uploading ? 'Uploading…' : 'Add photos'}</span>
        </label>
      )}
    </div>
  );
}

function ReviewForm({ productId, mine, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ rating: mine?.rating || 0, title: mine?.title || '', body: mine?.body || '', photos: mine?.photos || [] });
  const [busy, setBusy] = useState(false);
  const set = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteReview(productId);
      toast.show('Your review was removed', 'info');
      onSaved();
    } catch (err) {
      toast.show(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.rating) return toast.show('Please choose a star rating', 'error');
    setBusy(true);
    try {
      await api.saveReview(productId, form);
      toast.show('Thanks for your review!');
      onSaved();
    } catch (err) {
      toast.show(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="review-form" onSubmit={submit}>
      <h3>{mine ? 'Update your review' : 'Rate this product'}</h3>
      <StarPicker value={form.rating} onChange={(rating) => setForm({ ...form, rating })} />
      <label className="field">Title<input name="title" value={form.title} onChange={set} maxLength={120} /></label>
      <label className="field">Your review<textarea name="body" value={form.body} onChange={set} maxLength={2000} rows={3} placeholder="How is the quality, fit or performance? Would you recommend it?" /></label>
      <div className="field">Photos (optional, up to {MAX_PHOTOS})<PhotoPicker photos={form.photos} onChange={(photos) => setForm({ ...form, photos })} /></div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : mine ? 'Update review' : 'Submit review'}</button>
        {mine && <button type="button" className="btn-text" disabled={busy} onClick={remove}>Delete my review</button>}
      </div>
    </form>
  );
}

// What buyers say, in brief. Hidden until there are enough reviews, or when the AI service is away.
function ReviewSummary({ productId }) {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    api.reviewSummary(productId).then(setSummary).catch(() => setSummary(null));
  }, [productId]);

  if (!summary?.ready) return null;
  return (
    <div className="review-ai">
      <h3>What buyers say</h3>
      <p>{summary.summary}</p>
      {summary.pros.length > 0 && <ul className="review-pros">{summary.pros.map((p) => <li key={p}><Icon name="check" size={13} /> {p}</li>)}</ul>}
      {summary.cons.length > 0 && <ul className="review-cons">{summary.cons.map((c) => <li key={c}><Icon name="x" size={13} /> {c}</li>)}</ul>}
      {summary.generated && <p className="muted small">Summarised by AI from verified reviews.</p>}
    </div>
  );
}

// Ratings and reviews on the product page. Only shoppers who received the product can write one.
export default function Reviews({ productId }) {
  const [data, setData] = useState(null);
  const [sort, setSort] = useState('recent');
  const [photosOnly, setPhotosOnly] = useState(false);
  const [viewing, setViewing] = useState(null); // a review photo shown large
  const load = useCallback(
    () => api.reviews(productId, { sort, ...(photosOnly ? { photos: 'true' } : {}) }).then(setData).catch(() => setData(null)),
    [productId, sort, photosOnly],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return null;
  const mine = data.items.find((r) => r.mine);

  return (
    <section className="reviews panel" aria-label="Ratings and reviews">
      <h2>Ratings &amp; Reviews</h2>
      {data.count > 0 ? (
        <div className="review-summary">
          <div className="review-score">
            <strong>{data.average}</strong>
            <Rating value={data.average} />
            <span className="muted small">{data.count} verified {data.count === 1 ? 'rating' : 'ratings'}</span>
          </div>
          <ul className="review-bars">
            {STARS.map((stars) => (
              <li key={stars}>
                <span>{stars} ★</span>
                <span className="review-bar"><span style={{ width: `${(data.histogram[stars] / data.count) * 100}%` }} /></span>
                <span className="muted small">{data.histogram[stars]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted">No reviews yet. Only shoppers who received this product can review it.</p>
      )}

      {data.count >= MIN_FOR_SUMMARY && <ReviewSummary productId={productId} />}

      {data.canReview && <ReviewForm key={mine?.id || 'new'} productId={productId} mine={mine} onSaved={load} />}

      {data.count > 1 && (
        <div className="review-tools">
          <label className="small">Sort by{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          {(data.withPhotos > 0 || photosOnly) && (
            <label className="small"><input type="checkbox" checked={photosOnly} onChange={(e) => setPhotosOnly(e.target.checked)} /> With photos ({data.withPhotos})</label>
          )}
        </div>
      )}

      <ul className="review-list">
        {data.items.map((r) => (
          <li key={r.id}>
            <Rating value={r.rating} size="sm" />
            {r.title && <strong> {r.title}</strong>}
            {r.mine && <span className="chip">Your review</span>}
            {r.body && <p>{r.body}</p>}
            {r.photos?.length > 0 && (
              <div className="review-photos">
                {r.photos.map((src) => (
                  <button key={src} type="button" className="review-photo" onClick={() => setViewing(src)} aria-label="View photo larger">
                    <img src={src} alt={`Photo from ${r.author}`} loading="lazy" />
                  </button>
                ))}
              </div>
            )}
            <p className="muted small">{r.author} · <Icon name="shield" size={11} /> Verified buyer · {formatDate(r.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}{r.edited ? ' · edited' : ''}</p>
          </li>
        ))}
      </ul>

      {viewing && (
        <div className="review-photo-view" role="dialog" aria-label="Review photo" onClick={() => setViewing(null)}>
          <img src={viewing} alt="Review photo" />
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setViewing(null)}><Icon name="x" size={14} /> Close</button>
        </div>
      )}
    </section>
  );
}
