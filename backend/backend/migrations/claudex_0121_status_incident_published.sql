-- claudex_0121_status_incident_published.sql (service status)
-- An incident reaches people only once an administrator publishes it. The
-- ones the channel checks open by themselves start as drafts the console
-- shows; those already opened that way go back to being drafts.
ALTER TABLE claudex_status_incidents ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE claudex_status_incidents SET published = FALSE WHERE auto AND NOT EXISTS (
    SELECT 1 FROM claudex_status_incident_updates u
    WHERE u.incident_id = claudex_status_incidents.id AND u.created_by <> 0);
