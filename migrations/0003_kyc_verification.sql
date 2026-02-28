-- Migration: 0003_kyc_verification
-- Adds KYC/identity verification.
--
-- Design decisions:
--   - We add a SEPARATE `verification_status` column to `users` rather than
--     touching the existing `status` CHECK constraint (SQLite does not support
--     ALTER TABLE ... MODIFY CONSTRAINT, and a full table rebuild is risky on
--     live data).
--   - `users.status` stays as-is ('active' | 'banned' | 'suspended').
--   - Verification state is tracked in `verification_status` and the new
--     `verification_sessions` table.
--   - Signup now sets verification_status = 'unverified'; login is gated on
--     verification_status = 'verified'.

-- ─────────────────────────────────────────────────────────────────
-- Extend users table
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed'));

CREATE INDEX idx_users_verification_status ON users(verification_status);

-- ─────────────────────────────────────────────────────────────────
-- Verification sessions table
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS verification_sessions (
    id                  TEXT PRIMARY KEY,

    user_id             TEXT NOT NULL,

    -- R2 object keys for uploaded documents (NULL until confirmed)
    front_doc_key       TEXT,
    back_doc_key        TEXT,
    selfie_key          TEXT,

    -- Session lifecycle:
    --   created     -> session open, awaiting uploads
    --   pending     -> submitted, job enqueued
    --   processing  -> Gemini call in-flight
    --   verified    -> approved
    --   failed      -> rejected (AI or manual)
    --   expired     -> 24h TTL elapsed without submission
    status TEXT NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'pending', 'processing', 'verified', 'failed', 'expired')),

    -- AI review output
    ai_result           TEXT,           -- Raw JSON from Gemini
    ai_confidence       REAL,           -- 0.0–1.0
    ai_rejection_reason TEXT,
    ai_reviewed_at      TEXT,

    -- Manual override (admin)
    manual_reviewer_id  TEXT,
    manual_reviewed_at  TEXT,
    manual_note         TEXT CHECK (length(manual_note) <= 1000),

    -- Abuse prevention
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    last_attempt_at     TEXT,

    -- 24-hour TTL
    expires_at          TEXT NOT NULL,

    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (user_id)            REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (manual_reviewer_id) REFERENCES users(id)
);

CREATE INDEX idx_verification_sessions_user    ON verification_sessions(user_id);
CREATE INDEX idx_verification_sessions_status  ON verification_sessions(status);
CREATE INDEX idx_verification_sessions_expires ON verification_sessions(expires_at);

-- ─────────────────────────────────────────────────────────────────
-- Back-fill: mark all existing active users as verified so
--    they are not locked out after this migration is applied.
-- ─────────────────────────────────────────────────────────────────

UPDATE users SET verification_status = 'verified' WHERE status = 'active';