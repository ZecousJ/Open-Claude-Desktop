-- Claudex W-ADMIN1: an administrator can switch a runner token off without
-- revoking it. A disabled runner cannot link (like a revoked one) but the
-- token stays valid and can be switched on again from the console's Web app
-- page. Idempotent.
ALTER TABLE claudex_web_runners ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ NULL;
