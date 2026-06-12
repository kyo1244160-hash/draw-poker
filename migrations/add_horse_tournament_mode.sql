-- HORSE トーナメント親モードを追加する。
-- Hold'em / Omaha Hi-Lo は currentMode の内部ローテーションで扱うため、
-- tournaments.mode としては horse のみを許可する。

ALTER TABLE tournaments
  DROP CONSTRAINT IF EXISTS tournament_mode_check;

ALTER TABLE tournaments
  ADD CONSTRAINT tournament_mode_check
  CHECK (mode IN (
    '27',
    'badugi',
    'mix',
    'a5',
    '27sd',
    'mix3',
    'beast+',
    'stud_mix',
    'stud_s',
    'stud_e',
    'razz',
    'horse'
  ));
