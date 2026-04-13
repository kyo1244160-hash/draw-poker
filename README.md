# 🃏 Poker Room Pastis

2-7 Triple Draw / Badugi / Mix ドローポーカー対戦 Web アプリ

- **本番 URL**: https://draw-poker.onrender.com
- **技術スタック**: Next.js 14 · TypeScript · Socket.IO · PostgreSQL (Supabase) · NextAuth.js
- **デプロイ**: Render.com (単一サービス: Express + Next.js)

---

## ゲームモード

| モード | 説明 |
|---|---|
| **2-7 Triple Draw** | ローボール 5枚。数字が低いほど強い。A は最高位（最弱）。フラッシュ・ストレートも弱い手。最強: 2-3-4-5-7 異スート |
| **Badugi** | 4枚。ランク・スート全異なりが最強（バドゥギ）。有効枚数が多いほど強く、同枚数なら低ランクが強い。最強: A-2-3-4 異スート |
| **Mix** | 2-7 と Badugi をハンドごとに交互に切り替え |

---

## セットアップ

### 必要なもの

- Node.js 18 以上（`.nvmrc` 参照）
- Supabase プロジェクト（PostgreSQL）
- Google OAuth クライアント

### 手順

```bash
# 1. リポジトリをクローン
git clone <repo-url>
cd draw-poker-main

# 2. 依存パッケージをインストール
npm install

# 3. 環境変数を設定
cp .env.example .env.local
# .env.local を編集して各値を入力（詳細は .env.example を参照）

# 4. DB スキーマを適用
# Supabase Dashboard > SQL Editor で schema.sql を実行
# 既存 DB へのマイグレーションは migrations/ フォルダ内の SQL を順番に実行

# 5. 開発サーバーを起動
npm run dev
# → http://localhost:3000 でアクセス可能
```

### DB マイグレーション順序（新規環境）

```
schema.sql                          ← 全テーブル作成（初回のみ）
migrations/add_tournament_entries.sql
migrations/add_sit_and_go.sql
```

---

## スクリプト

| コマンド | 説明 |
|---|---|
| `npm run dev` | 開発サーバー起動（`node server/index.js`） |
| `npm run build` | Next.js プロダクションビルド |
| `npm start` | ビルド + 本番サーバー起動 |

---

## デプロイ（Render.com）

`render.yaml` に設定済み。GitHub リポジトリを Render に接続すると自動認識される。

- **Build**: `npm install && npm run build`
- **Start**: `node server/index.js`
- **Port**: 10000（環境変数 `PORT` で制御）
- **ヘルスチェック**: `GET /api/health`

Render の環境変数に以下を設定すること（`.env.example` 参照）。

---

## ファイル構成

```
draw-poker-main/
├── app/                          # Next.js App Router（トーナメント画面）
│   ├── components/
│   │   ├── TournamentTable.tsx   # トーナメント用テーブル UI（PC・モバイル対応）
│   │   ├── TournamentInfoBar.tsx # ブラインド・残り人数バー
│   │   ├── TableNoticeModal.tsx  # テーブル移動・通知トースト（右上）
│   │   ├── EliminatedOverlay.tsx # 脱落時オーバーレイ
│   │   └── SpectatorView.tsx    # 観戦ビュー
│   └── tournament/[id]/
│       ├── draw/page.tsx         # トーナメントゲーム画面
│       ├── result/page.tsx       # 結果ページ
│       └── spectate/page.tsx    # 観戦ページ
│
├── components/                   # Pages Router 用コンポーネント
│   ├── PokerTable.tsx            # 通常ポーカーテーブル UI
│   ├── Room.tsx                  # ロビー画面
│   ├── Card.tsx                  # カードコンポーネント
│   └── ZoomTable.tsx            # FastFold テーブル UI
│
├── pages/                        # Pages Router
│   ├── index.tsx                 # トップページ（ロビー）
│   ├── room/[roomId].tsx         # 通常ルームページ
│   ├── tournament/[id].tsx       # トーナメント参加登録ページ
│   ├── zoom/[poolId].tsx         # FastFold プールページ
│   ├── admin/index.tsx           # 管理者ページ
│   └── api/                     # API Routes
│
├── server/                       # Express + Socket.IO サーバー
│   ├── index.js                  # エントリポイント・全ソケットハンドラ
│   ├── config.js                 # ゲーム設定（タイマー・ブラインド等）
│   ├── logger.js                 # ログユーティリティ（dev/prod 分離）
│   ├── poker/
│   │   ├── gameManager.js        # ゲーム状態管理（全ルール実装）
│   │   ├── handEvaluator.js      # 役判定・勝者決定（スプリット対応）
│   │   ├── botManager.js         # ポーカー BOT アクション
│   │   └── deck.js               # デッキ生成・シャッフル
│   ├── tournament/
│   │   ├── tournamentManager.js  # トーナメント管理（バランシング・ブラインド）
│   │   ├── tournamentBotManager.js # トーナメント BOT 管理
│   │   └── blindSchedule.js      # ブラインドスケジュール定義
│   └── zoom/
│       └── zoomManager.js        # FastFold プール管理
│
├── lib/
│   ├── auth.ts                   # withAdminAuth ラッパー
│   ├── db.ts                     # フロントエンド向け DB クライアント（型付き）
│   └── useKeepalive.ts          # Render スリープ防止フック
│
├── schema.sql                    # Supabase DB スキーマ（初回セットアップ用）
├── migrations/                   # DB マイグレーション SQL
├── render.yaml                   # Render.com デプロイ設定
└── .env.example                  # 環境変数テンプレート
```

---

## 管理者機能

`/admin` ページにアクセスするには DB の `admins` テーブルに `account_id` を登録する必要がある。

```sql
INSERT INTO admins (account_id) VALUES ('Google の sub ID');
```

管理者でできること: ユーザー管理 · トーナメント作成・管理 · 結果参照 · BOT 追加
