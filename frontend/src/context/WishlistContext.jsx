import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

const WishlistContext = createContext(null);

export function WishlistProvider({ children }) {
  const { user } = useAuth();
  const [items, setItems] = useState([]);

  const refresh = useCallback(async () => {
    if (!user) return setItems([]);
    try {
      setItems(await api.wishlist());
    } catch {
      setItems([]);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(() => {
    const ids = new Set(items.map((p) => p._id));
    return {
      items,
      count: items.length,
      has: (id) => ids.has(id),
      add: async (id) => setItems(await api.addToWishlist(id)),
      remove: async (id) => setItems(await api.removeFromWishlist(id)),
      refresh,
    };
  }, [items, refresh]);

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export const useWishlist = () => useContext(WishlistContext);
