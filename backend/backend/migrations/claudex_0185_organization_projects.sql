ALTER TABLE claudex_web_projects
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES claudex_plugin_organizations(id),
    ADD COLUMN IF NOT EXISTS organization_role TEXT NOT NULL DEFAULT 'none'
        CHECK (organization_role IN ('none', 'view', 'user') AND (organization_id IS NOT NULL OR organization_role = 'none'));

CREATE UNIQUE INDEX IF NOT EXISTS claudex_web_projects_organization_id
    ON claudex_web_projects (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS claudex_web_projects_shared_id
    ON claudex_web_projects (id) WHERE organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS claudex_web_project_grants (
    organization_id UUID NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    user_id BIGINT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('view', 'user')),
    PRIMARY KEY (organization_id, project_id, user_id),
    FOREIGN KEY (organization_id, project_id) REFERENCES claudex_web_projects (organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, user_id) REFERENCES claudex_plugin_organization_members (organization_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claudex_web_project_stars (
    organization_id UUID NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    user_id BIGINT NOT NULL,
    PRIMARY KEY (organization_id, project_id, user_id),
    FOREIGN KEY (organization_id, project_id) REFERENCES claudex_web_projects (organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, user_id) REFERENCES claudex_plugin_organization_members (organization_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claudex_web_project_policies (
    organization_id UUID PRIMARY KEY REFERENCES claudex_plugin_organizations(id) ON DELETE CASCADE,
    sharing_enabled BOOLEAN NOT NULL,
    public_projects_enabled BOOLEAN NOT NULL CHECK (NOT public_projects_enabled OR sharing_enabled)
);
