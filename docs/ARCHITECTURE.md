# ARCHITECTURE.md — システム構成と設計の意図

## 全体構成

```
ブラウザ (React)
    │  HTTP (Next.js API Routes / App Router)
    │  WebSocket (Socket.IO)
    ▼
Express サーバー (server/index.js)
    ├── Next.js ハンドラ (SSR / API Routes)
    ├── Socket.IO サーバー
    ├── gameManager.js        ← ゲームロジック（純粋関数群）
    ├── tournamentManager.js  ← トーナメント状態管理（メモリ）
    ├── zoomManager.js        ← FastFold プール管理（メモリ）
    └── adminMonitor.js       ← BOT スポーン・トーナメント監視
    │
    └── Supabase (PostgreSQL)
         ├── accounts / profiles / admins
         ├── tournaments / tournament_entries / tournament_seats
         ├── tournament_results / tournament_chip_log
         └── blind_schedules / points / point_history
```

### 単一プロセス構成の理由

Express と Next.js を同一プロセスで動かしている（`server/index.js` が Next.js の `requestHandler` を呼ぶ）。Render.com の無料プランはサービスが1つしか立てられないため、Socket.IO サーバーと Next.js を分離できない。

---

## モジュール依存関係

```
server/index.js
  ├── poker/gameManager.js          ← ゲーム全ロジック。rooms Map を管理
  │     ├── poker/handEvaluator.js  ← 役判定（副作用なし・純粋関数）
  │     └── poker/deck.js           ← デッキ生成
  ├── poker/botManager.js           ← リングゲーム BOT（gameManager を呼ぶ）
  ├── tournament/tournamentManager.js
  │     ├── poker/gameManager.js    ← テーブル作成・参加・退出
  │     └── tournament/blindSchedule.js
  ├── tournament/tournamentBotManager.js
  │     └── tournament/tournamentManager.js
  ├── zoom/zoomManager.js
  │     └── poker/gameManager.js
  ├── adminMonitor.js               ← BOT スポーン、定期スキャン
  └── db/
        ├── client.js               ← postgres (pg) クライアント
        ├── tournament.js           ← トーナメント DB 操作
        ├── accounts.js             ← アカウント操作
        └── admin.js                ← 管理者操作・一覧クエリ
```

**重要な原則**: `gameManager.js` はソケットを知らない。`io` や `socket` を受け取らず、状態変更のみを行い、`broadcast` は `index.js` が担当する。これにより gameManager のテストが容易になっている。

---

## ゲーム状態管理 (gameManager.js)

### rooms Map

```js
rooms: Map<roomId, Room>

Room {
  players: Player[],       // 参加中プレイヤー（socket.id をキー）
  pendingPlayers: Player[], // 次のハンドから参加する待機プレイヤー
  phase: 'waiting' | 'bet0' | 'draw1' | 'bet1' | 'draw2' | 'bet2' | 'draw3' | 'bet3' | 'showdown',
  pot: number,
  pots: Pot[],             // メイン・サイドポット内訳
  dealerIndex: number,
  fixedDealerIdx: number,  // ハンド中は固定（バランシング中ズレ防止）
  currentBet: number,
  raiseCount: number,      // 1スタート、5でキャップ
  actionIndex: number,
  _isTournament: boolean,
  _tournamentId: string,
  // トーナメント用ブラインド（room プロパティ化で動的変更可能）
  smallBlind: number,
  bigBlind: number,
  smallBet: number,
  bigBet: number,
}
```

### フェーズ遷移

```
waiting
  → bet0 (Pre-Draw ベット)
  → draw1 (1回目のドロー)
  → bet1
  → draw2
  → bet2
  → draw3
  → bet3
  → showdown → waiting (次のハンド)
```

---

## トーナメント管理 (tournamentManager.js)

### メモリ上のトーナメントオブジェクト

