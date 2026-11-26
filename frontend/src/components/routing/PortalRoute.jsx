import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Spinner } from '../common/Feedback';

// Pages that need a session from a particular portal: the CRM needs the admin portal, the Seller Hub the seller (or
// admin) portal. Anyone else goes to that portal's own sign-in. The server checks the portal on every request too;
// this only decides which sign-in page to show.
export default function PortalRoute({ portals, login, children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Spinner />;
  if (!user || !portals.includes(user.portal)) return <Navigate to={login} replace state={{ from: location }} />;
  return children;
}
