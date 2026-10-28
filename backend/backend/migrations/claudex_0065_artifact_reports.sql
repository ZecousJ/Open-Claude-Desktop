-- claudex_0065_artifact_reports.sql (R1 sharing: the app's Report artifact)
-- The artifact viewer's title menu has "Report artifact" (live claude.ai
-- bundle, 2026-10-12): the report form without the training opt-out, sent
-- to the service. An artifact in a conversation lives on the user's
-- computer or runner, not on the service, so the report keeps a copy of
-- the artifact (title, language and up to 512 KiB of its text) for the
-- administrator to review. identity_hash is a SHA-256 hex digest of the
-- artifact's identity, used only to drop a second report of the same
-- artifact by the same account on the same day.
CREATE TABLE IF NOT EXISTS claudex_artifact_reports (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_hash       VARCHAR(64) NOT NULL DEFAULT '',
    title               VARCHAR(400) NOT NULL DEFAULT '',
    language            VARCHAR(32) NOT NULL DEFAULT '',
    content             TEXT NOT NULL DEFAULT '',
    content_bytes       BIGINT NOT NULL DEFAULT 0,
    content_truncated   BOOLEAN NOT NULL DEFAULT FALSE,
    reason              VARCHAR(16) NOT NULL CHECK (reason IN ('illegal','harmful','privacy','spam','other')),
    category            VARCHAR(64) NOT NULL DEFAULT '',
    notes               VARCHAR(4000) NOT NULL DEFAULT '',
    reporter_name       VARCHAR(255) NOT NULL DEFAULT '',
    reporter_email      VARCHAR(255) NOT NULL DEFAULT '',
    opt_out_of_training BOOLEAN NOT NULL DEFAULT FALSE,
    status              VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ NULL,
    resolved_by         BIGINT NULL
);
CREATE INDEX IF NOT EXISTS idx_claudex_artifact_reports_status ON claudex_artifact_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claudex_artifact_reports_user ON claudex_artifact_reports (user_id, identity_hash, created_at DESC);
