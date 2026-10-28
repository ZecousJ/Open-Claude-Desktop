-- Claudex W-GITHUB: a user's GitHub connection for Code on the web.
--
-- The administrator's OAuth App / GitHub App settings live in the settings
-- table (claudex_github); nothing here holds them. Tokens are sealed with the
-- server's secret encryption key (AES-256-GCM, core.SecretBox) before they are
-- stored: this table never holds a plaintext token.
CREATE TABLE IF NOT EXISTS claudex_github_connections (
    user_id            BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    github_user_id     BIGINT NOT NULL,
    login              VARCHAR(100) NOT NULL,
    avatar_url         VARCHAR(512) NOT NULL DEFAULT '',
    token_ciphertext   TEXT NOT NULL,
    -- GitHub App user tokens expire (8 h) and come with a refresh token;
    -- OAuth App tokens do not (both NULL).
    refresh_ciphertext TEXT NULL,
    token_expires_at   TIMESTAMPTZ NULL,
    scope              VARCHAR(255) NOT NULL DEFAULT '',
    connected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per OAuth authorization in flight: only the SHA-256 of the state is
-- stored, the PKCE verifier is sealed. A row is deleted when its callback
-- runs and after 10 minutes.
CREATE TABLE IF NOT EXISTS claudex_github_oauth_states (
    state_hash          VARCHAR(64) PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    verifier_ciphertext TEXT NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claudex_github_oauth_states_expires ON claudex_github_oauth_states (expires_at);
