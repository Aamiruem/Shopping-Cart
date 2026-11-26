// Tables only the Vercel store needs, on top of backend/app/db/schema.sql. Applied by scripts/setup-db.mjs.
export const STORE_SCHEMA = `
-- Login and order attempt counters: serverless instances share no memory, so they live in the database
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key      VARCHAR(64) PRIMARY KEY,
  hits     INT         NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL
);

-- The full backend keeps carts and wishlists in MongoDB
CREATE TABLE IF NOT EXISTS cart_items (
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  qty        INTEGER     NOT NULL CHECK (qty > 0),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);
-- One-time codes (api/_otp.mjs): verification_codes itself is in backend/app/db/schema.sql. verified_at tells a code
-- that was used apart from one replaced by a newer code. The log holds outcomes only: masked addresses, never codes.
ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS verification_codes_target_idx ON verification_codes (target, created_at DESC);
CREATE TABLE IF NOT EXISTS otp_delivery_logs (
  id              SERIAL       PRIMARY KEY,
  verification_id INTEGER      REFERENCES verification_codes(id) ON DELETE SET NULL,
  purpose         VARCHAR(20)  NOT NULL,
  channel         VARCHAR(10)  NOT NULL,
  provider        VARCHAR(20),
  target_masked   VARCHAR(255) NOT NULL,
  status          VARCHAR(20)  NOT NULL,                 -- accepted | failed | not_sent_dev
  provider_ref    VARCHAR(120),
  error           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS otp_delivery_logs_recent_idx ON otp_delivery_logs (created_at DESC);

-- Sizes and colours (api/_variants.mjs): one cart line per product + size + colour. '' = the product has no such option.
-- Existing rows keep working as lines without options; the key widens once, and running this again changes nothing.
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS size  VARCHAR(20) NOT NULL DEFAULT '';
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS color VARCHAR(20) NOT NULL DEFAULT '';
DO $$
BEGIN
  IF (SELECT array_length(conkey, 1) FROM pg_constraint WHERE conrelid = 'cart_items'::regclass AND contype = 'p') = 2 THEN
    ALTER TABLE cart_items DROP CONSTRAINT cart_items_pkey;
    ALTER TABLE cart_items ADD PRIMARY KEY (user_id, product_id, size, color);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wishlist_items (
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

-- Products sellers list in the Seller Hub (the full backend keeps these in MongoDB). The data column holds the product in the
-- catalog's shape; listed ones join the public catalog (api/_seller.mjs syncSellerProducts).
CREATE TABLE IF NOT EXISTS seller_products (
  id         VARCHAR(24) PRIMARY KEY,                     -- 24 hex characters, like a MongoDB id
  seller_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS seller_products_seller_idx ON seller_products (seller_id, updated_at DESC);

-- Coupons, returns and refunds, complaint conversations and review photos are in backend/app/db/schema.sql:
-- both backends use them.

-- Product page views, one per visitor per product per day: a demand signal for recommendations (api/_recommend.mjs).
-- visitor is "u<user id>" when signed in, otherwise a random id the browser keeps.
CREATE TABLE IF NOT EXISTS product_views (
  product_id VARCHAR(64) NOT NULL,
  visitor    VARCHAR(40) NOT NULL,
  user_id    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  day        DATE        NOT NULL DEFAULT CURRENT_DATE,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (visitor, product_id, day)
);
CREATE INDEX IF NOT EXISTS product_views_product_idx ON product_views (product_id, at DESC);
CREATE INDEX IF NOT EXISTS product_views_user_idx ON product_views (user_id, at DESC) WHERE user_id IS NOT NULL;

-- The admin's edits to the store's own catalog (products.json is read-only): price, MRP, stock, name, description,
-- listed or hidden. Applied over the file in api/_inventory.mjs.
CREATE TABLE IF NOT EXISTS catalog_overrides (
  product_id VARCHAR(64) PRIMARY KEY,
  data       JSONB       NOT NULL,
  updated_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stock sold and given back for the store's own catalog: stock = (override or file stock) + delta. Orders take stock,
-- cancellations and returns put it back. Seller products keep their stock in seller_products.data instead.
CREATE TABLE IF NOT EXISTS stock_adjustments (
  product_id VARCHAR(64) PRIMARY KEY,
  delta      INTEGER     NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enquiries people send the store themselves (contact form, product questions, bulk quotes, newsletter), each with the
-- consent they ticked. kind / intent / summary come from keyword rules in api/_leads.mjs; matches are catalog ids.
CREATE TABLE IF NOT EXISTS leads (
  id                SERIAL       PRIMARY KEY,
  source            VARCHAR(16)  NOT NULL,                 -- contact | product | quote | business | newsletter
  kind              VARCHAR(20)  NOT NULL,                 -- product_enquiry | quote | support | business | newsletter
  name              VARCHAR(80),
  email             VARCHAR(254),
  phone             VARCHAR(15),
  user_id           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  product_id        VARCHAR(64),
  message           TEXT,
  budget            INTEGER,                               -- rupees, given or read from the message
  quantity          INTEGER,
  intent            VARCHAR(8)   NOT NULL DEFAULT 'medium', -- high | medium | low
  summary           TEXT,
  matches           JSONB        NOT NULL DEFAULT '[]',
  status            VARCHAR(16)  NOT NULL DEFAULT 'new',    -- new | contacted | qualified | won | lost | unsubscribed
  assigned_to       INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  follow_up_on      DATE,
  notes             JSONB        NOT NULL DEFAULT '[]',     -- [{ at, by, text }]
  marketing_consent BOOLEAN      NOT NULL DEFAULT FALSE,
  consent_at        TIMESTAMPTZ  NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_email_idx ON leads (lower(email)) WHERE email IS NOT NULL;
-- One newsletter subscription per address
CREATE UNIQUE INDEX IF NOT EXISTS leads_newsletter_idx ON leads (lower(email)) WHERE source = 'newsletter';

-- ================= CRM (api/_crm*.mjs) =================
-- Everything below is additive: existing tables only gain nullable / defaulted columns and indexes.

-- Accounts: an admin can deactivate one (login refused, open sessions end) or end all of a person's sessions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at         TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS users_phone_idx   ON users (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, created_at DESC);

-- Team members with CRM access. The store admin (users.role = 'admin') is always Super Admin and needs no row here.
-- Built-in roles live in code (api/_crm_core.mjs); crm_roles holds the custom roles an admin creates.
CREATE TABLE IF NOT EXISTS crm_roles (
  key         VARCHAR(40)  PRIMARY KEY,
  name        VARCHAR(60)  NOT NULL,
  description TEXT,
  permissions JSONB        NOT NULL DEFAULT '[]',
  created_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS crm_staff (
  user_id      INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_key     VARCHAR(40) NOT NULL,
  title        VARCHAR(80),
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  feed_seen_at TIMESTAMPTZ,
  added_by     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One row per login token used on the CRM: login history, last activity, and revocation of a single session
CREATE TABLE IF NOT EXISTS crm_sessions (
  id         SERIAL       PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64)     NOT NULL UNIQUE,              -- sha256 of the token: the token itself is never stored
  ip         VARCHAR(64),
  user_agent VARCHAR(200),
  issued_at  TIMESTAMPTZ,
  first_seen TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_sessions_user_idx ON crm_sessions (user_id, last_seen DESC);
-- Who did what: logins, customer edits, assignments, order changes, refunds, permission and settings changes, exports
CREATE TABLE IF NOT EXISTS crm_audit_log (
  id         BIGSERIAL    PRIMARY KEY,
  actor_id   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  actor_name VARCHAR(100),
  action     VARCHAR(60)  NOT NULL,
  entity     VARCHAR(30),
  entity_id  VARCHAR(64),
  details    JSONB        NOT NULL DEFAULT '{}',
  ip         VARCHAR(64),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crm_audit_recent_idx ON crm_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS crm_audit_actor_idx  ON crm_audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_audit_entity_idx ON crm_audit_log (entity, entity_id);

-- CRM details of a customer (an account in users): tags, owner, dates for greetings, and per-channel marketing consent
CREATE TABLE IF NOT EXISTS crm_customer_profiles (
  user_id            INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tags               JSONB       NOT NULL DEFAULT '[]',
  assigned_to        INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  birthday           DATE,
  anniversary        DATE,
  email_opt_in       BOOLEAN     NOT NULL DEFAULT FALSE,
  sms_opt_in         BOOLEAN     NOT NULL DEFAULT FALSE,
  whatsapp_opt_in    BOOLEAN     NOT NULL DEFAULT FALSE,
  consent_updated_at TIMESTAMPTZ,
  source             VARCHAR(20) NOT NULL DEFAULT 'website', -- website | crm | import
  created_by         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crm_profiles_assigned_idx ON crm_customer_profiles (assigned_to);

-- Notes and logged interactions (call, meeting, email, SMS, WhatsApp) on a customer, lead, order or ticket. Soft-deleted.
CREATE TABLE IF NOT EXISTS crm_notes (
  id          SERIAL      PRIMARY KEY,
  entity      VARCHAR(20) NOT NULL,                    -- customer | lead | order | ticket
  entity_id   VARCHAR(64) NOT NULL,
  kind        VARCHAR(12) NOT NULL DEFAULT 'note',     -- note | call | meeting | email | sms | whatsapp
  body        TEXT        NOT NULL,
  outcome     VARCHAR(120),
  happened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  author_id   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_notes_entity_idx ON crm_notes (entity, entity_id, happened_at DESC);

-- Tasks and follow-ups. "Overdue" is not stored: it is an open task whose due time has passed.
CREATE TABLE IF NOT EXISTS crm_tasks (
  id           SERIAL       PRIMARY KEY,
  title        VARCHAR(160) NOT NULL,
  description  TEXT,
  kind         VARCHAR(20)  NOT NULL DEFAULT 'general',   -- general | lead_follow_up | customer_follow_up | support_follow_up
  priority     VARCHAR(8)   NOT NULL DEFAULT 'medium',    -- low | medium | high
  status       VARCHAR(12)  NOT NULL DEFAULT 'pending',   -- pending | in_progress | completed | cancelled
  due_at       TIMESTAMPTZ,
  assigned_to  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  lead_id      INTEGER      REFERENCES leads(id) ON DELETE CASCADE,
  customer_id  INTEGER      REFERENCES users(id) ON DELETE CASCADE,
  ticket_id    INTEGER      REFERENCES support_tickets(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_tasks_assignee_idx ON crm_tasks (assigned_to, status, due_at);
CREATE INDEX IF NOT EXISTS crm_tasks_due_idx      ON crm_tasks (due_at) WHERE deleted_at IS NULL;

-- Marketing campaigns, and every message the CRM sends or receives (campaigns, order updates, automations, WhatsApp
-- replies). status only moves forward on what the provider reports: accepted is not delivered.
CREATE TABLE IF NOT EXISTS crm_campaigns (
  id            SERIAL       PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  kind          VARCHAR(20)  NOT NULL DEFAULT 'promotional', -- promotional | newsletter | retention | follow_up
  channel       VARCHAR(10)  NOT NULL,                       -- email | sms | whatsapp
  audience      JSONB        NOT NULL DEFAULT '{}',
  subject       VARCHAR(200),
  body          TEXT         NOT NULL,
  template_name VARCHAR(80),
  coupon_code   VARCHAR(30),
  status        VARCHAR(12)  NOT NULL DEFAULT 'draft',        -- draft | sending | sent | cancelled
  created_by    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS crm_messages (
  id           BIGSERIAL    PRIMARY KEY,
  channel      VARCHAR(10)  NOT NULL,
  direction    VARCHAR(3)   NOT NULL DEFAULT 'out',          -- out | in
  kind         VARCHAR(14)  NOT NULL,                        -- campaign | transactional | automation | manual | inbound
  event        VARCHAR(40),
  dedupe_key   VARCHAR(160) UNIQUE,                          -- the same order update or campaign email is never sent twice
  user_id      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  lead_id      INTEGER      REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id  INTEGER      REFERENCES crm_campaigns(id) ON DELETE SET NULL,
  ticket_id    INTEGER      REFERENCES support_tickets(id) ON DELETE SET NULL,
  to_address   VARCHAR(255) NOT NULL,
  subject      VARCHAR(200),
  body         TEXT,
  status       VARCHAR(12)  NOT NULL DEFAULT 'queued',       -- queued | accepted | delivered | opened | clicked | bounced | failed | received
  provider     VARCHAR(20),
  provider_ref VARCHAR(120),
  error        TEXT,
  attempts     INTEGER      NOT NULL DEFAULT 0,
  sent_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  status_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_messages_campaign_idx ON crm_messages (campaign_id, status);
CREATE INDEX IF NOT EXISTS crm_messages_user_idx     ON crm_messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_messages_status_idx   ON crm_messages (status, created_at);
CREATE INDEX IF NOT EXISTS crm_messages_address_idx  ON crm_messages (lower(to_address));
CREATE UNIQUE INDEX IF NOT EXISTS crm_messages_ref_idx ON crm_messages (provider, provider_ref) WHERE provider_ref IS NOT NULL;
-- Addresses that unsubscribed or bounced: never sent marketing again on that channel
CREATE TABLE IF NOT EXISTS crm_suppressions (
  channel    VARCHAR(10)  NOT NULL,
  address    VARCHAR(255) NOT NULL,
  reason     VARCHAR(30)  NOT NULL,                          -- unsubscribed | bounced | complained | admin
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel, address)
);
CREATE TABLE IF NOT EXISTS crm_settings (
  key        VARCHAR(40) PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Support desk: an owner, response times, internal notes the customer never sees, and two more statuses
-- (waiting = waiting for the customer, closed = resolved and finished).
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to       INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS closed_at         TIMESTAMPTZ;
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS internal          BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status, updated_at DESC);

-- Leads captured automatically: one sign-up lead per account, and one open abandoned-cart lead per shopper
CREATE UNIQUE INDEX IF NOT EXISTS leads_registration_idx ON leads (user_id) WHERE source = 'registration';
CREATE UNIQUE INDEX IF NOT EXISTS leads_cart_open_idx ON leads (user_id)
  WHERE source = 'abandoned_cart' AND status IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation');
CREATE INDEX IF NOT EXISTS leads_assigned_idx ON leads (assigned_to, status);
CREATE INDEX IF NOT EXISTS leads_phone_idx    ON leads (phone) WHERE phone IS NOT NULL;

-- ================= Public launch: verified products, customer and order numbers, shipments =================
-- Product verification (CRM → Catalog): the evidence an admin checked before a product may be sold. A product's
-- status itself lives with the product (catalog_overrides.data.status / seller_products.data.status).
CREATE TABLE IF NOT EXISTS product_verifications (
  product_id   VARCHAR(64)  PRIMARY KEY,
  checks       JSONB        NOT NULL DEFAULT '{}',   -- { name: true, images: true, supplier: true, ... }
  supplier     VARCHAR(160),                         -- manufacturer or supplier
  evidence     TEXT,                                 -- invoice / authorisation / GST bill the admin saw
  condition    VARCHAR(20),                          -- new | refurbished | used
  warranty     VARCHAR(200),
  returnable   BOOLEAN,
  ships        BOOLEAN,
  notes        TEXT,
  decision     VARCHAR(12),                          -- approved | rejected
  decision_reason TEXT,
  verified_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  verified_at  TIMESTAMPTZ,
  updated_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Customer and order numbers people can quote: ARV-CUS-2026-000001, ARV-ORD-2026-000001. From database sequences,
-- so two sign-ups or checkouts at the same moment can never get the same number; the internal ids stay internal.
CREATE SEQUENCE IF NOT EXISTS arv_customer_seq;
CREATE SEQUENCE IF NOT EXISTS arv_order_seq;
ALTER TABLE users  ADD COLUMN IF NOT EXISTS customer_code VARCHAR(24);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number  VARCHAR(24);
UPDATE users SET customer_code = 'ARV-CUS-' || to_char(created_at, 'YYYY') || '-' || lpad(nextval('arv_customer_seq')::text, 6, '0')
 WHERE customer_code IS NULL AND id IN (SELECT id FROM users WHERE customer_code IS NULL ORDER BY id);
UPDATE orders SET order_number = 'ARV-ORD-' || to_char(created_at, 'YYYY') || '-' || lpad(nextval('arv_order_seq')::text, 6, '0')
 WHERE order_number IS NULL AND id IN (SELECT id FROM orders WHERE order_number IS NULL ORDER BY id);
ALTER TABLE users  ALTER COLUMN customer_code SET DEFAULT 'ARV-CUS-' || to_char(NOW(), 'YYYY') || '-' || lpad(nextval('arv_customer_seq')::text, 6, '0');
ALTER TABLE orders ALTER COLUMN order_number  SET DEFAULT 'ARV-ORD-' || to_char(NOW(), 'YYYY') || '-' || lpad(nextval('arv_order_seq')::text, 6, '0');
CREATE UNIQUE INDEX IF NOT EXISTS users_customer_code_idx ON users (customer_code);
CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_idx ON orders (order_number);

-- Shipments booked with the courier (api/_shipping.mjs): real AWB numbers and the courier's own tracking events only
CREATE TABLE IF NOT EXISTS shipments (
  id                SERIAL       PRIMARY KEY,
  order_id          INTEGER      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider          VARCHAR(20)  NOT NULL,              -- shiprocket
  provider_order_id VARCHAR(40),
  shipment_ref      VARCHAR(40),
  awb               VARCHAR(40),
  courier           VARCHAR(80),
  status            VARCHAR(30)  NOT NULL DEFAULT 'created',
  eta               DATE,
  label_url         TEXT,
  tracking_url      TEXT,
  last_event_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS shipments_order_idx ON shipments (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS shipments_awb_idx ON shipments (awb) WHERE awb IS NOT NULL;
CREATE TABLE IF NOT EXISTS shipment_events (
  id          SERIAL       PRIMARY KEY,
  shipment_id INTEGER      NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status      VARCHAR(40)  NOT NULL,
  location    VARCHAR(120),
  occurred_at TIMESTAMPTZ  NOT NULL,
  raw_key     VARCHAR(120) NOT NULL,                  -- the courier's event identity: a repeated webhook adds nothing
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (shipment_id, raw_key)
);
-- Delivery estimate and courier check made at checkout, kept with the order
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_check JSONB;
`;
