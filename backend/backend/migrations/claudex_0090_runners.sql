-- Claudex W-RELAY: runners of the web app (web plan §1, W-RUN §10).
--
-- claudex-runner dials the server's runner link with a runner token.
-- Administrators create the tokens on the console's Runners page; only a
-- SHA-256 of each token is stored (it is shown once). A revoked token can
-- never link again. last_seen_at, last_version and labels are what the
-- runner reported the last time it linked.
CREATE TABLE IF NOT EXISTS claudex_web_runners (
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    token_hash   VARCHAR(64) NOT NULL,
    created_by   BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at   TIMESTAMPTZ NULL,
    last_seen_at TIMESTAMPTZ NULL,
    last_version VARCHAR(64) NOT NULL DEFAULT '',
    labels       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_web_runners_token ON claudex_web_runners (token_hash);

-- Which runner serves which user (user -> runner affinity). The relay only
-- accepts a runner's events and store requests for users assigned to it, so
-- the assignment is kept across server restarts. runner_id is the link id:
-- 'r<claudex_web_runners.id>' or 'local' (the runner next to the server).
CREATE TABLE IF NOT EXISTS claudex_web_runner_users (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    runner_id   VARCHAR(64) NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claudex_web_runner_users_runner ON claudex_web_runner_users (runner_id);
