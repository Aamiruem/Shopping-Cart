// CRM foundations: permissions, roles, who may use the CRM, sessions, the audit log, settings and shared helpers.
//
// Access model
//   - The store admin (users.role = 'admin') is always Super Admin.
//   - Anyone else needs a row in crm_staff with an active role: a built-in role below, or a custom role an admin made.
//   - Every CRM route names the permission it needs, and the server checks it on every request (api/_crm.mjs). The
//     menu link in the storefront is only a convenience: it never grants anything.
//   - Each login token used on the CRM becomes a crm_sessions row (login history); a revoked session, a deactivated
//     account, or "end all sessions" (users.sessions_revoked_at) is refused at once.
import { createHash } from 'node:crypto';
import { ApiError, assertSessionValid, tokenClaims } from './_auth.mjs';

export const PERMISSIONS = {
  'dashboard.view': 'See the CRM dashboard',
  'customers.view': 'See customers',
  'customers.contact': 'See full email addresses and phone numbers (masked otherwise)',
  'customers.edit': 'Add and edit customers, activate / deactivate accounts',
  'customers.import': 'Import customers from a file',
  'customers.export': 'Export customer records',
  'notes.write': 'Add notes and log calls or meetings',
  'leads.view': 'See leads',
  'leads.edit': 'Work leads: stage, follow-ups, comments',
  'leads.assign': 'Assign leads to team members',
  'leads.delete': 'Erase a lead (e.g. on the person’s request)',
  'sales.view': 'See orders, payments and sales',
  'orders.edit': 'Update fulfilment and cancel orders',
  'refunds.manage': 'Approve, reject and complete returns and refunds',
  'marketing.view': 'See campaigns and subscribers',
  'marketing.send': 'Create and send campaigns, run automations',
  'support.view': 'See support tickets',
  'support.edit': 'Reply to, assign and close tickets',
  'tasks.manage': 'Create tasks for others and see everyone’s tasks',
  'reports.view': 'See reports and analytics',
  'reports.export': 'Download reports',
  'insights.view': 'See AI insights',
  'catalog.view': 'See every product with its verification status',
  'catalog.verify': 'Verify, approve, reject, publish and withdraw products',
  'shipping.manage': 'Book shipments with the courier',
  'staff.manage': 'Add team members, roles and permissions',
  'settings.manage': 'Change CRM settings',
  'audit.view': 'See the audit log',
};
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

const VIEW = ['dashboard.view', 'customers.view', 'notes.write'];
export const BUILT_IN_ROLES = {
  super_admin: { name: 'Super Admin', description: 'The store owner. Everything, always.', permissions: ALL_PERMISSIONS },
  admin: { name: 'Admin', description: 'Everything except managing other admins.', permissions: ALL_PERMISSIONS },
  sales_manager: {
    name: 'Sales Manager',
    description: 'Runs the sales pipeline and the sales team.',
    permissions: [...VIEW, 'customers.contact', 'customers.edit', 'customers.export', 'leads.view', 'leads.edit', 'leads.assign', 'leads.delete', 'sales.view', 'orders.edit', 'tasks.manage', 'reports.view', 'reports.export', 'insights.view'],
  },
  sales_executive: {
    name: 'Sales Executive',
    description: 'Works the leads assigned to them.',
    permissions: [...VIEW, 'customers.contact', 'leads.view', 'leads.edit', 'sales.view'],
  },
  support_manager: {
    name: 'Support Manager',
    description: 'Runs the support desk, returns and refunds.',
    permissions: [...VIEW, 'customers.contact', 'customers.edit', 'support.view', 'support.edit', 'refunds.manage', 'sales.view', 'orders.edit', 'shipping.manage', 'tasks.manage', 'reports.view', 'reports.export'],
  },
  support_executive: {
    name: 'Support Executive',
    description: 'Answers tickets.',
    permissions: [...VIEW, 'customers.contact', 'support.view', 'support.edit', 'sales.view'],
  },
  marketing_manager: {
    name: 'Marketing Manager',
    description: 'Campaigns, newsletters and automations.',
    permissions: [...VIEW, 'customers.export', 'leads.view', 'marketing.view', 'marketing.send', 'reports.view', 'reports.export', 'insights.view'],
  },
  analyst: {
    name: 'Analyst',
    description: 'Read-only reports and insights. Contact details stay masked.',
    permissions: ['dashboard.view', 'customers.view', 'leads.view', 'sales.view', 'marketing.view', 'support.view', 'reports.view', 'reports.export', 'insights.view'],
  },
};
// Only the Super Admin may hand out these: whoever holds them can change anyone's access
export const OWNER_ONLY = ['staff.manage'];

