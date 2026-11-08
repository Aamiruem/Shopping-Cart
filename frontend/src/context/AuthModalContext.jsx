import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import { SHOPPING } from '../config';

const LoginForm = lazy(() => import('../pages/Login').then((m) => ({ default: m.LoginForm })));
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
