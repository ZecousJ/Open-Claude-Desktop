-- "What kind of science do you do? (optional)" under the Scientist role
-- (live claude.ai bundle, 2026-10-14, c10bf8b47 Dc): the fields picked, one
-- per line (biology, chemistry, clinical_medical, computer_science_ml,
-- engineering, materials_science, mathematics, physics, social_sciences,
-- other).
ALTER TABLE claudex_onboarding
    ADD COLUMN IF NOT EXISTS science_fields TEXT NOT NULL DEFAULT '';
