-- claudex_0040_feedback.sql (B8, design 2.9)
-- Diagnostics and reply feedback sent by the Claudex desktop app. The server
-- stores nothing until an administrator turns collection on (setting
-- claudex_feedback, both parts off by default) and the user agreed in the app;
-- rows older than the retention period are deleted every hour.

CREATE TABLE IF NOT EXISTS claudex_diagnostics (
    id            BIGSERIAL PRIMARY KEY,
    report_uuid   UUID NOT NULL,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- claudex_devices.id; the foreign key is added below when that table exists.
    device_id     BIGINT NULL,
    kind          VARCHAR(32) NOT NULL,
    code          VARCHAR(64) NOT NULL DEFAULT '',
    message       VARCHAR(300) NOT NULL DEFAULT '',
    request_id    VARCHAR(128) NOT NULL DEFAULT '',
    model         VARCHAR(200) NOT NULL DEFAULT '',
    app_version   VARCHAR(32) NOT NULL DEFAULT '',
    codex_version VARCHAR(32) NOT NULL DEFAULT '',
    platform      VARCHAR(16) NOT NULL DEFAULT '',
    arch          VARCHAR(16) NOT NULL DEFAULT '',
    os_version    VARCHAR(64) NOT NULL DEFAULT '',
    context       JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at   TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_diagnostics_uuid ON claudex_diagnostics (user_id, report_uuid);
CREATE INDEX IF NOT EXISTS idx_claudex_diagnostics_created ON claudex_diagnostics (created_at);
CREATE INDEX IF NOT EXISTS idx_claudex_diagnostics_code ON claudex_diagnostics (code, created_at);
-- Per-user daily cap (rolling 24 hours) and the admin user filter.
CREATE INDEX IF NOT EXISTS idx_claudex_diagnostics_user_created ON claudex_diagnostics (user_id, created_at);

-- claudex_devices comes from claudex_0020_devices.sql (B4), which sorts and
-- runs before this file. The guard keeps this migration valid on a database
-- without it.
DO $$
BEGIN
    IF to_regclass('claudex_devices') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_claudex_diagnostics_device') THEN
        ALTER TABLE claudex_diagnostics
            ADD CONSTRAINT fk_claudex_diagnostics_device
            FOREIGN KEY (device_id) REFERENCES claudex_devices(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS claudex_feedback (
    id                   BIGSERIAL PRIMARY KEY,
    feedback_uuid        UUID NOT NULL,
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating               VARCHAR(8) NOT NULL CHECK (rating IN ('up','down')),
    categories           JSONB NOT NULL DEFAULT '[]'::jsonb,
    comment              VARCHAR(4000) NOT NULL DEFAULT '',
    model                VARCHAR(200) NOT NULL DEFAULT '',
    request_id           VARCHAR(128) NOT NULL DEFAULT '',
    conversation_excerpt TEXT NULL,
    app_version          VARCHAR(32) NOT NULL DEFAULT '',
    platform             VARCHAR(16) NOT NULL DEFAULT '',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_feedback_uuid ON claudex_feedback (user_id, feedback_uuid);
CREATE INDEX IF NOT EXISTS idx_claudex_feedback_created ON claudex_feedback (created_at);
CREATE INDEX IF NOT EXISTS idx_claudex_feedback_user_created ON claudex_feedback (user_id, created_at);
