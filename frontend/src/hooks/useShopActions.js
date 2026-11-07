import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { useWishlist } from '../context/WishlistContext';
import { OPENING_SOON_MESSAGE, PREVIEW } from '../config';
import { trackAddToCart, trackWishlist } from '../utils/analytics';
import { playSound } from '../utils/sound';

// Cart / wishlist actions with the same UX everywhere: send guests to login
// (and back again afterwards), then confirm with a toast and a sound.
export default function useShopActions() {
  const { user } = useAuth();
  const cart = useCart();
  const wishlist = useWishlist();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const requireLogin = () => {
    if (PREVIEW) {
      toast.show(OPENING_SOON_MESSAGE, 'info');
      return false;
    }
    if (user) return true;
    toast.show('Please log in to continue', 'info');
    navigate('/login', { state: { from: location } });
    return false;
  };

  const run = async (action, successMessage, sound) => {
    try {
      await action();
      playSound(sound);
      if (successMessage) toast.show(successMessage);
      return true;
    } catch (err) {
      playSound('error');
      toast.show(err.message, 'error');
      return false;
    }
  };

  return {
    addToCart: (product, qty = 1) =>
      requireLogin() && run(async () => {
        await cart.add(product._id, qty);
        trackAddToCart(product, qty);
      }, `${product.name} added to cart`, 'add'),

    buyNow: async (product) => {
      if (!requireLogin()) return;
      const ok = cart.has(product._id) || (await run(async () => {
        await cart.add(product._id, 1);
        trackAddToCart(product);
      }, null, 'add'));
      if (ok) navigate('/checkout');
    },

    toggleWishlist: (product) => {
      if (!requireLogin()) return;
      return wishlist.has(product._id)
        ? run(() => wishlist.remove(product._id), 'Removed from wishlist', 'click')
        : run(async () => {
          await wishlist.add(product._id);
          trackWishlist(product);
        }, 'Added to wishlist', 'wishlist');
    },

    // Cart page "Save for later": wishlist it, then drop it from the cart
    saveForLater: (item) =>
      run(async () => {
        await wishlist.add(item.productId);
        await cart.remove(item.productId);
      }, `${item.name} moved to wishlist`, 'wishlist'),
  };
}
