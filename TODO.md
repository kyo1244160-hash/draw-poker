# TODO.md — タスク・優先順位・既知の問題

最終更新: 2026-04-13 (Vol.3)

---

## 🔴 優先度: 高（バグ・本番影響あり）

### 「あなたの番ではない」エラーの根本原因
- バランシング後に古い socket.id が `room.currentPlayer.id` に残り、新しい socket.id でのアクションが拒否される
- **調査ポイント**: `_dissolveTable` → `jr()` 時の `p.id` が古い socket.id のまま
- **デバッグ方法**: サーバーログ `[getTableForPlayer]` を確認（nickname フォールバックスキャン追加済み）
- **対策済み**: エラー時はトーストで表示し gameState を自動再取得（ゲームを継続可能に）

### カードチェンジ時「あなたの番ではない」→ロビー戻り＋チップリセット
- 上記と同根。`fix-reconnect-chips.zip` で二重配置は防止済みだが根本未解決

### 観戦モード自動遷移（残存リスク）
- `_app.tsx` の `TournamentStartWatcher` が spectate ページ（App Router）では動作しない
- **対策済み**: `_eliminatePlayer` で `socket.leave(tableId)` 追加・`isEliminated` フォールバック強化
- **要確認**: 本番でまだ再現するか監視

---

## 🟡 優先度: 中（UX 改善・機能追加）

### Sit & Go
- [x] 基本実装完了
- [x] BOT を参加人数に含めて判定
- [x] BOT 予約追加後に SNG チェックを再実行
- [x] 終了後に同一設定で次の SNG を自動作成
- [x] レイトレジスト参加後に残り人数・ブラインドを即送信
- [x] `ALREADY_RUNNING` エラー時に `/add` に自動フォールバック
- [ ] `max_players` に達したら即時開始（現状: `min_players` 到達で開始）
- [ ] SNG 待機中の「あと N 人」表示をリアルタイム更新（現状: 30秒ポーリング）

### トーナメント
- [ ] ファイナルテーブル到達時の演出強化
- [ ] トーナメント結果ページに全ハンド履歴表示

### 通知・UX
- [ ] モバイルでの縦持ち時のレイアウト改善（特にカード選択エリア）

---

## 🟢 優先度: 低（将来対応）

### デバッグ・テスト環境（実装検討中）
- [ ] 管理画面に「テスト開始ボタン」（SNG 作成→BOT 追加→参加登録を1クリックで）
- [ ] `BET_TIME_LIMIT` / `DRAW_TIME_LIMIT` を `.env.local` から上書き可能にする
- [ ] 管理画面にリアルタイムログパネル
- [ ] 自動フォールド BOT（トーナメント進行速度テスト用）

### 機能追加
- [ ] チャット機能（テーブル内）
- [ ] ハンド履歴・統計表示
- [ ] Omaha などの別ゲームモード対応
- [ ] BOT の難易度設定 UI

---

## 既知の問題（即修正不要だが記録）

| 問題 | 状況 | 回避策 |
|---|---|---|
| iOS Safari でターン音が初回のみ鳴らないことがある | `AudioContext` 初期化タイミングの問題 | 画面タップ後は正常 |
| Render コールドスタート後の最初の接続が遅い（~30秒） | 無料プランのスリープ | `useKeepalive` でスリープ防止中 |
| SNG 参加登録→キャンセル後でも条件を満たすと参加させられる | タイミングの競合（レースコンディション）。発生確率低く保留 | 開発環境で `[SNG-debug]` ログで確認可能 |
| `tournament_seats` テーブルが未使用 | ドロー画面のシート表示実装前に作成 | 特になし |

---

## 完了済みタスク（2026-04-12 セッション）

- [x] SNG 作成時 `scheduledStartAt` が空で通信エラー → `isSitAndGo` 時は `undefined` に修正
- [x] SNG 開始後も「予約追加」ボタンが表示されたまま → BOT 追加後に一覧を自動リフレッシュ
- [x] レイトレジスト新テーブルに1人で止まる → 3秒×10回リトライ付きバランシング追加
- [x] タイマー 0:00 固定 → countdown===0 で pendingLevelUp 扱いに
- [x] バースト時フリーズ → `eliminatedRef` でクロージャ問題解消・フォールバック 1.5 秒に短縮
- [x] SNG 残り人数が表示されない → レイトレジスト参加直後に `t:tournamentStatus` 送信
- [x] BOT が 60 体しか追加できない → 上限 500 体・`MAX_TABLES` 100 に変更
- [x] App Router → Pages Router 遷移で `require.e is not a function` → `window.location.href` に変更
- [x] DB 接続上限（`MaxClientsInSessionMode`）→ 開発環境でグローバル singleton + `max=2`
- [x] DATABASE_URL が port 6543 → port 5432（Session pooler）に修正
- [x] SNG 終了後に同一設定で次のトーナメントを自動作成
- [x] `isSitAndGo` / `minPlayers` をメモリ上のトーナメントオブジェクトに保存
- [x] `broadcastStatus()` / `broadcastBlind()` を tournamentManager から公開

## 完了済みタスク（前セッション）

- [x] RRoP Rule 16 着席ルール実装
- [x] スプリットポット対応（奇数チップの SB 基準分配）
- [x] テーブルバランシング（進行中テーブル保護）
- [x] ブラインドレベルアップ中テーブル保護
- [x] ショートオールインのコール義務修正
- [x] 重複脱落バグ修正
- [x] 観戦モード（入口・レイアウト・自動切り替え・回り順修正）
- [x] レイトレジスト（時間ベース・レベルベース両対応）
- [x] ターン通知音（iOS Safari 対応）
- [x] Sit & Go 基本実装
