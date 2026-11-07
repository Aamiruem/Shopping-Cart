// Build-time store settings (see frontend/.env.example)

// VITE_STORE_MODE:
//   preview   browse only: accounts, cart and checkout are off, and prices are samples
//   accounts  preview plus real sign-up, login and profile, on the small API in api/ (cart and checkout stay off)
//   live      everything on: needs the full API with its databases and a real catalog
const MODE = import.meta.env.VITE_STORE_MODE;
export const PREVIEW = MODE === 'preview' || MODE === 'accounts'; // ordering is off, sample claims are hidden
export const ACCOUNTS = MODE !== 'preview';

// Public address for canonical links, set at build time (vite.config.js). Falls back to the current origin locally.
export const SITE_URL = (import.meta.env.VITE_SITE_URL || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '');

// Real support address, shown in the footer and legal pages. Hidden until set.
export const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || '';

export const OPENING_SOON_MESSAGE = 'Arvixa Store is opening soon. Ordering isn’t available yet.';
