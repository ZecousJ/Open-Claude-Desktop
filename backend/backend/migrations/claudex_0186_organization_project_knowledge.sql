ALTER TABLE claudex_web_files
    ADD COLUMN IF NOT EXISTS organization_id UUID,
    ADD COLUMN IF NOT EXISTS project_id VARCHAR(128);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'claudex_web_files'::regclass AND conname = 'claudex_web_files_organization_project') THEN
        ALTER TABLE claudex_web_files ADD CONSTRAINT claudex_web_files_organization_project
            FOREIGN KEY (organization_id, project_id) REFERENCES claudex_web_projects (organization_id, id)
            MATCH FULL ON DELETE CASCADE;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS claudex_web_files_project_name
    ON claudex_web_files (organization_id, project_id, name) WHERE organization_id IS NOT NULL;
