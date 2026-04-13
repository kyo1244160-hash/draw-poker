# docs/api.md — API 仕様・使い方メモ

## REST API（Next.js API Routes）

### 認証

| エンドポイント | メソッド | 認証 | 説明 |
|---|---|---|---|
| `/api/auth/[...nextauth]` | GET/POST | — | NextAuth.js ハンドラ（Google OAuth） |
| `/api/auth/socket-token` | GET | セッション必須 | Socket.IO 用 JWT トークンを返す |
| `/api/health` | GET | 不要 | ヘルスチェック（Render 用） |

### プロフィール

| エンドポイント | メソッド | 認証 | 説明 |
|---|---|---|---|
| `/api/profile/me` | GET/PATCH | セッション必須 | 自分のプロフィール取得・ニックネーム変更 |

### トーナメント（公開）

| エンドポイント | メソッド | 認証 | 説明 |
|---|---|---|---|
| `/api/tournaments` | GET | 不要 | トーナメント一覧（テスト用・終了・キャンセル除く） |
| `/api/tournament/[id]/entry` | GET | 不要 | 参加状況・エントリー数・脱落フラグ取得 |
| `/api/tournament/[id]/entry` | POST | セッション必須 | 参加登録（SNG なら自動起動チェック） |
| `/api/tournament/[id]/entry` | DELETE | セッション必須 | 参加キャンセル（受付中のみ） |

#### GET `/api/tournament/[id]/entry` レスポンス

```json
{
  "registered": true,
  "isEliminated": false,
  "entries": [ { "account_id": "...", "nickname": "カナ", ... } ],
  "tournament": {
    "id": "...",
    "name": "テスト",
    "status": "running",
    "scheduled_start_at": "2026-04-05T21:33:00Z",
    "starting_chips": 5000,
    "late_reg_open": true,
    "is_sit_and_go": false,
    "min_players": 3,
    ...
  },
  "rankings": [ { "accountId": "...", "nickname": "...", "rank": 1, "chips": 30000, "points": 100 } ],
  "myEntry": { "accountId": "...", "rank": 20, ... }
}
```

**重要**: `isEliminated` はサーバーのメモリ（`tournamentManager`）から取得する。サーバー再起動直後など、メモリが失われた場合は `null` になることがある。フロントエンドでは `myEntry` の存在をフォールバックとして使う。

