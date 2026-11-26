import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { crm } from '../../api/client';
import Icon from '../../components/common/Icon';
import { CrmContext, ago, ErrorBox, Loading, useConfirm, useToasts } from '../../components/crm/ui';
import { useAuth } from '../../context/AuthContext';
import '../../styles/crm.css';

const NAV = [
  { to: '/crm', end: true, icon: 'grid', label: 'Dashboard', perm: 'dashboard.view' },
  { to: '/crm/customers', icon: 'users', label: 'Customers', perm: 'customers.view' },
  { to: '/crm/leads', icon: 'zap', label: 'Leads', perm: 'leads.view' },
  { to: '/crm/sales', icon: 'shoppingBag', label: 'Sales & orders', perm: 'sales.view' },
  { to: '/crm/catalog', icon: 'tag', label: 'Catalog verification', perm: 'catalog.view' },
  { to: '/crm/marketing', icon: 'send', label: 'Marketing', perm: 'marketing.view' },
  { to: '/crm/support', icon: 'headphones', label: 'Support', perm: 'support.view' },
  { to: '/crm/tasks', icon: 'check', label: 'Tasks', perm: null },
  { to: '/crm/reports', icon: 'barChart', label: 'Reports', perm: 'reports.view' },
  { to: '/crm/insights', icon: 'activity', label: 'AI insights', perm: 'insights.view' },
  { to: '/crm/team', icon: 'shield', label: 'Team & roles', perm: 'staff.manage' },
  { to: '/crm/settings', icon: 'settings', label: 'Settings', perm: 'settings.manage' },
];
const POLL_MS = 20_000;
const THEME_KEY = 'crm-theme';

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved ? saved === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });
  const toggle = () => setDark((d) => {
    try {
      localStorage.setItem(THEME_KEY, d ? 'light' : 'dark');
    } catch {
      /* this visit only */
    }
    return !d;
  });
  return { dark, toggle };
}

/**
 * Live notifications: polls the feed while the tab is visible (Vercel functions can't hold Socket.IO connections).
 * Events carry stable ids, so each one is announced once however often it's fetched.
 */
function useFeed(toast, enabled) {
  const [feed, setFeed] = useState({ events: [], unread: 0 });
  const seen = useRef(null);
  const load = useCallback(async () => {
    if (document.hidden) return;
    try {
      const data = await crm.get('/feed');
      if (seen.current) {
        const fresh = data.events.filter((e) => !seen.current.has(e.id));
        fresh.slice(0, 3).forEach((e) => toast(e.text, 'info'));
      }
      seen.current = new Set(data.events.map((e) => e.id));
      setFeed(data);
    } catch {
      /* the next poll tries again */
    }
  }, [toast]);
  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const t = setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', load);
    };
  }, [load, enabled]);
  const markSeen = async () => {
    setFeed((f) => ({ ...f, unread: 0, events: f.events.map((e) => ({ ...e, unread: false })) }));
    await crm.post('/feed/seen').catch(() => {});
  };
  return { feed, markSeen, reload: load };
}

function Bell({ feed, markSeen }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="crm-bell" ref={ref}>
      <button type="button" className="b" onClick={() => { setOpen((o) => !o); if (!open && feed.unread) markSeen(); }} aria-label={`Notifications, ${feed.unread} unread`} aria-expanded={open}>
        <Icon name="message" size={16} /> Activity
        {feed.unread > 0 && <span className="dot">{feed.unread > 99 ? '99+' : feed.unread}</span>}
      </button>
      {open && (
        <div className="crm-feed">
          {feed.events.length ? feed.events.map((e) => (
            <Link key={e.id} to={e.link} className={e.unread ? 'unread' : ''} onClick={() => setOpen(false)}>
              {e.text}<time>{ago(e.at)}</time>
            </Link>
          )) : <div className="empty">No activity in the last day</div>}
        </div>
      )}
    </div>
  );
}

export default function CrmLayout() {
  const { user, ready } = useAuth();
  const { pathname } = useLocation();
  const { show: toast, view: toasts } = useToasts();
  const { confirm, view: confirmView } = useConfirm();
  const { dark, toggle } = useTheme();
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const allowed = Boolean(user?.crm);

  useEffect(() => {
    if (!allowed) return;
    crm.get('/me').then(setMe).catch((err) => setError(err.message));
  }, [allowed]);
  useEffect(() => setMenu(false), [pathname]);
  const { feed, markSeen } = useFeed(toast, Boolean(me));

  const value = useMemo(() => ({
    me, toast, confirm,
    can: (p) => !p || Boolean(me?.permissions.includes(p)),
  }), [me, toast, confirm]);

  // The menu link is hidden from everyone else; a typed-in /crm address goes back to the store
  if (ready && !allowed) return <Navigate to="/" replace />;
  if (error) return <div className="crm"><div className="crm-main" style={{ gridColumn: '1 / -1' }}><ErrorBox error={error} /><Link to="/">Back to the store</Link></div></div>;
  if (!me) return <Loading text="Opening the CRM…" />;

  const nav = NAV.filter((n) => value.can(n.perm));
  return (
    <CrmContext.Provider value={value}>
      <div className={`crm ${dark ? 'dark' : ''}`}>
        <aside className={`crm-side ${menu ? 'open' : ''}`} aria-label="CRM">
          <div className="crm-brand">
            <span className="crm-logo">A</span>
            <div><strong>{me.company} CRM</strong><span>{me.roleName}</span></div>
          </div>
          <nav className="crm-nav">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                <Icon name={n.icon} size={17} /> {n.label}
                {n.to === '/crm/tasks' && feed.events.some((e) => e.type === 'reminder') && <span className="count">!</span>}
              </NavLink>
            ))}
          </nav>
          <div className="crm-side-foot">
            <button type="button" className="b" onClick={toggle} aria-pressed={dark}><Icon name={dark ? 'eye' : 'eyeOff'} size={15} /> {dark ? 'Dark' : 'Light'} theme</button>
            <Link className="b" to="/"><Icon name="store" size={15} /> Back to store</Link>
          </div>
        </aside>
        <main className="crm-main">
          <div className="crm-top no-print">
            <button type="button" className="b crm-menu-btn" onClick={() => setMenu((m) => !m)} aria-label="Menu"><Icon name="menu" size={16} /></button>
            <span className="muted small">Signed in as <strong>{me.name}</strong> · {me.roleName}</span>
            <span className="spacer" />
            <Bell feed={feed} markSeen={markSeen} />
          </div>
          <Outlet />
        </main>
        {toasts}
        {confirmView}
      </div>
    </CrmContext.Provider>
  );
}
