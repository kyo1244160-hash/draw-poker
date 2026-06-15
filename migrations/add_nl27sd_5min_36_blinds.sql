-- NL 2-7 Single Draw 用 5分ブラインド / 36レベル
-- late_level_cutoff = 6 は 30分レイトレジスト想定。
-- レイトレジストなしにする場合は 0、別締切にする場合は任意のレベル番号へ変更してください。

INSERT INTO blind_schedules (id, name, description, levels, late_level_cutoff)
VALUES (
  'nl27sd_5min_36',
  'NL27SD 5min 36 Levels',
  'No-Limit 2-7 Single Draw tournament structure. 5-minute levels, 36 levels.',
  '[
    {"level":1, "sb":100,    "bb":200,     "smallBet":200,     "bigBet":400,      "durationMinutes":5},
    {"level":2, "sb":150,    "bb":300,     "smallBet":300,     "bigBet":600,      "durationMinutes":5},
    {"level":3, "sb":200,    "bb":400,     "smallBet":400,     "bigBet":800,      "durationMinutes":5},
    {"level":4, "sb":300,    "bb":600,     "smallBet":600,     "bigBet":1200,     "durationMinutes":5},
    {"level":5, "sb":400,    "bb":800,     "smallBet":800,     "bigBet":1600,     "durationMinutes":5},
    {"level":6, "sb":500,    "bb":1000,    "smallBet":1000,    "bigBet":2000,     "durationMinutes":5},
    {"level":7, "sb":600,    "bb":1200,    "smallBet":1200,    "bigBet":2400,     "durationMinutes":5},
    {"level":8, "sb":800,    "bb":1600,    "smallBet":1600,    "bigBet":3200,     "durationMinutes":5},
    {"level":9, "sb":1000,   "bb":2000,    "smallBet":2000,    "bigBet":4000,     "durationMinutes":5},
    {"level":10,"sb":1200,   "bb":2400,    "smallBet":2400,    "bigBet":4800,     "durationMinutes":5},
    {"level":11,"sb":1500,   "bb":3000,    "smallBet":3000,    "bigBet":6000,     "durationMinutes":5},
    {"level":12,"sb":2000,   "bb":4000,    "smallBet":4000,    "bigBet":8000,     "durationMinutes":5},
    {"level":13,"sb":2500,   "bb":5000,    "smallBet":5000,    "bigBet":10000,    "durationMinutes":5},
    {"level":14,"sb":3000,   "bb":6000,    "smallBet":6000,    "bigBet":12000,    "durationMinutes":5},
    {"level":15,"sb":4000,   "bb":8000,    "smallBet":8000,    "bigBet":16000,    "durationMinutes":5},
    {"level":16,"sb":5000,   "bb":10000,   "smallBet":10000,   "bigBet":20000,    "durationMinutes":5},
    {"level":17,"sb":6000,   "bb":12000,   "smallBet":12000,   "bigBet":24000,    "durationMinutes":5},
    {"level":18,"sb":8000,   "bb":16000,   "smallBet":16000,   "bigBet":32000,    "durationMinutes":5},
    {"level":19,"sb":10000,  "bb":20000,   "smallBet":20000,   "bigBet":40000,    "durationMinutes":5},
    {"level":20,"sb":12000,  "bb":24000,   "smallBet":24000,   "bigBet":48000,    "durationMinutes":5},
    {"level":21,"sb":15000,  "bb":30000,   "smallBet":30000,   "bigBet":60000,    "durationMinutes":5},
    {"level":22,"sb":20000,  "bb":40000,   "smallBet":40000,   "bigBet":80000,    "durationMinutes":5},
    {"level":23,"sb":25000,  "bb":50000,   "smallBet":50000,   "bigBet":100000,   "durationMinutes":5},
    {"level":24,"sb":30000,  "bb":60000,   "smallBet":60000,   "bigBet":120000,   "durationMinutes":5},
    {"level":25,"sb":40000,  "bb":80000,   "smallBet":80000,   "bigBet":160000,   "durationMinutes":5},
    {"level":26,"sb":50000,  "bb":100000,  "smallBet":100000,  "bigBet":200000,   "durationMinutes":5},
    {"level":27,"sb":60000,  "bb":120000,  "smallBet":120000,  "bigBet":240000,   "durationMinutes":5},
    {"level":28,"sb":80000,  "bb":160000,  "smallBet":160000,  "bigBet":320000,   "durationMinutes":5},
    {"level":29,"sb":100000, "bb":200000,  "smallBet":200000,  "bigBet":400000,   "durationMinutes":5},
    {"level":30,"sb":125000, "bb":250000,  "smallBet":250000,  "bigBet":500000,   "durationMinutes":5},
    {"level":31,"sb":150000, "bb":300000,  "smallBet":300000,  "bigBet":600000,   "durationMinutes":5},
    {"level":32,"sb":200000, "bb":400000,  "smallBet":400000,  "bigBet":800000,   "durationMinutes":5},
    {"level":33,"sb":250000, "bb":500000,  "smallBet":500000,  "bigBet":1000000,  "durationMinutes":5},
    {"level":34,"sb":300000, "bb":600000,  "smallBet":600000,  "bigBet":1200000,  "durationMinutes":5},
    {"level":35,"sb":400000, "bb":800000,  "smallBet":800000,  "bigBet":1600000,  "durationMinutes":5},
    {"level":36,"sb":500000, "bb":1000000, "smallBet":1000000, "bigBet":2000000,  "durationMinutes":5}
  ]'::jsonb,
  6
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  levels = EXCLUDED.levels,
  late_level_cutoff = EXCLUDED.late_level_cutoff;

-- 100/200/300 のように BB Ante = BB * 1.5 を付与する。
-- levels は他ゲームでも共用可能だが、実際に徴収するのはサーバー側で NL2-7SD(27sd) に限定する。
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
