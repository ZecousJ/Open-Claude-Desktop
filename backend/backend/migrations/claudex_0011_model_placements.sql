-- claudex_0011_model_placements.sql (model catalog by group)
-- Where each group shows a model: in the main menu, under More models, or
-- hidden, and its order there. A group lists every model its key gets
-- (/v1/models); a model without a row here shows in the main menu, in the
-- order of its shared description (claudex_model_meta). The default model
-- is no longer chosen: it is the first of the main menu.
CREATE TABLE IF NOT EXISTS claudex_model_placements (
    group_id   BIGINT       NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    model_id   VARCHAR(200) NOT NULL,
    placement  VARCHAR(8)   NOT NULL CHECK (placement IN ('main', 'more', 'hidden')),
    sort_order INT          NULL,
    updated_by BIGINT       NULL,
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, model_id)
);

-- More models stays as it was: a description marked hidden listed its model
-- under More models, so every existing group places it there.
INSERT INTO claudex_model_placements (group_id, model_id, placement, sort_order)
SELECT g.id, m.model_id, 'more', m.sort_order
FROM claudex_model_meta AS m
JOIN groups AS g ON (m.group_id IS NULL OR m.group_id = g.id)
WHERE m.hidden AND g.deleted_at IS NULL
ON CONFLICT (group_id, model_id) DO NOTHING;
