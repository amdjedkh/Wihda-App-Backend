-- Add language column to cleanify_submissions for AI response language support
ALTER TABLE cleanify_submissions ADD COLUMN language TEXT DEFAULT 'en';
