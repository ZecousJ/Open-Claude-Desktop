-- claudex_0061_share_invites.sql (R1 sharing: invited people)
-- A conversation share can be limited to invited people: `invited_only`
-- shares have no public page (/s/<token> answers 404), and the people
-- invited by e-mail read the snapshot after signing in (Shared with you).
-- The invites are addresses, lower-cased; an address needs no account when it
-- is invited, only when the person opens the share.
ALTER TABLE claudex_shares ADD COLUMN IF NOT EXISTS invited_only BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS claudex_share_invites (
    share_id   BIGINT NOT NULL REFERENCES claudex_shares(id) ON DELETE CASCADE,
    email      VARCHAR(320) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (share_id, email)
);
CREATE INDEX IF NOT EXISTS idx_claudex_share_invites_email ON claudex_share_invites (email);
