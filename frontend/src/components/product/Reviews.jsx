import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { formatDate } from '../../utils/format';
import Icon from '../common/Icon';

// The five levels, best first, each with its bar colour
const LEVELS = [
  { stars: 5, label: 'Excellent', tone: 'excellent' },
  { stars: 4, label: 'Very Good', tone: 'very-good' },
  { stars: 3, label: 'Good', tone: 'good' },
  { stars: 2, label: 'Average', tone: 'average' },
  { stars: 1, label: 'Poor', tone: 'poor' },
];
const toneOf = (rating) => (rating >= 4 ? 'excellent' : rating >= 3 ? 'good' : rating >= 2 ? 'average' : 'poor');
const count = (n, one, many) => `${Number(n).toLocaleString('en-IN')} ${n === 1 ? one : many}`;

// "4.2 ★" on a green, yellow, orange or red pill
function ScoreBadge({ value }) {
  return (
    <span className={`score-badge tone-${toneOf(value)}`} aria-label={`${value} out of 5 stars`}>
      {Number(value).toFixed(1)} <Icon name="star" size={13} filled strokeWidth={0} />
    </span>
  );
}
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
      <h2>Product Ratings &amp; Reviews</h2>
      <div className={`review-summary ${data.count ? '' : 'empty'}`}>
        <div className="review-score">
          {data.count > 0 ? (
            <>
              <strong className={`big-score tone-${toneOf(data.average)}`}>{Number(data.average).toFixed(1)} <Icon name="star" size={30} filled strokeWidth={0} /></strong>
              <span className="muted small">{count(data.count, 'Rating', 'Ratings')},<br />{count(data.written ?? data.count, 'Review', 'Reviews')}</span>
            </>
          ) : (
            <>
              <strong className="big-score muted">– <Icon name="star" size={30} filled strokeWidth={0} /></strong>
              <span className="muted small">No ratings yet</span>
            </>
          )}
        </div>
        <ul className="review-bars">
          {LEVELS.map(({ stars, label, tone }) => (
            <li key={stars}>
              <span className="level">{label}</span>
              <span className="review-bar"><span className={`tone-${tone}`} style={{ width: `${data.count ? (data.histogram[stars] / data.count) * 100 : 0}%` }} /></span>
              <span className="muted small">{Number(data.histogram[stars] || 0).toLocaleString('en-IN')}</span>
            </li>
          ))}
        </ul>
      </div>
      {!data.count && <p className="muted small">Be the first to rate it. Only customers who received this product can review it, so every rating here is from a real buyer.</p>}

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
            <p className="reviewer">
              <span className="reviewer-avatar" aria-hidden="true"><Icon name="user" size={16} /></span>
              <span className="reviewer-name">{r.author}</span>
              {r.mine && <span className="chip">Your review</span>}
            </p>
            <p className="review-meta">
              <ScoreBadge value={r.rating} />
              <span className="muted small">• Posted on {formatDate(r.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}{r.edited ? ' · edited' : ''}</span>
              <span className="verified small"><Icon name="shield" size={12} /> Verified buyer</span>
            </p>
            {r.title && <strong className="review-title">{r.title}</strong>}
            {r.body && <p className="review-body">{r.body}</p>}
            {r.photos?.length > 0 && (
              <div className="review-photos">
                {r.photos.map((src) => (
                  <button key={src} type="button" className="review-photo" onClick={() => setViewing(src)} aria-label="View photo larger">
                    <img src={src} alt={`Photo from ${r.author}`} loading="lazy" />
                  </button>
                ))}
              </div>
            )}
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
