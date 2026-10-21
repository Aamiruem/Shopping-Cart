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
    register: async (form) => saveSession(await api.register(form)),
    googleLogin: async (credential) => saveSession(await api.googleLogin(credential)),
    setUser,
    updateProfile: async (form) => setUser(await api.updateProfile(form)),
    logout: () => {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
    },
  }), [user, ready, saveSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
