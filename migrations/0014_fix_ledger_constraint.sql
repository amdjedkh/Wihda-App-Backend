-- Migration 0014: Expand coin_ledger_entries.source_type CHECK constraint
-- to include 'store_redemption' (SQLite requires full table recreation).
-- Also ensures Google OAuth users can have a placeholder password_hash.

-- Step 1: Create replacement table with updated constraint
CREATE TABLE IF NOT EXISTS coin_ledger_entries_v2 (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  neighborhood_id TEXT NOT NULL,
  source_type     TEXT NOT NULL CHECK (source_type IN (
    'leftovers_match_closed_giver',
    'leftovers_match_closed_receiver',
    'cleanify_approved',
    'admin_adjustment',
    'signup_bonus',
    'referral_bonus',
    'store_redemption'
  )),
  source_id       TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  category        TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'void')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL,
  voided_at       TEXT,
  voided_by       TEXT,
  void_reason     TEXT,
  FOREIGN KEY (user_id)         REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE,
  UNIQUE (source_type, source_id, user_id)
);

-- Step 2: Copy existing data
INSERT INTO coin_ledger_entries_v2
SELECT * FROM coin_ledger_entries;

-- Step 3: Drop old table (D1 disables FK checks during migrations)
DROP TABLE coin_ledger_entries;

-- Step 4: Rename to canonical name
ALTER TABLE coin_ledger_entries_v2 RENAME TO coin_ledger_entries;

-- Step 5: Restore indexes
CREATE INDEX IF NOT EXISTS idx_coin_ledger_user       ON coin_ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_neighborhood ON coin_ledger_entries(neighborhood_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_status      ON coin_ledger_entries(status);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_source      ON coin_ledger_entries(source_type, source_id);

-- ── Google OAuth: allow NULL password_hash ─────────────────────────────────────
-- Users created via Google don't have a password.  The original schema has
-- password_hash NOT NULL which would break createUserWithGoogle.
-- We recreate the users table with password_hash nullable.
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS users_v2 (
  id                   TEXT PRIMARY KEY,
  email                TEXT UNIQUE,
  phone                TEXT UNIQUE,
  password_hash        TEXT,          -- nullable: Google users have no password
  display_name         TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'user'   CHECK (role   IN ('user','moderator','admin')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned','suspended')),
  language_preference  TEXT DEFAULT 'fr',
  fcm_token            TEXT,
  photo_url            TEXT,
  google_id            TEXT UNIQUE,
  email_verified       INTEGER NOT NULL DEFAULT 0,
  phone_verified       INTEGER NOT NULL DEFAULT 0,
  verification_status  TEXT NOT NULL DEFAULT 'unverified'
                         CHECK (verification_status IN ('unverified','pending','approved','verified','rejected')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO users_v2
SELECT
  id, email, phone, password_hash, display_name, role, status,
  language_preference, fcm_token,
  COALESCE(photo_url, NULL),
  COALESCE(google_id, NULL),
  COALESCE(email_verified, 0),
  COALESCE(phone_verified, 0),
  COALESCE(verification_status, 'unverified'),
  created_at, updated_at
FROM users;

DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone  ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);

PRAGMA foreign_keys = ON;
