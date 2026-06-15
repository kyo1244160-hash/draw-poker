-- NL 2-7 Single Draw 用ブラインドスケジュールに BB Ante を追加する。
--
-- 既存の blind_schedules.levels は JSONB のため、テーブル定義変更は不要。
-- 各レベルに bbAnte を追加する。
--
-- 方針:
--   100/200/300 のような高めの BB Ante を想定し、
--   bbAnte = BB * 1.5 とする。
--
-- 注意:
--   スケジュール自体は他ゲームでも共用可能。
--   実際に BB Ante を徴収するかどうかはサーバー側でゲーム種別を見て判定し、
--   NL2-7SD(27sd) の時だけ徴収する。

UPDATE blind_schedules
SET levels = (
  SELECT jsonb_agg(
    CASE
      WHEN (lv->>'bb') ~ '^[0-9]+$' AND (lv->>'bb')::integer > 0 THEN
        jsonb_set(
          lv,
          '{bbAnte}',
          to_jsonb((((lv->>'bb')::integer * 3) / 2)),
          true
        )
      ELSE
        lv
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(levels) WITH ORDINALITY AS e(lv, ord)
)
WHERE id = 'nl27sd_5min_36';

