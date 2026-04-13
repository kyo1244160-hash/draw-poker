# TROUBLESHOOTING.md — ハマりやすい問題と対処法

---

## 開発環境のセットアップ

### `npm run dev` でサーバーが起動しない

1. `.env.local` が存在するか → `cp .env.example .env.local` で作成
2. `DATABASE_URL` が正しいか → Supabase Session pooler（port 5432）の URI か
3. Node.js のバージョンが 18 以上か → `node --version`

### DB 接続エラー `CONNECT_TIMEOUT`

Supabase の Transaction pooler（port 6543）を使っている場合に発生する。

**対処**: Session pooler の URI に変更する。
- Supabase Dashboard → Connect → ORM タブ → `DATABASE_URL=` の行（上の行）をコピー
- port は `5432` になっているはず

### `MaxClientsInSessionMode` エラー（開発環境）

HMR による接続数超過。

**対処**:
1. `.env.local` に `NODE_ENV=development` を追加してサーバーを再起動
2. `server/db/client.js` のグローバル singleton が有効になり解消する

---

## ゲームが動かない

### ゲームが開始されない / waiting のまま

1. 人数不足（2人以上必要）
2. BOT が参加していない → 管理画面から BOT を追加
3. `canAutoStart` が false → サーバーログの `[autoStart]` を確認

### ゲームがフリーズする（ハンドが進まない）

1. ブラウザコンソールにエラーが出ていないか確認
2. サーバーログに `[timeout]` が出ているか確認（タイムアウト処理待ちの可能性）
3. プレイヤーが全員 `sittingOut` または `disconnected` になっていないか確認

### 「そのアクションはできません」エラー

1. タイムアウトで自動フォールドされた直後にアクションした → 画面が自動更新される（3秒待つ）
2. レイトレジスト参加直後の socket.id 不整合 → 数秒待ってから再試行
3. 開発環境では `[betAction] rejected:` ログで詳細を確認

---

## トーナメント関連

### トーナメントが自動開始されない

1. `scheduled_start_at` が正しい時刻（UTC）に設定されているか
2. `status = 'registering'` になっているか（管理画面から確認）
3. サーバーログで `[scheduler]` の出力を確認

### SNG が開始されない

1. `is_sit_and_go = true` かつ `status = 'registering'` になっているか
2. エントリー数 + 事前予約 BOT 数が `min_players` 以上あるか
3. サーバーログで `[SNG]` の出力を確認

```
# 正常なログ
[SNG] xxxxxxxx: 1 humans + 2 bots = 3/3
[SNG] xxxxxxxx: min_players reached → launching
```

### SNG 終了後に次のトーナメントが自動作成されない

1. サーバーログで `[SNG] auto-recreated:` が出ているか確認
2. `tournament.isSitAndGo` がメモリに正しく保存されているか（`startTournament` の opts 確認）

### レイトレジストができない

`lateRegOpenResolved` は `late_reg_open !== false` で判定（楽観的）。実際の検証はサーバー側。
サーバーログで `[lateReg]` を確認。

### レイトレジスト後に「ゲームを準備中...」で止まる

新テーブルに1人で止まっている状態。サーバーログに以下が出るはず：

```
[lateReg] retry balance (N left) for xxxxxxxx
```

10回リトライ（30秒）で解消するはず。解消しない場合は他テーブルがすべて進行中でバランシングできない（稀なケース）。

---

## 認証・ログイン

### Google ログインできない（`invalid_grant`）

1. `NEXTAUTH_URL` が実際のアクセス URL と一致しているか
2. Google Cloud Console のリダイレクト URI に `{NEXTAUTH_URL}/api/auth/callback/google` が登録されているか

### 管理画面 `/admin` に 403 が返る

DB の `admins` テーブルに自分の `account_id` が登録されていない。

```sql
INSERT INTO admins (account_id) VALUES ('Google の sub ID');
```

---

## デプロイ（Render）

### デプロイ後にページが真っ白

Render Logs でビルドエラーを確認。最も多い原因は DB 接続エラー（`DATABASE_URL` を確認）。

### WebSocket が接続できない（本番環境）

1. `ALLOWED_ORIGIN` が本番 URL に設定されているか
2. `NEXTAUTH_URL` が本番 URL と一致しているか

### `Could not resolve host: github.com`

Render のネットワーク障害。https://status.render.com を確認して復旧待ち → Manual Deploy。

---

## よく使うデバッグ手順

### ローカルで logDev ログを出す

`.env.local` に `NODE_ENV=development` を追加してサーバーを再起動。

### SNG のデバッグ

```
# 参加登録・キャンセルの競合を調査
[SNG-debug][POST]    → 登録時刻とエントリー数
[SNG-debug][DELETE]  → キャンセル時刻
[SNG-debug] entries at check time → チェック時のエントリー一覧
[scheduler-debug] entries at launch → 起動時のエントリー一覧
```

### betAction が拒否される原因を調査

```
[betAction] rejected: roomId=... socketId=... action=...
  phase=... actionIdx=... currentPlayer=...
```

`currentPlayer` と自分の `socketId` が一致しているか確認。

---

## ローカル開発の注意事項

### `npm run start` 使用後のページエラー

ビルドのたびに webpack チャンク ID が変わるため、必ず **Ctrl+Shift+R**（強制リロード）を行う。

### Fast Refresh の無限ループ

`webpack.hot-update.json 404` が続く場合：

```cmd
rd /s /q .next
npm run build
npm run start
# ブラウザで Ctrl+Shift+R
```

### DB 接続設定の確認

```
# Supabase の正しい接続文字列の取得方法
Dashboard → Connect → ORM タブ → DATABASE_URL= の行（上の行）をコピー

✅ 正しい: ...pooler.supabase.com:5432/postgres
❌ 間違い: ...pooler.supabase.com:6543/postgres?pgbouncer=true
```
