-- Claudex B5: usage rules (5-hour current session, weekly limits for all
-- models or per model) and their per-user counters (design 2.6).
--
-- A rule applies to the API keys of one group (group_id) or of every group
-- (group_id NULL), device keys and user-created keys alike. Amounts are USD of
-- the billed ActualCost. Windows start at the first billed request after the
-- previous window ended (first-use windows), so a counter row holds the
-- current window of one (rule, user) pair.

CREATE TABLE IF NOT EXISTS claudex_usage_rules (
    id              BIGSERIAL PRIMARY KEY,
    group_id        BIGINT NULL REFERENCES groups(id) ON DELETE CASCADE,
    kind            VARCHAR(16) NOT NULL CHECK (kind IN ('session','all_models','models')),
    label           VARCHAR(60) NOT NULL,
    model_patterns  JSONB NOT NULL DEFAULT '["*"]'::jsonb,
    window_seconds  INT NOT NULL CHECK (window_seconds BETWEEN 3600 AND 2592000),
    limit_usd       NUMERIC(20,8) NOT NULL CHECK (limit_usd > 0),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    show_in_client  BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0,
    created_by      BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claudex_usage_rules_group ON claudex_usage_rules (group_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS claudex_usage_counters (
    rule_id        BIGINT NOT NULL REFERENCES claudex_usage_rules(id) ON DELETE CASCADE,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    window_start   TIMESTAMPTZ NOT NULL,
    window_end     TIMESTAMPTZ NOT NULL,
    used_usd       NUMERIC(20,8) NOT NULL DEFAULT 0,
    request_count  BIGINT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (rule_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_claudex_usage_counters_user ON claudex_usage_counters (user_id);
