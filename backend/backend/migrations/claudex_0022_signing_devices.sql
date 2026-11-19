CREATE TABLE IF NOT EXISTS claudex_signing_devices (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id          UUID NOT NULL,
    display_name       VARCHAR(255) NOT NULL,
    platform           VARCHAR(16) NOT NULL,
    public_key         BYTEA,
    is_hardware_backed BOOLEAN NOT NULL,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (public_key IS NOT NULL OR NOT is_hardware_backed)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_signing_devices_active_installation
    ON claudex_signing_devices (user_id, device_id) WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_signing_devices_public_key
    ON claudex_signing_devices (user_id, public_key) WHERE public_key IS NOT NULL;
