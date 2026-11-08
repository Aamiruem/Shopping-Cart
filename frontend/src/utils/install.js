// "Download App": the store installs like an app (manifest.webmanifest), with its own icon and window.
// Chrome and Edge offer an install prompt through `beforeinstallprompt`; it fires early, so this module is imported in
// main.jsx before React starts. Other browsers (Safari, Firefox) install from their own menu, and we say how.
let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // keep it for our "Download App" button instead of the browser's own banner
    deferred = event;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export const installStore = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  canPrompt: () => Boolean(deferred),
};

/** Already running as the installed app. */
export const isInstalled = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true);

export function manualInstallHint() {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'On iPhone or iPad: tap Share, then “Add to Home Screen”.';
  if (/android/i.test(ua)) return 'Open your browser’s ⋮ menu and choose “Install app” or “Add to Home screen”.';
  return 'Open your browser’s menu and choose “Install Arvixa” (or the install icon in the address bar).';
}

/** 'installed', 'dismissed', or 'manual' when the browser has no prompt to show and the shopper must use its menu. */
export async function installApp() {
  if (!deferred) return 'manual';
  const event = deferred;
  deferred = null;
  notify();
  event.prompt();
  const { outcome } = await event.userChoice;
  return outcome === 'accepted' ? 'installed' : 'dismissed';
}
