-- Usage by product (Settings → Usage, "This week's usage by product"): the
-- billed cost and request count of each person per UTC day and Claudex
-- surface (code, cowork, chat, other), from the client's x-claudex-product.
CREATE TABLE IF NOT EXISTS claudex_usage_products (
    user_id   BIGINT NOT NULL,
    day       DATE NOT NULL,
    product   TEXT NOT NULL CHECK (product IN ('code', 'cowork', 'chat', 'other')),
    cost_usd  NUMERIC(18, 8) NOT NULL DEFAULT 0,
    requests  BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, product)
);
