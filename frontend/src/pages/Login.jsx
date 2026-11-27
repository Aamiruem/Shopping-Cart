import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import QuickAuth from '../components/account/QuickAuth';
import { useAuth } from '../context/AuthContext';
import useSeo from '../hooks/useSeo';

// The /login and /register pages: the same one-field form as the login popup (AuthModalContext), then back to where
// the shopper was
export default function Login({ mode = 'login' }) {
  useSeo({ title: mode === 'register' ? 'Create account' : 'Login', noindex: true });
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from;
  const target = from ? `${from.pathname}${from.search || ''}` : '/';
  const redirectTo = /^\/(?![/\\])/.test(target) ? target : '/'; // only ever a page on this site (never `//host`)
  if (ready && user) return <Navigate to={redirectTo} replace />;
  return (
    <div className="page-auth container">
      <div className="quick-auth-page">
        <QuickAuth initial={mode} reason={from ? 'Please log in to continue.' : ''} onDone={() => navigate(redirectTo, { replace: true })} />
      </div>
    </div>
  );
}