export const ID_RE = /^\d{1,9}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const PHONE_RE = /^[6-9]\d{9}$/;

export const text = (v, max = 10_000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const fail = (message, status = 400) => {
  throw new ApiError(status, message);
};
export const num = (v) => (v === null || v === undefined ? 0 : Number(v));
export const round1 = (n) => Math.round(n * 10) / 10;
export const pct = (part, whole) => (whole ? round1((part / whole) * 100) : null);

/** Indian mobile number in any common form ("+91 98765-43210") → 10 digits, or '' */
export const cleanPhone = (v) => text(v).replace(/[\s()-]/g, '').replace(/^(\+91|91(?=\d{10}$)|0(?=\d{10}$))/, '');

/** a***@example.com, ******3210: for people who may see a customer but not their contact details */
export function mask(value) {
  if (!value) return value;
  const s = String(value);
  if (s.includes('@')) {
    const [local, domain] = s.split('@');
    return `${local[0]}${'*'.repeat(Math.max(local.length - 1, 2))}@${domain}`;
  }
  return `${'*'.repeat(Math.max(s.length - 4, 0))}${s.slice(-4)}`;
}

/** ?page=&pageSize= → LIMIT/OFFSET (1-based pages, at most 100 rows, or `max` for exports) */
export function paging(params = {}, max = 100) {
  const pageSize = Math.max(1, Math.min(Number(params.pageSize) || 25, max));
  const page = Math.max(1, Math.min(Number(params.page) || 1, 100_000));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
export const pageOf = (rows, { page, pageSize }, total) => ({ items: rows, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) });

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD → an inclusive range of days (default: the last `days`, today included) */
export function dateRange(params = {}, days = 30) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const valid = (s) => DATE_RE.test(s ?? '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  const to = valid(params.to) ? params.to : iso(today);
  const from = valid(params.from) ? params.from : iso(new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000));
  if (from > to) fail('The start date must be before the end date');
  if (Date.parse(to) - Date.parse(from) > 3 * 366 * 86_400_000) fail('Please choose a range of at most three years');
  return { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 };
}

/** Builds a WHERE clause with numbered parameters */
export function where() {
  const args = [];
  const parts = [];
  return {
    args,
    add(sql, ...values) {
      let i = 0;
      parts.push(sql.replace(/\?/g, () => {
        args.push(values[i++]);
        return `$${args.length}`;
      }));
    },
    raw: (sql) => parts.push(sql),
    arg(value) {
      args.push(value);
      return `$${args.length}`;
    },
    sql: () => (parts.length ? `WHERE ${parts.join(' AND ')}` : ''),
  };
}
export const like = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

// ---------- Who may use the CRM ----------
/** A person's CRM role and permissions, or null when they have no CRM access. */
export async function accessFor(db, u) {
  if (u.role === 'admin') return { role: 'super_admin', roleName: BUILT_IN_ROLES.super_admin.name, permissions: new Set(ALL_PERMISSIONS), owner: true };
  if (!db) return null;
  const [s] = await db(
    `SELECT s.role_key, s.active, s.title, r.name AS custom_name, r.permissions AS custom_permissions
       FROM crm_staff s LEFT JOIN crm_roles r ON r.key = s.role_key WHERE s.user_id = $1`,
    [u.id],
  );
  if (!s || !s.active || u.disabled_at) return null;
  const builtIn = Object.hasOwn(BUILT_IN_ROLES, s.role_key) && s.role_key !== 'super_admin' ? BUILT_IN_ROLES[s.role_key] : null;
  const list = builtIn ? builtIn.permissions : Array.isArray(s.custom_permissions) ? s.custom_permissions : null;
  if (!list) return null; // the custom role was deleted
  return { role: s.role_key, roleName: builtIn?.name ?? s.custom_name, title: s.title, permissions: new Set(list.filter((p) => Object.hasOwn(PERMISSIONS, p))), owner: false };
}

