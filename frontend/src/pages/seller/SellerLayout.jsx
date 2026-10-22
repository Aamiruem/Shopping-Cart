import { Navigate, NavLink, Outlet } from 'react-router-dom';
import Icon from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';

const LINKS = [
  { to: '/seller/dashboard', icon: 'barChart', label: 'Analytics & AI' },
  { to: '/seller/products', icon: 'tag', label: 'Products' },
  { to: '/seller/orders', icon: 'package', label: 'Orders' },
];

// Shell for the seller hub. Customers are sent to the onboarding page first.
export default function SellerLayout() {
  const { user } = useAuth();
  if (!['seller', 'admin'].includes(user.role)) return <Navigate to="/seller/register" replace />;

  return (
    <div className="seller-shell container">
      <aside className="seller-nav panel">
        <div className="seller-store">
          <span className="avatar">{(user.storeName || user.name)[0]?.toUpperCase()}</span>
          <div>
            <strong>{user.storeName || 'Arvixa Admin'}</strong>
            <span className="muted small">{user.role === 'admin' ? 'Marketplace admin' : 'Seller hub'}</span>
          </div>
        </div>
        <nav>
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to}><Icon name={l.icon} size={18} /> {l.label}</NavLink>
          ))}
        </nav>
      </aside>
      <section className="seller-main">
        <Outlet />
      </section>
    </div>
  );
}
