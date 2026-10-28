-- Claudex: the repository webhooks of scheduled tasks' GitHub triggers (the
-- task itself lives on the user's runner). GitHub delivers to
-- POST /api/v1/claudex/github/hooks/<trigger id>, signed with the secret,
-- which is sealed with the server's secret encryption key (core.SecretBox).
CREATE TABLE IF NOT EXISTS claudex_routine_github_hooks (
    trigger_id        VARCHAR(40) PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository        VARCHAR(220) NOT NULL,
    hook_id           BIGINT NOT NULL,
    secret_ciphertext TEXT NOT NULL,
    events            VARCHAR(100) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claudex_routine_github_hooks_user ON claudex_routine_github_hooks (user_id);
