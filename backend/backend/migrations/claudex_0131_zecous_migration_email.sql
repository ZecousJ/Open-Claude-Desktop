CREATE UNIQUE INDEX IF NOT EXISTS claudex_zecous_migrations_email_uidx
    ON claudex_zecous_migrations ((lower(btrim(email))));