### 管理者 API（`withAdminAuth` 必須）

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/api/admin/tournaments` | GET | トーナメント一覧（全件） |
| `/api/admin/tournaments` | POST | トーナメント作成 |
| `/api/admin/tournaments` | PATCH | ステータス変更 |
| `/api/admin/tournaments?type=schedules` | GET | ブラインドスケジュール一覧 |
| `/api/admin/results` | GET | 結果一覧 |
| `/api/admin/users` | GET | ユーザー一覧 |

#### POST `/api/admin/tournaments` リクエストボディ

```json
{
  "name": "テストトーナメント",
  "mode": "mix",
  "scheduledStartAt": "2026-04-10T21:00:00+09:00",
  "startingChips": 5000,
  "maxPlayers": null,
  "blindScheduleId": "turbo",
  "isTest": false,
  "lateRegMinutes": 0,

  // Sit & Go の場合（scheduledStartAt は不要）
  "isSitAndGo": true,
  "minPlayers": 3
}
```

`mode` の有効値: `"27"` `"badugi"` `"mix"`
`blindScheduleId` の有効値: `"standard"` `"turbo"` `"test"` `"test1min"` `"test2min"`（または DB に登録したカスタムスケジュール ID）

---

## Socket.IO イベント

### 接続

クライアントは `/api/auth/socket-token` からトークンを取得し `socket.auth = { token }` に設定してから接続する。未ログインの場合はゲストとして接続（一部機能が制限される）。

### 共通（通常テーブル・トーナメント）

| イベント | 方向 | ペイロード | 説明 |
|---|---|---|---|
| `gameState` | S→C | `{ players, meta, isSpectator? }` | ゲーム状態全体 |
| `gameStarted` | S→C | — | ハンド開始 |
| `showdown` | S→C | — | ショーダウン |
| `playerAction` | S→C | `{ playerName, action }` | プレイヤーアクション通知 |
| `timerUpdate` | S→C | `{ remaining, limit }` | タイマー残り秒数 |
| `error` | S→C | `{ message }` | エラー通知 |
| `joinRoom` | C→S | `{ roomId, password? }` | 入室 |
| `leaveRoom` | C→S | `{ roomId }` | 退室 |
| `betAction` | C→S | `{ roomId, action }` | ベットアクション（fold/check/call/bet/raise） |
| `drawCards` | C→S | `{ roomId, indices }` | カード交換（indices: 交換するカードのインデックス配列） |
| `updateSelected` | C→S | `{ roomId, indices }` | 選択中カードの同期（リアルタイム） |
| `getGameState` | C→S | `{ roomId }` | ゲーム状態を再取得 |
| `reserveLeave` | C→S | `{ roomId, type }` | 次のハンド終了後に退室予約 |
| `spectate` | C→S | `{ tableId? } or { tournamentId? }` | 観戦開始 |

### トーナメント専用（`t:` プレフィックス）

| イベント | 方向 | ペイロード |
|---|---|---|
| `t:getMyTable` | C→S | `{ tournamentId }` |
| `t:tournamentStarting` | S→C | `{ tournamentId, tableId }` |
| `t:tournamentStatus` | S→C | `{ tournamentId, totalPlayers, remainingPlayers, averageStack, isFinalTable }` |
| `t:blindUpdate` | S→C | `{ level, sb, bb, smallBet, bigBet, secondsToNextLevel, nextSb, nextBb, isLastLevel, lateRegOpen, pendingLevelUp }` |
| `t:eliminated` | S→C | `{ rank, totalPlayers }` |
| `t:playerEliminated` | S→C | `{ playerName, rank, totalPlayers }` |
| `t:tournamentFinished` | S→C | `{ rankings[] }` |
| `t:finalTable` | S→C | `{ totalPlayers, remainingPlayers }` |
| `t:tableTransfer` | S→C | `{ fromTableId, toTableId }` |
| `t:pendingTableTransfer` | S→C | `{ tableId, message }` |
| `t:playerArrived` | S→C | `{ playerName }` |
| `t:playerLeft` | S→C | `{ playerName }` |
| `t:lateRegClosed` | S→C | `{ tournamentId }` |
| `t:eliminatedSpectate` | S→C | `{ tournamentId }` （脱落済みでレイトレジスト不可時） |
| `t:tableClosed` | S→C | `{ tournamentId, newTableId }` （観戦テーブル解体時） |
| `t:tournamentNotFound` | S→C | `{ tournamentId }` |

### FastFold / Zoom専用（`z:` プレフィックス）

| イベント | 方向 | ペイロード |
|---|---|---|
| `z:join` | C→S | `{ poolId, name }` |
| `z:fastFold` | C→S | `{ poolId }` |
| `z:leave` | C→S | `{ poolId }` |
| `z:assigned` | S→C | `{ roomId, poolId }` |
| `z:waiting` | S→C | `{ poolId, waitingCount, totalCount }` |
| `z:poolState` | S→C | `{ poolId, waitingCount, totalCount }` |

---

## 外部サービス

### Supabase

- **接続方式**: Session pooler（Transaction pooler は Render の IPv4 制限で使用不可）
- **SDK**: `postgres` (pg) パッケージ（`server/db/client.js`）
- **RLS**: 無効（サーバーサイドのみからアクセス）

### Google OAuth

- **認証フロー**: Authorization Code Flow（NextAuth.js 経由）
- **必要なスコープ**: `openid email profile`
- **リダイレクト URI**: `{NEXTAUTH_URL}/api/auth/callback/google`

### Render.com

- **プラン**: Web Service（無料プランはスリープあり）
- **ヘルスチェック**: `GET /api/health` → `{ status: "ok" }` を返す
- **スリープ防止**: `lib/useKeepalive.ts` が `/api/health` を定期 ping
