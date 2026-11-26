// /api/crm/* — the CRM API. Every route names the permission it needs; crmUser() checks the token, the account, the
// session and the CRM role on every request, so hiding a menu item is never the only protection.
//
// Public exceptions (no login): GET/POST unsubscribe (a signed link), GET cron (Vercel Cron with CRON_SECRET).
import { createHash, timingSafeEqual } from 'node:crypto';
import { query, safely, limit, postgresStore } from './_auth.mjs';
import { addNote, createCustomer, deleteNote, exportCustomers, getCustomer, importCustomers, listCustomers, updateCustomer } from './_crm_customers.mjs';
import { catalogSettings, getCatalogProduct, listCatalog, saveVerification, setProductStatus } from './_crm_catalog.mjs';
import { insights } from './_crm_insights.mjs';
import { createLead, getLead, LEAD_SOURCES, listLeads, syncAutoLeads } from './_crm_leads.mjs';
import {
  cancelCampaign, createCampaign, deleteCampaign, getCampaign, listCampaigns, listMessages, listSubscribers, publicUnsubscribe, retryMessages, runAutomations,
  sendCampaign, sendDirect, staffUnsubscribe, updateCampaign,
} from './_crm_marketing.mjs';
import { bookShipment, cancelOrder, dashboard, getOrder, invoice, listOrders, refundAction, refundsList, report, REPORTS, setFulfilment } from './_crm_sales.mjs';
import { createTicket, getTicket, listTickets, replyTicket, updateTicket } from './_crm_support.mjs';
import {
  addStaff, auditLog, createRole, createTask, deleteRole, deleteTask, feed, listRoles, listStaff, listTasks, markFeedSeen, removeStaff, revokeSession,
  revokeSessions, sessions, updateRole, updateStaff, updateTask,
} from './_crm_team.mjs';
import { assignable, audit, crmUser, DEFAULT_SETTINGS, fail, getSettings, NOTIFICATION_EVENTS, need, saveSection } from './_crm_core.mjs';
import { channelStatus, siteUrl } from './_messaging.mjs';
import { providerStatus } from './_otp.mjs';

async function me({ db, staff }) {
  const settings = await getSettings(db);
  return {
    body: {
      id: staff.id, name: staff.name, email: staff.email, role: staff.role, roleName: staff.roleName, title: staff.title ?? null,
      permissions: [...staff.permissions], owner: staff.owner, sessionId: staff.sessionId,
      company: settings.company.name, leadSources: LEAD_SOURCES, reports: REPORTS,
    },
  };
}

function integrations() {
  const env = process.env;
  const messaging = channelStatus(env);
  const has = (...names) => names.every((n) => Boolean(env[n]));
  return {
    body: {
      siteUrl: siteUrl(env) || null,
      messaging,
      otp: providerStatus(env),
      payments: { provider: 'razorpay', configured: has('RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'), webhook: has('RAZORPAY_WEBHOOK_SECRET') },
      shipping: { provider: 'shiprocket', configured: has('SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_PICKUP_POSTCODE'), webhook: has('SHIPROCKET_WEBHOOK_TOKEN') },
      cron: { configured: has('CRON_SECRET') },
      encryption: { configured: has('DATA_ENCRYPTION_KEY') },
      // What each provider needs, so the page can say exactly what to set (names only, never values)
      setup: {
        email: ['RESEND_API_KEY + EMAIL_FROM (a domain verified in Resend)', 'or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS + EMAIL_FROM', 'RESEND_WEBHOOK_SECRET for delivered / opened / bounced reports', 'MARKETING_EMAIL_FROM (optional)'],
        sms: ['TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM', 'or MSG91_AUTH_KEY + MSG91_NOTIFY_TEMPLATE_ID (DLT-approved, one ##VAR1## variable), SMS_PROVIDER=msg91'],
        whatsapp: ['WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_UPDATE_TEMPLATE (utility) and WHATSAPP_MARKETING_TEMPLATE (marketing), each with one body variable', 'WHATSAPP_APP_SECRET + WHATSAPP_VERIFY_TOKEN for the webhook (incoming messages and delivery reports)'],
        site: ['SITE_URL, e.g. https://arvixa-store.vercel.app (links in messages, unsubscribe)'],
        cron: ['CRON_SECRET (Vercel sends it to the daily job)'],
        shipping: ['SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD (an API user: Shiprocket → Settings → API)', 'SHIPROCKET_PICKUP_POSTCODE and SHIPROCKET_PICKUP_LOCATION (the pickup address name in Shiprocket)', 'SHIPROCKET_WEBHOOK_TOKEN, set on the tracking webhook pointing at /api/webhooks/courier'],
        payments: ['RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (live keys after KYC)', 'RAZORPAY_WEBHOOK_SECRET with events payment.captured, payment.failed, refund.processed'],
      },
      webhookUrls: siteUrl(env) ? {
        resend: `${siteUrl(env)}/api/webhooks/resend`, courier: `${siteUrl(env)}/api/webhooks/courier`, whatsapp: `${siteUrl(env)}/api/webhooks/whatsapp`, twilio: `${siteUrl(env)}/api/webhooks/twilio`,
      } : null,
    },
  };
}

