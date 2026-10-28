-- Claudex W-AUTH: browser sessions of the web app.
--
-- One row per web sign-in. The refresh token itself lives only in the
-- HttpOnly __Secure-claudex_web_rt cookie and in the upstream refresh-token
-- store (hashed there); this table records the session family (JWT "sid")
-- so the web component can cap sessions per user, list them and revoke
-- them. The family id is an identifier, not a credential (it cannot be
-- turned into a token), and is stored like claudex_revoked_sessions stores
-- it, so revocation can reach the upstream family and the JWT guard.
CREATE TABLE IF NOT EXISTS claudex_web_sessions (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id       VARCHAR(64) NOT NULL,
    user_agent      VARCHAR(256) NOT NULL DEFAULT '',
    ip              VARCHAR(64) NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ NULL,
    revoked_reason  VARCHAR(32) NOT NULL DEFAULT '' CHECK (revoked_reason IN ('', 'logout', 'user', 'admin', 'revoke_all', 'cap'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_web_sessions_family ON claudex_web_sessions (family_id);
CREATE INDEX IF NOT EXISTS idx_claudex_web_sessions_user_active ON claudex_web_sessions (user_id, created_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_claudex_web_sessions_expires ON claudex_web_sessions (expires_at);
