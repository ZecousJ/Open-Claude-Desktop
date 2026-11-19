-- claudex_0130_zecous_migration.sql (ZecousAI accounts moved to Claudex, owner 2026-10-03)
--
-- One row per Claudex user who confirmed the move in the dialog: what the
-- ZecousAI account was worth (CNY, credited 1:1 as USD) and how far the move
-- got. 'confirming' is written before ZecousAI is cleared, 'credited' once
-- the Claudex balance holds the amount; a confirm that stopped in between is
-- finished by the next one (the ZecousAI side answers with its recorded
-- amount, and the credit's balance-history record is checked before
-- crediting).
CREATE TABLE IF NOT EXISTS claudex_zecous_migrations (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email       VARCHAR(255) NOT NULL,
    state       VARCHAR(16) NOT NULL CHECK (state IN ('confirming', 'credited')),
    amount_usd  NUMERIC(20, 8) NOT NULL DEFAULT 0 CHECK (amount_usd >= 0),
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    credited_at TIMESTAMPTZ
);
