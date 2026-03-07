-- Migration: 0005_contact_verification
-- Adds OTP-based email and phone verification before KYC.
--
-- Flow:
--   1. User signs up  -> restricted_token issued (scope: verification_only)
--   2. OTP sent to email (Resend) or phone (Twilio)
--   3. User submits OTP -> contact marked verified
--   4. User may then proceed to KYC (/v1/verification/*)
--
-- Design decisions:
--   - A separate `contact_verifications` table keeps OTP state out of `users`.
--   - We add two lightweight boolean columns to `users` rather than repurposing
--     `verification_status`, which is reserved for KYC.
--   - Codes are stored as SHA-256 hashes (hex) — never plaintext.
--   - Rate limiting is enforced via `send_count` + `last_sent_at`; the route
--     layer rejects a new send if send_count >= 3 within a 1-hour window.
--   - After 5 consecutive wrong guesses the record is locked (locked_until set).

-- ─────────────────────────────────────────────────────────────────
-- Extend users table
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN phone_verified  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified);
CREATE INDEX IF NOT EXISTS idx_users_phone_verified  ON users(phone_verified);

-- ─────────────────────────────────────────────────────────────────
-- OTP records table
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contact_verifications (
    id              TEXT PRIMARY KEY,           -- UUID

    user_id         TEXT NOT NULL,
    channel         TEXT NOT NULL               -- 'email' | 'phone'
        CHECK (channel IN ('email', 'phone')),
    target          TEXT NOT NULL,              -- The actual email address or phone number

    -- Code storage (SHA-256 hex of the 6-digit code)
    code_hash       TEXT NOT NULL,
    expires_at      TEXT NOT NULL,              -- 10 minutes from send time

    -- Attempt tracking
    attempts        INTEGER NOT NULL DEFAULT 0, -- Wrong guesses so far
    verified_at     TEXT,                       -- Set on successful verification

    -- Send-rate limiting
    send_count      INTEGER NOT NULL DEFAULT 1, -- Times a code was sent in this window
    last_sent_at    TEXT NOT NULL,              -- Used to enforce 1-hour send window

    -- Lockout (too many wrong guesses)
    locked_until    TEXT,                       -- NULL = not locked

    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_verifications_user    ON contact_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_contact_verifications_channel ON contact_verifications(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_contact_verifications_expires ON contact_verifications(expires_at);

-- ─────────────────────────────────────────────────────────────────
-- Back-fill: existing verified users need no contact re-verification.
-- Mark whichever column is populated as verified.
-- ─────────────────────────────────────────────────────────────────

UPDATE users SET email_verified = 1 WHERE email IS NOT NULL AND verification_status = 'verified';
UPDATE users SET phone_verified  = 1 WHERE phone  IS NOT NULL AND verification_status = 'verified';