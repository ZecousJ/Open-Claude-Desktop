CREATE TABLE IF NOT EXISTS claudex_plugin_organization_packages (
    marketplace_id UUID NOT NULL,
    name TEXT NOT NULL,
    commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    archive BYTEA NOT NULL CHECK (octet_length(archive) BETWEEN 1 AND 209715200),
    PRIMARY KEY (marketplace_id, name, commit_sha),
    FOREIGN KEY (marketplace_id, name)
        REFERENCES claudex_plugin_organization_catalog (marketplace_id, name) ON DELETE CASCADE,
    CHECK (sha256 = encode(sha256(archive), 'hex'))
);
