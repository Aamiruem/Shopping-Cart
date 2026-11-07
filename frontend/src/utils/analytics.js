// Google Analytics 4 with Consent Mode. Does nothing until VITE_GA_MEASUREMENT_ID (G-XXXXXXXXXX) is set at build time.
// Analytics storage stays denied (no cookies) until the visitor accepts in the consent banner.

const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID || '';
const CONSENT_KEY = 'analytics-consent';
const CURRENCY = 'INR';

export const analyticsEnabled = /^G-[A-Z0-9]+$/.test(MEASUREMENT_ID);

function readChoice() {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null; // storage blocked (private window, strict browser settings)
  }
}

export const needsConsent = () => analyticsEnabled && !readChoice();

function gtag() {
  // gtag.js only understands the real `arguments` object, not an array
  window.dataLayer.push(arguments);
}

let started = false;

export function initAnalytics() {
  if (!analyticsEnabled || started) return;
  started = true;
  window.dataLayer = window.dataLayer || [];
  const granted = readChoice() === 'granted' ? 'granted' : 'denied';
  gtag('consent', 'default', { analytics_storage: granted, ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID, { send_page_view: false }); // pages are sent by pageView(), including React route changes
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(script);
}

export function setConsent(granted) {
  try {
    localStorage.setItem(CONSENT_KEY, granted ? 'granted' : 'denied');
  } catch {
    /* the choice just won't be remembered */
  }
  if (started) gtag('consent', 'update', { analytics_storage: granted ? 'granted' : 'denied' });
}

function track(name, params) {
  if (started) gtag('event', name, params);
}

const toItem = (p, qty = 1) => ({
  item_id: String(p._id || p.productId || p.id),
  item_name: p.name,
  item_brand: p.brand,
  item_category: p.category,
  price: Number(p.price),
  quantity: qty,
});

export const pageView = (path) => track('page_view', { page_location: window.location.href, page_path: path, page_title: document.title });
export const trackSearch = (term) => track('search', { search_term: term });
export const trackViewItem = (p) => track('view_item', { currency: CURRENCY, value: Number(p.price), items: [toItem(p)] });
export const trackViewList = (name, products) =>
  track('view_item_list', { item_list_name: name, items: products.slice(0, 20).map((p) => toItem(p)) });
export const trackAddToCart = (p, qty = 1) => track('add_to_cart', { currency: CURRENCY, value: Number(p.price) * qty, items: [toItem(p, qty)] });
export const trackWishlist = (p) => track('add_to_wishlist', { currency: CURRENCY, value: Number(p.price), items: [toItem(p)] });
export const trackBeginCheckout = (cart) =>
  track('begin_checkout', { currency: CURRENCY, value: cart.total, items: cart.items.map((i) => toItem(i, i.qty)) });
export const trackPurchase = (orderId, cart) =>
  track('purchase', {
    transaction_id: String(orderId),
    currency: CURRENCY,
    value: cart.total,
    shipping: cart.deliveryFee,
    items: cart.items.map((i) => toItem(i, i.qty)),
  });
export const trackLogin = (method) => track('login', { method });
export const trackSignUp = (method) => track('sign_up', { method });
