-- Wihda Backend Database Schema
-- Cloudflare D1 (SQLite) - All UUIDs stored as TEXT

-- ============================================
-- 1. USERS & AUTHENTICATION
-- ============================================

-- Users table: Account and identity
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,  -- UUID
    email TEXT UNIQUE,
    phone TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'suspended')),
    language_preference TEXT DEFAULT 'fr',
    fcm_token TEXT,  -- Firebase Cloud Messaging token for push notifications
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_status ON users(status);

-- ============================================
-- 2. NEIGHBORHOODS & MEMBERSHIP
-- ============================================

-- Neighborhoods table: Tenant boundary
CREATE TABLE IF NOT EXISTS neighborhoods (
    id TEXT PRIMARY KEY,  -- UUID
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    country TEXT DEFAULT 'DZ',  -- Algeria country code
    center_lat REAL,  -- Latitude of center point
    center_lng REAL,  -- Longitude of center point
    radius_meters REAL,  -- Radius in meters from center
    geo_polygon TEXT,  -- JSON array of polygon coordinates (optional)
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_neighborhoods_city ON neighborhoods(city);
CREATE INDEX idx_neighborhoods_active ON neighborhoods(is_active);

-- User-Neighborhood membership
CREATE TABLE IF NOT EXISTS user_neighborhoods (
    id TEXT PRIMARY KEY,  -- UUID
    user_id TEXT NOT NULL,
    neighborhood_id TEXT NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    left_at TEXT,  -- NULL if currently active
    is_primary INTEGER DEFAULT 1,  -- Primary neighborhood for user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE,
    UNIQUE (user_id, neighborhood_id, left_at)  -- Prevent duplicate active memberships
);

CREATE INDEX idx_user_neighborhoods_user ON user_neighborhoods(user_id);
CREATE INDEX idx_user_neighborhoods_neighborhood ON user_neighborhoods(neighborhood_id);

-- ============================================
-- 3. COINS & REWARDS
-- ============================================

-- Coin ledger entries: Source of truth for all coin transactions
-- This is append-only; void entries instead of deleting
CREATE TABLE IF NOT EXISTS coin_ledger_entries (
    id TEXT PRIMARY KEY,  -- UUID
    user_id TEXT NOT NULL,
    neighborhood_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN (
        'leftovers_match_closed_giver',
        'leftovers_match_closed_receiver',
        'cleanify_approved',
        'admin_adjustment',
        'signup_bonus',
        'referral_bonus'
    )),
    source_id TEXT NOT NULL,  -- ID of related entity (match_id, submission_id, etc.)
    amount INTEGER NOT NULL,  -- Positive for awards, negative for deductions
    category TEXT NOT NULL,  -- 'leftovers', 'cleanify', 'admin', 'bonus'
    description TEXT,
    status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'void')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL,  -- 'system' or user_id of moderator/admin
    voided_at TEXT,
    voided_by TEXT,
    void_reason TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE,
    -- CRITICAL: Idempotency constraint - prevents duplicate awards
    UNIQUE (source_type, source_id, user_id)
);

CREATE INDEX idx_coin_ledger_user ON coin_ledger_entries(user_id);
CREATE INDEX idx_coin_ledger_neighborhood ON coin_ledger_entries(neighborhood_id);
CREATE INDEX idx_coin_ledger_status ON coin_ledger_entries(status);
CREATE INDEX idx_coin_ledger_source ON coin_ledger_entries(source_type, source_id);

-- ============================================
-- 4. LEFTOVERS (OFFERS & NEEDS)
-- ============================================

-- Leftover offers: Users offering extra food
CREATE TABLE IF NOT EXISTS leftover_offers (
    id TEXT PRIMARY KEY,  -- UUID
    user_id TEXT NOT NULL,
    neighborhood_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    survey_json TEXT NOT NULL,  -- JSON with schema_version, food_type, diet_constraints, portions, pickup_time_preference, distance_willing_km, notes
    schema_version INTEGER DEFAULT 1,
    quantity INTEGER DEFAULT 1,
    pickup_window_start TEXT,  -- ISO datetime
    pickup_window_end TEXT,    -- ISO datetime
    expiry_at TEXT NOT NULL,   -- When offer expires
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'matched', 'closed', 'cancelled', 'expired')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE
);

