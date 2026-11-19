ALTER TABLE claudex_directory_submissions ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

UPDATE claudex_directory_submissions
SET published_at = updated_at
WHERE status = 'approved' AND published_at IS NULL AND withdrawn_at IS NULL
  AND NOT (input->>'kind' = 'mcp' AND input ? 'original');

CREATE UNIQUE INDEX IF NOT EXISTS claudex_directory_submissions_nonempty_slug
    ON claudex_directory_submissions ((input->>'slug'))
    WHERE withdrawn_at IS NULL AND input->>'slug' <> '';
DROP INDEX IF EXISTS claudex_directory_submissions_slug;
