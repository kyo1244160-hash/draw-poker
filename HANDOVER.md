# Poker Room Pastis — 引き継ぎメモ Vol.8

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

## このセッション（Vol.8）で完了した作業

### コードレビュー指摘の全修正（fix-all.zip）

以下のファイルを修正済み（bot-model-impl.zip も含む）：

| ファイル | 修正内容 |
|---|---|
| `server/index.js` | 起動時必須ENV チェック・`[betAction-debug]` を `logDev` に・accountId補完コメント・BOTモデルプリロード追加 |
| `server/logger.js` | `logPot` コメント修正（本番抑制を明記） |
| `server/poker/deck.js` | `Math.random` → `crypto.randomInt`（暗号論的乱数） |
| `server/poker/gameManager.js` | `[pot]` ログを `logPot` に・デッキ枯渇 null ハンドリング |
| `server/tournament/tournamentManager.js` | `_cleanupTables` で `deleteRoom`/`removeBots` 使用・`tournaments` Map 削除・`_disconnectedChips` クリーンアップ・`tournamentId` 保存 |
| `server/tournament/tournamentBotManager.js` | `'use strict'` 先頭に・`leaveRoom(botId)` 引数修正・phase チェック追加・`async` 化・`decideBotDrawWithRoom` に切り替え |
| `server/db/tournament.js` | 定員チェックをアトミックなサブクエリに変更 |
| `server/db/admin.js` | `sql.unsafe` の使用理由コメント追記 |
| `server/db/points.js` | `point_history.reason` にトーナメント名を含める |
| `pages/api/tournaments.ts` | `is_test` フィルタ追加 |
| `pages/api/profile/nickname.ts` | 全 DB コールに try/catch 追加 |
| `pages/room/[roomId].tsx` | `dynamic({ ssr: false })` で SSR 明示無効化 |
| `pages/tournament/[id].tsx` | `t:lateRegClosed` 購読 → 即時 `fetchData()` |
| `components/PokerTable.tsx` | `orientationchange` クリーンアップ・AudioContext `suspended/resume` 方式 |
| `app/components/TournamentTable.tsx` | AudioContext `suspended/resume` 方式 |
| `app/tournament/[id]/draw/page.tsx` | useEffect 空依存配列にコメント追加 |
| `migrations/add_unique_tournament_results.sql` | `tournament_results` UNIQUE 制約（**Supabaseで要実行**） |

### AIモデルBOT統合（bot-model-impl.zip）

| ファイル | 内容 |
|---|---|
| `scripts/convert_model.py` | `.pth` → `.onnx` 変換スクリプト（手動実行） |
| `server/poker/botInfoState.js` | ゲーム状態 → 122次元ベクトル変換（学習コードを完全移植） |
| `server/poker/botModel.js` | ONNX推論ラッパー（プリロード・フォールバック対応） |
| `server/poker/botManager.js` | モデル推論優先・ルールベースフォールバック構成に全面改訂 |
| `models/*.onnx` | 変換済み ONNX モデル 4ファイル（git管理） |
| `BOT_MODEL_MANUAL.md` | 運用マニュアル |

**現在のモデル学習状況:**
- Badugi: **233,536 steps**（変換・動作確認済み）
- 27TD:   **73,704 steps**（変換・動作確認済み、学習途中）

---

## 未デプロイ・未適用の作業

| # | 内容 | ファイル |
|---|---|---|
| 1 | **fix-v25**: 通常トーナメント開始直後に参加ボタンが出ない | `pages/api/tournament/[id]/entry.ts` |
| 2 | **fix-v26**: スマホXシェアの画像添付 / PCシェアシート誤表示 | `draw/page.tsx` `result/page.tsx` |
| 3 | **fix-all**: コードレビュー全修正（18ファイル） | `fix-all.zip` |
| 4 | **bot-model**: AIモデルBOT統合 | `bot-model-impl.zip` |
| 5 | **Supabase UNIQUE 制約** | `migrations/add_unique_tournament_results.sql` を要実行 |

---

## 現在のソースコード状態（主要ファイル）

```
server/
  index.js                         — 全修正累積（fix-all + bot preload）
  logger.js                        — logPot コメント修正
  poker/
    deck.js                        — crypto.randomInt シャッフル
    gameManager.js                 — pot ログ抑制・デッキ枯渇対策
    botManager.js                  — モデル推論優先版（NEW）
    botInfoState.js                — 122次元エンコーダ（NEW）
    botModel.js                    — ONNX推論ラッパー（NEW）
  tournament/
    tournamentManager.js           — _cleanupTables 修正・Map クリーンアップ
    tournamentBotManager.js        — async 化・leaveRoom 引数修正・phase ガード
  db/
    tournament.js                  — 定員チェック アトミック化
    admin.js                       — sql.unsafe コメント追記
    points.js                      — point_history にトーナメント名

pages/
  api/
    tournaments.ts                 — is_test フィルタ
    profile/nickname.ts            — try/catch 追加
    tournament/[id]/entry.ts       — lateRegOpen 楽観的フォールバック（fix-v25）
  room/[roomId].tsx                — SSR 明示無効化
  tournament/[id].tsx              — t:lateRegClosed 購読

components/
  PokerTable.tsx                   — orientationchange クリーンアップ・AudioContext 修正

app/
  components/TournamentTable.tsx   — AudioContext 修正
  tournament/[id]/
    draw/page.tsx                  — useEffect コメント追加・モバイルシェア（fix-v26）
    result/page.tsx                — モバイルシェア（fix-v26）

models/
  model_badugi.pth / model_27td.pth           — 学習済みモデル（git管理）
  model_badugi_strategy.onnx / _draw.onnx     — 変換済み（git管理）
  model_27td_strategy.onnx / _draw.onnx       — 変換済み（git管理）
  model_meta.json                              — steps・変換日時

scripts/
  convert_model.py                 — .pth → .onnx 変換（手動実行）

BOT_MODEL_MANUAL.md                — AIモデルBOT 運用マニュアル
migrations/
  add_unique_tournament_results.sql — 要Supabase実行
```

---

## AIモデルBOT 更新フロー

```
学習完了
  ↓
.pth を models/ に上書きコピー
  ↓
python scripts/convert_model.py  ← ローカルで手動実行
  ↓
git add models/ && git commit -m "update models" && git push
  ↓
Render が自動デプロイ（npm install && npm run build のみ）
```

詳細は `BOT_MODEL_MANUAL.md` を参照。

---

## デバッグ方法

```bash
[blind-debug]           — ブラインドレベルアップの流れ
[stuck-debug]           — ゲームが始まらない原因調査
[betAction-debug]       — レイズ等のボタンが効かない（本番では抑制済み）
[lateReg]               — レイトレジスト管理
[bot-chain] END         — BOT チェーン終了・人間のターン
[BotModel]              — BOTモデルのロード・推論状況
[BotManager]            — BOT行動決定ログ（開発環境のみ）
[t:grace-start]         — 切断猶予タイマー開始
```

---

## DB マイグレーション適用状況
- `schema.sql` ✅
- `migrations/add_tournament_entries.sql` ✅
- `migrations/add_sit_and_go.sql` ✅
- `migrations/add_unique_tournament_results.sql` ⏳ **未適用（Supabaseで要実行）**

---

## 環境変数
```
DATABASE_URL=postgresql://postgres.xxxxx:[PW]@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres
NEXTAUTH_URL=https://draw-poker.onrender.com
NEXTAUTH_SECRET=（必須・未設定だとサーバーが起動しない）
ALLOWED_ORIGIN=https://draw-poker.onrender.com
BOT_SECRET=pastis-internal-bot
```