async function settingsGet({ db }) {
  return { body: { settings: await getSettings(db), defaults: DEFAULT_SETTINGS, notificationEvents: NOTIFICATION_EVENTS } };
}

async function settingsPut({ db, staff, body }) {
  const saved = {};
  for (const [key, value] of Object.entries(body || {})) saved[key] = await saveSection(db, staff, key, value);
  if (!Object.keys(saved).length) fail('Nothing to save');
  return settingsGet({ db });
}

const routes = [
  // [method, path, permission (null = any CRM user), handler]
  ['GET', 'me', null, me],
  ['GET', 'team', null, async ({ db, params }) => ({ body: await assignable(db, params.permission || null) })],
  ['GET', 'feed', null, feed],
  ['POST', 'feed/seen', null, markFeedSeen],
  ['GET', 'dashboard', 'dashboard.view', dashboard],

  ['GET', 'customers', 'customers.view', listCustomers],
  ['POST', 'customers', 'customers.edit', createCustomer],
  ['POST', 'customers/import', 'customers.import', importCustomers],
  ['GET', 'customers/export', 'customers.export', exportCustomers],
  ['GET', 'customers/:id', 'customers.view', getCustomer],
  ['PATCH', 'customers/:id', 'customers.edit', updateCustomer],
  ['POST', 'notes', 'notes.write', addNote],
  ['DELETE', 'notes/:id', 'notes.write', deleteNote],

  ['GET', 'leads', 'leads.view', listLeads],
  ['POST', 'leads', 'leads.edit', createLead],
  ['POST', 'leads/sync', 'leads.edit', async ({ db, staff }) => {
    const out = await syncAutoLeads(db, { force: true });
    await audit(db, staff, 'leads.sync', 'lead', null, out);
    return { body: out };
  }],
  ['GET', 'leads/:id', 'leads.view', getLead],

  ['GET', 'orders', 'sales.view', listOrders],
  ['GET', 'orders/export', 'reports.export', async (ctx) => {
    const out = await listOrders({ ...ctx, params: { ...ctx.params, page: 1, pageSize: 5000 } }, { max: 5000 });
    await audit(ctx.db, ctx.staff, 'orders.export', 'order', null, { rows: out.body.items.length });
    return out;
  }],
  ['GET', 'orders/:id', 'sales.view', getOrder],
  ['GET', 'orders/:id/invoice', 'sales.view', invoice],
  ['PATCH', 'orders/:id/fulfilment', 'orders.edit', setFulfilment],
  ['POST', 'orders/:id/cancel', 'orders.edit', cancelOrder],
  ['POST', 'orders/:id/shipment', 'shipping.manage', bookShipment],
  ['GET', 'refunds', 'sales.view', refundsList],
  ['PATCH', 'refunds/:id', 'refunds.manage', refundAction],

  ['GET', 'catalog', 'catalog.view', listCatalog],
  ['GET', 'catalog/settings', 'catalog.view', (ctx) => catalogSettings({ ...ctx, method: 'GET' })],
  ['PUT', 'catalog/settings', 'settings.manage', (ctx) => catalogSettings({ ...ctx, method: 'PUT' })],
  ['GET', 'catalog/:id', 'catalog.view', getCatalogProduct],
  ['POST', 'catalog/:id/verification', 'catalog.verify', saveVerification],
  ['POST', 'catalog/:id/status', 'catalog.verify', setProductStatus],

  ['GET', 'tickets', 'support.view', listTickets],
  ['POST', 'tickets', 'support.edit', createTicket],
  ['GET', 'tickets/:id', 'support.view', getTicket],
  ['PATCH', 'tickets/:id', 'support.edit', updateTicket],
  ['POST', 'tickets/:id/messages', 'support.edit', replyTicket],

  ['GET', 'campaigns', 'marketing.view', listCampaigns],
  ['POST', 'campaigns', 'marketing.send', createCampaign],
  ['GET', 'campaigns/:id', 'marketing.view', getCampaign],
  ['PATCH', 'campaigns/:id', 'marketing.send', updateCampaign],
  ['DELETE', 'campaigns/:id', 'marketing.send', deleteCampaign],
  ['POST', 'campaigns/:id/send', 'marketing.send', sendCampaign],
  ['POST', 'campaigns/:id/cancel', 'marketing.send', cancelCampaign],
  ['GET', 'messages', 'marketing.view', listMessages],
  ['POST', 'messages', 'notes.write', sendDirect],
  ['POST', 'messages/retry', 'marketing.send', retryMessages],
  ['GET', 'newsletter', 'marketing.view', listSubscribers],
  ['POST', 'newsletter/:id/unsubscribe', 'marketing.send', staffUnsubscribe],
  ['POST', 'automations/run', 'marketing.send', async ({ db, staff }) => ({ body: await runAutomations(db, { staff }) })],

  ['GET', 'tasks', null, listTasks],
  ['POST', 'tasks', null, createTask],
  ['PATCH', 'tasks/:id', null, updateTask],
  ['DELETE', 'tasks/:id', null, deleteTask],

  ['GET', 'reports/:id', 'reports.view', report],
  ['GET', 'insights', 'insights.view', insights],

  ['GET', 'staff', 'staff.manage', listStaff],
  ['POST', 'staff', 'staff.manage', addStaff],
  ['PATCH', 'staff/:id', 'staff.manage', updateStaff],
  ['DELETE', 'staff/:id', 'staff.manage', removeStaff],
  ['GET', 'staff/:id/sessions', null, sessions],
  ['POST', 'staff/:id/revoke-sessions', null, revokeSessions],
  ['POST', 'sessions/:id/revoke', null, revokeSession],
  ['GET', 'roles', 'staff.manage', listRoles],
  ['POST', 'roles', 'staff.manage', createRole],
  ['PATCH', 'roles/:id', 'staff.manage', updateRole],
  ['DELETE', 'roles/:id', 'staff.manage', deleteRole],

  ['GET', 'settings', 'settings.manage', settingsGet],
  ['PUT', 'settings', 'settings.manage', settingsPut],
  ['GET', 'integrations', 'settings.manage', integrations],
  ['GET', 'audit', 'audit.view', auditLog],
];

