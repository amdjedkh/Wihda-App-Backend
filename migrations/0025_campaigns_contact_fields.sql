-- Add contact fields to campaigns table
ALTER TABLE campaigns ADD COLUMN contact_phone TEXT;
ALTER TABLE campaigns ADD COLUMN contact_email TEXT;
