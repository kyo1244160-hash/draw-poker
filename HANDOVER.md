# Poker Room Pastis — 引き継ぎメモ Vol.5

## プロジェクト概要
- **本番URL**: https://draw-poker.onrender.com
- **スタック**: Next.js 14 / TypeScript / Socket.IO / PostgreSQL (Supabase) / NextAuth.js
- **ソース**: `/home/claude/draw-poker-main/`
- **GitHub**: kyo1244160-hash/draw-poker
- **管理者**: account_id=`107893429759486617839`、nickname=Fujita

---

## 重要な設計制約（変更禁止）

| 項目 | 値 | 理由 |
|---|---|---|
| DATABASE_URL port | **5432**（Session pooler） | 6543は prepared statement エラー |
| MAX_RAISES | **5** / raiseCount **1** スタート | ベット上限バグ防止 |
| gameManager.js | **io を受け取らない** | broadcast は index.js が担当 |
| SNG scheduled_start_at | **2099-01-01** | スケジューラーが拾わない |
| zip 提供形式 | フォルダなしで `app/` `server/` を直接トップ | Render デプロイ構造 |

---

## このセッション（Vol.5）で完了した修正

### fix-v11: バランシング後 socket.id 不一致修正
- `tournamentManager.js`: `_dissolveTable` と1対1移動で `jr()` 直後に `room.players` の id を最新 socket.id に常時上書き（条件チェック廃止）

### fix-v12: ハンド開始時ブラインド情報同期
- `index.js`: `startGame` 成功時に毎回 `broadcastBlind` で `t:blindUpdate` を再送

### fix-v13/v14: 脱落・優勝オーバーレイに X シェア追加
- `EliminatedOverlay.tsx`: `onShare` prop 追加、シェアボタン
- `draw/page.tsx`: `handleShareCopy` 関数（Canvas 画像生成）、`shareCanvasRef`
- 定型文: `🃏 Poker Room Pastis でトーナメントに参加しました！\n#PastisPoker\nhttps://draw-poker.onrender.com`
- フロー: Canvas で結果カード生成 → クリップボードコピー → X 投稿画面が開く

### fix-v15〜v18: テーブル移動タイミング修正
- `sock.leave/join` は即時実行、`t:tableTransfer` 通知のみ 3 秒遅延（showdown 確認時間確保）
- `applyPendingLevelUp` 末尾の `broadcastBlind` 復活

### fix-v19: BOT waitZone スキップ + pendingLevelUp kickstart
- `gameManager.js`: BOT（`tbot::` プレフィックス）は RRoP Rule 16 waitZone をスキップ
- `tournamentManager.js`: `_pendingLevelUp` で waiting テーブルを kickstart

### fix-v20: t:tableJoin イベント追加
- `tournamentManager.js`: バランシング時に `sock.join` 直後に即時 `t:tableJoin` を送信
- `draw/page.tsx`: `t:tableJoin` ハンドラで `tableIdRef.current` を即時更新
- **目的**: `t:tableTransfer`（3秒後）前に tableIdRef を更新しアクションが旧テーブルに送られるバグを防ぐ

### fix-v21: 再接続時ブラインド情報未更新修正
- `draw/page.tsx`: 再接続時に `joinRoom` ではなく `t:getMyTable` を使用
- `joinRoom` は ring game 用で `t:blindUpdate` を再送しない

### fix-v22: stuck デバッグログ追加
- `[stuck-debug]` プレフィックスでゲームが始まらない原因調査用ログ

### fix-v23: ブラインドアップ連続期限切れ修正
- `index.js`: `applyPendingLevelUp` をループ化（複数レベルが期限切れの場合に一括適用）

### fix-v23b: _kickstartAfterBalance 多段リトライ
- `tournamentManager.js`: 300ms/1s/3s/7s の 4 段リトライ

### fix-v24b: `_io=false` バグ修正（最重要・根本修正）
- `tournamentManager.js`: `init()` で `undefined` 引数は既存値を保持するよう変更
  - `tournamentManager.init(undefined, undefined, _launchTournament)` が `_io` を上書きしないように
  - **これが「ゲームが始まらない」「ブラインドアップ表示が消えない」の根本原因だった**
