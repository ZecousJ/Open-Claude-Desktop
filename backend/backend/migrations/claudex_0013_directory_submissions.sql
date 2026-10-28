-- B3 catalog owns the app directory as well as model display metadata.
CREATE TABLE IF NOT EXISTS claudex_directory_submissions (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    input JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'in_review', 'approved', 'rejected')),
    reviewer_note TEXT NOT NULL DEFAULT '',
    reviewer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    withdrawn_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS claudex_directory_submissions_user ON claudex_directory_submissions (user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS claudex_directory_submissions_slug ON claudex_directory_submissions ((input->>'slug')) WHERE withdrawn_at IS NULL;
