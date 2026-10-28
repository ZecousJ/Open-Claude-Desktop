-- claudex_0142_native_sessions.sql (Settings → Account → Active sessions)
--
-- The sign-ins of the phone apps (and any other client of the upstream
-- /api/v1/auth bearer flow that is neither the desktop app nor the web
-- app). One row per session family (the JWT "sid"), written when the auth
-- endpoints answer a token pair (hook H16): user agent and IP of the last
-- sign-in or refresh, when the session began and was last used. Like
-- claudex_web_sessions, the family id is an identifier, not a credential.
-- The desktop app's sign-ins stay in claudex_devices, the web app's in
-- claudex_web_sessions.
CREATE TABLE IF NOT EXISTS claudex_native_sessions (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id       VARCHAR(64) NOT NULL,
    user_agent      VARCHAR(256) NOT NULL DEFAULT '',
    ip              VARCHAR(64) NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ NULL,
    revoked_reason  VARCHAR(32) NOT NULL DEFAULT '' CHECK (revoked_reason IN ('', 'logout', 'user', 'revoke_all'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_native_sessions_family ON claudex_native_sessions (family_id);
CREATE INDEX IF NOT EXISTS idx_claudex_native_sessions_user_active ON claudex_native_sessions (user_id, last_seen_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_claudex_native_sessions_expires ON claudex_native_sessions (expires_at);
