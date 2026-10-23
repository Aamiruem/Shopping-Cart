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