CREATE INDEX idx_leftover_offers_user ON leftover_offers(user_id);
CREATE INDEX idx_leftover_offers_neighborhood ON leftover_offers(neighborhood_id);
CREATE INDEX idx_leftover_offers_status ON leftover_offers(status);
CREATE INDEX idx_leftover_offers_expiry ON leftover_offers(expiry_at);

-- Leftover needs: Users requesting food
CREATE TABLE IF NOT EXISTS leftover_needs (
    id TEXT PRIMARY KEY,  -- UUID
    user_id TEXT NOT NULL,
    neighborhood_id TEXT NOT NULL,
    survey_json TEXT NOT NULL,  -- JSON with matching fields
    schema_version INTEGER DEFAULT 1,
    urgency TEXT DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high', 'urgent')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'matched', 'closed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE
);

CREATE INDEX idx_leftover_needs_user ON leftover_needs(user_id);
CREATE INDEX idx_leftover_needs_neighborhood ON leftover_needs(neighborhood_id);
CREATE INDEX idx_leftover_needs_status ON leftover_needs(status);

-- ============================================
-- 5. MATCHES
-- ============================================

-- Matches: Pairing of offers and needs
CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,  -- UUID
    neighborhood_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    need_id TEXT NOT NULL,
    offer_user_id TEXT NOT NULL,
    need_user_id TEXT NOT NULL,
    score REAL NOT NULL,  -- Match score (0-1)
    match_reason TEXT,  -- JSON explaining why match was made
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_closure', 'closed', 'cancelled', 'disputed')),
    closed_by TEXT,  -- User ID who initiated closure
    closed_at TEXT,
    closure_type TEXT CHECK (closure_type IN ('successful', 'cancelled', 'expired', 'disputed')),
    dispute_reason TEXT,
    coins_awarded INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (offer_id) REFERENCES leftover_offers(id) ON DELETE CASCADE,
    FOREIGN KEY (need_id) REFERENCES leftover_needs(id) ON DELETE CASCADE,
    FOREIGN KEY (offer_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (need_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE,
    UNIQUE (offer_id, need_id)  -- Prevent duplicate matches
);

CREATE INDEX idx_matches_neighborhood ON matches(neighborhood_id);
CREATE INDEX idx_matches_offer ON matches(offer_id);
CREATE INDEX idx_matches_need ON matches(need_id);
CREATE INDEX idx_matches_offer_user ON matches(offer_user_id);
CREATE INDEX idx_matches_need_user ON matches(need_user_id);
CREATE INDEX idx_matches_status ON matches(status);

-- ============================================
-- 6. CHAT SYSTEM
-- ============================================

-- Chat threads: Temporary match-based chat
CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY,  -- UUID
    match_id TEXT NOT NULL UNIQUE,
    neighborhood_id TEXT NOT NULL,
    participant_1_id TEXT NOT NULL,
    participant_2_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
    last_message_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
    FOREIGN KEY (participant_1_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (participant_2_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_threads_match ON chat_threads(match_id);
CREATE INDEX idx_chat_threads_participant_1 ON chat_threads(participant_1_id);
CREATE INDEX idx_chat_threads_participant_2 ON chat_threads(participant_2_id);

-- Chat messages: Individual messages in threads
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,  -- UUID
    thread_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    body TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'system', 'location')),
    media_url TEXT,  -- R2 URL for images
    metadata TEXT,  -- JSON for additional data
    read_at TEXT,  -- When recipient read the message
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Critical index for pagination
CREATE INDEX idx_chat_messages_thread_created ON chat_messages(thread_id, created_at);
CREATE INDEX idx_chat_messages_sender ON chat_messages(sender_id);

-- ============================================
-- 7. CLEANIFY
-- ============================================

-- Cleanify submissions: Before/after cleaning proof
CREATE TABLE IF NOT EXISTS cleanify_submissions (
    id TEXT PRIMARY KEY,  -- UUID
    user_id TEXT NOT NULL,
    neighborhood_id TEXT NOT NULL,
    before_photo_url TEXT NOT NULL,  -- R2 URL
    after_photo_url TEXT NOT NULL,   -- R2 URL
    geo_lat REAL,
    geo_lng REAL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewer_id TEXT,
    reviewed_at TEXT,
    review_note TEXT,
    coins_awarded INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewer_id) REFERENCES users(id)
);

