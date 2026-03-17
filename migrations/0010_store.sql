CREATE TABLE IF NOT EXISTS store_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT NOT NULL DEFAULT '🎁',
  color TEXT NOT NULL DEFAULT 'bg-gray-50',
  category TEXT NOT NULL DEFAULT 'Popular',
  price_coins INTEGER NOT NULL DEFAULT 1000,
  stock INTEGER DEFAULT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS store_redemptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL REFERENCES store_items(id),
  coins_spent INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_redemptions_user ON store_redemptions(user_id);

INSERT INTO store_items (id, name, description, icon, color, category, price_coins) VALUES
  ('item-1','Feed 3 Cats Today','Help feed stray cats in your neighborhood','🐱','bg-[#fffaeb]','Popular',8000),
  ('item-2','Plant a Tree','A tree will be planted in your name','🌳','bg-green-50','Popular',5000),
  ('item-3','Event Tickets','Get free tickets to a community event','🎫','bg-blue-50','New',10000),
  ('item-4','Eco-friendly Items','Receive eco-friendly household items','♻️','bg-rose-50','New',10000),
  ('item-5','Premium Badges','Unlock exclusive profile badges','🏅','bg-purple-50','Top',10000),
  ('item-6','Donation to Charity','Donate to a local charity in your name','❤️','bg-red-50','Popular',3000);
