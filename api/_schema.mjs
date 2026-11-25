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
`;