- `tournamentManager.js`: `_pendingLevelUp` に 3 秒後の再チェックを追加
- `index.js`: `betAction` 拒否時に `[betAction-debug]` 詳細ログを追加

---

### fix-v25: 通常トーナメント開始直後にレイトレジスト参加ボタンが表示されない修正
- `pages/api/tournament/[id]/entry.ts`: 最終フォールバックを `false` → `true`（楽観的）に変更
- **原因**: レベルベース（`late_reg_minutes=0`）の通常トーナメントで、webpackバンドル境界により `tournamentManager` が別インスタンスになり `lateRegOpen` 取得失敗 → `scheduled_start_at` が過去 → `false` になっていた
- **安全性**: `_markLateRegClosed()` は終了時に必ず `__pastisLateRegClosed` Set に追加するため、Set 未登録 = まだ開放中が確定。レイトレジスト終了後は正しく `false` が返る
- **注意**: 同様の修正を Vol.4 で SNG 向けに実施済み（楽観的フォールバック）。今回は通常トーナメントのレベルベースが対象

---

## 現在のソースコード状態（主要ファイル）

```
server/
  index.js                        — 全修正累積（fix-v11〜v24b）
  poker/
    gameManager.js                — BOT waitZone スキップ（fix-v19）
  tournament/
    tournamentManager.js          — init()undefined 保護、t:tableJoin、kickstart 多段リトライ

pages/
  api/tournament/[id]/entry.ts    — lateRegOpen 楽観的フォールバック（SNG: Vol.4 / 通常レベルベース: fix-v25）

app/
  components/
    EliminatedOverlay.tsx         — X シェアボタン（fix-v13）
    TournamentTable.tsx           — フォールドボタン制御
  tournament/[id]/
    draw/page.tsx                 — 全修正累積（t:tableJoin、t:getMyTable 再接続、handleShareCopy）
    result/page.tsx               — X シェアボタン
    spectate/page.tsx             — t:tournamentNotFound 対応
```

---

## デバッグ方法

```bash
# 確認すべきログキーワード
[blind-debug]           — ブラインドレベルアップの流れ
[stuck-debug]           — ゲームが始まらない原因調査
[betAction-debug]       — レイズ等のボタンが効かない原因調査
[TM] ... kickstart      — pendingLevelUp kickstart
[lateReg]               — レイトレジスト配置
[bot-chain] END         — BOT チェーン終了・人間のターン
[t:grace-start]         — 切断猶予タイマー開始
```

### betAction 拒否ログの読み方
```
[betAction-debug] REJECTED user=Fujita action=raise
[betAction-debug]   roomId=e6ec59-4   ← 旧テーブルなら原因
[betAction-debug]   currentPlayer=Dealer-Dan idMatch=false  ← falseなら socket.id 不一致
```

---

## DB マイグレーション適用状況
- `schema.sql` ✅
- `migrations/add_tournament_entries.sql` ✅
- `migrations/add_sit_and_go.sql` ✅

---

## 未解決・要調査

| 問題 | 優先度 | 状況 |
|---|---|---|
| テーブル移動後の最初のハンドに参加できない | 高 | t:tableJoin で tableIdRef は更新済みだが、waitZone で sittingOut になっている可能性あり |
| ゲームが始まらない（稀に残存） | 中 | fix-v24b の多段リトライで改善見込み |
| ブラインドアップ表示 | 中 | fix-v24b（_io=false修正）で根本解決済み。要最終確認 |
| SNG 待機人数リアルタイム更新 | 低 | 30 秒ポーリング |
| モバイル縦持ちレイアウト | 低 | 未対応 |

---

## 環境変数
```
DATABASE_URL=postgresql://postgres.xxxxx:[PW]@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres
NEXTAUTH_URL=http://localhost:3000  # Render では https://draw-poker.onrender.com
ALLOWED_ORIGIN=http://localhost:3000
BOT_SECRET=pastis-internal-bot
```
