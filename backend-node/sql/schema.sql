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
