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
`;