function findRoute(method, rest) {
  for (const [m, path, permission, handler] of routes) {
    if (m !== method) continue;
    const parts = path.split('/');
    if (parts.length !== rest.length) continue;
    let id;
    const ok = parts.every((p, i) => {
      if (p === ':id') {
        id = rest[i];
        return /^[\w-]{1,64}$/.test(rest[i] ?? '');
      }
      return p === rest[i];
    });
    if (ok) return { permission, handler, id };
  }
  return null;
}

const PUBLIC = ['GET unsubscribe', 'POST unsubscribe', 'GET cron'];
export const isCrmRoute = (method, rest) => PUBLIC.includes(`${method} ${rest.join('/')}`) || Boolean(findRoute(method, rest));

function cronAllowed(authorization, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const a = createHash('sha256').update(String(authorization || '')).digest();
  const b = createHash('sha256').update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

/** The daily job (vercel.json crons): automatic leads, automations, retrying failed messages */
async function cron(db) {
  const leads = await syncAutoLeads(db, { force: true });
  const automations = await runAutomations(db);
  await db("UPDATE crm_messages SET status = 'queued' WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '15 minutes' AND campaign_id IS NOT NULL");
  await audit(db, null, 'cron.daily', 'system', null, { leads, automations });
  return { leads, automations };
}

export function handleCrm({ method, rest, body, params = {}, authorization, ip = 'unknown', userAgent = '' }, { db = query } = {}) {
  return safely(async () => {
    const key = `${method} ${rest.join('/')}`;
    if (key === 'GET unsubscribe' || key === 'POST unsubscribe') {
      await limit(postgresStore(db), `unsub:${ip}`, 30, 'Too many requests. Please try again later.');
      return publicUnsubscribe({ db, method, params, body });
    }
    if (key === 'GET cron') {
      if (!cronAllowed(authorization)) fail('Not allowed', 401);
      return { body: await cron(db) };
    }
    const route = findRoute(method, rest);
    if (!route) fail('Not found', 404);
    const staff = await crmUser(db, authorization, { ip, userAgent });
    if (route.permission) need(staff, route.permission);
    // Writes are rate-limited per person: generous for real work, a ceiling for a runaway script or a stolen token
    if (method !== 'GET') await limit(postgresStore(db), `crm-write:${staff.id}`, 600, 'Too many changes in a short time. Please wait a few minutes.');
    return route.handler({ db, staff, id: route.id, body: body ?? {}, params, ip });
  });
}