export const tokenHash = (authorization) => createHash('sha256').update(String(authorization).slice(7)).digest('hex');

/**
 * The signed-in CRM user, after checking their token, account, session and CRM role. Records the session (first use =
 * a CRM login in the audit log). Throws 401 / 403 otherwise.
 */
export async function crmUser(db, authorization, { ip = 'unknown', userAgent = '' } = {}) {
  const claims = tokenClaims(authorization);
  const [u] = await db('SELECT id, name, email, role, disabled_at, sessions_revoked_at FROM users WHERE id = $1', [claims.id]);
  if (!u) fail('Please log in again', 401);
  assertSessionValid(u, claims);
  const access = await accessFor(db, u);
  if (!access) fail('You don’t have access to the CRM', 403);
  const [s] = await db(
    `INSERT INTO crm_sessions (user_id, token_hash, ip, user_agent, issued_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5))
     ON CONFLICT (token_hash) DO UPDATE SET last_seen = NOW(), ip = EXCLUDED.ip
     RETURNING id, revoked_at, (first_seen = last_seen) AS fresh`,
    [u.id, tokenHash(authorization), String(ip).slice(0, 64), text(userAgent, 200), claims.iat ?? Math.floor(Date.now() / 1000)],
  );
  if (s.revoked_at) fail('This session was ended by an administrator. Please log in again.', 401);
  const staff = { id: u.id, name: u.name, email: u.email, ...access, sessionId: s.id, ip };
  if (s.fresh) await audit(db, staff, 'crm.login', 'session', s.id, { userAgent: text(userAgent, 200) });
  return staff;
}

export const can = (staff, permission) => staff.permissions.has(permission);
export function need(staff, permission) {
  if (!can(staff, permission)) fail('You don’t have permission to do this', 403);
}

/** Team members who can be given work needing `permission` (the admin always can) */
export async function assignable(db, permission) {
  const rows = await db(
    `SELECT u.id, u.name, u.email, CASE WHEN u.role = 'admin' THEN 'super_admin' ELSE s.role_key END AS role_key, r.permissions AS custom
       FROM users u LEFT JOIN crm_staff s ON s.user_id = u.id AND s.active LEFT JOIN crm_roles r ON r.key = s.role_key
      WHERE u.disabled_at IS NULL AND (u.role = 'admin' OR s.user_id IS NOT NULL)
      ORDER BY u.name, u.id`,
  );
  return rows
    .filter((r) => {
      const list = Object.hasOwn(BUILT_IN_ROLES, r.role_key) ? BUILT_IN_ROLES[r.role_key].permissions : r.custom || [];
      return !permission || list.includes(permission);
    })
    .map(({ id, name, role_key: role }) => ({ id, name, role, roleName: BUILT_IN_ROLES[role]?.name ?? role }));
}

export async function assertAssignable(db, userId, permission, label = 'This person') {
  if (userId === null || userId === undefined || userId === '') return null;
  if (!ID_RE.test(String(userId))) fail(`${label} isn’t on the team`);
  const team = await assignable(db, permission);
  const person = team.find((t) => t.id === Number(userId));
  if (!person) fail(`${label} can’t be given this work: they aren’t on the team or don’t have access to it`);
  return person;
}

// ---------- Audit log ----------
export async function audit(db, staff, action, entity = null, entityId = null, details = {}) {
  await db(
    'INSERT INTO crm_audit_log (actor_id, actor_name, action, entity, entity_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)',
    [staff?.id ?? null, staff?.name ?? 'system', action, entity, entityId === null ? null : String(entityId), JSON.stringify(details ?? {}), staff?.ip ?? null],
  );
}

