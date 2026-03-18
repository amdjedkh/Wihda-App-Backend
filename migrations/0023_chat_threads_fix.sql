-- Migration 0023: Fix chat_threads + expand coin source types
-- 1) Recreate chat_threads: make match_id nullable, add need_id + confirmation fields
-- 2) Recreate coin_ledger_entries: add leftovers_exchange_complete source types

PRAGMA foreign_keys = OFF;

-- ─── chat_threads ────────────────────────────────────────────────────────────

CREATE TABLE chat_threads_v2 (
  id                  TEXT PRIMARY KEY,
  match_id            TEXT,
  offer_id            TEXT,
  need_id             TEXT,
  neighborhood_id     TEXT NOT NULL,
  participant_1_id    TEXT NOT NULL,
  participant_2_id    TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  confirmation_state  TEXT,
  confirmed_by        TEXT,
  last_message_at     TEXT,
  created_at          TEXT NOT NULL,
  closed_at           TEXT
);

INSERT INTO chat_threads_v2
  (id, match_id, offer_id, neighborhood_id, participant_1_id, participant_2_id,
   status, last_message_at, created_at, closed_at)
SELECT
  id, match_id, offer_id, neighborhood_id, participant_1_id, participant_2_id,
  status, last_message_at, created_at, closed_at
FROM chat_threads;

DROP TABLE chat_threads;
ALTER TABLE chat_threads_v2 RENAME TO chat_threads;

CREATE INDEX IF NOT EXISTS idx_chat_threads_match        ON chat_threads(match_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_participant1 ON chat_threads(participant_1_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_participant2 ON chat_threads(participant_2_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_offer        ON chat_threads(offer_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_need         ON chat_threads(need_id);

-- ─── coin_ledger_entries: add new source types ───────────────────────────────

CREATE TABLE coin_ledger_entries_v3 (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  neighborhood_id TEXT NOT NULL,
  source_type     TEXT NOT NULL CHECK (source_type IN (
    'leftovers_match_closed_giver',
    'leftovers_match_closed_receiver',
    'leftovers_exchange_complete',
    'leftovers_exchange_receiver',
    'cleanify_approved',
    'admin_adjustment',
    'signup_bonus',
    'referral_bonus',
    'store_redemption'
  )),
  source_id       TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  category        TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'void')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL,
  voided_at       TEXT,
  voided_by       TEXT,
  void_reason     TEXT,
  UNIQUE (source_type, source_id, user_id)
);

INSERT INTO coin_ledger_entries_v3 SELECT * FROM coin_ledger_entries;
DROP TABLE coin_ledger_entries;
ALTER TABLE coin_ledger_entries_v3 RENAME TO coin_ledger_entries;

CREATE INDEX IF NOT EXISTS idx_coin_ledger_user         ON coin_ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_neighborhood  ON coin_ledger_entries(neighborhood_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_status        ON coin_ledger_entries(status);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_source        ON coin_ledger_entries(source_type, source_id);

PRAGMA foreign_keys = ON;
