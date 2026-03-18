-- Columns for secure in-place email change flow
ALTER TABLE users ADD COLUMN pending_email TEXT;
ALTER TABLE users ADD COLUMN pending_email_code_hash TEXT;
ALTER TABLE users ADD COLUMN pending_email_expires_at TEXT;
