-- Minimal permanent replay denial; no feedback text is retained here.
CREATE TABLE IF NOT EXISTS claudex_feedback_withdrawals (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feedback_uuid UUID NOT NULL,
    withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, feedback_uuid)
);
