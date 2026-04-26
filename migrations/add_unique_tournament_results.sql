-- ================================================================
-- migration: add_unique_tournament_results.sql
-- 目的: tournament_results の (tournament_id, account_id) に
--       UNIQUE 制約を追加して二重ポイント加算を防ぐ
--
-- 適用方法: Supabase の SQL エディタで実行
-- ================================================================

ALTER TABLE tournament_results
  ADD CONSTRAINT uq_tournament_results_tournament_account
  UNIQUE (tournament_id, account_id);
