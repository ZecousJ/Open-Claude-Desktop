-- Claudex: the API triggers of users' scheduled tasks (the task itself lives
-- on the user's runner). A trigger's fire address is
-- POST /api/v1/claudex/routines/<trigger id>/fire with the trigger's token as
-- the Bearer credential. Only the token's SHA-256 is stored, with its last
-- four characters for the task's page; the token is shown to its owner once.
CREATE TABLE IF NOT EXISTS claudex_routine_triggers (
    trigger_id     VARCHAR(40) PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash     VARCHAR(64) NOT NULL,
    token_hint     VARCHAR(8) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_fired_at  TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_claudex_routine_triggers_user ON claudex_routine_triggers (user_id);
