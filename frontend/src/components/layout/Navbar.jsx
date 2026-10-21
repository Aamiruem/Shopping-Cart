import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/CartContext';
import { useToast } from '../../context/ToastContext';
import { useWishlist } from '../../context/WishlistContext';
import { soundStore } from '../../utils/sound';
import Icon from '../common/Icon';
import SearchBar from './SearchBar';

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Veyra home">
      <span className="logo-word">Veyra</span>
      <span className="logo-tag">Explore <em>Plus</em> <Icon name="zap" size={10} filled strokeWidth={0} /></span>
    </Link>
  );
}

function AccountMenu() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    const onClick = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (!user) {
    return (
      <Link to="/login" state={{ from: location }} className="nav-login">
        <Icon name="user" size={18} /> Login
      </Link>
    );
  }

  const onLogout = () => {
    logout();
    toast.show('You have been logged out', 'info');
    navigate('/');
  };

  return (
    <div className="account-menu" ref={ref} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="nav-item" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="user" size={18} />
        <span className="nav-label">{user.name.split(' ')[0]}</span>
        <Icon name="chevronDown" size={14} className={open ? 'flip' : ''} />
      </button>
      {open && (
        <div className="dropdown">
          <Link to="/account"><Icon name="user" size={16} /> My Profile</Link>
          <Link to="/orders"><Icon name="package" size={16} /> Orders</Link>
          <Link to="/wishlist"><Icon name="heart" size={16} /> Wishlist</Link>
          <Link to="/account?tab=addresses"><Icon name="mapPin" size={16} /> Saved Addresses</Link>
          {['seller', 'admin'].includes(user.role)
            ? <Link to="/seller/dashboard"><Icon name="barChart" size={16} /> Seller Hub</Link>
            : <Link to="/seller/register"><Icon name="tag" size={16} /> Become a Seller</Link>}
          <button type="button" onClick={onLogout}><Icon name="logout" size={16} /> Logout</button>
        </div>
      )}
    </div>
  );
}

function SoundToggle() {
  const muted = useSyncExternalStore(soundStore.subscribe, soundStore.isMuted);
  return (
    <button
      type="button"
      className="nav-item nav-icon-only"
      onClick={() => soundStore.setMuted(!muted)}
      aria-label={muted ? 'Turn sounds on' : 'Turn sounds off'}
      title={muted ? 'Sounds off' : 'Sounds on'}
    >
      <Icon name={muted ? 'volumeOff' : 'volume'} size={18} />
    </button>
  );
}

export default function Navbar() {
  const { count } = useCart();
  const { count: wishCount } = useWishlist();

  return (
    <header className="navbar">
      <div className="navbar-inner container">
        <Logo />
        <SearchBar />
        <nav className="nav-actions" aria-label="Main">
          <AccountMenu />
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
          <SoundToggle />
        </nav>
      </div>
    </header>
  );
}
