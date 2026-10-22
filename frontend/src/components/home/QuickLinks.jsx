import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Icon from '../common/Icon';
import { useAccountLinks } from '../layout/Navbar';

// Top of the home page: a greeting plus every account option one click away (same list as the ⋮ menu)
export default function QuickLinks() {
  const { user } = useAuth();
  const location = useLocation();
  // Guests get the essentials only; account pages are one hover away in the Login menu
  const links = useAccountLinks().filter((l) => (user ? true : ['/products', '/help'].includes(l.to)));

  return (
    <section className="quick-links panel" aria-label="Your shortcuts">
      <div className="quick-hello">
        <strong>{user ? `Hello, ${user.name.split(' ')[0]}` : 'Welcome to Arvixa'}</strong>
        <span>{user ? 'Everything for your account, one click away' : 'Log in to track orders, save a wishlist and check out faster'}</span>
      </div>
      <nav className="quick-list">
        {!user && (
          <>
            <Link to="/login" state={{ from: location }} className="quick-link primary"><Icon name="user" size={18} /> Login</Link>
            <Link to="/register" className="quick-link"><Icon name="plus" size={18} /> Create account</Link>
          </>
        )}
        {links.map((l) => (
          <Link key={l.to} to={l.to} className={`quick-link ${l.to === '/products' ? 'shop-all' : ''}`}><Icon name={l.icon} size={18} /> {l.label}</Link>
        ))}
      </nav>
    </section>
  );
}
