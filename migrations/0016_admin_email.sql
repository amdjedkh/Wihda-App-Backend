-- Promote the designated admin account.
-- Safe to run before or after registration; no-op if the email doesn't exist yet.
UPDATE users
SET    role                = 'admin',
       verification_status = 'verified'
WHERE  email               = 'amdjedkh.collab@gmail.com';
