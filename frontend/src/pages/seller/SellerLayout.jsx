import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../../api/client';
import Icon from '../../components/common/Icon';
import { PREVIEW } from '../../config';
import { useAuth } from '../../context/AuthContext';
import useApi from '../../hooks/useApi';

// Each section gets its own colour so the hub is easy to scan
const ALL_LINKS = [
  { to: '/seller/dashboard', icon: 'barChart', label: 'Analytics & AI', tone: 'blue' },
  { to: '/seller/products', icon: 'tag', label: 'Products', tone: 'orange' },
  { to: '/seller/catalog', icon: 'store', label: 'Store catalog', tone: 'blue', admin: true },
  { to: '/seller/orders', icon: 'package', label: 'Orders', tone: 'green' },
  { to: '/seller/earnings', icon: 'wallet', label: 'Payments & Earnings', tone: 'purple' },
  { to: '/seller/settings', icon: 'settings', label: 'Store Settings', tone: 'slate' },
  { to: '/seller/support', icon: 'message', label: 'Complaints', tone: 'orange', admin: true },
  { to: '/seller/leads', icon: 'users', label: 'Leads & enquiries', tone: 'green', admin: true },
];
// Store mode has its own dashboard (StoreDashboard.jsx); the analytics & ML dashboard needs the full Python API
const LINKS = PREVIEW ? ALL_LINKS.map((l) => (l.to === '/seller/dashboard' ? { ...l, icon: 'grid', label: 'Dashboard' } : l)) : ALL_LINKS;

// The store profile, shared with the hub pages (settings edits it, the sidebar shows the logo)
const SellerProfileContext = createContext({ profile: null, reload: () => {} });
export const useSellerProfile = () => useContext(SellerProfileContext);

const THEME_KEY = 'hub-theme';
const savedTheme = () => {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
};

// The hub is dark by default (easier on the eyes for long sessions), with a switch. The ML analytics dashboard stays
// light: its charts are drawn for a white background. The store-mode dashboard follows the switch.
function useHubTheme() {
  const { pathname } = useLocation();
  const [theme, setTheme] = useState(savedTheme);
  const dark = theme === 'dark' && (PREVIEW || pathname !== '/seller/dashboard');
  useEffect(() => {
    document.body.classList.toggle('hub-dark', dark);
    return () => document.body.classList.remove('hub-dark');
  }, [dark]);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  };
  return { theme, toggle };
}

// Shell for the seller hub. Customers are sent to the onboarding page first.
export default function SellerLayout() {
  const { user } = useAuth();
  const { theme, toggle } = useHubTheme();
  const isSeller = ['seller', 'admin'].includes(user.role);
  const { data: profile, reload } = useApi(() => (isSeller ? api.sellerProfile() : Promise.resolve(null)), [isSeller]);
  if (!isSeller) return <Navigate to="/seller/register" replace />;

  const storeName = profile?.store_name || user.storeName || 'Arvixa Admin';
  return (
    <SellerProfileContext.Provider value={{ profile, reload }}>
      <div className="seller-shell container">
        <aside className="seller-nav panel">
          <div className="seller-store">
            {profile?.logo ? <img className="store-logo" src={profile.logo} alt="" /> : <span className="avatar">{storeName[0]?.toUpperCase()}</span>}
            <div>
              <strong>{storeName}</strong>
              <span className="muted small">{user.role === 'admin' ? 'Marketplace admin' : 'Seller Hub'}</span>
            </div>
          </div>
          <nav>
            {LINKS.filter((l) => !l.admin || user.role === 'admin').map((l) => (
              <NavLink key={l.to} to={l.to} className={`tone-${l.tone}`}>
                <span className="nav-chip"><Icon name={l.icon} size={17} /></span> {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="seller-help">
            <Icon name="help" size={16} />
            <span>Need help? <a href="/help">Seller support</a></span>
          </div>
          <button type="button" className="hub-theme-toggle" onClick={toggle} aria-pressed={theme === 'dark'}>
            <Icon name={theme === 'dark' ? 'eye' : 'eyeOff'} size={15} /> {theme === 'dark' ? 'Dark theme' : 'Light theme'}
          </button>
        </aside>
        <section className="seller-main">
          <Outlet />
        </section>
      </div>
    </SellerProfileContext.Provider>
  );
}
