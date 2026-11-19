CREATE TABLE IF NOT EXISTS claudex_memory_melange (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision    BIGINT NOT NULL CHECK (revision >= 1),
    state_enc   TEXT,
    state_bytes INTEGER NOT NULL CHECK (state_bytes >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
