-- claudex_0012_placement_default.sql (model catalog by group)
-- A group may name its default model by hand (owner, 2026-10-02). The
-- catalog uses it while the group still offers it and does not hide it;
-- otherwise the default falls to the next model in menu order (the first of
-- the main menu). At most one default per group.
ALTER TABLE claudex_model_placements
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_claudex_model_placements_default
    ON claudex_model_placements (group_id) WHERE is_default;
