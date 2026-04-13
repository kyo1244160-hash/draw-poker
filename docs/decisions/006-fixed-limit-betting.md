# ADR-006: フィックスドリミット方式のベット上限（5bet-cap）

- **日付**: 2024-03（初期実装時）
- **ステータス**: 採用・変更禁止

## コンテキスト

2-7 Triple Draw と Badugi はカジノの標準ルールではフィックスドリミット（Fixed Limit）のポーカーであり、1ラウンドのベット回数に上限がある。

## 決定

1ラウンド最大 **5アクション**（ベット1回 + レイズ4回 = 5bet-cap）を採用する。

実装の核心:
- `raiseCount` は **1スタート**（最初のベットで1になる）
- `MAX_RAISES = 5`（raiseCount が 5 に達したらキャップ）
- キャップ状態では `canRaise = false`

```js
// gameManager.js より
// ⚠️ 変更禁止
MAX_RAISES = 5  // raiseCount が 5 に達したらキャップ
// raiseCount: bet時に1になり、raise時にインクリメント
// 5/5 でキャップ（5回目のアクション完了）
```

## なぜ 0スタートではないか

`raiseCount = 0スタート + MAX_RAISES = 4` にすると「BET60 まで可能」になるバグが発生する（4回レイズ後にもう1回できてしまう）。`1スタート + MAX_RAISES = 5` が正しい 5bet-cap の実装。

## なぜ MAX_RAISES = 4 ではないか

`MAX_RAISES = 4` にすると `raiseCount = 4`（4/5）の時点でレイズ不可になり、5bet目（4回目のレイズ）が打てなくなる。5bet-cap は「BET + RAISE×4 = 5アクション」であるため `MAX_RAISES = 5` が正しい。

## 変更禁止事項

`MAX_RAISES` の値と `raiseCount` の初期値を変更してはならない。これを変えると必ずベット上限バグが発生する（過去に実際にバグが出て修正済み）。
