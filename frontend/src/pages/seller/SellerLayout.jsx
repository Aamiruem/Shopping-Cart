import { createContext, useContext } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { api } from '../../api/client';
import Icon from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';
import useApi from '../../hooks/useApi';

// Each section gets its own colour so the hub is easy to scan
const LINKS = [
  { to: '/seller/dashboard', icon: 'barChart', label: 'Analytics & AI', tone: 'blue' },
  { to: '/seller/products', icon: 'tag', label: 'Products', tone: 'orange' },
  { to: '/seller/orders', icon: 'package', label: 'Orders', tone: 'green' },
  { to: '/seller/earnings', icon: 'wallet', label: 'Payments & Earnings', tone: 'purple' },
  { to: '/seller/settings', icon: 'settings', label: 'Store Settings', tone: 'slate' },
];

// The store profile, shared with the hub pages (settings edits it, the sidebar shows the logo)
const SellerProfileContext = createContext({ profile: null, reload: () => {} });
export const useSellerProfile = () => useContext(SellerProfileContext);

// Shell for the seller hub. Customers are sent to the onboarding page first.
export default function SellerLayout() {
  const { user } = useAuth();
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
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className={`tone-${l.tone}`}>
                <span className="nav-chip"><Icon name={l.icon} size={17} /></span> {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="seller-help">
            <Icon name="help" size={16} />
            <span>Need help? <a href="/help">Seller support</a></span>
          </div>
        </aside>
        <section className="seller-main">
          <Outlet />
        </section>
      </div>
    </SellerProfileContext.Provider>
  );
}
