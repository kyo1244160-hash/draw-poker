-- migration: add tournament_entries table
-- Supabase の SQL Editor で実行してください

CREATE TABLE IF NOT EXISTS tournament_entries (
  id             BIGSERIAL   PRIMARY KEY,
  tournament_id  TEXT        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  account_id     TEXT        NOT NULL REFERENCES accounts(id)    ON DELETE CASCADE,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at   TIMESTAMPTZ,
  UNIQUE (tournament_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_tournament ON tournament_entries(tournament_id);
CREATE INDEX IF NOT EXISTS idx_entries_account    ON tournament_entries(account_id);