// ---------- Settings ----------
export const NOTIFICATION_EVENTS = {
  welcome: 'Welcome email after signing up',
  order_confirmation: 'Order confirmation',
  payment_confirmation: 'Online payment received',
  shipping_update: 'Order shipped',
  delivery_confirmation: 'Order delivered',
  support_update: 'Reply on a support ticket',
};
export const DEFAULT_SETTINGS = {
  company: { name: 'Arvixa Store', legalName: '', address: '', gstin: '', email: '', phone: '', invoicePrefix: 'ARV' },
  // Which order and account updates go out on which channel. Off by default for SMS / WhatsApp: they cost money and
  // need approved templates. Nothing is sent on a channel whose provider isn't configured, whatever this says.
  notifications: Object.fromEntries(Object.keys(NOTIFICATION_EVENTS).map((e) => [e, { email: true, sms: false, whatsapp: false }])),
  leads: { registrationLeads: true, abandonedCartLeads: true, abandonedCartHours: 6, autoAssign: false, duplicateWindowHours: 72 },
  support: { firstResponseHours: 24, resolutionHours: 72 },
  automations: { abandonedCartReminder: false, abandonedCartCoupon: '', birthday: false, birthdayCoupon: '', anniversary: false, winBack: false, winBackDays: 90 },
};
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

export async function getSettings(db) {
  const rows = await db(`SELECT key, value FROM crm_settings WHERE key = ANY($1::text[])`, [SETTING_KEYS]);
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const { key, value } of rows) {
    if (key === 'notifications') {
      for (const [event, channels] of Object.entries(value || {})) if (out.notifications[event]) Object.assign(out.notifications[event], channels);
    } else Object.assign(out[key], value || {});
  }
  return out;
}

const bool = (v, label) => (typeof v === 'boolean' ? v : fail(`${label} must be on or off`));
const int = (v, min, max, label) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : fail(`${label} must be a whole number from ${min} to ${max}`));

/** Validates one settings section against its defaults: unknown keys are ignored, wrong types refused. */
export function cleanSection(key, value) {
  if (!SETTING_KEYS.includes(key)) fail('Unknown settings section', 404);
  if (!value || typeof value !== 'object') fail('Please send the settings to save');
  const base = DEFAULT_SETTINGS[key];
  const out = {};
  if (key === 'notifications') {
    for (const event of Object.keys(base)) {
      if (!value[event]) continue;
      out[event] = {};
      for (const ch of ['email', 'sms', 'whatsapp']) if (value[event][ch] !== undefined) out[event][ch] = bool(value[event][ch], `${NOTIFICATION_EVENTS[event]} (${ch})`);
    }
    return out;
  }
  for (const [field, def] of Object.entries(base)) {
    if (value[field] === undefined) continue;
    if (typeof def === 'boolean') out[field] = bool(value[field], field);
    else if (typeof def === 'number') {
      const limits = { abandonedCartHours: [1, 168], duplicateWindowHours: [1, 720], firstResponseHours: [1, 240], resolutionHours: [1, 720], winBackDays: [30, 730] }[field];
      out[field] = int(value[field], ...limits, field);
    } else out[field] = text(value[field], field === 'address' ? 300 : 120);
  }
  if (out.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(out.gstin.toUpperCase())) fail('Please enter a valid 15-character GSTIN');
  if (out.gstin) out.gstin = out.gstin.toUpperCase();
  if (out.email && !EMAIL_RE.test(out.email)) fail('Please enter a valid company email');
  for (const c of ['abandonedCartCoupon', 'birthdayCoupon']) if (out[c]) out[c] = out[c].toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
  return out;
}

export async function saveSection(db, staff, key, value) {
  const clean = cleanSection(key, value);
  await db(
    `INSERT INTO crm_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = crm_settings.value || EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, JSON.stringify(clean), staff.id],
  );
  await audit(db, staff, 'settings.update', 'settings', key, clean);
  return clean;
}

/** Runs `job` at most once every `seconds` across all serverless instances (a timestamp row in crm_settings). */
export async function throttled(db, key, seconds, job) {
  const [won] = await db(
    `INSERT INTO crm_settings (key, value, updated_at) VALUES ($1, '{}'::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET updated_at = NOW() WHERE crm_settings.updated_at < NOW() - make_interval(secs => $2)
     RETURNING key`,
    [`run:${key}`, seconds],
  );
  return won ? job() : null;
}
