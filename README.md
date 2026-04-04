# 🃏 Poker Room Pastis

2-7 Triple Draw / Badugi / Mix ドローポーカー対戦 Web アプリ

- **本番 URL**: https://draw-poker.onrender.com
- **技術スタック**: Next.js 14 (App Router + Pages Router) / TypeScript / Socket.IO / PostgreSQL (Supabase) / NextAuth.js

---

## セットアップ

```bash
npm install
npm run dev
```

ブラウザで http://localhost:3000 を開く

---

## 環境変数

`.env.local.example` をコピーして `.env.local` を作成し、各値を設定してください。

| 変数 | 説明 |
|---|---|
| `DATABASE_URL` | Supabase の Session pooler URI |
| `GOOGLE_CLIENT_ID` | Google OAuth クライアント ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth クライアントシークレット |
| `NEXTAUTH_SECRET` | NextAuth.js 署名用シークレット（ランダム文字列） |
| `NEXTAUTH_URL` | アプリの URL（開発: `http://localhost:3000`） |
| `ALLOWED_ORIGIN` | Socket.IO CORS 許可オリジン（`NEXTAUTH_URL` と同じ値） |
| `BOT_SECRET` | BOT 認証用シークレット（`pastis-internal-bot`） |

---

## デプロイ（Render.com）

`render.yaml` に設定済み。GitHub リポジトリを Render に接続すると自動認識される。

- **Build**: `npm install && npm run build`
- **Start**: `node server/index.js`
- **ヘルスチェック**: `/api/health`

---

## ファイル構成

```
draw-poker-main/
├── app/                            # Next.js App Router
│   ├── layout.tsx                  # グローバルレイアウト（Keepalive 含む）
│   ├── Keepalive.tsx               # セッション維持コンポーネント
│   ├── components/
│   │   ├── TournamentTable.tsx     # トーナメント用テーブル UI
│   │   ├── TournamentInfoBar.tsx   # ブラインド・残り人数バー
│   │   ├── TableNoticeModal.tsx    # テーブル移動・通知（右上トースト）
│   │   ├── EliminatedOverlay.tsx   # 脱落時オーバーレイ
│   │   └── SpectatorView.tsx       # 観戦ビュー
│   └── tournament/[id]/
│       ├── draw/page.tsx           # トーナメントゲーム画面
│       ├── result/page.tsx         # 結果ページ
│       └── spectate/page.tsx       # 観戦ページ
│
├── components/                     # Pages Router 用コンポーネント
│   ├── PokerTable.tsx              # 通常ポーカーテーブル UI
│   ├── DrawPokerRoom.tsx           # 2-7 Triple Draw ラッパー
│   ├── BadugiRoom.tsx              # Badugi ラッパー
│   ├── ZoomTable.tsx               # FastFold (Zoom) テーブル UI
│   ├── Room.tsx                    # ロビー画面
│   ├── Card.tsx                    # カードコンポーネント
│   ├── TimerBar.tsx                # アクションタイマーバー
│   ├── UserMenu.tsx                # ユーザーメニュー
│   ├── NicknameSetup.tsx           # ニックネーム設定
│   └── LoginPromptModal.tsx        # ログイン促進モーダル
│
├── pages/                          # Pages Router
│   ├── index.tsx                   # トップページ（ロビー）
│   ├── room/[roomId].tsx           # 通常ルームページ
│   ├── tournament/[id].tsx         # トーナメント参加登録ページ
│   ├── zoom/[poolId].tsx           # FastFold プールページ
│   ├── admin/index.tsx             # 管理者ページ
│   └── api/
│       ├── auth/                   # NextAuth.js ハンドラ
│       ├── admin/
│       │   ├── tournaments.ts      # トーナメント CRUD
│       │   ├── results.ts          # 結果参照
│       │   └── users.ts            # ユーザー管理
│       ├── tournament/[id]/entry.ts# 参加登録
│       ├── tournaments.ts          # トーナメント一覧
│       ├── ranking.ts              # ランキング
│       └── profile/                # プロフィール
│
├── server/                         # Socket.IO + Express サーバー
│   ├── index.js                    # エントリポイント・全ソケットハンドラ
│   ├── logger.js                   # ログユーティリティ（dev/prod 分離）
│   ├── adminMonitor.js             # BOT 事前確保・キックスタート
│   ├── bot.js                      # BOT 基本定義
│   ├── ringBotManager.js           # 通常テーブル BOT 管理
│   ├── config.js                   # サーバー設定
│   ├── profanityFilter.js          # 禁止ワードフィルター
│   ├── db/
│   │   ├── client.js               # DB クライアント（pg）
│   │   ├── accounts.js             # アカウント操作
│   │   ├── admin.js                # 管理者操作
│   │   ├── points.js               # ポイント・結果記録
│   │   └── tournament.js           # トーナメント DB 操作
│   ├── poker/
│   │   ├── gameManager.js          # ゲーム状態管理（全ルール実装）
│   │   ├── handEvaluator.js        # 役判定・勝者決定（スプリット対応）
│   │   ├── botManager.js           # ポーカー BOT アクション
│   │   └── deck.js                 # デッキ生成・シャッフル
│   ├── tournament/
│   │   ├── tournamentManager.js    # トーナメント管理（バランシング・ブラインド）
│   │   ├── tournamentBotManager.js # トーナメント BOT 管理
│   │   └── blindSchedule.js        # ブラインドスケジュール定義
│   └── zoom/
│       └── zoomManager.js          # FastFold (Zoom) プール管理
│
├── lib/
│   ├── auth.ts                     # NextAuth.js 設定
│   ├── db.ts                       # フロントエンド向け DB クライアント
│   └── useKeepalive.ts             # セッション維持フック
│
├── schema.sql                      # Supabase DB スキーマ
├── migrations/                     # DB マイグレーション SQL
├── render.yaml                     # Render.com デプロイ設定
├── socket.ts                       # クライアント共通ソケット
└── .env.local.example              # 環境変数テンプレート
```

