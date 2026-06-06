-- トーナメントのゲームモード制約に単体スタッド系を追加する。
-- 既存DBでは CHECK 制約が古いままだと stud_s / stud_e / razz の作成に失敗する。

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
    'razz'
  ));
