-- Migration: 0004_contact_submissions
-- Stores citizen and partner contact form submissions from the public website.

CREATE TABLE IF NOT EXISTS contact_submissions (
  id              TEXT    NOT NULL PRIMARY KEY,

  -- Discriminator — matches frontend ContactPayload['type']
  type            TEXT    NOT NULL CHECK(type IN ('citizen', 'partner')),

  -- Citizen fields (required when type = 'citizen')
  name            TEXT,
  email           TEXT    NOT NULL,
  topic           TEXT    CHECK(topic IN ('account', 'bug', 'feedback', 'other')),
  message         TEXT,

  -- Partner fields (required when type = 'partner')
  organization    TEXT,
  contact_person  TEXT,
  proposal        TEXT,

  -- Meta
  ip_address      TEXT,
  status          TEXT    NOT NULL DEFAULT 'new'
                          CHECK(status IN ('new', 'read', 'resolved')),
  created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_submissions_type       ON contact_submissions(type);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_status     ON contact_submissions(status);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_created_at ON contact_submissions(created_at);