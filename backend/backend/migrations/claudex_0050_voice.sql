-- Claudex B7 (design 2.8, owner decisions 6/18): one row per dictation
-- session relayed through GET /v1/audio/realtime/transcriptions. Sessions are
-- billed by the audio forwarded upstream (16 kHz mono 16-bit PCM, so
-- audio_bytes / 32000 seconds): the upstream service reports no duration, so
-- every row is an estimate from the byte count. usage_logs needs an upstream
-- account, which this relay does not use, so administrators read dictation
-- charges here (GET /api/v1/admin/claudex/voice/estimated-usage) and match
-- request_id with the billing dedup row (usage_billing_dedup).
CREATE TABLE IF NOT EXISTS claudex_voice_sessions (
    request_id        VARCHAR(255) PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_id        BIGINT NULL REFERENCES api_keys(id) ON DELETE SET NULL,
    group_id          BIGINT NULL,
    audio_bytes       BIGINT NOT NULL,
    billed_seconds    NUMERIC(12,3) NOT NULL,
    cost_usd          NUMERIC(20,10) NOT NULL DEFAULT 0,
    billed            BOOLEAN NOT NULL,
    duration_ms       BIGINT NOT NULL DEFAULT 0,
    end_reason        VARCHAR(64) NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The admin list, newest first, optionally for one user.
CREATE INDEX IF NOT EXISTS idx_claudex_voice_sessions_created
    ON claudex_voice_sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_claudex_voice_sessions_user_created
    ON claudex_voice_sessions (user_id, created_at);
