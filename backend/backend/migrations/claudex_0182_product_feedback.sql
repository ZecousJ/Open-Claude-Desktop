-- Durable deduplication only: never store feedback text, email or logs here.
-- Retain receipts until account deletion; removing them permits re-delivery.
CREATE TABLE IF NOT EXISTS claudex_product_feedback_receipts (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id UUID NOT NULL,
 feedback_id UUID NOT NULL UNIQUE,
 payload_hash CHAR(64) NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('sending','sent','unknown')),
 created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS claudex_product_feedback_rate_idx
 ON claudex_product_feedback_receipts (user_id, created_at);
