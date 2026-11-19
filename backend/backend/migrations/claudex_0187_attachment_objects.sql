ALTER TABLE claudex_web_files ADD COLUMN IF NOT EXISTS object_storage BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS claudex_web_attachment_objects (
    user_id BIGINT NOT NULL,
    file_id VARCHAR(64) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, file_id)
);
