-- claudex_0141_device_signed_in.sql (Settings → Account → Active sessions)
--
-- When the device's current sign-in began. The app's Active sessions table
-- shows it as Created: created_at is the first time the device was ever
-- registered, which stays the same across sign-outs and new sign-ins.
-- A registration sets it when the row is new, was signed out, or arrives
-- with another session family (another sign-in on the same device). Rows
-- from before this column read created_at instead (COALESCE in the list).
ALTER TABLE claudex_devices ADD COLUMN IF NOT EXISTS signed_in_at TIMESTAMPTZ NULL;
