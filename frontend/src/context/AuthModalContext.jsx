import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import { SHOPPING } from '../config';
import { useAuth } from './AuthContext';

const loadLoginForm = () => import('../pages/Login');
const LoginForm = lazy(() => loadLoginForm().then((m) => ({ default: m.LoginForm })));
const AuthModalContext = createContext({ openLogin: () => {} });

// Login and sign-up in a dialog over the current page, so shoppers stay where they were.
// The /login and /register pages still exist for direct links and for pages that need a login.
export function AuthModalProvider({ children }) {
  const [mode, setMode] = useState(null); // null | 'login' | 'register'
  const dialog = useRef(null);
  const opener = useRef(null);

  const openLogin = useCallback((next = 'login') => {
    if (!SHOPPING) return;
    opener.current = document.activeElement;
    setMode(next);
  }, []);
  const close = useCallback(() => setMode(null), []);

  useEffect(() => {
    if (!mode) return undefined;
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden'; // the page behind doesn't scroll
    const focusFirst = setTimeout(() => dialog.current?.querySelector('input')?.focus(), 50);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      clearTimeout(focusFirst);
      opener.current?.focus?.(); // back to the button that opened it
    };
  }, [mode, close]);

  useFirstVisitPrompt(openLogin, Boolean(mode));

  const value = useMemo(() => ({ openLogin }), [openLogin]);
  return (
    <AuthModalContext.Provider value={value}>
      {children}
      {mode && (
        <div className="auth-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div ref={dialog} className="auth-modal" role="dialog" aria-modal="true" aria-label={mode === 'register' ? 'Create account' : 'Login'}>
            <button type="button" className="auth-modal-close" onClick={close} aria-label="Close">
              <Icon name="x" size={22} />
            </button>
            <Suspense fallback={<Spinner />}>
              <LoginForm key={mode} mode={mode} embedded onDone={close} onSwitch={setMode} />
            </Suspense>
          </div>
        </div>
      )}
    </AuthModalContext.Provider>
  );
}

export const useAuthModal = () => useContext(AuthModalContext);

const WELCOMED_KEY = 'arvixa:welcomed';
const WELCOME_DELAY_MS = 4000;
// Pages where a popup would get in the way: the shopper is already logging in, paying or reading a policy
const NO_PROMPT = /^\/(login|register|checkout|cart|orders|account|seller|terms|privacy|refunds|shipping)/;
// Search engines penalise pop-ups that cover content, so crawlers and audit tools never see it
const isBot = () => /bot|crawl|spider|slurp|lighthouse|headlesschrome/i.test(navigator.userAgent);

// A first-time visitor who isn't logged in is asked once, a few seconds in, to log in or sign up (like Flipkart).
// Closing it is remembered, so it never comes back on that browser.
function useFirstVisitPrompt(openLogin, alreadyOpen) {
  const { user, ready } = useAuth();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!SHOPPING || !ready || user || alreadyOpen || NO_PROMPT.test(pathname) || isBot()) return undefined;
    let seen = false;
    try {
      seen = localStorage.getItem(WELCOMED_KEY) === '1';
    } catch { /* private window: show it, just don't remember */ }
    if (seen) return undefined;
    loadLoginForm(); // fetched during the wait, so the popup opens with the form, not a spinner
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(WELCOMED_KEY, '1');
      } catch { /* ignore */ }
      openLogin('login');
    }, WELCOME_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready, user, pathname, alreadyOpen, openLogin]);
}
