-- 0006: Neighborhood creation by users
-- Adds description, color, and created_by to neighborhoods table

ALTER TABLE neighborhoods ADD COLUMN description TEXT;
ALTER TABLE neighborhoods ADD COLUMN color TEXT DEFAULT '#14ae5c';
ALTER TABLE neighborhoods ADD COLUMN created_by TEXT REFERENCES users(id);
