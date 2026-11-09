// POST /api/seller/uploads?kind=image: a product or logo photo from the Seller Hub, saved to Vercel Blob.
// POST /api/uploads?kind=review: a shopper's photo for a review of something delivered to them.
// A web-standard handler so the browser's multipart form can be read directly. Vercel functions accept bodies up to
// 4.5 MB, so photos are capped at 4 MB; videos and audio need the full backend (S3) for now.
import { put } from '@vercel/blob';
import { ApiError, currentUserId, limit, postgresStore, query, safely } from './_auth.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
};

/** Checks and stores one uploaded photo. `store` saves the bytes and returns a public URL (Vercel Blob in production). */
export async function handleUpload({ authorization, kind, file }, { db = query, store = blobStore } = {}) {
  return safely(async () => {
    const userId = currentUserId(authorization);
    const [user] = await db('SELECT role FROM users WHERE id = $1', [userId]);
    if (!user) throw new ApiError(401, 'Please log in again');
    const review = kind === 'review';
    if (review) {
      // Only buyers with a delivered order can add review photos, so the photo store can't be used as free hosting
      const [delivered] = await db(
        "SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = $1 AND oi.fulfilment = 'delivered' LIMIT 1",
        [userId],
      );
      if (!delivered) throw new ApiError(403, 'You can add photos to a review once your order has been delivered');
      await limit(postgresStore(db), `review-photo:${userId}`, 15, 'Too many photos just now. Please try again in 15 minutes.');
    } else {
      if (!['seller', 'admin'].includes(user.role)) throw new ApiError(403, 'Seller account required');
      if (kind !== 'image') throw new ApiError(400, 'Videos and audio clips can’t be uploaded here yet. Please add photos.');
    }
    if (!file || typeof file.arrayBuffer !== 'function') throw new ApiError(400, 'Choose a photo to upload');
    if (file.size > MAX_BYTES) throw new ApiError(413, 'Photos can be up to 4 MB. Please choose a smaller one.');
    const bytes = Buffer.from(await file.arrayBuffer());
    const type = IMAGE_TYPES[file.type];
    // The bytes must really be the image type claimed, not just the label
    if (!type || !type.magic(bytes)) throw new ApiError(400, 'Please upload a JPEG, PNG or WebP photo');
    const url = await store(`${review ? 'reviews' : 'products'}/${userId}/photo.${type.ext}`, bytes, file.type);
    return { status: 201, body: { url, kind: 'image', quality: null } };
  });
}

async function blobStore(pathname, bytes, contentType) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new ApiError(503, 'Photo uploads aren’t set up yet. Please try again later.');
  const blob = await put(pathname, bytes, { access: 'public', contentType, addRandomSuffix: true });
  return blob.url;
}

export async function POST(request) {
  const kind = new URL(request.url).searchParams.get('kind') || 'image';
  let file = null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    file = null;
  }
  const { status, body } = await handleUpload({ authorization: request.headers.get('authorization') || '', kind, file });
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
