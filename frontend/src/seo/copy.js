// SEO wording and URLs, shared by the browser (useSeo) and the build (scripts/prerender.mjs) so a page keeps exactly
// the same title and description before and after React loads. Plain JavaScript only: Node imports this file too.

export const SITE_NAME = 'Arvixa Store';
export const SLOGAN = 'Shop Beyond Limits';
export const HOME_TITLE = `${SITE_NAME} — Online Shopping in India: Mobiles, Fashion, Grocery & More`;
export const LOGO_PATH = '/brand/arvixa-mark-512.png';
export const SHARE_IMAGE_PATH = '/brand/arvixa-share.png';

export const homeDescription = (preview) =>
  preview
    ? `${SITE_NAME} is an online marketplace for India, opening soon. Browse mobiles, electronics, fashion for women and men, groceries, beauty, home and kitchen products.`
    : `Shop online at ${SITE_NAME}: mobiles, electronics, fashion for women and men, groceries, beauty, home and kitchen. Best prices, free delivery over ₹499, UPI, cards and cash on delivery.`;

export const slugify = (text = '') =>
  text.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80);

export const productPath = (p) => `/products/${p._id || p.id}/${slugify(p.name)}`;

const unitOf = (p) => (p.unit ? ` (${p.unit})` : '');

export const productTitle = (p, preview) =>
  preview
    ? `${p.name}${unitOf(p)}${p.brand ? ` by ${p.brand}` : ''}`
    : `${p.name}${unitOf(p)} - Buy online at ₹${Math.round(p.price)}`;

export function productDescription(p, preview) {
  const summary = (p.description || '').slice(0, preview ? 130 : 110);
  const brand = p.brand || SITE_NAME;
  if (preview) return `${p.name} by ${brand}. ${summary}`.trim();
  const saving = p.discount ? ` (${p.discount}% off)` : '';
  return `${p.name} by ${brand} at ₹${Math.round(p.price)}${saving}. ${summary} Free delivery over ₹499, easy returns.`;
}

export const listingTitle = (heading, preview) => (preview ? `${heading} Online in India` : `${heading} - Buy ${heading} online at best prices`);

export const listingDescription = (label, count, preview) =>
  preview
    ? `Browse ${label} on ${SITE_NAME}, an online marketplace for India opening soon. ${count || 'Hundreds of'} products from top brands.`
    : `Shop ${label} online at ${SITE_NAME}. ${count || 'Hundreds of'} products with top brands, great discounts, free delivery over ₹499 and easy returns.`;

export const ABOUT_DESCRIPTION = `About ${SITE_NAME}, an online marketplace for shoppers and sellers in India.`;
export const PRIVACY_DESCRIPTION = `How ${SITE_NAME} collects, uses and protects your information, including analytics cookies.`;

// One line of unique text per category for the prerendered pages, so they aren't just lists of links
export const CATEGORY_INTROS = {
  mobiles: 'Compare smartphones and mobile phones across popular brands, from everyday handsets to flagship models.',
  electronics: 'Laptops, tablets, audio, cameras, smart gadgets and accessories for home and work.',
  fashion: 'Clothing and footwear for women and men, with sizes, colours and 360° views on selected styles.',
  accessories: 'Watches, bags, sunglasses and everyday accessories to finish any outfit.',
  beauty: 'Skincare, make-up, fragrance and personal care for your daily routine.',
  home: 'Furniture, decor and home essentials for every room.',
  kitchen: 'Cookware, appliances and kitchen tools for Indian and everyday cooking.',
  sports: 'Fitness, outdoor and sports gear for training at home or on the field.',
  grocery: 'Fruits and vegetables, dairy, staples, snacks and household essentials in one place.',
};
