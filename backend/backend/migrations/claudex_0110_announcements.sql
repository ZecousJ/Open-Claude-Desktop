-- claudex_0110_announcements.sql (announcements: pop-up notices and e-mail)
-- An announcement is written in the admin console and published for a
-- while: until expires_at the Claudex apps show it once to every signed-in
-- user, who closes it (any button) and never sees it again. A withdrawn or
-- expired announcement is shown to nobody. The reads are one row per user.
-- E-mail notices are sent to chosen users; each send keeps its message and
-- how many addresses it reached.
CREATE TABLE IF NOT EXISTS claudex_announcements (
    id            BIGSERIAL PRIMARY KEY,
    title         VARCHAR(200) NOT NULL DEFAULT '',
    badge         VARCHAR(40) NOT NULL DEFAULT '',
    body_html     TEXT NOT NULL DEFAULT '',
    body_format   VARCHAR(8) NOT NULL DEFAULT 'text',
    image_url     VARCHAR(2048) NOT NULL DEFAULT '',
    primary_label VARCHAR(60) NOT NULL DEFAULT '',
    primary_url   VARCHAR(2048) NOT NULL DEFAULT '',
    dismiss_label VARCHAR(60) NOT NULL DEFAULT '',
    status        VARCHAR(16) NOT NULL DEFAULT 'draft',
    published_at  TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,
    created_by    BIGINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claudex_announcements_live ON claudex_announcements (status, expires_at);

CREATE TABLE IF NOT EXISTS claudex_announcement_reads (
    announcement_id BIGINT NOT NULL REFERENCES claudex_announcements(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL,
    action          VARCHAR(16) NOT NULL DEFAULT 'close',
    read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_claudex_announcement_reads_user ON claudex_announcement_reads (user_id);

CREATE TABLE IF NOT EXISTS claudex_announcement_mails (
    id          BIGSERIAL PRIMARY KEY,
    subject     VARCHAR(200) NOT NULL,
    body_html   TEXT NOT NULL,
    recipients  INTEGER NOT NULL DEFAULT 0,
    sent        INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    status      VARCHAR(16) NOT NULL DEFAULT 'sending',
    created_by  BIGINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);
