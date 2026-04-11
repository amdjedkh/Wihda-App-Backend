-- Add apple_id column to users table for Sign in with Apple
ALTER TABLE users ADD COLUMN apple_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_apple_id ON users(apple_id);
