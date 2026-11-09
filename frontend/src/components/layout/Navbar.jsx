import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useAuthModal } from '../../context/AuthModalContext';
import { useCart } from '../../context/CartContext';
import { useToast } from '../../context/ToastContext';
import { useWishlist } from '../../context/WishlistContext';
import { PREVIEW } from '../../config';
import { installApp, installStore, isInstalled, manualInstallHint } from '../../utils/install';
import { soundStore } from '../../utils/sound';
import Icon from '../common/Icon';
import { OPEN_CHAT_EVENT } from '../chat/ChatWidget';
import SearchBar from './SearchBar';

export const isSellerRole = (user) => ['seller', 'admin'].includes(user?.role);

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Arvixa Store home">
      <img className="logo-mark" src="/brand/arvixa-mark-192.png" alt="" width="42" height="42" />
      <span className="logo-text">
        <span className="logo-word">Arvixa</span>
        <span className="logo-tag">Shop Beyond Limits</span>
      </span>
    </Link>
  );
}

// Account pages, shared by the Login dropdown and the home page shortcuts. Seller Hub is not here:
// it lives only in the More menu, and only for sellers.
export function useAccountLinks() {
  const { user } = useAuth();
  const { count: cartCount } = useCart();
  const { count: wishCount } = useWishlist();
  return [
    { to: '/products', icon: 'grid', label: 'Shop all products' },
    { to: '/account', icon: 'user', label: 'My Profile' },
    { to: '/orders', icon: 'package', label: 'Orders' },
    { to: '/payments', icon: 'wallet', label: 'Payments & Refunds' },
    { to: '/wishlist', icon: 'heart', label: 'Wishlist', count: user ? wishCount : 0 },
    { to: '/cart', icon: 'cart', label: 'Cart', count: user ? cartCount : 0 },
    { to: '/account?tab=addresses', icon: 'mapPin', label: 'Saved Addresses' },
    { to: '/help', icon: 'help', label: 'Help Center' },
  ];
}

// Hover to open on desktop, click/tap to toggle everywhere, Esc or a click outside to close
function useDropdown() {
  const location = useLocation();
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
  const hover = window.matchMedia?.('(hover: hover)').matches;
  const wrapper = { ref, ...(hover ? { onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false) } : {}) };
  // With a mouse, hovering already opened the menu, so a click must not close it again
  const toggle = () => setOpen((o) => (hover ? true : !o));
  return { open, setOpen, toggle, wrapper };
}

function MenuLink({ to, icon, label, count, state }) {
  return (
    <Link to={to} state={state} className="menu-link">
      <Icon name={icon} size={18} strokeWidth={1.6} />
      <span>{label}</span>
      {count > 0 && <span className="menu-count">{count}</span>}
    </Link>
  );
}

// "Download App": the browser's install prompt where there is one, otherwise how to install from its menu
function InstallAppItem({ onDone }) {
  const toast = useToast();
  useSyncExternalStore(installStore.subscribe, installStore.canPrompt);
  if (isInstalled()) return null;
  const install = async () => {
    onDone?.();
    const result = await installApp();
    if (result === 'installed') toast.show('Arvixa is installed. Find it on your home screen or desktop.');
    if (result === 'manual') toast.show(manualInstallHint(), 'info');
  };
  return (
    <button type="button" className="menu-link" onClick={install}>
      <Icon name="download" size={18} strokeWidth={1.6} /> <span>Download App</span>
    </button>
  );
}

