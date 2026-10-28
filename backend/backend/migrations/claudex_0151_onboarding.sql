-- Claudex first-run onboarding: the questions a new account answers once,
-- after sign-up (live claude.ai bundle, 2026-10-12: "What kind of work do you
-- do?", "Set up and start coding", "Connect your work tools", "How did you
-- get here?", the first task).
--
-- A row is written by the sign-up hook with finished_at NULL: the apps show
-- the onboarding while it is NULL and never again once it is set. Accounts
-- made before this table (no row) are never asked; a row the apps create for
-- them (the work type changed in Settings) is finished from the start.
CREATE TABLE IF NOT EXISTS claudex_onboarding (
    user_id             BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- The original's work_function (the Settings work type).
    work_function       VARCHAR(40) NOT NULL DEFAULT '',
    -- "How did you get here?": the source, the social platform, the "Other" text.
    hear_about          VARCHAR(40) NOT NULL DEFAULT '',
    hear_about_platform VARCHAR(40) NOT NULL DEFAULT '',
    hear_about_other    VARCHAR(200) NOT NULL DEFAULT '',
    -- "Set up and start coding": desktop, web or skipped.
    code_setup          VARCHAR(20) NOT NULL DEFAULT '',
    -- The connectors connected during the step (names, one per line).
    connected_tools     TEXT NOT NULL DEFAULT '',
    -- The starter task picked first, own_topic, or skipped.
    first_task          VARCHAR(60) NOT NULL DEFAULT '',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
