-- A person's own monthly spend limit (Settings → Billing, "Set monthly spend
-- limit"): requests stop once the calendar month's spend (UTC) reaches it.
-- No row means no spend limit.
CREATE TABLE IF NOT EXISTS claudex_spend_limits (
    user_id    BIGINT PRIMARY KEY,
    limit_usd  NUMERIC(12, 2) NOT NULL CHECK (limit_usd >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
