-- claudex_0062_share_report_details.sql (R1 sharing: the app's Report chat)
-- A report sent from the app's Report chat dialog carries the form of the
-- live claude.ai report dialog (2026-10-12): the finer report category, the
-- reporter's optional name and e-mail, "Opt out of training on this report"
-- (off unless the reporter switches it on), and the signed-in account that
-- sent it. Reports from the public page keep the defaults. An administrator
-- must not use a report with opt_out_of_training set to train models.
ALTER TABLE claudex_share_reports ADD COLUMN IF NOT EXISTS category VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE claudex_share_reports ADD COLUMN IF NOT EXISTS reporter_name VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE claudex_share_reports ADD COLUMN IF NOT EXISTS reporter_email VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE claudex_share_reports ADD COLUMN IF NOT EXISTS opt_out_of_training BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE claudex_share_reports ADD COLUMN IF NOT EXISTS reporter_user_id BIGINT NULL;
