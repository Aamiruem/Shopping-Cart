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
`;
