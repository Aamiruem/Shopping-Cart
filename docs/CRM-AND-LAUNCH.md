# Arvixa CRM and public launch

Reference for the store team and developers: what was built, where it lives, how to switch on each integration, and
what must happen before the live site is updated.

Stack as deployed: React (Vite) storefront + Vercel functions in `api/` + Neon PostgreSQL. The CRM is part of that
same app and database. It does not use MongoDB, Socket.IO or Redis; see "Design notes" for why.

## 1. Modules

| Module | Where | What it does |
|---|---|---|
| Access control | `api/_crm_core.mjs` | 8 built-in roles + custom roles, 28 permissions, server-side check on every CRM request, session log, audit log |
| Dashboard | `api/_crm_sales.mjs` → `dashboard` · `pages/crm/Dashboard.jsx` | All KPIs from live tables, date ranges, charts, funnel, recent orders/leads, my tasks |
| Customers | `api/_crm_customers.mjs` · `Customers.jsx`, `CustomerDetail.jsx` | Every account is a customer; profile, segments, tags, owner, consent, notes, timeline, import/export, deactivate |
| Leads | `api/_leads.mjs` (forms) + `api/_crm_leads.mjs` · `Leads.jsx` | 7-stage pipeline (drag and drop), auto-capture, duplicates merged, explained lead score, activities |
| Sales & orders | `api/_crm_sales.mjs` · `Sales.jsx`, `Invoice.jsx` | Orders, fulfilment, cancel (restock + refund), courier booking, returns/refunds, invoices, forecast |
| Catalog verification | `api/_crm_catalog.mjs` · `Catalog.jsx` | 12-point checklist, approve/reject/publish/coming soon/out of stock/disable/discontinue |
| Marketing | `api/_crm_marketing.mjs` · `Marketing.jsx` | Campaigns (email/SMS/WhatsApp) to consenting people only, batched sending, delivery stats, newsletter, automations |
| Support | `api/_crm_support.mjs` + `api/_support.mjs` · `Support.jsx` | 5 statuses, owners, internal notes, response-time targets, tickets on a customer's behalf |
| Tasks | `api/_crm_team.mjs` · `Tasks.jsx` | Tasks and follow-ups linked to leads/customers/tickets, overdue shown automatically, calendar |
| Reports | `api/_crm_sales.mjs` → `report` · `Reports.jsx` | 10 reports with written definitions; CSV, Excel (.xlsx) and PDF (print) |
| AI insights | `api/_crm_insights.mjs` · `Insights.jsx` | RFM segments, churn risk, lead scores, behaviour, product insights, sentiment, backtested forecast |
| Team & roles | `api/_crm_team.mjs` · `Team.jsx` | Members, roles, login history, end one or all sessions |
| Settings & audit | `api/_crm.mjs` · `Settings.jsx` | Company, notifications, lead capture, support targets, automations, integration status, audit log |
| Messaging | `api/_messaging.mjs`, `api/_crm_webhooks.mjs`, `api/crm-webhooks.mjs` | Resend/SMTP, Twilio/MSG91, WhatsApp Cloud API; signed delivery webhooks |
| Shipping | `api/_shipping.mjs` | Shiprocket serviceability at checkout, shipment booking (real AWB), tracking webhook |
| Launch features | `api/_catalog.mjs`, `api/_auth.mjs`, `context/CartContext.jsx`, `components/account/WelcomeSheet.jsx` | Product statuses, customer/order numbers, mobile OTP sign-up, guest cart, welcome popup |

## 2. Database changes (`api/_schema.mjs`, applied by `npm run db:setup`)

All additive and idempotent. New tables: `crm_roles`, `crm_staff`, `crm_sessions`, `crm_audit_log`,
`crm_customer_profiles`, `crm_notes`, `crm_tasks`, `crm_campaigns`, `crm_messages`, `crm_suppressions`, `crm_settings`,
`product_verifications`, `shipments`, `shipment_events`. New sequences: `arv_customer_seq`, `arv_order_seq`.

