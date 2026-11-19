CREATE TABLE IF NOT EXISTS claudex_memory_cowork (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    epoch BIGINT NOT NULL CHECK (epoch >= 0),
    entries_enc TEXT,
    entries_bytes INTEGER NOT NULL CHECK (entries_bytes >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
