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
`;
