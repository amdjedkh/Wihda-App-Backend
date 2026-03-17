-- Migration 0013: Replace store items with Flexy, add redemption form fields
-- and campaign_participants table

-- ── Store: disable all existing items ─────────────────────────────────────────
UPDATE store_items SET is_active = 0;

-- ── Store: add "1000 DZD Flexy" as the only active item ──────────────────────
INSERT OR REPLACE INTO store_items (id, name, description, icon, color, category, price_coins, is_active)
VALUES (
  'item-flexy',
  '1000 DZD Flexy',
  'Mobile credit recharge for any Algerian operator (Djezzy, Ooredoo, Mobilis). Delivered within 48 hours.',
  '📱',
  'bg-green-50',
  'Popular',
  2000,
  1
);

-- ── Store redemptions: add form fields ────────────────────────────────────────
ALTER TABLE store_redemptions ADD COLUMN full_name TEXT;
ALTER TABLE store_redemptions ADD COLUMN phone_number TEXT;
ALTER TABLE store_redemptions ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE store_redemptions ADD COLUMN notes TEXT;

-- ── Campaigns: add participant tracking and coin reward ───────────────────────
CREATE TABLE IF NOT EXISTS campaign_participants (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_participants_campaign ON campaign_participants(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_participants_user ON campaign_participants(user_id);

-- Add coin_reward column to campaigns if not present
ALTER TABLE campaigns ADD COLUMN coin_reward INTEGER NOT NULL DEFAULT 0;
