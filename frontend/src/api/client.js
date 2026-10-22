const BASE = import.meta.env.VITE_API_URL || '';
export const TOKEN_KEY = 'token';

// Fired when the server rejects our token so AuthContext can sign the user out
export const AUTH_EXPIRED_EVENT = 'auth:expired';

async function request(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server. Make sure it is running, then reload the page (Ctrl+F5) and try again.');
  }

  const text = res.status === 204 ? '' : await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(res.ok ? 'The server returned an unreadable response.' : `Request failed (${res.status}).`);
    }
  }

  // The dev proxy / nginx answer 500-504 with no JSON body when the API itself is down
  if (!data && res.status >= 500) {
    throw new Error('Our server is not responding right now. Please make sure the backend is running and try again.');
  }

  if (res.status === 401 && token) {
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  if (!res.ok) throw new Error(data?.error || data?.detail || `Request failed (${res.status}).`);
  return data;
}

// multipart/form-data upload (the browser sets the boundary header itself)
async function upload(path, file) {
  const token = localStorage.getItem(TOKEN_KEY);
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status}).`);
  return data;
}

// Downloads a file from an authenticated endpoint (e.g. CSV exports)
export async function downloadFile(url, filename) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Download failed (${res.status}).`);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await res.blob());
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

const query = (params) => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  return new URLSearchParams(clean).toString();
};

export const api = {
  // Auth
  authConfig: () => request('/auth/config'),
  register: (body) => request('/auth/register', { method: 'POST', body }), // emails a code; no account yet
  verifySignup: (body) => request('/auth/register/verify', { method: 'POST', body }),
  resendSignup: (email) => request('/auth/register/resend', { method: 'POST', body: { email } }),
  phoneOtp: (phone, channel) => request('/auth/phone/otp', { method: 'POST', body: { phone, channel } }),
  phoneVerify: (phone, code) => request('/auth/phone/verify', { method: 'POST', body: { phone, code } }),
  login: (body) => request('/auth/login', { method: 'POST', body }),
  googleLogin: (credential) => request('/auth/google', { method: 'POST', body: { credential } }),
  me: () => request('/auth/me'),
  updateProfile: (body) => request('/auth/me', { method: 'PUT', body }),
  changePassword: (body) => request('/auth/password', { method: 'PUT', body }),

  // Catalog
  products: (params = {}) => request(`/products?${query(params)}`),
  product: (id) => request(`/products/${id}`),
  categories: () => request('/products/categories'),
  subcategories: (category) => request(`/products/subcategories?category=${category}`),
  facets: (params = {}) => request(`/products/facets?${query(params)}`),

  // Cart
  cart: () => request('/cart'),
  addToCart: (productId, qty = 1) => request('/cart', { method: 'POST', body: { productId, qty } }),
  updateCart: (productId, qty) => request(`/cart/${productId}`, { method: 'PUT', body: { qty } }),
  removeFromCart: (productId) => request(`/cart/${productId}`, { method: 'DELETE' }),

  // Wishlist
  wishlist: () => request('/wishlist'),
  addToWishlist: (productId) => request(`/wishlist/${productId}`, { method: 'POST' }),
  removeFromWishlist: (productId) => request(`/wishlist/${productId}`, { method: 'DELETE' }),

  // Addresses
  addresses: () => request('/addresses'),
  addAddress: (body) => request('/addresses', { method: 'POST', body }),
  removeAddress: (id) => request(`/addresses/${id}`, { method: 'DELETE' }),

  // Orders
  requestPaymentOtp: () => request('/orders/otp', { method: 'POST' }),
  checkout: (body) => request('/orders', { method: 'POST', body }),
  orders: () => request('/orders'),
  order: (id) => request(`/orders/${id}`),
  cancelOrder: (id) => request(`/orders/${id}/cancel`, { method: 'PATCH' }),

  // Online payments (Razorpay: UPI, net banking, cards, wallets)
  paymentsConfig: () => request('/payments/config'),
  startPayment: (body) => request('/payments/razorpay/order', { method: 'POST', body }),
  verifyPayment: (body) => request('/payments/razorpay/verify', { method: 'POST', body }),
  myPayments: () => request('/payments/mine'),

  // Seller hub
  becomeSeller: (body) => request('/seller/register', { method: 'POST', body }),
  sellerProfile: () => request('/seller/profile'),
  sellerProducts: (params = {}) => request(`/seller/products?${query(params)}`),
  sellerCreateProduct: (body) => request('/seller/products', { method: 'POST', body }),
  sellerUpdateProduct: (id, body) => request(`/seller/products/${id}`, { method: 'PUT', body }),
  sellerPatchProduct: (id, body) => request(`/seller/products/${id}`, { method: 'PATCH', body }),
  sellerDeleteProduct: (id) => request(`/seller/products/${id}`, { method: 'DELETE' }),
  sellerOrders: (params = {}) => request(`/seller/orders?${query(params)}`),
  sellerUpdateFulfilment: (orderId, fulfilment) => request(`/seller/orders/${orderId}`, { method: 'PATCH', body: { fulfilment } }),
  sellerUpdateProfile: (body) => request('/seller/profile', { method: 'PUT', body }),
  sellerPayoutOtp: () => request('/seller/profile/otp', { method: 'POST' }),
  sellerBulk: (ids, action, extra = {}) => request('/seller/products/bulk', { method: 'POST', body: { ids, action, ...extra } }),
  sellerDuplicateProduct: (id) => request(`/seller/products/${id}/duplicate`, { method: 'POST' }),
  sellerEarnings: () => request('/seller/earnings'),
  uploadImage: (file) => upload('/seller/uploads?kind=image', file),
  uploadMedia: (file, kind) => upload(`/seller/uploads?kind=${kind}`, file),
  aiListing: (body) => request('/ai/listing', { method: 'POST', body }),

  // Analytics & ML (sellers see their own store; admins can pass sellerId)
  analyticsSellers: () => request('/analytics/sellers'),
  analyticsOverview: (params) => request(`/analytics/overview?${query(params)}`),
  analyticsForecast: (params) => request(`/analytics/forecast?${query(params)}`),
  analyticsBestsellers: (params) => request(`/analytics/bestsellers?${query(params)}`),
  analyticsGrowth: (params) => request(`/analytics/growth?${query(params)}`),
  analyticsCustomers: (params) => request(`/analytics/customers?${query(params)}`),
  analyticsSupport: () => request('/analytics/support'),
  analyticsRetrain: () => request('/analytics/retrain', { method: 'POST' }),
  exportUrl: (params) => `${BASE}/api/analytics/export?${query(params)}`,

  // Personalised recommendations
  forYou: () => request('/recommendations/for-you'),
  together: (productId) => request(`/recommendations/together/${productId}`),

  // Support
  createTicket: (body) => request('/support/tickets', { method: 'POST', body }),
  tickets: (params = {}) => request(`/support/tickets?${query(params)}`),
  updateTicket: (id, status) => request(`/support/tickets/${id}`, { method: 'PATCH', body: { status } }),

  // AI service (proxied by the backend)
  recommend: (productId) => request(`/ai/recommend/${productId}`),
  ask: (question) => request('/ai/ask', { method: 'POST', body: { question } }),
  agent: (messages) => request('/ai/agent', { method: 'POST', body: { messages } }),
};
