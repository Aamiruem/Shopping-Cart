// Product options for the store API: sizes and colours, the same model as the full backend (backend/app/routers/cart.py,
// services/cart.py). A product lists `sizes` and `colors` (plain names); a colour may have a swatch (`colorHex`) and a
// photo of the product in that colour (`colorImages`, one of the product's own photos). A cart line is one product in
// one size and colour, and its id is "productId~size~colour" (just the product id for products without options).
import { ApiError } from './_auth.mjs';

const MAX_SIZES = 20; // the same limits as the full backend (backend/app/schemas/product.py)
const MAX_COLORS = 20;
const NAME_MAX = 20;
const HEX_RE = /^#[0-9a-f]{6}$/i;

const fail = (message, status = 400) => {
  throw new ApiError(status, message);
};
const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const names = (value, max, label) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} must be a list`);
  const out = [];
  for (const raw of value) {
    const v = clean(raw);
    if (!v) continue;
    if (v.length > NAME_MAX) fail(`${label}: "${v.slice(0, 30)}" is too long (up to ${NAME_MAX} characters)`);
    if (v.includes('~')) fail(`${label} can’t contain "~"`);
    if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > max) fail(`Up to ${max} ${label.toLowerCase()}`);
  return out;
};

/**
 * Sizes and colours from a seller's or the admin's form, checked. `images` are the product's photos: a colour's photo
 * must be one of them, so the picture shown for "Navy" is always a photo of this product.
 */
export function validateVariants(body, images = []) {
  const sizes = names(body.sizes, MAX_SIZES, 'Sizes');
  const colors = names(body.colors, MAX_COLORS, 'Colours');
  const colorHex = {};
  const colorImages = {};
  const hexIn = body.colorHex && typeof body.colorHex === 'object' ? body.colorHex : {};
  const imagesIn = body.colorImages && typeof body.colorImages === 'object' ? body.colorImages : {};
  for (const color of colors) {
    const hex = clean(Object.hasOwn(hexIn, color) ? hexIn[color] : '');
    if (hex) {
      if (!HEX_RE.test(hex)) fail(`The swatch for ${color} must be a colour code like #1f3a93`);
      colorHex[color] = hex.toLowerCase();
    }
    const image = clean(Object.hasOwn(imagesIn, color) ? imagesIn[color] : '');
    if (image) {
      if (!images.includes(image)) fail(`The photo for ${color} must be one of this product’s photos`);
      colorImages[color] = image;
    }
  }
  return { sizes, colors, colorHex, colorImages };
}

export const lineId = (productId, size = null, color = null) => [productId, size || '', color || ''].join('~').replace(/~+$/, '');

/** "id~M~Navy" -> { productId, size, color } (empty parts are null). */
export function parseLineId(key) {
  const [productId = '', size = '', color = ''] = String(key ?? '').split('~');
  return { productId, size: size || null, color: color || null };
}

/** The size and colour a shopper picked, checked against the product; same rules as the full backend. */
export function chooseOptions(product, { size, color } = {}) {
  let chosenSize = null;
  let chosenColor = null;
  if (product.sizes?.length) {
    const s = clean(size);
    if (!s) fail('Please select a size');
    chosenSize = product.sizes.find((x) => x.toLowerCase() === s.toLowerCase());
    if (!chosenSize) fail(`Size ${s} is not available`);
  }
  if (product.colors?.length) {
    const c = clean(color);
    if (c) {
      chosenColor = product.colors.find((x) => x.toLowerCase() === c.toLowerCase());
      if (!chosenColor) fail(`Colour ${c} is not available`);
    } else {
      chosenColor = product.colors[0]; // a product with one look needs no choice
    }
  }
  return { size: chosenSize, color: chosenColor };
}
