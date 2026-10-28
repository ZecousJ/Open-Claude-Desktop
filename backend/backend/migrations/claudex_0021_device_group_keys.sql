-- Claudex MG: one device key per group the user may use.
--
-- claudex_devices.api_key_id stays the device's plan-group key (the key older
-- clients use); this table holds the device's keys for its other groups. A key
-- is a Claudex device key exactly when claudex_devices.api_key_id or a row here
-- points to it. Signing a device out, revoke-all and the device limit work per
-- device, so they cover every key of the device.
CREATE TABLE IF NOT EXISTS claudex_device_group_keys (
    id          BIGSERIAL PRIMARY KEY,
    device_id   BIGINT NOT NULL REFERENCES claudex_devices(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id    BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    api_key_id  BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_device_group_keys_group ON claudex_device_group_keys (device_id, group_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_device_group_keys_key ON claudex_device_group_keys (api_key_id);
CREATE INDEX IF NOT EXISTS idx_claudex_device_group_keys_user ON claudex_device_group_keys (user_id);
