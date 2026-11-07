import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { formatDate } from '../../utils/format';
import Icon from '../common/Icon';
import Rating from '../common/Rating';

const STARS = [5, 4, 3, 2, 1];
const MIN_FOR_SUMMARY = 3;

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

function ReviewForm({ productId, mine, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ rating: mine?.rating || 0, title: mine?.title || '', body: mine?.body || '' });
  const [busy, setBusy] = useState(false);
  const set = (e) => setForm({ ...form, [e.target.name]: e.target.value });

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
      <label className="field">Your review<textarea name="body" value={form.body} onChange={set} maxLength={2000} rows={3} /></label>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Submit'}</button>
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
  const load = useCallback(() => api.reviews(productId).then(setData).catch(() => setData(null)), [productId]);
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

      <ul className="review-list">
        {data.items.map((r) => (
          <li key={r.id}>
            <Rating value={r.rating} size="sm" />
            {r.title && <strong> {r.title}</strong>}
            {r.body && <p>{r.body}</p>}
            <p className="muted small">{r.author} · <Icon name="shield" size={11} /> Verified buyer · {formatDate(r.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
