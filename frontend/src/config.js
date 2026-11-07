// Build-time store settings (see frontend/.env.example)

// VITE_STORE_MODE:
//   preview  browse only, no accounts or ordering
//   store    accounts, cart, wishlist and cash-on-delivery orders on the small API in api/
//   live     everything on: needs the full API with its databases and a real catalog
const MODE = import.meta.env.VITE_STORE_MODE;
// People can sign in and order
export const SHOPPING = MODE !== 'preview';
// The catalog is sample data and there's no full API: ratings, discounts and offers stay hidden because nothing backs
// them yet, and so do the features only the full API has
export const PREVIEW = MODE === 'preview' || MODE === 'store';

// Public address for canonical links, set at build time (vite.config.js). Falls back to the current origin locally.
export const SITE_URL = (import.meta.env.VITE_SITE_URL || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '');

// Real support address, shown in the footer and legal pages. Hidden until set.
export const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || '';

export const OPENING_SOON_MESSAGE = 'Arvixa Store is opening soon. Ordering isn’t available yet.';
