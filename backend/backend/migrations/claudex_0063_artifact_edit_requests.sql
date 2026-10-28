CREATE TABLE IF NOT EXISTS claudex_artifact_edit_requests (
    share_id BIGINT NOT NULL REFERENCES claudex_shares(id) ON DELETE CASCADE,
    email VARCHAR(254) NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'declined', 'granted')),
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (share_id, email)
);
