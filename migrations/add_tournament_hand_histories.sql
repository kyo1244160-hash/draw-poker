-- トーナメント専用ハンドヒストリー
-- 1レコード = 1ハンド。リングゲームは保存対象外。

CREATE TABLE IF NOT EXISTS tournament_hand_histories (
  id            BIGSERIAL PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  table_id      TEXT NOT NULL,
  hand_no       INTEGER NOT NULL,
  mode          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  payload_hash  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tournament_id, table_id, hand_no)
);

CREATE INDEX IF NOT EXISTS idx_tournament_hand_histories_tournament
  ON tournament_hand_histories (tournament_id, hand_no, table_id);

