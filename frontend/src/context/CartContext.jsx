import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

const EMPTY = { items: [], totalMrp: 0, discount: 0, subtotal: 0, deliveryFee: 0, total: 0 };
const CartContext = createContext(null);

export function CartProvider({ children }) {
  const { user } = useAuth();
  const [cart, setCart] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return setCart(EMPTY);
    setLoading(true);
    try {
      setCart(await api.cart());
    } catch {
      setCart(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(() => ({
    cart,
    loading,
    count: cart.items.reduce((n, i) => n + i.qty, 0),
    has: (id) => cart.items.some((i) => String(i.productId) === String(id)),
    refresh,
    add: async (id, qty = 1) => setCart(await api.addToCart(id, qty)),
    update: async (id, qty) => setCart(await api.updateCart(id, qty)),
    remove: async (id) => setCart(await api.removeFromCart(id)),
  }), [cart, loading, refresh]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
