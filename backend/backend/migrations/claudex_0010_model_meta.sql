-- CLAUDEX: file added by the Claudex fork (see backend/CLAUDEX_CHANGES.md).
-- Model display catalog (B3, design 2.4).
--
-- One row describes how the desktop client shows a model: the global row
-- (group_id NULL) applies to every group, a group row replaces the global row
-- of the same model for that group. Availability is not stored here: the
-- client intersects the catalog with the gateway /v1/models list.
-- Upstream groups and users are soft-deleted, so the ON DELETE actions below
-- only fire on a hard delete; readers join groups with deleted_at IS NULL.
CREATE TABLE IF NOT EXISTS claudex_model_meta (
    id                  BIGSERIAL PRIMARY KEY,
    model_id            VARCHAR(200) NOT NULL,
    group_id            BIGINT NULL REFERENCES groups(id) ON DELETE CASCADE,
    display_name        VARCHAR(100) NOT NULL DEFAULT '',
    description         VARCHAR(500) NOT NULL DEFAULT '',
    badges              JSONB NOT NULL DEFAULT '[]'::jsonb,
    sort_order          INT NOT NULL DEFAULT 0,
    hidden              BOOLEAN NOT NULL DEFAULT FALSE,
    is_default          BOOLEAN NOT NULL DEFAULT FALSE,
    supported_efforts   JSONB NULL,
    default_effort      VARCHAR(16) NOT NULL DEFAULT '',
    context_window      INT NULL CHECK (context_window IS NULL OR context_window > 0),
    auto_compact_tokens INT NULL CHECK (auto_compact_tokens IS NULL OR auto_compact_tokens > 0),
    fast_tier           BOOLEAN NULL,
    usage_hint          VARCHAR(40) NOT NULL DEFAULT '',
    created_by          BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per model and scope (global = group 0).
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_model_meta_scope ON claudex_model_meta (model_id, COALESCE(group_id, 0));
-- At most one default model per scope.
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_model_meta_default ON claudex_model_meta (COALESCE(group_id, 0)) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_claudex_model_meta_group ON claudex_model_meta (group_id);
