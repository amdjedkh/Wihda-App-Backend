CREATE TABLE cleanify_submissions_new (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    neighborhood_id     TEXT NOT NULL,
    before_photo_url    TEXT,
    before_photo_key    TEXT,
    before_uploaded_at  TEXT,
    started_at          TEXT,
    after_photo_url     TEXT,
    after_photo_key     TEXT,
    after_uploaded_at   TEXT,
    completed_at        TEXT,
    geo_lat             REAL,
    geo_lng             REAL,
    description         TEXT,
    status TEXT NOT NULL DEFAULT 'draft_before',
    reviewer_id         TEXT,
    reviewed_at         TEXT,
    review_note         TEXT,
    coins_awarded       INTEGER NOT NULL DEFAULT 0,
    submitted_at        TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewer_id) REFERENCES users(id)
);
INSERT INTO cleanify_submissions_new SELECT id, user_id, neighborhood_id, before_photo_url, before_photo_key, before_uploaded_at, started_at, after_photo_url, after_photo_key, after_uploaded_at, completed_at, geo_lat, geo_lng, description, status, reviewer_id, reviewed_at, review_note, coins_awarded, submitted_at, created_at, updated_at FROM cleanify_submissions;
DROP TABLE cleanify_submissions;
ALTER TABLE cleanify_submissions_new RENAME TO cleanify_submissions;
CREATE INDEX IF NOT EXISTS idx_cleanify_user ON cleanify_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_cleanify_neighborhood ON cleanify_submissions(neighborhood_id);
CREATE INDEX IF NOT EXISTS idx_cleanify_status ON cleanify_submissions(status);
CREATE INDEX IF NOT EXISTS idx_cleanify_submitted ON cleanify_submissions(created_at);
