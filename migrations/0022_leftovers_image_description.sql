-- Migration 0022: Add image_url to leftover_offers, description/title to leftover_needs
-- Also adds offer_id to chat_threads for direct (non-match) chat

ALTER TABLE leftover_offers ADD COLUMN image_url TEXT;
ALTER TABLE leftover_needs ADD COLUMN title TEXT;
ALTER TABLE leftover_needs ADD COLUMN description TEXT;
ALTER TABLE chat_threads ADD COLUMN offer_id TEXT REFERENCES leftover_offers(id) ON DELETE SET NULL;
