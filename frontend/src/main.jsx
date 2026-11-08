import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { CartProvider } from './context/CartContext';
import { ToastProvider } from './context/ToastContext';
import { WishlistProvider } from './context/WishlistContext';
import './styles/index.css';
import './utils/install'; // catches the browser's install prompt before React starts

// After a deploy, a tab opened earlier still asks for the old build's code files, which are gone: reload once to get the
// new build instead of leaving the shopper on a stuck page. The flag stops a reload loop if something else is wrong.
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (sessionStorage.getItem('arvixa:reloaded-for-update')) return;
    sessionStorage.setItem('arvixa:reloaded-for-update', '1');
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});
window.addEventListener('load', () => {
  setTimeout(() => {
    try {
      sessionStorage.removeItem('arvixa:reloaded-for-update');
    } catch { /* ignore */ }
  }, 10000);
});

// If a product image fails to load (e.g. a CDN hiccup), show a neutral placeholder instead of a broken icon
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && !img.dataset.fallback) {
    img.dataset.fallback = '1';
    img.src = '/placeholder.svg';
  }
}, true);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <CartProvider>
            <WishlistProvider>
              <App />
            </WishlistProvider>
          </CartProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
