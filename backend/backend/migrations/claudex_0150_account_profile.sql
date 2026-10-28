-- claudex_0150_account_profile.sql (sign-up profile step, owner 2026-10-12)
--
-- One row per Claudex user who finished the step after sign-up, after the
-- original's "Let's create your account": what Claudex calls them, their
-- birthday (checked against the minimum age before it is written) and the
-- version of the Claudex Terms of Service they accepted, with when. A user
-- whose terms_version is not the current one sees the step again.
CREATE TABLE IF NOT EXISTS claudex_account_profiles (
    user_id           BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name      VARCHAR(100) NOT NULL,
    birthdate         DATE NOT NULL,
    terms_version     VARCHAR(32) NOT NULL,
    terms_accepted_at TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
