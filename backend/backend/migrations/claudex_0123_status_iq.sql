-- claudex_0123_status_iq.sql (service status: IQ check)
-- Every hour the service asks a model for an HTML page with an SVG animation
-- of a pelican riding a bicycle (status/iq.go); the status page shows the
-- latest pages. A run claims its hour with a "running" row first, so only
-- one instance runs it.
CREATE TABLE IF NOT EXISTS claudex_status_iq (
    id          BIGSERIAL PRIMARY KEY,
    model       VARCHAR(200) NOT NULL,
    prompt      TEXT NOT NULL,
    status      VARCHAR(16) NOT NULL DEFAULT 'running',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    html        TEXT NOT NULL DEFAULT '',
    error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_claudex_status_iq_started ON claudex_status_iq (started_at DESC);