CREATE INDEX idx_cleanify_user ON cleanify_submissions(user_id);
CREATE INDEX idx_cleanify_neighborhood ON cleanify_submissions(neighborhood_id);
CREATE INDEX idx_cleanify_status ON cleanify_submissions(status);
CREATE INDEX idx_cleanify_submitted ON cleanify_submissions(submitted_at);

-- ============================================
-- 8. CAMPAIGNS
-- ============================================

-- Campaigns: Local activity listings
CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,  -- UUID
    neighborhood_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    organizer TEXT,
    location TEXT,
    location_lat REAL,
    location_lng REAL,
    start_dt TEXT NOT NULL,  -- ISO datetime
    end_dt TEXT,  -- ISO datetime, NULL if single-day event
    url TEXT,  -- External URL
    image_url TEXT,  -- R2 URL or external
    source TEXT NOT NULL CHECK (source IN ('scrape', 'manual', 'api')),
    source_identifier TEXT,  -- Unique identifier from source
    external_id TEXT,  -- ID from external system
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
    last_seen_at TEXT NOT NULL,  -- Last time seen in source
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id) ON DELETE CASCADE,
    -- Upsert constraint
    UNIQUE (source, url)
);

CREATE INDEX idx_campaigns_neighborhood ON campaigns(neighborhood_id);
CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaigns_start_dt ON campaigns(start_dt);
CREATE INDEX idx_campaigns_source ON campaigns(source);
CREATE INDEX idx_campaigns_last_seen ON campaigns(last_seen_at);

-- ============================================
-- 9. MODERATION LOG
-- ============================================

-- Moderation actions log for audit trail
CREATE TABLE IF NOT EXISTS moderation_logs (
    id TEXT PRIMARY KEY,  -- UUID
    moderator_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (action_type IN (
        'cleanify_approve',
        'cleanify_reject',
        'match_void',
        'coin_void',
        'user_ban',
        'user_unban',
        'content_remove'
    )),
    target_type TEXT NOT NULL,  -- 'submission', 'match', 'user', etc.
    target_id TEXT NOT NULL,
    reason TEXT,
    metadata TEXT,  -- JSON for additional context
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (moderator_id) REFERENCES users(id)
);

CREATE INDEX idx_moderation_logs_moderator ON moderation_logs(moderator_id);
CREATE INDEX idx_moderation_logs_target ON moderation_logs(target_type, target_id);
CREATE INDEX idx_moderation_logs_created ON moderation_logs(created_at);

-- ============================================
-- 10. NOTIFICATIONS
-- ============================================

-- Notification queue for tracking sent notifications
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,  -- UUID
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN (
        'match_created',
        'new_message',
        'match_closed',
        'coins_awarded',
        'cleanify_approved',
        'cleanify_rejected',
        'campaign_new',
        'system'
    )),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data TEXT,  -- JSON payload
    read_at TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_read ON notifications(user_id, read_at);
CREATE INDEX idx_notifications_created ON notifications(created_at);

-- ============================================
-- 11. RATE LIMITING & ANTI-ABUSE
-- ============================================

-- Match history for pair repetition detection
CREATE TABLE IF NOT EXISTS match_history (
    id TEXT PRIMARY KEY,
    user_1_id TEXT NOT NULL,
    user_2_id TEXT NOT NULL,
    match_id TEXT NOT NULL,
    closed_at TEXT NOT NULL,
    was_successful INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX idx_match_history_users ON match_history(user_1_id, user_2_id);
CREATE INDEX idx_match_history_closed ON match_history(closed_at);

-- ============================================
-- 12. SETTINGS & CONFIGURATION
-- ============================================

-- System configuration
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Coin reward rules
CREATE TABLE IF NOT EXISTS coin_rules (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert default coin rules
INSERT OR IGNORE INTO coin_rules (id, source_type, amount, description) VALUES
    ('rule-001', 'leftovers_match_closed_giver', 200, 'Reward for successfully giving leftovers'),
    ('rule-002', 'leftovers_match_closed_receiver', 50, 'Reward for successfully receiving leftovers'),
    ('rule-003', 'cleanify_approved', 150, 'Reward for approved cleanify submission'),
    ('rule-004', 'signup_bonus', 50, 'Welcome bonus for new users');
