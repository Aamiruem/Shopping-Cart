import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/CartContext';
import { useToast } from '../../context/ToastContext';
import { useWishlist } from '../../context/WishlistContext';
import { soundStore } from '../../utils/sound';
import Icon from '../common/Icon';
import SearchBar from './SearchBar';

export const isSellerRole = (user) => ['seller', 'admin'].includes(user?.role);

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Arvixa home">
      <span className="logo-mark"><img src="/brand/arvixa-mark-192.png" alt="" width="40" height="40" /></span>
      <span className="logo-text">
        <span className="logo-word">Arvixa</span>
        <span className="logo-tag">Shop Beyond Limits</span>
      </span>
    </Link>
  );
}

// Every account option, shared by the ⋮ menu and the home page quick links
export function useAccountLinks() {
  const { user } = useAuth();
  if (!user) {
    return [
      { to: '/login', icon: 'user', label: 'Login' },
      { to: '/register', icon: 'plus', label: 'Create an account' },
      { to: '/help', icon: 'help', label: 'Help Center' },
    ];
  }
  return [
    { to: '/account', icon: 'user', label: 'My Profile' },
    { to: '/orders', icon: 'package', label: 'My Orders' },
    { to: '/wishlist', icon: 'heart', label: 'Wishlist' },
    { to: '/cart', icon: 'cart', label: 'Cart' },
    { to: '/account?tab=addresses', icon: 'mapPin', label: 'Saved Addresses' },
    ...(isSellerRole(user) ? [{ to: '/seller/dashboard', icon: 'barChart', label: 'Seller Hub' }] : []),
    { to: '/help', icon: 'help', label: 'Help Center' },
  ];
}

function MoreMenu() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const links = useAccountLinks();
  const muted = useSyncExternalStore(soundStore.subscribe, soundStore.isMuted);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => setOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onLogout = () => {
    setOpen(false);
    logout();
    toast.show('You have been logged out', 'info');
    navigate('/');
  };

  return (
    <div className="more-menu" ref={ref}>
      <button
        type="button"
        className="nav-item nav-icon-only more-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Menu"
      >
        <Icon name="moreVertical" size={20} />
      </button>
      {open && (
        <div className="dropdown more-dropdown">
          <div className="more-head">
            {user ? (
              <><strong>Hello, {user.name.split(' ')[0]}</strong><span>{user.email}</span></>
            ) : (
              <><strong>Welcome to Arvixa</strong><span>Log in for orders, wishlist and offers</span></>
            )}
          </div>
          {links.map((l) => (
            <Link key={l.to} to={l.to} state={l.to === '/login' ? { from: location } : undefined}>
              <Icon name={l.icon} size={16} /> {l.label}
            </Link>
          ))}
          <button type="button" onClick={() => soundStore.setMuted(!muted)}>
            <Icon name={muted ? 'volumeOff' : 'volume'} size={16} /> {muted ? 'Sounds off' : 'Sounds on'}
          </button>
          {user && <button type="button" className="more-logout" onClick={onLogout}><Icon name="logout" size={16} /> Logout</button>}
        </div>
      )}
    </div>
  );
}

function AccountButton() {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) {
    return (
      <Link to="/login" state={{ from: location }} className="nav-login">
        <Icon name="user" size={18} /> Login
      </Link>
    );
  }
  return (
    <Link to="/account" className="nav-item" aria-label="My account">
      <Icon name="user" size={18} />
      <span className="nav-label">{user.name.split(' ')[0]}</span>
    </Link>
  );
}

export default function Navbar() {
  const { user } = useAuth();
  const { count } = useCart();
  const { count: wishCount } = useWishlist();

  return (
    <header className="navbar">
      <div className="navbar-inner container">
        <Logo />
        <SearchBar />
        <nav className="nav-actions" aria-label="Main">
          <AccountButton />
          {/* Only sellers and admins see the seller side of the store */}
          {isSellerRole(user) && (
            <Link to="/seller/dashboard" className="nav-item" aria-label="Seller Hub">
              <Icon name="barChart" size={18} />
              <span className="nav-label">Seller Hub</span>
            </Link>
          )}
          <Link to="/wishlist" className="nav-item" aria-label="Wishlist">
            <span className="nav-icon">
              <Icon name="heart" size={20} />
              {wishCount > 0 && <span className="badge">{wishCount}</span>}
            </span>
            <span className="nav-label">Wishlist</span>
          </Link>
          <Link to="/cart" className="nav-item" aria-label={`Cart, ${count} items`}>
            <span className="nav-icon">
              <Icon name="cart" size={20} />
              {count > 0 && <span className="badge">{count}</span>}
            </span>
            <span className="nav-label">Cart</span>
          </Link>
          <MoreMenu />
        </nav>
      </div>
    </header>
  );
}
