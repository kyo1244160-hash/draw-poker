-- =============================================================
-- Poker Room Pastis — Supabase スキーマ
-- =============================================================
-- Supabase の SQL Editor でこのファイルをそのまま実行してください。
-- 既存テーブルがある場合は DROP TABLE を先に実行してください。
-- =============================================================

-- ---------------------------------------------------------------
-- 認証・ユーザー系
-- ---------------------------------------------------------------

-- Google アカウント情報
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT        PRIMARY KEY,           -- Google ID (sub)
  email       TEXT        UNIQUE NOT NULL,
  google_name TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ゲーム内表示名（ニックネーム）
CREATE TABLE IF NOT EXISTS profiles (
  account_id           TEXT        PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  nickname             TEXT        UNIQUE NOT NULL,
  nickname_updated_at  TIMESTAMPTZ DEFAULT NOW(),  -- 最終変更日時（30日制限の基準）
  change_count         INTEGER     DEFAULT 0,        -- 変更回数（初回設定はカウントしない）
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  -- ニックネームは 2〜12 文字
  CONSTRAINT nickname_length CHECK (char_length(nickname) BETWEEN 2 AND 12)
);

-- 管理者
CREATE TABLE IF NOT EXISTS admins (
  account_id  TEXT        PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- トーナメント系
-- ---------------------------------------------------------------

-- ブラインドスケジュール（レベルごとのブラインド・ベット額・継続時間）
-- levels の形式: [{ level, sb, bb, smallBet, bigBet, durationMinutes }]
-- durationMinutes = 0 は最終レベル（タイマーなし）
CREATE TABLE IF NOT EXISTS blind_schedules (
  id                TEXT        PRIMARY KEY,  -- "standard" / "turbo" など
  name              TEXT        NOT NULL,
  description       TEXT,
  levels            JSONB       NOT NULL,
  late_level_cutoff INTEGER     NOT NULL DEFAULT 0,  -- レイトレジスト終了レベル（0=開始直後）
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- トーナメント
CREATE TABLE IF NOT EXISTS tournaments (
  id                  TEXT        PRIMARY KEY,
  name                TEXT        NOT NULL,
  mode                TEXT        NOT NULL,
  scheduled_start_at  TIMESTAMPTZ NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'registering',
  -- "registering" | "running" | "finished" | "cancelled"
  starting_chips      INTEGER     NOT NULL,
  max_players         INTEGER,               -- NULL = 無制限
  blind_schedule_id   TEXT        REFERENCES blind_schedules(id),
  is_test             BOOLEAN     NOT NULL DEFAULT FALSE,
  late_reg_minutes    INTEGER     NOT NULL DEFAULT 0,  -- 0=レベルベース, >0=開始から何分間参加可
  late_reg_closed_at  TIMESTAMPTZ,
  created_by          TEXT        REFERENCES accounts(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT tournament_status_check
    CHECK (status IN ('registering','running','finished','cancelled')),
  CONSTRAINT tournament_mode_check
    CHECK (mode IN ('27','badugi','mix','a5','27sd','mix3','beast+','stud_mix','stud_s','stud_e','razz','horse'))
);

-- テーブル座席割り当て（テーブルドロー画面・バランシング後の更新に使用）
CREATE TABLE IF NOT EXISTS tournament_seats (
  tournament_id  TEXT     NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  table_index    INTEGER  NOT NULL,
  seat_index     INTEGER  NOT NULL,
  account_id     TEXT     REFERENCES accounts(id),
  nickname       TEXT,
  PRIMARY KEY (tournament_id, table_index, seat_index)
);

-- ---------------------------------------------------------------
-- 履歴・ポイント系
-- ---------------------------------------------------------------

-- トーナメント結果（脱落時・終了時に記録）
CREATE TABLE IF NOT EXISTS tournament_results (
  id             SERIAL      PRIMARY KEY,
  tournament_id  TEXT        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  account_id     TEXT        NOT NULL REFERENCES accounts(id),
  final_rank     INTEGER     NOT NULL,
  final_chips    INTEGER     NOT NULL,
  hands_played   INTEGER     NOT NULL DEFAULT 0,
  eliminated_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_tournament_results_tournament_account
    UNIQUE (tournament_id, account_id)
);

-- チップ推移ログ（ブラインドレベルアップ時に全プレイヤー分を一括記録）
CREATE TABLE IF NOT EXISTS tournament_chip_log (
  id             SERIAL      PRIMARY KEY,
  tournament_id  TEXT        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  account_id     TEXT        NOT NULL REFERENCES accounts(id),
  blind_level    INTEGER     NOT NULL,
  chips          INTEGER     NOT NULL,
  recorded_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ポイント（将来の実績・ランキング機能用）
CREATE TABLE IF NOT EXISTS points (
  account_id    TEXT     PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  total_points  INTEGER  NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS point_history (
  id          SERIAL      PRIMARY KEY,
  account_id  TEXT        NOT NULL REFERENCES accounts(id),
  points      INTEGER     NOT NULL,
  reason      TEXT,          -- "tournament_1st" など
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- インデックス（パフォーマンス向上）
-- ---------------------------------------------------------------

-- accounts をメールで検索
CREATE INDEX IF NOT EXISTS idx_accounts_email
  ON accounts(email);

-- 自分のトーナメント結果を取得
CREATE INDEX IF NOT EXISTS idx_tournament_results_account
  ON tournament_results(account_id);

-- トーナメントの全結果を順位順で取得
CREATE INDEX IF NOT EXISTS idx_tournament_results_tournament
  ON tournament_results(tournament_id, final_rank);

-- チップ推移ログをトーナメント・アカウントで検索
CREATE INDEX IF NOT EXISTS idx_chip_log_tournament_account
  ON tournament_chip_log(tournament_id, account_id);

-- トーナメント一覧をステータス・開始日時で絞り込み
CREATE INDEX IF NOT EXISTS idx_tournaments_status_start
  ON tournaments(status, scheduled_start_at);

-- ---------------------------------------------------------------
-- 初期データ：ブラインドスケジュール
-- ---------------------------------------------------------------

INSERT INTO blind_schedules (id, name, description, levels)
VALUES (
  'standard',
  'スタンダード',
  '20分ごとにレベルアップ。6レベル構成。',
  '[
    {"level":1,"sb":5,  "bb":10, "smallBet":10, "bigBet":20, "durationMinutes":20},
    {"level":2,"sb":10, "bb":20, "smallBet":20, "bigBet":40, "durationMinutes":20},
    {"level":3,"sb":20, "bb":40, "smallBet":40, "bigBet":80, "durationMinutes":20},
    {"level":4,"sb":40, "bb":80, "smallBet":80, "bigBet":160,"durationMinutes":20},
    {"level":5,"sb":75, "bb":150,"smallBet":150,"bigBet":300,"durationMinutes":20},
    {"level":6,"sb":100,"bb":200,"smallBet":200,"bigBet":400,"durationMinutes":0}
  ]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO blind_schedules (id, name, description, levels)
VALUES (
  'turbo',
  'ターボ',
  '10分ごとにレベルアップ。5レベル構成。',
  '[
    {"level":1,"sb":10, "bb":20, "smallBet":20, "bigBet":40, "durationMinutes":10},
    {"level":2,"sb":25, "bb":50, "smallBet":50, "bigBet":100,"durationMinutes":10},
    {"level":3,"sb":50, "bb":100,"smallBet":100,"bigBet":200,"durationMinutes":10},
    {"level":4,"sb":100,"bb":200,"smallBet":200,"bigBet":400,"durationMinutes":10},
    {"level":5,"sb":200,"bb":400,"smallBet":400,"bigBet":800,"durationMinutes":0}
  ]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------
-- マイグレーション（既存DBへの適用）
-- 新規構築の場合は不要。既存DBには以下を Supabase SQL Editor で実行してください。
-- ---------------------------------------------------------------
ALTER TABLE blind_schedules
  ADD COLUMN IF NOT EXISTS late_level_cutoff INTEGER NOT NULL DEFAULT 0;
