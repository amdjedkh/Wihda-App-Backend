-- Add deleted_at column to soft-delete users without touching the status CHECK constraint
ALTER TABLE users ADD COLUMN deleted_at TEXT;