```js
tournaments: Map<tournamentId, Tournament>
roomToTournament: Map<roomId, tournamentId>  // 逆引き用

Tournament {
  id, name, mode, startingChips,
  levels: BlindLevel[],       // blindSchedule からコピー
  currentLevelIdx: number,
  levelStartedAt: number,     // Date.now() ms
  tableIds: string[],         // 現在のテーブル roomId 一覧
  eliminationOrder: string[], // 脱落順（accountId）
  totalPlayers: number,
  status: 'running' | 'finished',
  lateRegOpen: boolean,
  lateRegMinutes: number,     // 0=レベルベース, >0=時間ベース
}
```

### 自動開始スケジューラー（index.js）

60秒ごとに DB をスキャンし、`scheduled_start_at` を過ぎた `status=registering` のトーナメントを `_launchTournament()` で起動する。

### Sit & Go の起動フロー

通常トーナメントとの唯一の違いは起動トリガー。

```
参加登録 API (entry.ts POST)
  → tournamentManager.triggerSitAndGoCheck(tournamentId)
      → DB: エントリー数 >= min_players?
          YES → _launchTournament() (通常と同じ関数)
          NO  → 何もしない
```

SNG の `scheduled_start_at` は `2099-01-01` に設定されているため、スケジューラーが誤って起動することはない。

---

## 観戦モード

### サーバー側

`_spectators: Map<roomId, Set<socketId>>` でソケット別管理。`_broadcast()` 関数が毎回この Map を参照し、手札を `'??'` に置き換えた `gameState` を配信する（`buildGameState(room, null)` に `requesterId=null` を渡すと全カードが `'??'` になる）。

### クライアント側

`spectate/page.tsx` → `socket.emit('spectate', { tournamentId })` → サーバーが `tableIds[0]` を解決 → `socket.join(tableId)` + `_spectators.get(tableId).add(socket.id)`

---

## FastFold (Zoom) アーキテクチャ

```
プール (poolId: 'zoom-27' 等)
  waitingPlayers: Player[]   // 待機中
  activeTables: Map<roomId, Set<socketId>>  // ゲーム中テーブル
```

6人集まると新テーブルを作成しゲーム開始。Showdown 後は全員まとめてプールへ戻る。FastFold 押下で即フォールド・プール待機に戻る（他プレイヤーのゲームは継続）。

---

## 認証フロー

```
ブラウザ → /api/auth/socket-token → NextAuth セッションからJWTを返す
ブラウザ → socket.auth = { token } → socket.connect()
サーバー → Socket.IO middleware で decode(token) → socket.data.user に格納
```

BOT は `token = "bot:<BOT_SECRET>"` で認証をバイパスする。

---

## ルーター構成（App Router と Pages Router の混在）

| パス | ルーター | 理由 |
|---|---|---|
| `/tournament/[id]/draw` | App Router | 全画面ゲーム UI（`height: 100dvh`）が必要。`_app.tsx` の影響を受けない |
| `/tournament/[id]/spectate` | App Router | 同上 |
| `/tournament/[id]` | Pages Router | `TournamentStartWatcher`（`_app.tsx`）が必要 |
| それ以外 | Pages Router | 既存コード資産 |

**注意**: App Router ページは `_app.tsx` の `TournamentStartWatcher` が動作しない。そのため draw/spectate ページは自前でソケット接続・遷移ロジックを持つ。

---

## DB 接続

Supabase の **Session pooler** を使用（Render は IPv4 のみのため Transaction pooler は不可）。`server/db/client.js` で `postgres` (pg) クライアントを初期化し、全 DB 操作モジュールからインポートする。

---

## ログ設計

| 関数 | 本番 | 開発 | 用途 |
|---|---|---|---|
| `log(...)` | ✅ | ✅ | 重要イベント（起動・エラー・トーナメント状態変化） |
| `logDev(...)` | ❌ | ✅ | デバッグ用詳細ログ |
| `logPot(...)` | ❌ | ✅ | ポット計算詳細（サイドポットバグ追跡用） |

主なログプレフィックス: `[TM]` `[scheduler]` `[SNG]` `[balance]` `[bot-chain]` `[timeout]` `[lateReg]` `[spectate]` `[t:grace-start]`
