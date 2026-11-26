import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, AUTH_EXPIRED_EVENT, TOKEN_KEY } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // Restore the session from a saved token on first load
  useEffect(() => {
    if (!localStorage.getItem(TOKEN_KEY)) return setReady(true);
    api.me()
      .then(setUser)
      .catch(() => localStorage.removeItem(TOKEN_KEY))
      .finally(() => setReady(true));
  }, []);

  // The API client fires this when the server rejects our token
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const saveSession = useCallback(({ token, user: nextUser }) => {
    localStorage.setItem(TOKEN_KEY, token);
    setUser(nextUser);
    return nextUser;
  }, []);

  const value = useMemo(() => ({
    user,
    ready,
    login: async (email, password) => saveSession(await api.login({ email, password })),
    // Admin portal: { mfaRequired: true } until the authenticator code is given, then the session
    adminLogin: async (email, password, code) => {
      const result = await api.adminLogin({ email, password, ...(code ? { code } : {}) });
      return result.token ? { user: saveSession(result) } : result;
    },
    sellerLogin: async (email, password) => saveSession(await api.sellerLogin({ email, password })),
    sellerSignup: async (form) => saveSession(await api.sellerSignup(form)),
    otpLogin: async (identifier, code) => saveSession(await api.otpLoginVerify(identifier, code)),
    // Mobile sign-in: signs in, or returns { needsProfile, signupToken } for a number with no account yet
    mobileLogin: async (phone, code) => {
      const result = await api.mobileLogin(phone, code);
      return result.token ? { user: saveSession(result) } : result;
    },
    mobileComplete: async (body) => saveSession(await api.mobileComplete(body)),
    // Forgot password: a correct code sets the new password and signs in
    resetPassword: async (identifier, code, password) => saveSession(await api.resetPassword(identifier, code, password)),
    // The full API signs up in two steps: register() emails a code, verifySignup() creates the account and signs in.
    // The api/ functions have no email service yet, so they create the account straight away.
    register: async (form) => {
      const result = await api.register(form);
      return result.token ? { user: saveSession(result) } : result;
    },
    verifySignup: async (email, code) => saveSession(await api.verifySignup({ email, code })),
    googleLogin: async (credential) => saveSession(await api.googleLogin(credential)),
    setUser,
    // A profile change keeps the portal this session came from
    updateProfile: async (form) => {
      const next = await api.updateProfile(form);
      setUser((prev) => ({ ...next, portal: prev?.portal }));
    },
    logout: () => {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
    },
  }), [user, ready, saveSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
