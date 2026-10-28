-- Claudex: which e-mails about artifacts an account wants (Settings →
-- General → Notifications): Mentions and replies, Comments on your
-- artifacts (NULL follows Mentions and replies until it is set) and
-- Artifacts shared with you. No row: all of them.
CREATE TABLE IF NOT EXISTS claudex_artifact_mail_prefs (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mentions    BOOLEAN NOT NULL DEFAULT TRUE,
    comments    BOOLEAN NULL,
    shares      BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
