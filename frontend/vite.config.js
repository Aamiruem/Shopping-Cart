import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { siteUrl } from './scripts/site-url.mjs';

// Ownership tags for Google Search Console and Bing Webmaster Tools, added only when their tokens are set
function siteVerification(env) {
  const tags = [
    ['google-site-verification', env.VITE_GOOGLE_SITE_VERIFICATION],
    ['msvalidate.01', env.VITE_BING_SITE_VERIFICATION],
  ].filter(([, token]) => token);
  return {
    name: 'site-verification',
    transformIndexHtml: () => tags.map(([name, content]) => ({ tag: 'meta', attrs: { name, content }, injectTo: 'head' })),
  };
}

// Two local APIs: the store API (scripts/local-store.mjs, port 5100) has the admin portal, the CRM and the seller
// portal; the Python backend (python main.py / start-dev.ps1, port 5000) doesn't. `npm run dev` starts the store API
// by itself and restarts it if it stops, and sends every /api call to it, so /admin/login always works and a Python
// backend left running can't get in the way. Settings (frontend/.env.local, never committed):
//   LOCAL_ADMIN_EMAIL / LOCAL_ADMIN_PASSWORD / LOCAL_ADMIN_NAME   your own admin login, besides owner@example.com
//   LOCAL_STORE_API=off   don't start it: /api goes to the store API while one runs, otherwise to the Python backend
const STORE_PORT = 5100;
const STORE_API = `http://127.0.0.1:${STORE_PORT}`;
const PYTHON_API = 'http://127.0.0.1:5000';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Kept on globalThis: Vite re-runs this file when it reloads the config, and there must still be one watcher and one child
const store = (globalThis.__localStoreApi ||= { up: false, child: null, lastStart: 0, autoStart: false, admin: {}, watching: false });

function startStoreApi() {
  store.lastStart = Date.now();
  console.log(`  Starting the store API on ${STORE_API} (admin portal, CRM, seller portal)...`);
  const { email, password, name } = store.admin;
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'local-store.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(STORE_PORT), ...(email && password ? { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, ADMIN_NAME: name || 'Store Admin' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const relay = (stream, log) => stream.on('data', (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => log(`  [store API] ${line}`)));
  relay(child.stdout, console.log);
  relay(child.stderr, console.error);
  child.on('exit', (code) => {
    if (store.child === child) store.child = null;
    if (code) console.error(`  [store API] stopped (exit code ${code}); restarting it shortly`);
  });
  store.child = child;
}

function watchStoreApi() {
  if (store.watching) return;
  store.watching = true;
  process.once('exit', () => store.child?.kill()); // the store API lives as long as the dev server
  const probe = () => {
    const socket = net.connect(STORE_PORT, '127.0.0.1');
    let settled = false;
    const done = (up) => () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (up !== store.up && !store.autoStart) console.log(`  /api -> ${up ? `store API ${STORE_API}` : `Python backend ${PYTHON_API}`}`);
      store.up = up;
      // Not running (never started, closed, or crashed): start it, at most every 20 seconds
      if (!up && store.autoStart && !store.child && Date.now() - store.lastStart > 20_000) startStoreApi();
    };
    socket.setTimeout(500, done(false));
    socket.once('connect', done(true));
    socket.once('error', done(false));
  };
  probe();
  setInterval(probe, 2000).unref();
}

function apiProxy() {
  const fixed = process.env.VITE_API_PROXY;
  return {
    target: fixed || STORE_API,
    changeOrigin: true,
    configure(proxy) {
      if (fixed) return;
      const web = proxy.web.bind(proxy);
      // Started here: always the store API (while it starts, the site briefly says the server isn't responding)
      proxy.web = (req, res, options = {}) => web(req, res, { ...options, target: store.autoStart || store.up ? STORE_API : PYTHON_API });
    },
  };
}

function localStoreApi(local) {
  return {
    name: 'local-store-api',
    apply: 'serve',
    configureServer() {
      if (process.env.VITE_API_PROXY) return;
      store.autoStart = local.LOCAL_STORE_API !== 'off';
      const admin = { email: local.LOCAL_ADMIN_EMAIL, password: local.LOCAL_ADMIN_PASSWORD, name: local.LOCAL_ADMIN_NAME };
      const changed = JSON.stringify(admin) !== JSON.stringify(store.admin);
      store.admin = admin;
      // .env.local edited: restart the store API this dev server started, so it seeds the new admin login
      if (changed && store.child) {
        store.lastStart = 0;
        store.child.kill();
      }
      watchStoreApi();
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), 'VITE_') };
  const local = { ...loadEnv(mode, process.cwd(), 'LOCAL_'), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('LOCAL_'))) };
  return {
    plugins: [react(), siteVerification(env), localStoreApi(local)],
    define: {
      'import.meta.env.VITE_SITE_URL': JSON.stringify(mode === 'production' ? siteUrl(env) : ''),
    },
    server: {
      // IPv4 so both http://localhost:5173 and http://127.0.0.1:5173 work; fail loudly instead of moving to 5174
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // 127.0.0.1, not localhost: Node may resolve localhost to ::1 while uvicorn only listens on IPv4
      // /sitemap.xml and /robots.txt are generated by the API from the live catalog
      proxy: Object.fromEntries(['/api', '/sitemap.xml', '/robots.txt'].map((p) => [p, apiProxy()])),
    },
  };
});
