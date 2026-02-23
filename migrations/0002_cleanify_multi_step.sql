-- Migration: 0002_cleanify_multi_step
-- Rewrites cleanify_submissions to support the multi-step, time-gated flow
-- described in Architecture.md:
--   draft_before → in_progress → pending_review → approved | rejected | expired
--
-- BREAKING CHANGE: replaces the old 'pending|approved|rejected' single-step schema.

-- Create new table with full multi-step schema
CREATE TABLE IF NOT EXISTS cleanify_submissions (
    id                  TEXT PRIMARY KEY,               -- UUID

    -- Ownership
    user_id             TEXT NOT NULL,
    neighborhood_id     TEXT NOT NULL,

    -- Step 1 – before photo
    before_photo_url    TEXT,                           -- NULL until confirmed
    before_photo_key    TEXT,                           -- R2 object key
    before_uploaded_at  TEXT,                           -- When confirmed; used for time gate
    started_at          TEXT,                           -- Same as before_uploaded_at (alias for clarity)

    -- Step 2 – after photo (≥20 min after before_uploaded_at)
    after_photo_url     TEXT,                           -- NULL until confirmed
    after_photo_key     TEXT,                           -- R2 object key
    after_uploaded_at   TEXT,
    completed_at        TEXT,                           -- When after confirmed & sent to review

    -- Optional metadata
    geo_lat             REAL,
    geo_lng             REAL,
    description         TEXT CHECK (length(description) <= 1000),

    -- Status lifecycle
    status TEXT NOT NULL DEFAULT 'draft_before'
        CHECK (status IN (
            'draft_before',     -- created, waiting for before photo
            'in_progress',      -- before confirmed, waiting for after photo
            'pending_review',   -- after confirmed, awaiting moderation
            'approved',
            'rejected',
            'expired'           -- 48 h window elapsed without completion
        )),

    -- Moderation fields (populated on approve/reject)
    reviewer_id         TEXT,
    reviewed_at         TEXT,
    review_note         TEXT CHECK (length(review_note) <= 1000),
    coins_awarded       INTEGER NOT NULL DEFAULT 0,

    -- Audit
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (user_id)           REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (neighborhood_id)   REFERENCES neighborhoods(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewer_id)       REFERENCES users(id)
);

-- Re-create indexes
CREATE INDEX idx_cleanify_user        ON cleanify_submissions(user_id);
CREATE INDEX idx_cleanify_neighborhood ON cleanify_submissions(neighborhood_id);
CREATE INDEX idx_cleanify_status      ON cleanify_submissions(status);
CREATE INDEX idx_cleanify_submitted   ON cleanify_submissions(created_at);