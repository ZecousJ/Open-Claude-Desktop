ALTER TABLE claudex_share_invites
    ADD COLUMN role TEXT NOT NULL DEFAULT 'edit'
    CHECK (role IN ('view', 'comment', 'edit'));
