// Ratings and reviews on the Vercel store: the same product_reviews table and response shape as
// backend/app/routers/reviews.py, plus up to 3 photos per review.
//
//   GET    /products/:id/reviews        public; with a login it also says whether you can review and which is yours
//   POST   /products/:id/reviews        rating 1-5, title, body, photos: creates or replaces your review
//   DELETE /products/:id/reviews/mine   removes your review
//
// Only shoppers whose order for the product was delivered can review it, so every review is from a verified buyer.
// Averages feed the catalog (api/_inventory.mjs), so listings show real ratings.
import { ApiError, currentUserId, limit, postgresStore, query, safely } from './_auth.mjs';
import { getProduct } from './_catalog.mjs';
import { syncCatalogState } from './_inventory.mjs';

const PAGE_SIZE = 20;
const MAX_PHOTOS = 3;
// Photos must be ones this store uploaded (api/seller-upload.mjs, kind=review)
const PHOTO_RE = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/reviews\/[\w./-]+$/i;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const fail = (message, status = 400) => {
  throw new ApiError(status, message);
};

/** First name and last initial: enough to feel real, without publishing a shopper's full name. */
export function publicName(fullName = '') {
  const parts = String(fullName).split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Shopper';
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : parts[0];
}

/** True once the shopper has received this product. */
export async function hasReceived(db, userId, productId) {
  const [row] = await db(
    `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.user_id = $1 AND oi.product_id = $2 AND oi.fulfilment = 'delivered' AND o.status IN ('placed', 'returned') LIMIT 1`,
    [userId, productId],
  );
  return Boolean(row);
}

async function summary(db, productId) {
  const grouped = await db('SELECT rating, COUNT(*)::int AS n FROM product_reviews WHERE product_id = $1 GROUP BY rating', [productId]);
  const histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  grouped.forEach((r) => {
    histogram[r.rating] = r.n;
  });
  const count = Object.values(histogram).reduce((a, b) => a + b, 0);
  const average = count ? Math.round((Object.entries(histogram).reduce((s, [stars, n]) => s + stars * n, 0) / count) * 10) / 10 : 0;
  return { average, count, histogram };
}

function optionalUser(authorization) {
  if (!authorization) return null;
  try {
    return currentUserId(authorization);
  } catch {
    return null; // an expired login still sees the reviews
  }
}

async function listReviews({ db, productId, authorization, params }) {
  const userId = optionalUser(authorization);
  const page = Math.max(1, Math.trunc(Number(params.page)) || 1);
  const sort = params.sort === 'helpful' ? 'r.rating DESC, length(r.body) DESC' : params.sort === 'critical' ? 'r.rating ASC, r.created_at DESC' : 'r.created_at DESC';
  const withPhotos = params.photos === 'true' ? "AND jsonb_array_length(r.photos) > 0" : '';
  const rows = await db(
    `SELECT r.id, r.rating, r.title, r.body, r.photos, r.created_at, r.updated_at, r.user_id, u.name
       FROM product_reviews r JOIN users u ON u.id = r.user_id
      WHERE r.product_id = $1 ${withPhotos}
      ORDER BY ${sort} LIMIT $2 OFFSET $3`,
    [productId, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );
  const items = rows.map((r) => ({
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    photos: r.photos || [],
    author: publicName(r.name),
    createdAt: r.created_at,
    edited: new Date(r.updated_at) - new Date(r.created_at) > 60_000,
    mine: userId !== null && r.user_id === userId,
  }));
  // Your own review is always on the first page, so you can edit it
  if (userId && page === 1 && !items.some((r) => r.mine)) {
    const [own] = await db('SELECT r.*, u.name FROM product_reviews r JOIN users u ON u.id = r.user_id WHERE r.product_id = $1 AND r.user_id = $2', [productId, userId]);
    if (own) items.unshift({ id: own.id, rating: own.rating, title: own.title, body: own.body, photos: own.photos || [], author: publicName(own.name), createdAt: own.created_at, edited: false, mine: true });
  }
  const [{ photos }] = await db("SELECT COUNT(*)::int AS photos FROM product_reviews WHERE product_id = $1 AND jsonb_array_length(photos) > 0", [productId]);
  return {
    body: {
      ...(await summary(db, productId)),
      items,
      withPhotos: photos,
      page,
      canReview: userId !== null && (await hasReceived(db, userId, productId)),
    },
  };
}

async function saveReview({ db, productId, authorization, body, store }) {
  const userId = currentUserId(authorization);
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail('Please choose a star rating from 1 to 5');
  const title = text(body.title).slice(0, 120);
  const words = text(body.body);
  if (words.length > 2000) fail('Reviews can be up to 2,000 characters');
  const photos = Array.isArray(body.photos) ? body.photos.map(text).filter(Boolean) : [];
  if (photos.length > MAX_PHOTOS) fail(`Add up to ${MAX_PHOTOS} photos`);
  if (photos.some((url) => !PHOTO_RE.test(url))) fail('Please upload photos with the “Add photos” button');
  if (!(await hasReceived(db, userId, productId))) fail('You can review a product once it has been delivered to you', 403);
  await limit(store, `review:${userId}`, 20, 'Too many reviews just now. Please try again later.');
  const [saved] = await db(
    `INSERT INTO product_reviews (product_id, user_id, rating, title, body, photos) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (product_id, user_id) DO UPDATE
       SET rating = EXCLUDED.rating, title = EXCLUDED.title, body = EXCLUDED.body, photos = EXCLUDED.photos, updated_at = NOW()
     RETURNING id, rating, title, body, photos`,
    [productId, userId, rating, title, words, JSON.stringify(photos)],
  );
  await syncCatalogState(db, Date.now(), true); // the new average shows on this instance straight away
  return { status: 201, body: saved };
}

async function deleteReview({ db, productId, authorization }) {
  const userId = currentUserId(authorization);
  await db('DELETE FROM product_reviews WHERE product_id = $1 AND user_id = $2', [productId, userId]);
  await syncCatalogState(db, Date.now(), true);
  return { status: 204, body: null };
}

const ROUTES = { GET: listReviews, POST: saveReview, 'DELETE mine': deleteReview };

/** rest: [productId, 'reviews'] or [productId, 'reviews', 'mine'] */
export function isReviewRoute(method, rest) {
  const [productId, area, mine, ...extra] = rest;
  if (area !== 'reviews' || extra.length || !productId) return false;
  return Object.hasOwn(ROUTES, mine ? `${method} ${mine}` : method);
}

export function handleReviews({ method, rest, body, params = {}, authorization }, { db = query } = {}) {
  return safely(async () => {
    const [productId, , mine] = rest;
    // Reviews only for products the store sells (a hidden product keeps its reviews but takes no new ones)
    if (method === 'POST' && !getProduct(productId)) fail('Product not found', 404);
    if (!/^[0-9a-f]{24}$/.test(productId)) fail('Product not found', 404);
    return ROUTES[mine ? `${method} ${mine}` : method]({ db, productId, authorization, body: body ?? {}, params, store: postgresStore(db) });
  });
}