---

## ゲームモード

| モード | 説明 |
|---|---|
| **2-7 Triple Draw** | ローボール。数字が低いほど強い。A は最高位（弱い）。フラッシュ・ストレートも弱い手 |
| **Badugi** | 4枚。ランク・スート全異なりが最強。有効枚数が多いほど強く、同枚数なら低ランクが強い |
| **Mix** | 2-7 と Badugi をハンドごとに交互に切り替え |

各モードで **引き分け（スプリットポット）** に対応。奇数チップは SB 位置から時計回りで最も近い勝者が受け取る。

---

## トーナメント

### ルール
- 最大 6 人テーブル、複数テーブル同時進行
- ブラインドスケジュールに従って自動レベルアップ（ハンド終了後に適用）
- テーブルバランシング: 差が 2 人以上になると自動で人数均等化（ゲーム進行中テーブルからは移動しない）
- 着席ルール: RRoP Rule 16 準拠（BTN〜SB 席に着席した移動プレイヤーは 1 ハンド待機）
- ボタン位置: 初回ハンドはランダム、以降は時計回りに前進
- サイドポット: 全プレイヤーの貢献額を基に正確に計算・分配

### ブラインドスケジュール

| スケジュール | レベル時間 | 用途 |
|---|---|---|
| standard | 20 分 | 本番トーナメント |
| turbo | 10 分 | 短時間トーナメント |
| test1 | 永続（1 レベル） | 動作確認用 |
| dev | 1 分 | 開発・デバッグ用 |

### ポイント配分

| 順位 | ポイント |
|---|---|
| 1 位 | 100 pt |
| 2 位 | 60 pt |
| 3 位 | 40 pt |
| 4 位 | 25 pt |
| 5 位 | 15 pt |
| 6 位以下 | 0 pt |

