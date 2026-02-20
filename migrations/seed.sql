-- Wihda Backend - Seed Data
-- Initial data for pilot neighborhood and testing

-- ============================================
-- 1. NEIGHBORHOODS
-- ============================================

INSERT INTO neighborhoods (id, name, city, country, center_lat, center_lng, radius_meters, is_active) VALUES
    ('nb-001', 'Hay Riad', 'Rabat', 'MA', 33.9716, -6.8498, 3000, 1),
    ('nb-002', 'Agdal', 'Rabat', 'MA', 33.9911, -6.8477, 2500, 1),
    ('nb-003', 'Maarif', 'Casablanca', 'MA', 33.5883, -7.6114, 2000, 1);

-- ============================================
-- 2. TEST USERS
-- ============================================

-- Password for all test users: 'password123' (bcrypt hash)
INSERT INTO users (id, email, phone, password_hash, display_name, role, status) VALUES
    ('user-001', 'admin@wihda.ma', '+212600000001', '4069da231443a3b2ebf392908e35b8b3f1a697ee08d6c921efc45a2d00d21455', 'Admin User', 'admin', 'active'),
    ('user-002', 'mod@wihda.ma', '+212600000002', '4069da231443a3b2ebf392908e35b8b3f1a697ee08d6c921efc45a2d00d21455', 'Moderator One', 'moderator', 'active'),
    ('user-003', 'ahmed@example.ma', '+212600000003', '4069da231443a3b2ebf392908e35b8b3f1a697ee08d6c921efc45a2d00d21455', 'Ahmed Benali', 'user', 'active'),
    ('user-004', 'fatima@example.ma', '+212600000004', '4069da231443a3b2ebf392908e35b8b3f1a697ee08d6c921efc45a2d00d21455', 'Fatima Zahra', 'user', 'active'),
    ('user-005', 'youssef@example.ma', '+212600000005', '4069da231443a3b2ebf392908e35b8b3f1a697ee08d6c921efc45a2d00d21455', 'Youssef Amrani', 'user', 'active');

-- ============================================
-- 3. USER NEIGHBORHOOD MEMBERSHIP
-- ============================================

INSERT INTO user_neighborhoods (id, user_id, neighborhood_id, is_primary) VALUES
    ('un-001', 'user-001', 'nb-001', 1),
    ('un-002', 'user-002', 'nb-001', 1),
    ('un-003', 'user-003', 'nb-001', 1),
    ('un-004', 'user-004', 'nb-001', 1),
    ('un-005', 'user-005', 'nb-002', 1);

-- ============================================
-- 4. SAMPLE CAMPAIGNS
-- ============================================

INSERT INTO campaigns (id, neighborhood_id, title, description, organizer, location, start_dt, end_dt, source, last_seen_at) VALUES
    ('camp-001', 'nb-001', 'Nettoyage Quartier Hay Riad', 'Opération de nettoyage communautaire', 'Association Hay Riad', 'Place Hay Riad', '2026-02-15T09:00:00Z', '2026-02-15T12:00:00Z', 'manual', datetime('now')),
    ('camp-002', 'nb-001', 'Distribution de Vêtements', 'Distribution de vêtements pour les familles dans le besoin', 'Croissant Rouge Marocain', 'Centre Social Hay Riad', '2026-02-20T10:00:00Z', '2026-02-20T16:00:00Z', 'manual', datetime('now')),
    ('camp-003', 'nb-002', 'Festival Culturel Agdal', 'Journées culturelles et artistiques', 'Municipalité Agdal', 'Parc Agdal', '2026-03-01T14:00:00Z', '2026-03-03T22:00:00Z', 'manual', datetime('now'));

-- ============================================
-- 5. SAMPLE LEFTOVER OFFERS (for testing)
-- ============================================

INSERT INTO leftover_offers (id, user_id, neighborhood_id, title, description, survey_json, quantity, expiry_at, status) VALUES
    ('offer-001', 'user-003', 'nb-001', 'Couscous traditionnel', 'Couscous aux légumes fait maison, assez pour 4 personnes', 
     '{"schema_version":1,"food_type":"cooked_meal","diet_constraints":["halal"],"portions":4,"pickup_time_preference":"evening","distance_willing_km":2,"notes":"Préparé aujourd''hui"}', 
     1, datetime('now', '+1 day'), 'active');

-- ============================================
-- 6. SAMPLE LEFTOVER NEEDS (for testing)
-- ============================================

INSERT INTO leftover_needs (id, user_id, neighborhood_id, survey_json, urgency, status) VALUES
    ('need-001', 'user-004', 'nb-001', 
     '{"schema_version":1,"food_type":"cooked_meal","diet_constraints":["halal"],"portions":2,"pickup_time_preference":"evening","distance_willing_km":3,"notes":"Famille de 2 personnes"}',
     'normal', 'active');

-- ============================================
-- 7. SYSTEM SETTINGS
-- ============================================

INSERT INTO system_settings (key, value, description) VALUES
    ('matching_min_score', '0.5', 'Minimum score threshold for creating matches'),
    ('matching_max_per_day', '5', 'Maximum matches per user per day'),
    ('cleanify_max_pending_hours', '48', 'Maximum hours a submission can stay pending'),
    ('campaign_grace_period_hours', '72', 'Hours before marking unseen campaigns as expired'),
    ('chat_max_message_length', '2000', 'Maximum characters per chat message'),
    ('rate_limit_offers_per_day', '10', 'Maximum offers per user per day'),
    ('rate_limit_needs_per_day', '10', 'Maximum needs per user per day'),
    ('rate_limit_messages_per_minute', '10', 'Maximum messages per user per minute');
