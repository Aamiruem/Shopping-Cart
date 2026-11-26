import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAuthModal } from '../context/AuthModalContext';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { useWishlist } from '../context/WishlistContext';
import { OPENING_SOON_MESSAGE, SHOPPING } from '../config';
import { trackAddToCart, trackWishlist } from '../utils/analytics';
import { playSound } from '../utils/sound';

// Cart / wishlist actions with the same UX everywhere: send guests to login
// (and back again afterwards), then confirm with a toast and a sound.
export default function useShopActions() {
  const { user } = useAuth();
  const { openLogin } = useAuthModal();
  const cart = useCart();
  const wishlist = useWishlist();
  const toast = useToast();
  const navigate = useNavigate();

  const requireLogin = (why = 'Sign in to continue') => {
    if (!SHOPPING) {
      toast.show(OPENING_SOON_MESSAGE, 'info');
      return false;
    }
    if (user) return true;
    openLogin('welcome', why);
    return false;
  };
  // Guests can fill a cart (kept in this browser until they sign in); ordering always needs an account
  const canShop = () => {
    if (SHOPPING) return true;
    toast.show(OPENING_SOON_MESSAGE, 'info');
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
    addToCart: (product, qty = 1, options = {}) =>
      canShop() && run(async () => {
        await cart.add(product._id, qty, options);
        trackAddToCart(product, qty);
      }, `${product.name} added to cart`, 'add'),

    // Straight to checkout with this product at the chosen quantity
    buyNow: async (product, qty = 1, options = {}) => {
      if (!user) {
        if (!canShop()) return;
        // Into the guest cart, then sign in: it moves to the account and checkout is one tap away
        if (await run(() => cart.add(product._id, qty, options), null, 'add')) requireLogin('Sign in to place your order. Your cart is saved.');
        return;
      }
      // The same product in the same size and colour (a product without options matches on its id alone)
      const line = cart.cart.items.find((i) => i.productId === product._id
        && (!options.size || i.size === options.size) && (!options.color || i.color === options.color));
      const ok = line
        ? line.qty === qty || qty === 1 || (await run(() => cart.update(line.lineId ?? line.productId, qty), null, 'add'))
        : await run(async () => {
          await cart.add(product._id, qty, options);
          trackAddToCart(product, qty);
        }, null, 'add');
      if (ok) navigate('/checkout');
    },

    toggleWishlist: (product) => {
      if (!requireLogin('Sign in to save items to your wishlist')) return;
      return wishlist.has(product._id)
        ? run(() => wishlist.remove(product._id), 'Removed from wishlist', 'click')
        : run(async () => {
          await wishlist.add(product._id);
          trackWishlist(product);
        }, 'Added to wishlist', 'wishlist');
    },

    // Cart page "Save for later": wishlist it, then drop it from the cart
    saveForLater: (item) =>
      requireLogin('Sign in to save items for later') && run(async () => {
        await wishlist.add(item.productId);
        await cart.remove(item.lineId ?? item.productId);
      }, `${item.name} moved to wishlist`, 'wishlist'),
  };
}
