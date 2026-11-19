CREATE TABLE IF NOT EXISTS claudex_plugin_organization_catalog (
    marketplace_id UUID NOT NULL REFERENCES claudex_plugin_organization_marketplaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
    display_name TEXT NOT NULL CHECK (length(btrim(display_name)) > 0 AND octet_length(display_name) <= 200),
    description TEXT NOT NULL CHECK (octet_length(description) <= 1000),
    version TEXT NOT NULL CHECK (octet_length(version) <= 100),
    repository TEXT NOT NULL CHECK (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' AND octet_length(repository) <= 200),
    commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
    source_path TEXT NOT NULL CHECK (source_path ~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$' AND octet_length(source_path) <= 500),
    installation_preference TEXT NOT NULL CHECK (installation_preference IN ('available', 'auto_install', 'required', 'not_available')),
    PRIMARY KEY (marketplace_id, name)
);
