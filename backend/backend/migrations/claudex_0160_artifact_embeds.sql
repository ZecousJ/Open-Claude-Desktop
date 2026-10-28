-- claudex_0160_artifact_embeds.sql (artifact embeds: Get embed code)
-- The Publish dialog's "Get embed code" (live claude.ai bundle, 2026-10-12)
-- keeps, per published artifact, the domains that may embed it ("Allowed
-- domains"). A published version is an artifact share, so the list belongs
-- to the share and goes with it. domains is a JSON array of lower-case
-- host names, each optionally starting with "*."; an empty array lets any
-- site embed the artifact.
CREATE TABLE IF NOT EXISTS claudex_share_embeds (
    share_id   BIGINT PRIMARY KEY REFERENCES claudex_shares(id) ON DELETE CASCADE,
    domains    JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
