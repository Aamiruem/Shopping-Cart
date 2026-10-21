import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let scriptPromise;
let configPromise;

function loadGoogleScript() {
  scriptPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Could not load Google sign-in'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// The server decides whether Google sign-in is enabled (GOOGLE_CLIENT_ID in backend/.env)
const loadConfig = () => (configPromise ||= api.authConfig().catch(() => ({ googleClientId: null })));

// "Continue with Google" button (Google Identity Services). Renders nothing when not configured.
export default function GoogleButton({ onCredential, onError }) {
  const ref = useRef(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then(async ({ googleClientId }) => {
        if (!googleClientId || cancelled) return;
        setEnabled(true);
        await loadGoogleScript();
        if (cancelled || !ref.current) return;
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: ({ credential }) => onCredential(credential),
        });
        window.google.accounts.id.renderButton(ref.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width: Math.min(ref.current.offsetWidth || 360, 400),
        });
      })
      .catch((err) => !cancelled && onError?.(err.message));
    return () => {
      cancelled = true;
    };
  }, [onCredential, onError]);

  if (!enabled) return null;
  return (
    <>
      <div className="divider"><span>or</span></div>
      <div className="google-btn" ref={ref} />
    </>
  );
}
