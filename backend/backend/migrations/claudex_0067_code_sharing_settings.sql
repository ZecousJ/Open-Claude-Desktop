CREATE TABLE IF NOT EXISTS claudex_code_sharing_settings (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    require_repository_access BOOLEAN NOT NULL DEFAULT TRUE,
    show_name BOOLEAN NOT NULL DEFAULT TRUE
);