New columns: `users.disabled_at`, `users.sessions_revoked_at`, `users.customer_code` (unique),
`orders.order_number` (unique), `orders.delivery_check`, `support_tickets.assigned_to / first_response_at / closed_at`,
`ticket_messages.internal`. Existing users and orders are numbered once, in id order.

New indexes on users, orders, order_items, leads (two partial unique indexes stop duplicate sign-up and abandoned-cart
leads), support tickets, messages and the audit log.

`db:setup` also inserts `crm_settings.catalog = {"requireVerification": true}` if it isn't set: from then on **no product
is shown or sold until an admin verifies it**.

## 3. API (all under `/api/crm`, Bearer token, permission in brackets)

| Method & path | Permission |
|---|---|
| `GET me`, `GET team`, `GET feed`, `POST feed/seen` | any CRM user |
| `GET dashboard?from&to` | dashboard.view |
| `GET customers` `POST customers` `POST customers/import` `GET customers/export` `GET/PATCH customers/:id` | customers.view / edit / import / export |
| `POST notes`, `DELETE notes/:id` | notes.write |
| `GET leads?view=board` `POST leads` `POST leads/sync` `GET leads/:id` (+ existing `PATCH/DELETE /api/leads/:id`) | leads.view / edit / delete |
| `GET orders` `GET orders/export` `GET orders/:id` `GET orders/:id/invoice` | sales.view / reports.export |
| `PATCH orders/:id/fulfilment`, `POST orders/:id/cancel` | orders.edit |
| `POST orders/:id/shipment` | shipping.manage |
| `GET refunds`, `PATCH refunds/:orderId` (approve / reject / receive / refund) | sales.view / refunds.manage |
| `GET catalog` `GET catalog/:id` `POST catalog/:id/verification` `POST catalog/:id/status` `GET/PUT catalog/settings` | catalog.view / verify |
| `GET tickets` `POST tickets` `GET/PATCH tickets/:id` `POST tickets/:id/messages` | support.view / edit |
| `GET/POST campaigns` `GET/PATCH/DELETE campaigns/:id` `POST campaigns/:id/send` `POST campaigns/:id/cancel` | marketing.view / send |
| `GET messages` `POST messages` (one-off) `POST messages/retry` `GET newsletter` `POST newsletter/:id/unsubscribe` `POST automations/run` | marketing.* / notes.write |
| `GET/POST tasks`, `PATCH/DELETE tasks/:id` | own tasks; others need tasks.manage |
| `GET reports/:id?from&to&export=1` (sales, revenue, products, customers, leads, conversion, employees, campaigns, retention, refunds) | reports.view / export |
| `GET insights?section=` (customers, forecast, behaviour, products, sentiment, enquiries) | insights.view |
| `GET/POST staff` `PATCH/DELETE staff/:id` `GET staff/:id/sessions` `POST staff/:id/revoke-sessions` `POST sessions/:id/revoke` | staff.manage (own sessions: anyone) |
| `GET/POST roles` `PATCH/DELETE roles/:key` | staff.manage |
| `GET/PUT settings`, `GET integrations`, `GET audit` | settings.manage / audit.view |
| `GET/POST unsubscribe?c&a&t` | public, signed link |
| `GET cron` | `Authorization: Bearer $CRON_SECRET` (Vercel Cron, daily 03:30 UTC) |

Other new endpoints: `POST /api/auth/mobile/start | mobile/login | mobile/complete` (mobile sign-in / sign-up),
`GET /api/shipping/check?pincode=&cod=1`, `GET /api/products?availability=coming_soon`,
`POST /api/webhooks/{resend|whatsapp|twilio|courier}` (signed).

## 4. Admin access

1. The store admin account (`users.role = 'admin'`) is Super Admin. Log in, open **More → CRM Dashboard**.
2. To give someone access: they sign up on the store themselves, then **CRM → Team & roles → Add team member** with
   their email and a role. Only the Super Admin can grant `staff.manage`; nobody can grant a permission they lack.
3. Customers, sellers and guests never see the link, and `/crm` sends them home; every API call is checked again.

## 5. Integrations (set in Vercel → Settings → Environment Variables, Production; then redeploy)

