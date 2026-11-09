-- Users, addresses and orders live in PostgreSQL (relational, transactional data).
-- This file runs on every start, so every statement must be idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'customer',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone          VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id      VARCHAR(64) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;  -- Google-only accounts have no password

-- One-time codes that confirm online (UPI / card) payments
CREATE TABLE IF NOT EXISTS payment_otps (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  VARCHAR(64) NOT NULL,
  attempts   INTEGER     NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payment_otps_user_idx ON payment_otps (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS addresses (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  phone      VARCHAR(20)  NOT NULL,
  line1      TEXT         NOT NULL,
  city       VARCHAR(100) NOT NULL,
  state      VARCHAR(100) NOT NULL,
  pincode    VARCHAR(10)  NOT NULL,
  type       VARCHAR(10)  NOT NULL DEFAULT 'home',  -- home | work
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  total      NUMERIC(12, 2) NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'placed',  -- placed | cancelled
  address    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cod';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee   NUMERIC(12, 2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS order_items (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,  -- MongoDB product _id
  name       VARCHAR(255) NOT NULL,
  price      NUMERIC(12, 2) NOT NULL,
  qty        INTEGER NOT NULL CHECK (qty > 0)
);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS image TEXT;

-- ---------- Marketplace sellers ----------
-- A seller is a user with role 'seller' plus a store profile. Products in MongoDB carry sellerId = users.id.
CREATE TABLE IF NOT EXISTS sellers (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  store_name VARCHAR(120) NOT NULL UNIQUE,
  gstin      VARCHAR(15),
  phone      VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which seller fulfils each order line (drives seller payouts and seller analytics)
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS seller_id INTEGER REFERENCES users(id);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS category  VARCHAR(40);
CREATE INDEX IF NOT EXISTS order_items_seller_idx  ON order_items (seller_id);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items (product_id);
CREATE INDEX IF NOT EXISTS orders_user_idx         ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_created_idx      ON orders (created_at);

-- Synthetic customers created by the seed script, so re-seeding can replace them safely
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city         VARCHAR(60);

-- ---------- Customer support (ML-triaged) ----------
CREATE TABLE IF NOT EXISTS support_tickets (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_id         INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  subject          VARCHAR(200) NOT NULL,
  message          TEXT NOT NULL,
  category         VARCHAR(30) NOT NULL,          -- predicted by the ticket classifier
  category_confidence NUMERIC(4, 3),
  sentiment        NUMERIC(4, 3) NOT NULL DEFAULT 0, -- -1 (angry) .. +1 (happy)
  priority         VARCHAR(10) NOT NULL DEFAULT 'medium', -- low | medium | high
  status           VARCHAR(15) NOT NULL DEFAULT 'open',   -- open | in_progress | resolved
  suggested_reply  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets (user_id, created_at DESC);

-- 'web' = placed in the store, 'seed' = demo history from scripts/seed.py (safe to delete and regenerate)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'web';

-- ---------- Seller store profile & payout details ----------
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS description         TEXT;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS logo                TEXT;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS payout_upi          VARCHAR(100);
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bank_account_name   VARCHAR(120);
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(20);
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bank_ifsc           VARCHAR(11);
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ;

-- ---------- Fulfilment: each seller moves their own lines through pending -> packed -> shipped -> delivered ----------
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fulfilment   VARCHAR(12) NOT NULL DEFAULT 'pending';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ;

-- ---------- Online payments (Razorpay: UPI, net banking, cards, wallets) ----------
-- One row per payment attempt. The order is only created after the payment signature is verified.
CREATE TABLE IF NOT EXISTS payments (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  order_id            INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  provider            VARCHAR(20) NOT NULL DEFAULT 'razorpay',
  provider_order_id   VARCHAR(64) NOT NULL UNIQUE,
  provider_payment_id VARCHAR(64),
  method              VARCHAR(20),                          -- upi | card | netbanking | wallet | emi
  amount              NUMERIC(12, 2) NOT NULL,              -- rupees (Razorpay itself works in paise)
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  status              VARCHAR(20) NOT NULL DEFAULT 'created', -- created | paid | failed | refunded | refund_pending
  address             TEXT NOT NULL,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payments_user_idx  ON payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);

-- ---------- Order timeline, shipment details and returns ----------
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS courier         VARCHAR(60);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(60);

-- What the shopper sees on the order page: placed, packed, shipped, delivered, cancelled, return requested...
CREATE TABLE IF NOT EXISTS order_events (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     VARCHAR(30) NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, created_at);

-- One return per order: requested -> approved (refunded) | rejected
CREATE TABLE IF NOT EXISTS order_returns (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  status      VARCHAR(15) NOT NULL DEFAULT 'requested',  -- requested | approved | rejected
  refund      VARCHAR(20),                               -- refunded | refund_pending | cod_manual
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- ---------- Product reviews: only from shoppers whose order for the product was delivered ----------
CREATE TABLE IF NOT EXISTS product_reviews (
  id         SERIAL PRIMARY KEY,
  product_id VARCHAR(64) NOT NULL,  -- MongoDB product _id
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title      VARCHAR(120) NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  sentiment  REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, user_id)
);
CREATE INDEX IF NOT EXISTS product_reviews_product_idx ON product_reviews (product_id, created_at DESC);

-- ---------- Verification codes: signup email, phone (SMS / WhatsApp), payout changes ----------
-- Codes are stored only as an HMAC. A signup is held here (payload) until its email code is confirmed.
CREATE TABLE IF NOT EXISTS verification_codes (
  id         SERIAL PRIMARY KEY,
  purpose    VARCHAR(20)  NOT NULL,          -- signup | login | phone | payout
  target     VARCHAR(255) NOT NULL,          -- email address or phone number
  channel    VARCHAR(10)  NOT NULL,          -- email | sms | whatsapp
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  payload    JSONB,
  code_hash  VARCHAR(64)  NOT NULL,
  attempts   INTEGER      NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ  NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS verification_codes_lookup_idx ON verification_codes (purpose, target, created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Payout bank account numbers are encrypted at rest; the last 4 digits are kept separately for display
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bank_account_last4 VARCHAR(4);
ALTER TABLE sellers ALTER COLUMN bank_account_number TYPE TEXT;

-- Size / colour chosen for clothing and footwear lines
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS options JSONB;

-- Read-only reporting views for the AI data analyst (ai-service). Only safe columns: no names, emails,
-- phones, passwords, bank details or codes. When the session sets arvixa.seller_id (the AI service does
-- this for sellers), every view shows only that seller's sales; unset or '' = whole marketplace (admins).
-- {analytics} is replaced with "<PG_SCHEMA>_analytics" (see db/postgres.py); the unqualified table names
-- below bind to the store's own schema because this file runs with search_path = PG_SCHEMA.
CREATE SCHEMA IF NOT EXISTS {analytics};

CREATE OR REPLACE VIEW {analytics}.order_items AS
SELECT oi.id, oi.order_id, oi.product_id, oi.name AS product_name, oi.category, oi.seller_id,
       oi.price, oi.qty, oi.price * oi.qty AS line_total, oi.fulfilment,
       o.status AS order_status, o.payment_method, o.created_at AS ordered_at
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
 WHERE NULLIF(current_setting('arvixa.seller_id', true), '') IS NULL
    OR oi.seller_id = NULLIF(current_setting('arvixa.seller_id', true), '')::int;

CREATE OR REPLACE VIEW {analytics}.orders AS
SELECT o.id, o.user_id AS customer_id, o.status, o.payment_method, o.source, o.delivery_fee, o.created_at,
       -- a seller sees only their own share of an order shared with other sellers
       CASE WHEN NULLIF(current_setting('arvixa.seller_id', true), '') IS NULL THEN o.total
            ELSE (SELECT SUM(i.price * i.qty) FROM order_items i
                   WHERE i.order_id = o.id AND i.seller_id = NULLIF(current_setting('arvixa.seller_id', true), '')::int)
       END AS total
  FROM orders o
 WHERE NULLIF(current_setting('arvixa.seller_id', true), '') IS NULL
    OR EXISTS (SELECT 1 FROM order_items i
                WHERE i.order_id = o.id AND i.seller_id = NULLIF(current_setting('arvixa.seller_id', true), '')::int);

CREATE OR REPLACE VIEW {analytics}.customers AS
SELECT u.id, u.city, u.created_at AS joined_at, u.is_synthetic
  FROM users u
 WHERE u.role = 'customer'
   AND (NULLIF(current_setting('arvixa.seller_id', true), '') IS NULL
        OR EXISTS (SELECT 1 FROM orders o JOIN order_items i ON i.order_id = o.id
                    WHERE o.user_id = u.id AND i.seller_id = NULLIF(current_setting('arvixa.seller_id', true), '')::int));

CREATE OR REPLACE VIEW {analytics}.sellers AS
SELECT s.user_id AS seller_id, s.store_name, s.created_at
  FROM sellers s
 WHERE NULLIF(current_setting('arvixa.seller_id', true), '') IS NULL
    OR s.user_id = NULLIF(current_setting('arvixa.seller_id', true), '')::int;

CREATE OR REPLACE VIEW {analytics}.support_tickets AS  -- marketplace-wide only (admins)
SELECT t.id, t.category, t.priority, t.status, t.sentiment, t.created_at, t.resolved_at
  FROM support_tickets t
 WHERE NULLIF(current_setting('arvixa.seller_id', true), '') IS NULL;

-- ---------- Shared with the Vercel store API (api/): coupons, returns & refunds, complaint threads, review photos ----------
-- Coupon codes the owner creates (npm run coupon). One use per customer; cancelling the order gives the use back.
CREATE TABLE IF NOT EXISTS coupons (
  code         VARCHAR(30)    PRIMARY KEY,                -- upper case
  description  TEXT           NOT NULL DEFAULT '',
  kind         VARCHAR(10)    NOT NULL CHECK (kind IN ('percent', 'flat')),
  value        NUMERIC(10, 2) NOT NULL CHECK (value > 0),
  min_order    NUMERIC(10, 2) NOT NULL DEFAULT 0,
  max_discount NUMERIC(10, 2),                            -- cap for percentage coupons
  starts_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  ends_at      TIMESTAMPTZ,
  public       BOOLEAN        NOT NULL DEFAULT TRUE,      -- listed in the cart; private codes work but aren't shown
  active       BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- The coupon a shopper has applied to their cart
CREATE TABLE IF NOT EXISTS cart_coupons (
  user_id    INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code       VARCHAR(30) NOT NULL REFERENCES coupons(code) ON DELETE CASCADE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  code       VARCHAR(30) NOT NULL REFERENCES coupons(code),
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id   INTEGER     NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (code, user_id)
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code     VARCHAR(30);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_discount NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- Returns (api/_returns.mjs): requested -> approved (pickup) -> received (refund sent) | rejected | withdrawn.
-- refund: refunded | refund_pending (online refund to retry) | cod_manual (bank or UPI transfer still to be made).
-- Online payments go back to the account they came from; cash-on-delivery refunds go to the bank account or UPI ID
-- the shopper gives, stored encrypted and wiped once the transfer is made.
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS reason_code           VARCHAR(20);
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS amount                NUMERIC(12, 2);
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS refund_to             VARCHAR(10);  -- original | upi | bank
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS refund_upi            VARCHAR(100);
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS refund_account_name   VARCHAR(120);
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS refund_account_number TEXT;         -- encrypted, like seller payouts
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS refund_account_last4  VARCHAR(4);
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS refund_ifsc           VARCHAR(11);
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS refund_reference      VARCHAR(60);  -- UTR of a manual transfer
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS refunded_at           TIMESTAMPTZ;
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS note                  TEXT;         -- the store's note to the shopper
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Complaints (api/_support.mjs): a conversation between the shopper and the store team on each support ticket
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE TABLE IF NOT EXISTS ticket_messages (
  id         SERIAL PRIMARY KEY,
  ticket_id  INTEGER     NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  staff      BOOLEAN     NOT NULL DEFAULT FALSE,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages (ticket_id, created_at);

-- Reviews (api/_reviews.mjs) can carry up to 3 photos, uploaded to Vercel Blob
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]';
