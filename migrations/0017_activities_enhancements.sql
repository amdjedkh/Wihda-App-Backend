-- 0017: Activities system enhancements
-- Adds richer media + metadata columns to campaigns

ALTER TABLE campaigns ADD COLUMN images_json    TEXT;      -- JSON array of up to 3 image URLs
ALTER TABLE campaigns ADD COLUMN organizer_logo TEXT;      -- Logo URL for the organizer
ALTER TABLE campaigns ADD COLUMN subtitle       TEXT;      -- Short subtitle / tagline
