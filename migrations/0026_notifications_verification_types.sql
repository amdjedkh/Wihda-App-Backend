-- Add verification_approved and verification_rejected to notifications type constraint
-- SQLite doesn't support ALTER COLUMN, so we recreate the table

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS notifications_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN (
        'match_created',
        'new_message',
        'match_closed',
        'coins_awarded',
        'cleanify_approved',
        'cleanify_rejected',
        'campaign_new',
        'verification_approved',
        'verification_rejected',
        'system'
    )),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data TEXT,
    read_at TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO notifications_new SELECT * FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

PRAGMA foreign_keys = ON;
