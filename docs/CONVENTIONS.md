# CONVENTIONS.md — 命名規則・ディレクトリ構造・コメントルール

## ディレクトリ構造の原則

| ディレクトリ | 役割 | 言語 |
|---|---|---|
| `server/` | Express + Socket.IO サーバーサイドのみ | JavaScript (CommonJS) |
| `server/poker/` | ゲームロジック（ルール・役判定） | JavaScript |
| `server/tournament/` | トーナメント管理・ブラインドスケジュール | JavaScript |
| `server/zoom/` | FastFold プール管理 | JavaScript |
| `server/db/` | DB アクセス層（クライアント・クエリ） | JavaScript |
| `app/` | Next.js App Router（トーナメントゲーム画面） | TypeScript + React |
| `app/components/` | App Router 専用コンポーネント | TypeScript + React |
| `app/types/` | App Router で使う型定義 | TypeScript |
| `components/` | Pages Router 専用コンポーネント | TypeScript + React |
| `pages/` | Next.js Pages Router | TypeScript + React |
| `pages/api/` | API Routes | TypeScript |
| `lib/` | フロントエンド共通ユーティリティ・型付き DB クライアント | TypeScript |
| `migrations/` | DB マイグレーション SQL（適用順に命名） | SQL |
| `docs/` | 詳細ドキュメント | Markdown |
| `docs/decisions/` | ADR（Architecture Decision Records） | Markdown |

---

## 命名規則

### ファイル名

| 種別 | 命名規則 | 例 |
|---|---|---|
| React コンポーネント | PascalCase | `TournamentTable.tsx` |
| サーバーモジュール | camelCase | `gameManager.js` |
| Next.js ページ | Next.js 規約に従う | `[id].tsx`, `page.tsx` |
| API Route | Next.js 規約に従う | `[...nextauth].ts` |
| SQL マイグレーション | `add_<機能>.sql` | `add_sit_and_go.sql` |
| ADR | `NNN-<タイトル>.md` (3桁ゼロ埋め) | `001-nextjs-express.md` |

### 変数・関数

| 種別 | 規則 | 例 |
|---|---|---|
| 通常変数・関数 | camelCase | `tableId`, `getEntries` |
| React コンポーネント | PascalCase | `TournamentTable` |
| 定数（変更しない値） | UPPER_SNAKE_CASE | `MAX_PLAYERS`, `BOT_SECRET` |
| プライベート関数（モジュール内部） | `_` プレフィックス | `_eliminatePlayer`, `_scan` |
| Socket.IO イベント名 | `t:` プレフィックス（トーナメント）、`z:` プレフィックス（Zoom） | `t:blindUpdate`, `z:join` |
| DB カラム | snake_case | `scheduled_start_at`, `is_sit_and_go` |
| TypeScript 型・インターフェース | PascalCase | `PlayerState`, `GameMeta` |

### React State

- useState の変数名は意味が明確な名詞: `players`, `meta`, `blind`, `connected`
- Ref は `xxxRef` サフィックス: `tableIdRef`, `fetchReadyRef`, `isEliminatedRef`
- コールバックは `onXxx` または `handleXxx`: `onBetAction`, `handleRegister`

---

## コメントルール

### JavaScript (server/)

```js
// ===== セクション区切り =====  ← モジュール内の大きな区切り

/**
 * JSDoc 形式  ← 公開関数・重要な内部関数
 * @param {string} tournamentId
 * @returns {Tournament | null}
 */
function getTournament(tournamentId) { ... }

// 1行コメント ← 処理の意図が自明でない箇所

// ⚠️ 変更禁止: ... ← 壊れやすい箇所・過去のバグ修正跡
```

### TypeScript (app/, pages/, lib/)

```ts
// interface と type は JSDoc なしでも可（型が自己説明的なため）
// ただし非自明なフィールドにはインラインコメントを付ける

interface PlayerState {
  isSelf: boolean;          // 自分自身かどうか
  isPendingPlayer?: boolean; // pendingPlayers 待機中（次のハンドから参加）
}
```

### コメントを書く基準

**書く**: なぜその実装にしたか（背景・制約）、罠、過去のバグ修正、TODO
**書かない**: コードを読めばわかること（`i++` に「i をインクリメント」など）

---

## Socket.IO イベント命名規則

| プレフィックス | 用途 |
|---|---|
| なし | 通常リングゲーム共通（`gameState`, `joinRoom` 等） |
| `t:` | トーナメント専用（`t:blindUpdate`, `t:eliminated` 等） |
| `z:` | FastFold (Zoom) 専用（`z:join`, `z:fastFold` 等） |

方向の表記: コード内コメントでは `C→S`（クライアント→サーバー）、`S→C`（サーバー→クライアント）と書く。

---

## DB カラム・テーブル命名

- テーブル名: `snake_case` 複数形 (`tournaments`, `tournament_entries`)
- カラム名: `snake_case` (`scheduled_start_at`, `is_sit_and_go`)
- 外部キー: `参照先テーブル名_id` (`tournament_id`, `account_id`)
- フラグ: `is_` プレフィックス (`is_test`, `is_sit_and_go`)
- 日時: `_at` サフィックス (`created_at`, `eliminated_at`)

---

## import 順序（TypeScript）

```ts
// 1. React 標準
import { useEffect, useState, useRef } from 'react';
// 2. Next.js
import { useRouter, useParams } from 'next/navigation';
// 3. 外部ライブラリ
import { useSession } from 'next-auth/react';
// 4. 内部モジュール（絶対パス → 相対パス）
import { socket, connectWithAuth } from '../../../socket';
import type { PlayerState } from '../../types/tournament';
```

---

## 禁止事項

- `server/` 配下のモジュールを `pages/api/` や `app/` から直接 `require` しない（ただし `tournamentManager` の `triggerSitAndGoCheck` 等、意図的に許可しているものを除く）
- `io`（Socket.IO インスタンス）を `gameManager.js` に渡さない（gameManager はソケットを知らない設計）
- DB ステータス値に `'in_progress'` を使わない（`'running'` が正）
- `MAX_RAISES` と `raiseCount` の初期値を変更しない（5bet-cap の実装が壊れる）