function AccountMenu() {
  const { user, ready, logout } = useAuth();
  const { openLogin } = useAuthModal();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const links = useAccountLinks().filter((l) => l.to !== '/products' && l.to !== '/help');
  const { open, setOpen, toggle, wrapper } = useDropdown();

  const onLogout = () => {
    setOpen(false);
    logout();
    toast.show('You have been logged out', 'info');
    navigate('/');
  };

  return (
    <div className="nav-dropdown" {...wrapper}>
      <button type="button" className={`nav-item nav-account ${open ? 'open' : ''}`} onClick={toggle} aria-expanded={open} aria-haspopup="true" aria-label="Account">
        <Icon name="user" size={20} />
        {/* Until the saved session is checked, say 'Account' rather than flashing 'Login' at signed-in users */}
        <span className="nav-label">{user ? user.name.split(' ')[0] : ready ? 'Login' : 'Account'}</span>
        <Icon name="chevronDown" size={14} className="nav-chevron" />
      </button>
      {open && (
        <div className="menu-panel">
          {user ? (
            <div className="menu-head">
              <span className="menu-avatar">{user.name.trim()[0]?.toUpperCase()}</span>
              <div><strong>Hello, {user.name.split(' ')[0]}</strong><span>{user.email}</span></div>
            </div>
          ) : !ready ? null : (
            <div className="menu-head menu-head-guest">
              <p className="menu-signup">New customer? <Link to="/register" onClick={(e) => { e.preventDefault(); setOpen(false); openLogin('register'); }}>Sign Up</Link></p>
              <Link to="/login" state={{ from: location }} className="btn btn-primary btn-block" onClick={(e) => { e.preventDefault(); setOpen(false); openLogin('login'); }}>Login</Link>
            </div>
          )}
          <p className="menu-title">Your Account</p>
          {links.map((l) => <MenuLink key={l.to} {...l} />)}
          {!isSellerRole(user) && <MenuLink to="/sell" icon="store" label="Become a Seller" />}
          <MenuLink to="/help" icon="headphones" label="Customer Care" />
          <InstallAppItem onDone={() => setOpen(false)} />
          {user && (
            <button type="button" className="menu-link menu-logout" onClick={onLogout}>
              <Icon name="logout" size={18} /> <span>Logout</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MoreMenu() {
  const { user } = useAuth();
  const muted = useSyncExternalStore(soundStore.subscribe, soundStore.isMuted);
  const { open, setOpen, toggle, wrapper } = useDropdown();

  return (
    <div className="nav-dropdown" {...wrapper}>
      <button type="button" className={`nav-item nav-more ${open ? 'open' : ''}`} onClick={toggle} aria-expanded={open} aria-haspopup="true" aria-label="More">
        <Icon name="moreVertical" size={18} className="nav-more-icon" />
        <span className="nav-label">More</span>
        <Icon name="chevronDown" size={14} className="nav-chevron" />
      </button>
      {open && (
        <div className="menu-panel menu-panel-more">
          <p className="menu-title">More</p>
          {!isSellerRole(user) && <MenuLink to="/sell" icon="store" label="Become a Seller" />}
          <MenuLink to="/products" icon="grid" label="Shop all products" />
          <MenuLink to="/grocery" icon="home" label="Grocery Store" />
          {/* Seller Hub: sellers and admins only, and only in this menu */}
          {isSellerRole(user) && <MenuLink to="/seller/dashboard" icon="barChart" label="Seller Hub" />}
          <MenuLink to="/help" icon="headphones" label="Customer Care" />
          <MenuLink to="/orders" icon="package" label="Track your orders" />
          {/* The chat assistant needs the full API; in store mode there's no chat window to open */}
          {!PREVIEW && (
            <button type="button" className="menu-link" onClick={() => { setOpen(false); window.dispatchEvent(new Event(OPEN_CHAT_EVENT)); }}>
              <Icon name="message" size={18} /> <span>Chat with our assistant</span>
            </button>
          )}
          <InstallAppItem onDone={() => setOpen(false)} />
          <button type="button" className="menu-link" onClick={() => soundStore.setMuted(!muted)} aria-pressed={!muted}>
            <Icon name={muted ? 'volumeOff' : 'volume'} size={18} /> <span>Notification sounds</span>
            <span className={`menu-switch ${muted ? '' : 'on'}`} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

export default function Navbar() {
  const { search } = useLocation(); // "Shop All" is highlighted only on the unfiltered listing
  const { count } = useCart();

  return (
    <header className="navbar">
      <div className="navbar-inner container">
        <Logo />
        <SearchBar />
        <nav className="nav-actions" aria-label="Main">
          <NavLink to="/products" end className={({ isActive }) => `nav-item nav-shop ${isActive && !search ? 'active' : ''}`} aria-label="Shop all products">
            <Icon name="grid" size={18} />
            <span className="nav-label">Shop All</span>
          </NavLink>
          <AccountMenu />
          <MoreMenu />
          <Link to="/cart" className="nav-item" aria-label={`Cart, ${count} items`}>
            <span className="nav-icon">
              <Icon name="cart" size={22} />
              {count > 0 && <span className="badge">{count}</span>}
            </span>
            <span className="nav-label">Cart</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}
