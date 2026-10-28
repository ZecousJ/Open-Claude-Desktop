-- claudex_0060_sharing.sql (R1, design R1 3.1)
-- Hosted shares of conversations and artifacts, served read-only at
-- /s/<token>. Nothing is shared until an administrator turns sharing on
-- (setting claudex_sharing, off by default) and a user publishes a snapshot
-- from the desktop app. A share holds a validated snapshot (prompts, reply
-- text and artifacts; never tool commands or their output), never the raw
-- client conversation id: source_key is a SHA-256 hex digest.

CREATE TABLE IF NOT EXISTS claudex_shares (
    id              BIGSERIAL PRIMARY KEY,
    -- Capability token (32 random bytes, base64url, 43 characters, never
    -- starting with '_' or '-'). A revoked token is never reused: the row
    -- stays with status 'revoked'.
    token           VARCHAR(64) NOT NULL,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            VARCHAR(16) NOT NULL CHECK (kind IN ('conversation','artifact')),
    source_key      VARCHAR(64) NOT NULL,
    title           VARCHAR(400) NOT NULL DEFAULT '',
    status          VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','disabled')),
    disabled_reason VARCHAR(500) NOT NULL DEFAULT '',
    disabled_by     BIGINT NULL,
    disabled_at     TIMESTAMPTZ NULL,
    content_bytes   BIGINT NOT NULL DEFAULT 0,
    view_count      BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NULL,
    revoked_at      TIMESTAMPTZ NULL,
    last_viewed_at  TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_shares_token ON claudex_shares (token);
-- One live share per user and source: sharing the same conversation again
-- updates the snapshot and keeps the link.
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_shares_live_source
    ON claudex_shares (user_id, kind, source_key) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS idx_claudex_shares_user ON claudex_shares (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claudex_shares_status ON claudex_shares (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claudex_shares_expires ON claudex_shares (expires_at) WHERE status <> 'revoked' AND expires_at IS NOT NULL;

-- The snapshot body (design 3.2). Deleted when the share is revoked.
CREATE TABLE IF NOT EXISTS claudex_share_contents (
    share_id BIGINT PRIMARY KEY REFERENCES claudex_shares(id) ON DELETE CASCADE,
    schema   SMALLINT NOT NULL DEFAULT 1,
    body     JSONB NOT NULL
);

-- Abuse reports sent from the public page. ip_hash is an HMAC of the
-- visitor address with a daily key, used only to drop duplicates.
CREATE TABLE IF NOT EXISTS claudex_share_reports (
    id          BIGSERIAL PRIMARY KEY,
    share_id    BIGINT NOT NULL REFERENCES claudex_shares(id) ON DELETE CASCADE,
    reason      VARCHAR(16) NOT NULL CHECK (reason IN ('illegal','harmful','privacy','spam','other')),
    detail      VARCHAR(4000) NOT NULL DEFAULT '',
    ip_hash     VARCHAR(64) NOT NULL DEFAULT '',
    status      VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ NULL,
    resolved_by BIGINT NULL
);
CREATE INDEX IF NOT EXISTS idx_claudex_share_reports_status ON claudex_share_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claudex_share_reports_share ON claudex_share_reports (share_id, created_at DESC);

-- Users an administrator stopped from sharing. Existing shares stay online
-- unless the administrator also takes them down.
CREATE TABLE IF NOT EXISTS claudex_share_user_blocks (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason     VARCHAR(500) NOT NULL DEFAULT '',
    created_by BIGINT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
