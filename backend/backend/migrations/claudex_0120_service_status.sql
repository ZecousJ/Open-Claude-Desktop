-- claudex_0120_service_status.sql (service status page)
-- The apps' Service status page shows each provider's channels (Sub2API's
-- channel monitors) with a bar a day and the incidents an administrator is
-- handling. Sub2API keeps its check history and daily rollups for 30 days;
-- this table keeps each channel's daily counts for longer (it is refreshed
-- from channel_monitor_histories every few minutes).
CREATE TABLE IF NOT EXISTS claudex_status_days (
    monitor_id  BIGINT NOT NULL,
    model       VARCHAR(200) NOT NULL,
    day         DATE NOT NULL,
    total       INTEGER NOT NULL DEFAULT 0,
    operational INTEGER NOT NULL DEFAULT 0,
    degraded    INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (monitor_id, model, day)
);
CREATE INDEX IF NOT EXISTS idx_claudex_status_days_day ON claudex_status_days (day);

-- An incident: opened by an administrator, or automatically when a
-- provider's channels keep failing. Its handling status moves through
-- investigating → identified → monitoring → resolved; every change is an
-- update with a message.
CREATE TABLE IF NOT EXISTS claudex_status_incidents (
    id          BIGSERIAL PRIMARY KEY,
    title       VARCHAR(200) NOT NULL,
    platform    VARCHAR(40) NOT NULL DEFAULT '',
    impact      VARCHAR(16) NOT NULL DEFAULT 'degraded',
    status      VARCHAR(16) NOT NULL DEFAULT 'investigating',
    auto        BOOLEAN NOT NULL DEFAULT FALSE,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    created_by  BIGINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claudex_status_incidents_open ON claudex_status_incidents (resolved_at, started_at);

CREATE TABLE IF NOT EXISTS claudex_status_incident_updates (
    id          BIGSERIAL PRIMARY KEY,
    incident_id BIGINT NOT NULL REFERENCES claudex_status_incidents(id) ON DELETE CASCADE,
    status      VARCHAR(16) NOT NULL,
    message     TEXT NOT NULL DEFAULT '',
    created_by  BIGINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claudex_status_incident_updates_incident ON claudex_status_incident_updates (incident_id, created_at);
