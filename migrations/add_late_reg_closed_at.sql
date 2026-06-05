-- migration: add_late_reg_closed_at.sql
-- 目的: late registration 終了状態をDBに永続化し、サーバー再起動後の再開放を防ぐ

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS late_reg_closed_at TIMESTAMPTZ;
