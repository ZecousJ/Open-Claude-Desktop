-- Claudex W-KEY: usage of the web app (design W-SRV 6).
--
-- Model calls of the web runner use the user's web key (claudex_devices row
-- with platform 'web'), so they are billed by the upstream gateway like any
-- other request. claudex_web_usage_links ties each billed request of a web
-- key to the web conversation it served, for "usage of this conversation"
-- and for tracing in the console. (request_id, api_key_id) is the key of
-- the upstream usage log row (idx_usage_logs_request_id_api_key_unique);
-- model and cost are copied so the totals survive usage log retention.
CREATE TABLE IF NOT EXISTS claudex_web_usage_links (
    id              BIGSERIAL PRIMARY KEY,
    request_id      VARCHAR(255) NOT NULL,
    api_key_id      BIGINT NOT NULL,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id VARCHAR(64) NOT NULL,
    web_session_id  VARCHAR(64) NOT NULL DEFAULT '',
    model           VARCHAR(128) NOT NULL DEFAULT '',
    cost_usd        NUMERIC(20, 10) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_web_usage_links_request ON claudex_web_usage_links (request_id, api_key_id);
CREATE INDEX IF NOT EXISTS idx_claudex_web_usage_links_conversation ON claudex_web_usage_links (user_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_claudex_web_usage_links_created ON claudex_web_usage_links (created_at);

-- Runner resources of one run (one slot: a turn or a session of the web
-- runner). Recorded only; the per-minute price is informational unless an
-- administrator sets one (web PLAN Q12).
CREATE TABLE IF NOT EXISTS claudex_web_runner_usage (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id VARCHAR(64) NOT NULL DEFAULT '',
    runner_id       VARCHAR(64) NOT NULL DEFAULT '',
    mode            VARCHAR(16) NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'cowork', 'code')),
    wall_seconds    DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (wall_seconds >= 0),
    cpu_seconds     DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (cpu_seconds >= 0),
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ NOT NULL,
    exit_reason     VARCHAR(32) NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claudex_web_runner_usage_user ON claudex_web_runner_usage (user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_claudex_web_runner_usage_conversation ON claudex_web_runner_usage (user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_claudex_web_runner_usage_started ON claudex_web_runner_usage (started_at);
