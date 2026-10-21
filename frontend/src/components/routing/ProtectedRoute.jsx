import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Spinner } from '../common/Feedback';

// Sends guests to /login and remembers where they were going
export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Spinner />;
  return user ? children : <Navigate to="/login" replace state={{ from: location }} />;
}
