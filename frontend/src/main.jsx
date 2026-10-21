import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { CartProvider } from './context/CartContext';
import { ToastProvider } from './context/ToastContext';
import { WishlistProvider } from './context/WishlistContext';
import './styles/index.css';

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
