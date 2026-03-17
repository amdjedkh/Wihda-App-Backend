CREATE TABLE IF NOT EXISTS badges (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#14ae5c',
  category TEXT NOT NULL DEFAULT 'general',
  requirement_type TEXT NOT NULL,
  requirement_value INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_badges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  badge_key TEXT NOT NULL,
  earned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, badge_key)
);

INSERT INTO badges (id, key, name, description, icon, color, category, requirement_type, requirement_value) VALUES
  ('badge-1', 'food_saver', 'Food Saver', 'Share food with your community', '🍞', '#f97316', 'leftovers', 'leftover_offers', 1),
  ('badge-2', 'active_member', 'Active Member', 'Be an active community participant', '⚡', '#3b82f6', 'community', 'total_actions', 5),
  ('badge-3', 'citizen_of_month', 'Citizen of the Month', 'Complete 10 community activities', '🏆', '#f0a326', 'community', 'total_actions', 10),
  ('badge-4', 'local_giver', 'Local Giver', 'Help your neighbors', '🤝', '#14ae5c', 'community', 'total_actions', 3),
  ('badge-5', 'cleanify_champion', 'Cleanify Champion', 'Complete 5 cleanify submissions', '🌿', '#10b981', 'cleanify', 'cleanify_approved', 5),
  ('badge-6', 'top_helper', 'Top Helper', 'Complete 20 community activities', '💪', '#8b5cf6', 'community', 'total_actions', 20);
