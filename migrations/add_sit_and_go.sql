-- migration: add Sit & Go support to tournaments table
-- Supabase の SQL Editor で実行してください

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS is_sit_and_go BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS min_players INTEGER NOT NULL DEFAULT 3;

-- インデックス: SNG の registering 状態を高速に検索
CREATE INDEX IF NOT EXISTS idx_tournaments_sng
  ON tournaments(is_sit_and_go, status)
  WHERE is_sit_and_go = TRUE;
