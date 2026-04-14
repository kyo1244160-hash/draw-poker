# ERRORS.md — 過去のエラーと解決策

---

## DB 接続

### `MaxClientsInSessionMode: max clients reached`

**現象**: 開発環境で DB クエリが全て失敗する。

**原因**: Next.js HMR（Hot Module Reload）がモジュールを再評価するたびに新しい `postgres` クライアントが生成され、Supabase Session pooler の同時接続上限（NANO: 15）に達する。

**修正**: `server/db/client.js` で開発環境のみ `global._pgSqlInstance` にシングルトンを保持。接続数も `max=2`（dev）/ `max=5`（prod）に制限。

---

### `CONNECT_TIMEOUT aws-1-ap-northeast-2.pooler.supabase.com:5432`

**現象**: サーバーログにタイムアウトが連続して出る。502 Bad Gateway になる。

**原因候補**:
1. Supabase の DB パスワードが自動変更された
2. `DATABASE_URL` が Transaction pooler（port 6543）になっている
3. Supabase プロジェクトが無料プランで自動一時停止している

**確認順序**:
1. Supabase Dashboard でプロジェクトが「Paused」になっていないか
2. `DATABASE_URL` の port が `5432` か確認
3. Supabase の Connect → ORM タブから最新の `DATABASE_URL` を取得して Render に設定

---

### `prepared statement "xxx" does not exist`

**原因**: `DATABASE_URL` が Transaction pooler（port 6543）になっている。Transaction pooler は prepared statement に非対応。

**修正**: `DATABASE_URL` を Session pooler（port 5432）の URL に変更。

```
✅ 正しい: ...pooler.supabase.com:5432/postgres
❌ 間違い: ...pooler.supabase.com:6543/postgres?pgbouncer=true
```

---

## ゲームロジック

### ショートオールインでコール義務が発生しない

**原因**: `betAction` のショートオールイン処理で `currentBet` が上昇したとき、アクション済みプレイヤーの `acted` をリセットしていなかった。

**修正**: `currentBet` が上昇した場合に `acted=false` にリセット（`server/poker/gameManager.js`）。

---

### 再接続後ショートオールインでコールするとエラー

**原因**: `t:getMyTable` ハンドラで `player.id` を新しい `socket.id` に更新していなかった。

**修正**: `t:getMyTable` で `activePlayer.id = socket.id` を即座に更新（`server/index.js`）。

---

### 「そのアクションはできません」エラー

**現象**: 自分のターンなのにアクションが拒否される。

**開発環境での確認方法**: `[betAction] rejected:` ログを確認。`currentPlayer` と `socketId` の一致を確認する。

**原因候補**:
1. タイムアウトでサーバーが自動フォールド処理をした直後にアクションした
2. レイトレジスト参加直後の socket.id 不整合

**フロントエンドの対処**: 全画面ブロックではなくトーストで表示し、`getGameState` を自動再取得してゲームを継続可能にした（`app/tournament/[id]/draw/page.tsx`）。

---

## トーナメント

### ゲームフリーズ（複数テーブル同時脱落時）

**原因**: `canAutoStart` が `sittingOut` プレイヤーを除外してカウントしていた。

**修正**: `canAutoStart` で全員カウント + `_tryAutoStart` で `null` 返時に 1 秒後リトライ。

---

### 重複脱落（結果に同一プレイヤーが複数表示）

**修正**: `checkEliminations` 内で `eliminationOrder` 重複チェックを追加。`_finishTournament` で重複 `accountId` を除去。

---

### レイトレジスト新テーブルで1人のまま止まる

**原因**: 新テーブル作成後にバランシングを1回実行するが、全テーブルがゲーム進行中のため誰も移動できない。その後リトライがない。

**修正**: 新テーブルに2人以上になるまで 3秒×10回バランシングをリトライ（`server/index.js`）。

---

### タイマーが 0:00 で固定

**原因**: ローカルのカウントダウンが 0 になっても、サーバーから新しい `secondsToNextLevel` が届くまで `pendingLevelUp` にならず「0:00」で表示が固まる。

**修正**: `countdown === 0` のときも `pendingLevelUp` 扱いにする（`app/components/TournamentInfoBar.tsx`）。

---

### バースト時に脱落オーバーレイが表示されずフリーズ

**原因**: `gameState` ハンドラ内のフォールバック条件で `!eliminated`（state）を参照していたがクロージャで古い値を読んでいた。

**修正**: `eliminatedRef`（ref）を使用してクロージャ問題を解消。フォールバック発動遅延を 3 秒 → 1.5 秒に短縮。

---

### SNG: BOT 追加後もトーナメントが開始されない

**原因**: `triggerSitAndGoCheck` は参加登録（POST）後にしか呼ばれず、BOT 追加後は呼ばれていなかった。

**修正**: BOT 予約追加完了後（`pre-add` エンドポイント）でも `triggerSitAndGoCheck` を呼ぶ（`server/adminMonitor.js`）。

---

### SNG: BOT が 60 体しか追加できない

**原因**: `/add` と `/pre-add` の1リクエスト上限が 60 体・`MAX_TABLES = 10` だった。

**修正**: 1リクエスト上限 → 500 体、`MAX_TABLES` → 100 に変更（`server/adminMonitor.js`）。

---

### SNG: 作成時に「通信エラーが発生しました」

**原因**: 管理画面の `handleCreate` で `scheduledStartAt: new Date('').toISOString()` が実行され `Invalid Date` エラーが発生していた（SNG の場合は日時入力が非表示で空文字になる）。

**修正**: `scheduledStartAt: form.isSitAndGo ? undefined : new Date(form.scheduledStartAt).toISOString()` に変更（`pages/admin/index.tsx`）。

---

## 観戦モード

### 観戦ボタンを押さずに観戦画面へ遷移

**原因の連鎖**: `_eliminatePlayer` が `leaveRoom()` はするが `socket.leave(tableId)` を呼ばなかったため、ソケットが Room に残留して `t:tournamentStarting` が届き続けた。

**修正**: `_eliminatePlayer` 内で `sock.leave(tableId)` を追加（`server/tournament/tournamentManager.js`）。

---

## フロントエンド

### `require.e is not a function`（App Router → Pages Router 遷移）

**原因**: App Router ページ（`draw`, `spectate`）から `router.push('/')` でロビー（Pages Router）に遷移すると webpack のチャンク ID が合わずエラーになる。

**修正**: `router.push('/')` → `window.location.href = '/'` に変更（フルページリロードで回避）。

---

## 認証

### `invalid_grant (Bad Request)` — Google ログインできない

**原因候補**:
1. `NEXTAUTH_URL` が実際の URL と一致していない
2. Google Cloud Console のリダイレクト URI に本番 URL が未登録

**確認**: Render → Environment → `NEXTAUTH_URL=https://draw-poker.onrender.com`

---

## デプロイ

### `Could not resolve host: github.com`（Render）

**原因**: Render Oregon リージョンのネットワーク障害。

**対処**: https://status.render.com を確認 → 復旧後に Manual Deploy を再実行。

---

## DB スキーマ

### `in_progress` ステータスを使ったことによる不整合

DB の CHECK 制約で許可されているのは `'registering' | 'running' | 'finished' | 'cancelled'` のみ。`'in_progress'` は使用禁止。
