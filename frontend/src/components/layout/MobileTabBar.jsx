import { Link, NavLink, useLocation } from 'react-router-dom';
import { SHOPPING } from '../../config';
import { useAuth } from '../../context/AuthContext';
import { useAuthModal } from '../../context/AuthModalContext';
import { useCart } from '../../context/CartContext';
import { useWishlist } from '../../context/WishlistContext';
import Icon from '../common/Icon';

// Pages with their own bottom bar (product: Add to cart / Buy now) or no need for one
const HIDDEN = [/^\/products\/[^/]+/, /^\/checkout/, /^\/seller/, /^\/login/, /^\/register/];
export const showsTabBar = (pathname) => !HIDDEN.some((re) => re.test(pathname));

// Phones only (CSS shows it under 720px): the store's main places within thumb reach
export default function MobileTabBar() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { openLogin } = useAuthModal();
  const { count: cartCount = 0 } = useCart() || {};
  const { count: wishCount = 0 } = useWishlist() || {};
  if (!showsTabBar(pathname)) return null;

  const tab = (to, icon, label, badge = 0, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
      <span className="tab-icon"><Icon name={icon} size={22} />{badge > 0 && <span className="tab-badge">{badge > 99 ? '99+' : badge}</span>}</span>
      <span>{label}</span>
    </NavLink>
  );

  return (
    <nav className="mobile-tabbar" aria-label="Main">
      {tab('/', 'home', 'Home', 0, true)}
      {tab('/products', 'grid', 'Shop', 0, true)}
      {SHOPPING && tab('/wishlist', 'heart', 'Wishlist', wishCount)}
      {SHOPPING && tab('/cart', 'cart', 'Cart', cartCount)}
      {SHOPPING && (user
        ? tab('/account', 'user', 'Account')
        : (
          <Link to="/login" className="tab" onClick={(e) => { e.preventDefault(); openLogin('login'); }}>
            <span className="tab-icon"><Icon name="user" size={22} /></span><span>Login</span>
          </Link>
        ))}
      {!SHOPPING && tab('/help', 'help', 'Help')}
    </nav>
  );
}
