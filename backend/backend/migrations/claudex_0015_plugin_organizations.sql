CREATE TABLE IF NOT EXISTS claudex_plugin_organizations (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND octet_length(name) <= 200)
);

CREATE TABLE IF NOT EXISTS claudex_plugin_organization_members (
    organization_id UUID NOT NULL REFERENCES claudex_plugin_organizations(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
    PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_claudex_plugin_organization_members_user
    ON claudex_plugin_organization_members (user_id, organization_id);

CREATE TABLE IF NOT EXISTS claudex_plugin_organization_marketplaces (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES claudex_plugin_organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
    display_name TEXT NOT NULL CHECK (length(btrim(display_name)) > 0 AND octet_length(display_name) <= 200),
    UNIQUE (organization_id, name)
);
