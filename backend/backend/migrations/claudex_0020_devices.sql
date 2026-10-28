-- Claudex B4: desktop devices and their device keys (design 2.5).
--
-- claudex_devices: one row per (user, device). api_key_id is the device key;
-- an API key is a Claudex device key exactly when a row here points to it.
-- The raw device id is never stored, only
-- hex(sha256("claudex-device\n" || device_id)).
CREATE TABLE IF NOT EXISTS claudex_devices (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id_hash    CHAR(64) NOT NULL,
    api_key_id        BIGINT NULL REFERENCES api_keys(id) ON DELETE SET NULL,
    group_id          BIGINT NULL REFERENCES groups(id) ON DELETE SET NULL,
    session_family_id VARCHAR(64) NOT NULL DEFAULT '',
    device_name       VARCHAR(100) NOT NULL DEFAULT '',
    platform          VARCHAR(16) NOT NULL DEFAULT '',
    arch              VARCHAR(16) NOT NULL DEFAULT '',
    app_version       VARCHAR(32) NOT NULL DEFAULT '',
    last_seen_at      TIMESTAMPTZ NULL,
    last_ip           VARCHAR(64) NOT NULL DEFAULT '',
    revoked_at        TIMESTAMPTZ NULL,
    revoked_reason    VARCHAR(32) NOT NULL DEFAULT '' CHECK (revoked_reason IN ('', 'user', 'admin', 'revoke_all')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_devices_user_device ON claudex_devices (user_id, device_id_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_devices_api_key ON claudex_devices (api_key_id) WHERE api_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claudex_devices_user ON claudex_devices (user_id);

-- Last "log out of all devices" per user: access tokens issued at or before
-- this second are refused on every JWT endpoint (H9b).
CREATE TABLE IF NOT EXISTS claudex_session_revocations (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revoked_at  TIMESTAMPTZ NOT NULL,
    reason      VARCHAR(32) NOT NULL DEFAULT ''
);

-- Signed-out device sessions (JWT "sid" = refresh-token family). Rows expire
-- once no token of the family can still be valid.
CREATE TABLE IF NOT EXISTS claudex_revoked_sessions (
    session_family_id VARCHAR(64) PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revoked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claudex_revoked_sessions_expires ON claudex_revoked_sessions (expires_at);

-- Per-user device limit set by an administrator; without a row the
-- claudex_provisioning max_devices_per_user default applies.
CREATE TABLE IF NOT EXISTS claudex_user_device_limits (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_devices INT NOT NULL CHECK (max_devices BETWEEN 1 AND 50),
    updated_by  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
