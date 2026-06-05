# Poker Room Pastis — 引き継ぎメモ

## プロジェクト概要
Next.js + Socket.IO 製マルチプレイヤードローポーカー Web アプリ。
本番URL: https://draw-poker.onrender.com

## ZIPの内容
`draw-poker-handover.zip` = ソースコード全体（node_modules・.next・.git を除く）

---

## ★ 直前の作業状況（ここから再開）

### 完了済みコミット一覧
| Step | 内容 |
|------|------|
| 1–5  | 認証・DB・ニックネーム・ログインUI |
| 6    | Socket.IO auth middleware + rate limit |
| 7    | admin API |
| 8    | admin UI |
| 9    | admin link to lobby |
| 10   | ポイントシステム・トーナメント結果 |
| 11–13| server-side input validation |
| 14   | トーナメントロビー・参加登録 |

### 今セッションで実装した（コミット未）
- **gameManager.js の修正**（Phase 3）
  - `smallBlind / bigBlind / smallBet / bigBet / startingChips` を room プロパティ化
  - `getOrCreateRoom(roomId, opts)` の opts で上書き可能
  - `joinRoom` に `opts.existingChips` と `opts.accountId` を追加
- **server/tournament/blindSchedule.js** 新規作成
- **server/tournament/tournamentManager.js** 新規作成（骨格・テーブル生成・脱落検出・ブラインドレベルアップ）

### server/index.js の修正が途中
以下の1行を index.js の 48行目（zoomManager require の直後）に追加する必要がある：
```js
const tournamentManager = require('./tournament/tournamentManager');
```
さらに io 初期化後に `tournamentManager.init(io);` を呼ぶ。
また `_makeTimeoutHandler` の kick 部分を `tournamentManager.handleForcedLeave()` 経由にする（Step 20）。

---

## 次に実装するステップ

### 今すぐやること
1. `server/index.js` に tournamentManager の require と init を追加（2行）
2. 動作確認（ビルドエラーがないか）
3. ここまでをコミット: `feat: add tournamentManager skeleton (Steps 11-15)`

### その後の実装順序（Phase 4 続き）
- **Step 16**: ブラインドレベルアップタイマー（`applyPendingLevelUp` のハンド開始フック）
- **Step 17**: テーブルバランシング
- **Step 18**: 切断猶予3分・オートアクション
- **Step 19**: reserveLeave のトーナメントテーブル除外
- **Step 20**: タイムアウトキックの tournamentManager 経由化
- **Step 21**: トーナメントテーブルのメモリクリーンアップ
- **Step 22**: tournamentBotManager.js
- **Step 23**: _broadcast に spectators 対応
- **Step 24**: adminMonitor.js

### Phase 5: フロントエンド（Step 25–32）
- Step 25: TournamentTable.tsx
- Step 26: TournamentInfoBar.tsx
- Step 27: /tournament/[id]/draw ページ
- Step 28: /tournament 一覧ページ
- Step 29: 脱落画面
- Step 30: SpectatorView.tsx
- Step 31: /tournament/[id]/result
- Step 32: /admin/tournaments/[id]/monitor

### Phase 6: 本番適用（Step 33–36）

---

## 環境変数

### ローカル `.env.local`
```
DATABASE_URL=postgresql://postgres.brawfptjwtawkkkdnsry:パスワード@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres
GOOGLE_CLIENT_ID=190651132384-s6joic0b8mfb7u1p3r2bntphvqosdave.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=（各自の値）
NEXTAUTH_SECRET=（各自の値）
NEXTAUTH_URL=http://localhost:3000
ALLOWED_ORIGIN=http://localhost:3000
BOT_SECRET=（必須・強ランダム値。デフォルト値は禁止）
```

### Render 環境変数
```
NEXTAUTH_URL=https://draw-poker.onrender.com
ALLOWED_ORIGIN=https://draw-poker.onrender.com
（他は同上）
```

---

## DB 重要事項

- Supabase の **Session pooler** を使用（Render は IPv4 のみ）
- トーナメント status の値: `'registering' | 'running' | 'finished' | 'cancelled'`（`in_progress` は使用禁止）
- `tournament_entries` テーブルは Step 14 で追加済み（Supabase で実行済み）

## 管理者
- 藤田恭平 / account_id: `107893429759486617839`

## ポイント配分（案A固定制）
1位: 100pt / 2位: 60pt / 3位: 40pt / 4位: 25pt / 5位: 15pt / 6位以下: 0pt

## Socket.IO イベント（確定版）
- `t:blindUpdate`: `{ level, sb, bb, smallBet, bigBet, secondsToNextLevel, nextSb, nextBb, isLastLevel }`
- `t:tournamentStatus`: `{ tournamentId, totalPlayers, remainingPlayers, averageStack }`
- `t:tournamentStarting`: `{ tournamentId, tableId }`
- `t:eliminated`: `{ rank, totalPlayers }`
- `t:tournamentFinished`: `{ rankings[] }`
