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

// The business behind the store, shown in the Terms and policy pages. India's Consumer Protection (E-Commerce)
// Rules 2020 and payment gateways such as Razorpay require these before selling: set them in Vercel, then redeploy.
export const LEGAL = {
  name: import.meta.env.VITE_LEGAL_NAME || '',
  address: import.meta.env.VITE_LEGAL_ADDRESS || '',
  phone: import.meta.env.VITE_CONTACT_PHONE || '',
  grievanceOfficer: import.meta.env.VITE_GRIEVANCE_OFFICER || '',
};

export const OPENING_SOON_MESSAGE = 'Arvixa Store is opening soon. Ordering isn’t available yet.';