CRM → Settings → Integrations shows live status and exactly which variables are missing. See `.env.example`.

| Service | Variables | Also needed |
|---|---|---|
| Site links | `SITE_URL` | Required for unsubscribe links (marketing email refuses to send without it) |
| Email | `RESEND_API_KEY`, `EMAIL_FROM` (or `SMTP_*`), `RESEND_WEBHOOK_SECRET` | Verified sending domain in Resend; webhook → `/api/webhooks/resend` |
| SMS | `TWILIO_*` or `MSG91_AUTH_KEY` + `MSG91_OTP_TEMPLATE_ID` + `MSG91_NOTIFY_TEMPLATE_ID` | India: DLT entity + sender ID + approved templates |
| WhatsApp | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME` (OTP), `WHATSAPP_UPDATE_TEMPLATE`, `WHATSAPP_MARKETING_TEMPLATE`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | Verified Meta business, approved templates, webhook → `/api/webhooks/whatsapp` |
| Payments | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay KYC/live activation. **The key committed in acdfc56 must be regenerated first.** |
| Courier | `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`, `SHIPROCKET_PICKUP_POSTCODE`, `SHIPROCKET_PICKUP_LOCATION`, `SHIPROCKET_WEBHOOK_TOKEN` | Shiprocket account + KYC + pickup address; tracking webhook → `/api/webhooks/courier` |
| Daily job | `CRON_SECRET` | — |

Without a provider, its channel is simply off: no fake "sent", no fake tracking number, no fake serviceability.
Messages show *accepted* when the provider took them and *delivered/opened* only when its webhook says so.

## 6. Tests

`cd frontend && npm test` — 159 tests on PGlite (real PostgreSQL), including `scripts/crm.test.mjs` (14) and
`scripts/launch.test.mjs` (5): access control and masking, privilege escalation, session revocation and deactivation,
customer dedupe/import/export, dashboard and report totals against placed orders, auto-leads and dedupe, support
internal notes, campaign consent/suppression/one-send, signed webhooks, unsubscribe, automations, WhatsApp leads,
tasks, forecast validation, product verification gating at cart and checkout, concurrent order numbers, order
privacy, mobile OTP sign-up, courier checks and tracking dedupe.

## 7. Deploying (in this order)

1. Regenerate the leaked Razorpay key (if online payments will be used).
2. `npm run db:setup` against Neon — **switches product verification on**: the live storefront then lists nothing
   until products are verified in CRM → Catalog verification.
3. Verify the products you really stock (or add your real products in Seller Hub and verify those).
4. Set `SITE_URL`, `CRON_SECRET` and whichever providers you have; then deploy
   (`CI=1 node "$LOCALAPPDATA/npm-cache/_npx/c760c4d48bfe0d75/node_modules/vercel/dist/vc.js" deploy --prod --yes`).

## 8. Design notes and known limits

- **Real time:** Vercel functions can't hold Socket.IO connections. The CRM polls a feed built from the source tables
  every 20 s while the tab is visible; events have stable ids, so nothing is announced twice.
- **Login tokens** stay Bearer tokens in localStorage (the existing scheme). Revocation, deactivation and per-session
  ending are enforced on `/auth/me`, shopping, ordering and every CRM request. Moving to HttpOnly cookies would be a
  store-wide change (and would then need CSRF protection); not done.
- **AI:** rules and statistics on the store's own data, each with its method shown; no uncalibrated probabilities.
  The Python ML service in `ai-service/` has no host, so it isn't used. Nothing automated sends, refunds or changes
  accounts without a person.
- **Delivery fee** stays the published ₹40 / free over ₹499; the courier's rate is recorded on the order, not charged.
- **Tax:** prices include GST; a per-line tax breakdown needs HSN codes and rates the catalog doesn't hold.
- **Address form** keeps line 1 / city / state / pincode; separate landmark and district fields were not added.
- **Sample catalog:** `backend/app/data/products.json` is sample data. With verification on it is never shown or
  sold unless an admin verifies each product against a real supplier.
