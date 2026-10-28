-- claudex_0070_memory.sql (R3-S1, design R3 3.1)
-- Per-user memory for the Claudex desktop app (Chat and Cowork). Memory text
-- and memory edits are sealed with AES-256-GCM under the server's fixed
-- secret key (core.SecretBox) before they reach these tables; administrators
-- only ever see the metadata (sizes, revisions, times) and can clear it.
-- Conversations never reach the server: the desktop app builds the memory.

-- The user's two switches (Search and reference chats, Generate memory from
-- chats). No row means the policy default (memory.default_on).
CREATE TABLE IF NOT EXISTS claudex_memory_prefs (
    user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    search_chats BOOLEAN NOT NULL DEFAULT FALSE,
    generate     BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One memory document per user and scope ('global' or 'project:<uuid>').
CREATE TABLE IF NOT EXISTS claudex_memory_docs (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope         VARCHAR(80) NOT NULL,
    -- base64(nonce | ciphertext | tag)
    content_enc   TEXT NOT NULL,
    -- plaintext size in bytes (metadata, visible to administrators)
    content_bytes INTEGER NOT NULL DEFAULT 0 CHECK (content_bytes >= 0),
    revision      BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    source        VARCHAR(16) NOT NULL CHECK (source IN ('generated', 'user', 'import')),
    -- last write by the desktop app's memory synthesis
    generated_at  TIMESTAMPTZ NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_memory_docs_scope ON claudex_memory_docs (user_id, scope);

-- Things the user asked Claude to remember or forget ("memory_edits"), kept
-- until the next synthesis folds them into the document.
CREATE TABLE IF NOT EXISTS claudex_memory_edits (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope       VARCHAR(80) NOT NULL,
    text_enc    TEXT NOT NULL,
    text_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (text_bytes >= 0),
    -- claudex_devices.id; the foreign key is added below when that table exists.
    device_id   BIGINT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claudex_memory_edits_user ON claudex_memory_edits (user_id, scope, id);

-- claudex_devices comes from claudex_0020_devices.sql (B4), which sorts and
-- runs before this file. The guard keeps this migration valid on a database
-- without it.
DO $$
BEGIN
    IF to_regclass('claudex_devices') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_claudex_memory_edits_device') THEN
        ALTER TABLE claudex_memory_edits
            ADD CONSTRAINT fk_claudex_memory_edits_device
            FOREIGN KEY (device_id) REFERENCES claudex_devices(id) ON DELETE SET NULL;
    END IF;
END $$;
