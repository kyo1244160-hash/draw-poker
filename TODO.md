# TODO.md — タスク・優先順位・既知の問題

最終更新: 2026-04-25 (Vol.8)

---

## 🔴 優先度: 高（バグ・本番影響あり）

### [未デプロイ] fix-v25: 通常トーナメント開始直後に参加ボタンが出ない
- `pages/api/tournament/[id]/entry.ts` 修正済み

### [未デプロイ] fix-v26: スマホXシェアで画像が添付できない / PCシェアシート誤表示
- `draw/page.tsx` `result/page.tsx` 修正済み

### [未デプロイ] fix-all: コードレビュー全修正 18ファイル
- fix-all.zip として出力済み。`npm run build` 後デプロイ

### [未適用] Supabase UNIQUE 制約
- `migrations/add_unique_tournament_results.sql` を Supabase SQL エディタで実行が必要
- 二重ポイント加算防止のため重要

### テーブル移動後の最初のハンドに参加できない
- waitZone（RRoP Rule 16）で sittingOut=true になっている可能性
- `[betAction-debug]` ログで1手目タイムアウト時を確認

---

## 🟡 優先度: 中（UX 改善・品質）

### AIモデルBOT統合（実装済み・未デプロイ）
- bot-model-impl.zip として出力済み
- `onnxruntime-web` を使用（WASM バックエンド）
- デプロイ時は `models/*.onnx` が git に含まれていることを確認
- 詳細は `BOT_MODEL_MANUAL.md` 参照

### AIモデルの学習継続
- Badugi: 233,536 steps（動作中）
- 27TD:   73,704 steps（学習途中・判断不安定な場合あり）
- 更新時は `python scripts/convert_model.py` を実行して `git push`

### ゲームが始まらない（稀に残存）
- fix-v24b で大幅改善。継続監視中
- `[stuck-debug]` ログで `canAutoStart=false` の原因を確認

### ブラインドアップ表示の最終確認
- fix-v24b（`_io=false` 修正）で解決済みのはず。再現したら `[blind-debug]` 確認

### Sit & Go
- [ ] `max_players` に達したら即時開始
- [ ] SNG 待機中の「あと N 人」表示をリアルタイム更新（現状: 30秒ポーリング）

---

## 🟢 優先度: 低（将来対応）

- [ ] リングゲーム・ファストフォールドのレイアウトをトーナメントに合わせる（`PokerTable.tsx` 1ファイル）
- [ ] モバイル縦持ちレイアウト改善
- [ ] ファイナルテーブル到達時の演出強化
- [ ] 管理画面に「テスト開始ボタン」
- [ ] チャット機能（テーブル内）
- [ ] ハンド履歴・統計表示
- [ ] サーバーサイドのユニットテスト整備
- [ ] `onnxruntime-node` が使えるようになったら `botModel.js` の require を切り替え

---

## 完了済みタスク（Vol.8 / 2026-04-25）

- [x] コードレビュー6ラウンドの全指摘を修正（fix-all.zip）
- [x] AIモデルBOT統合（Badugi + 27TD、ONNX変換・推論・特徴量エンコーダ）
- [x] `BOT_MODEL_MANUAL.md` 作成

## 完了済みタスク（Vol.7 / 2026-04-20）

- [x] 全ソースコードのAI三者協議コードレビュー（6ラウンド）
- [x] ゲーム開始直後の音が鳴らない問題の原因調査
- [x] レイトレジスト終了後に観戦ボタンが使えない問題の原因調査

## 完了済みタスク（Vol.6 / 2026-04-18）

- [x] 通常トーナメント（レベルベース）開始直後に参加ボタンが表示されない → fix-v25
- [x] スマホから X シェアで画像が添付できない → fix-v26

## 完了済みタスク（Vol.5 / 2026-04-17）

- [x] fix-v11〜v24b（バランシング/ブラインド/BOT/テーブル移動/再接続等 多数）
