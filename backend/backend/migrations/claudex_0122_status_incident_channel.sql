-- claudex_0122_status_incident_channel.sql (service status)
-- The status page lists Sub2API's channels by their names (codex, grok, …),
-- not the providers they belong to: incidents that named a provider now name
-- that provider's channel.
UPDATE claudex_status_incidents AS i SET platform = m.name
FROM channel_monitors AS m
WHERE i.platform <> '' AND i.platform = m.provider
  AND NOT EXISTS (SELECT 1 FROM channel_monitors x WHERE x.name = i.platform);
