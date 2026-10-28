-- claudex_0161_status_iq_groups.sql (service status: IQ check per group)
-- The IQ check runs for each of its groups (status/iq.go iqGroups; owner,
-- 2026-10-14: codex and "Astra 专用"); a row names the group it ran in.
-- Rows from before are codex's.
ALTER TABLE claudex_status_iq ADD COLUMN IF NOT EXISTS group_key VARCHAR(32) NOT NULL DEFAULT 'codex';
CREATE INDEX IF NOT EXISTS idx_claudex_status_iq_group_started ON claudex_status_iq (group_key, started_at DESC);
