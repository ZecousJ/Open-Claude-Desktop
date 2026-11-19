-- Keep reset tombstones as well as edit versions: an old window must not
-- recreate controls after memory was cleared, even when the scope is empty.
CREATE TABLE IF NOT EXISTS claudex_memory_versions (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    reset_revision BIGINT NOT NULL DEFAULT 0 CHECK (reset_revision >= 0),
    PRIMARY KEY (user_id, scope)
);