---

## FastFold (Zoom)

- 6 人プール制。6 人集まると即テーブルアサイン・ゲーム開始
- ベット中に FastFold すると即フォールドしてプール待機列へ戻る
- Showdown 後は全員プールへ戻り新テーブルを編成

---

## Socket.IO イベント一覧

### 共通（通常テーブル・トーナメント）

| イベント | 方向 | ペイロード |
|---|---|---|
| `gameState` | S→C | `{ players, meta }` |
| `gameStarted` | S→C | — |
| `showdown` | S→C | — |
| `playerAction` | S→C | `{ playerName, action }` |
| `joinRoom` | C→S | `{ roomId, password }` |
| `leaveRoom` | C→S | `{ roomId }` |
| `betAction` | C→S | `{ roomId, action }` |
| `drawCards` | C→S | `{ roomId, indices }` |
| `updateSelected` | C→S | `{ roomId, indices }` |
| `getGameState` | C→S | `{ roomId }` |
| `reserveLeave` | C→S | `{ roomId, type }` |
| `spectate` | C→S | `{ tableId }` |

### トーナメント専用

| イベント | 方向 | ペイロード |
|---|---|---|
| `t:getMyTable` | C→S | `{ tournamentId }` |
| `t:tournamentStarting` | S→C | `{ tournamentId, tableId }` |
| `t:tournamentStatus` | S→C | `{ tournamentId, totalPlayers, remainingPlayers, averageStack }` |
| `t:blindUpdate` | S→C | `{ level, sb, bb, smallBet, bigBet, secondsToNextLevel, nextSb, nextBb, isLastLevel }` |
| `t:eliminated` | S→C | `{ rank, totalPlayers }` |
| `t:playerEliminated` | S→C | `{ playerName, rank, totalPlayers }` |
| `t:tournamentFinished` | S→C | `{ rankings[] }` |
| `t:finalTable` | S→C | `{ totalPlayers, remainingPlayers }` |
| `t:tableTransfer` | S→C | `{ fromTableId, toTableId }` |
| `t:pendingTableTransfer` | S→C | `{ tableId, message }` |
| `t:playerArrived` | S→C | `{ playerName }` |
| `t:playerLeft` | S→C | `{ playerName }` |
| `t:lateRegClosed` | S→C | `{ tournamentId }` |

### FastFold (Zoom) 専用

| イベント | 方向 | ペイロード |
|---|---|---|
| `z:join` | C→S | `{ poolId, name }` |
| `z:fastFold` | C→S | `{ poolId }` |
| `z:leave` | C→S | `{ poolId }` |
| `z:assigned` | S→C | `{ roomId, poolId }` |
| `z:waiting` | S→C | `{ poolId, waitingCount, totalCount }` |
| `z:poolState` | S→C | `{ poolId, waitingCount, totalCount }` |

---

## DB スキーマ（主要テーブル）

| テーブル | 用途 |
|---|---|
| `accounts` | Google アカウント情報 |
| `profiles` | ニックネーム（2〜12 文字、30 日変更制限） |
| `admins` | 管理者権限 |
| `tournaments` | トーナメント情報（mode / status / scheduled_start_at 等） |
| `tournament_entries` | 参加登録（account_id × tournament_id） |
| `blind_schedules` | ブラインドスケジュール定義 |
| `tournament_results` | 最終順位・チップ数・ポイント |
| `ranking` | 累計ポイントランキング |

---

## ログ設計

`server/logger.js` で本番/開発を分離。

| 関数 | 本番 | 開発 |
|---|---|---|
| `log(...)` | ✅ | ✅ |
| `logDev(...)` | ❌ | ✅ |
| `logPot(...)` | ❌ | ✅ |

主なログカテゴリ: `[pot]` `[TM]` `[scheduler]` `[adminMonitor]` `[balance]` `[bot-chain]` `[timeout]` `[lateReg]`
