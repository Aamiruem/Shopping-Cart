import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { SHOPPING } from '../config';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';

const EMPTY = { items: [], totalMrp: 0, discount: 0, subtotal: 0, deliveryFee: 0, total: 0 };
const CartContext = createContext(null);

// ---------- Guest cart ----------
// Visitors can fill a cart without an account. It lives only in this browser (product ids and quantities, nothing
// personal); prices, stock and availability always come fresh from the server, and the server checks everything again
// when the cart moves to the account at sign-in and at checkout. Orders exist only on the server.
const GUEST_KEY = 'arvixa:guest-cart';
const FREE_DELIVERY_ABOVE = 499; // same as api/_shop.mjs: the server's total is the one charged
const DELIVERY_FEE = 40;
const MAX_LINES = 50;
const lineIdOf = (productId, size, color) => [productId, size || '', color || ''].join('~').replace(/~+$/, '');

function readGuest() {
  try {
    const lines = JSON.parse(localStorage.getItem(GUEST_KEY) || '[]');
    return Array.isArray(lines) ? lines.filter((l) => l && typeof l.productId === 'string' && l.qty > 0).slice(0, MAX_LINES) : [];
  } catch {
    return [];
  }
}
function writeGuest(lines) {
  try {
    if (lines.length) localStorage.setItem(GUEST_KEY, JSON.stringify(lines));
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    /* storage blocked: the cart lasts for this page only */
  }
}

async function guestSummary(lines) {
  const products = await Promise.all(lines.map((l) => api.product(l.productId).catch(() => null)));
  const items = [];
  lines.forEach((l, i) => {
    const p = products[i];
    if (!p || p.purchasable === false || !(p.stock > 0)) return; // no longer on sale: dropped, like the server does
    const qty = Math.min(l.qty, 10, p.stock);
    items.push({
      lineId: lineIdOf(p._id, l.size, l.color), productId: p._id, size: l.size || null, color: l.color || null,
      name: p.name, brand: p.brand ?? '', image: (l.color && p.colorImages?.[l.color]) || p.image || null, category: p.category ?? null,
      price: p.price, mrp: p.price, stock: p.stock, qty, subtotal: p.price * qty,
    });
  });
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const deliveryFee = !items.length || subtotal >= FREE_DELIVERY_ABOVE ? 0 : DELIVERY_FEE;
  return { items, totalMrp: subtotal, discount: 0, subtotal, deliveryFee, coupon: null, couponDiscount: 0, total: subtotal + deliveryFee, guest: true };
}

export function CartProvider({ children }) {
  const { user, ready } = useAuth();
  const toast = useToast();
  const [cart, setCart] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const merging = useRef(false);

  const refresh = useCallback(async () => {
    if (!SHOPPING || !ready) return setCart(EMPTY);
    setLoading(true);
    try {
      setCart(user ? await api.cart() : await guestSummary(readGuest()));
    } catch {
      setCart(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [user, ready]);

  // Signing in moves the guest cart into the account; the server checks each line (anything not on sale is skipped)
  useEffect(() => {
    if (!user || merging.current) return;
    const lines = readGuest();
    if (!lines.length) return;
    merging.current = true;
    (async () => {
      let skipped = 0;
      for (const l of lines) {
        try {
          await api.addToCart(l.productId, l.qty, { size: l.size || undefined, color: l.color || undefined });
        } catch {
          skipped++;
        }
      }
      writeGuest([]);
      merging.current = false;
      if (skipped) toast.show(`${skipped} item${skipped === 1 ? ' is' : 's are'} no longer available and weren’t added to your cart`, 'info');
      refresh();
    })();
  }, [user, refresh, toast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const guestChange = useCallback(async (change) => {
    const lines = change(readGuest());
    writeGuest(lines);
    const summary = await guestSummary(lines);
    setCart(summary);
    return summary;
  }, []);

  const value = useMemo(() => ({
    cart,
    loading,
    guest: !user,
    count: cart.items.reduce((n, i) => n + i.qty, 0),
    has: (id) => cart.items.some((i) => String(i.productId) === String(id)),
    refresh,
    add: async (id, qty = 1, options = {}) => {
      if (user) return setCart(await api.addToCart(id, qty, options));
      const p = await api.product(id);
      if (p.purchasable === false || !(p.stock > 0)) throw new Error(p.availability === 'coming_soon' ? `${p.name} is coming soon and can’t be ordered yet` : `${p.name} isn’t available right now`);
      if (p.sizes?.length && !options.size) throw new Error('Please choose a size');
      return guestChange((lines) => {
        const same = lines.find((l) => l.productId === id && (l.size || '') === (options.size || '') && (l.color || '') === (options.color || ''));
        if (same) {
          same.qty = Math.min(same.qty + qty, 10, p.stock);
          return lines;
        }
        if (lines.length >= MAX_LINES) throw new Error('Your cart is full');
        return [...lines, { productId: id, qty: Math.min(qty, 10, p.stock), size: options.size || '', color: options.color || '' }];
      });
    },
    // update / remove take the line's lineId: one product can be in the cart in several sizes and colours
    update: async (lineId, qty) => {
      if (user) return setCart(await api.updateCart(lineId, qty));
      return guestChange((lines) => lines.map((l) => (lineIdOf(l.productId, l.size, l.color) === lineId ? { ...l, qty } : l)).filter((l) => l.qty > 0));
    },
    remove: async (lineId) => {
      if (user) return setCart(await api.removeFromCart(lineId));
      return guestChange((lines) => lines.filter((l) => lineIdOf(l.productId, l.size, l.color) !== lineId));
    },
    applyCoupon: async (code) => {
      if (!user) throw new Error('Please sign in to use a coupon');
      return setCart(await api.applyCoupon(code));
    },
    removeCoupon: async () => user && setCart(await api.removeCoupon()),
  }), [cart, loading, refresh, user, guestChange]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
