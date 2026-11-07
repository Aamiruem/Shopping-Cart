// Build-time store settings (see frontend/.env.example)

// Preview mode: the catalog is browsable but accounts, cart and checkout are off, and prices are samples. It's on
// until the store has its databases and a real catalog; set VITE_STORE_MODE=live to switch everything back on.
export const PREVIEW = import.meta.env.VITE_STORE_MODE === 'preview';

// Public address for canonical links, set at build time (vite.config.js). Falls back to the current origin locally.
export const SITE_URL = (import.meta.env.VITE_SITE_URL || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '');

// Real support address, shown in the footer and legal pages. Hidden until set.
export const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || '';

export const OPENING_SOON_MESSAGE = 'Arvixa Store is opening soon. Ordering isn’t available yet.';
