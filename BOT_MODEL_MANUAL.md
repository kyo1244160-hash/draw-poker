# AIモデルBOT 運用マニュアル

最終更新: 2026-04-25

---

## 概要

Poker Room Pastis のトーナメントBOTは、Deep CFR（深層反実仮想後悔最小化）で学習した
ニューラルネットワークモデルを使用してアクションを決定します。

モデルが使えない場合は自動的にルールベースにフォールバックするため、
モデルが存在しない状態でも動作します。

---

## ファイル構成

```
draw-poker-main/
├── models/
│   ├── model_badugi.pth            ← Badugi 学習済みモデル（git管理）
│   ├── model_27td.pth              ← 27TD 学習済みモデル（git管理）
│   ├── model_badugi_strategy.onnx  ← 変換後・ベット判断用（git管理）
│   ├── model_badugi_draw.onnx      ← 変換後・ドロー判断用（git管理）
│   ├── model_27td_strategy.onnx    ← 変換後・ベット判断用（git管理）
│   ├── model_27td_draw.onnx        ← 変換後・ドロー判断用（git管理）
│   └── model_meta.json             ← ステップ数・変換日時（変換時自動生成）
├── scripts/
│   └── convert_model.py            ← .pth → .onnx 変換スクリプト
└── server/poker/
    ├── botInfoState.js              ← ゲーム状態 → 122次元ベクトル変換
    ├── botModel.js                  ← ONNX推論ラッパー
    └── botManager.js               ← BOT行動決定（モデル優先・ルールベース兼用）
```

---

## モデル更新の手順

学習が進んで新しい `.pth` ファイルができたら、以下の手順でデプロイします。

### 必要なもの

- Python 環境（ローカル）
- `torch` `onnx` `onnxscript` がインストール済みであること

```bash
pip install torch onnx onnxscript
```

### ステップ 1: `.pth` ファイルを配置

```bash
# Badugi のみ更新する場合
cp ~/poker_trainer/data/models/model_badugi.pth ./models/

# 27TD のみ更新する場合
cp ~/poker_trainer/data/models/model_27td.pth ./models/

# 両方同時に更新する場合
cp ~/poker_trainer/data/models/model_badugi.pth ./models/
cp ~/poker_trainer/data/models/model_27td.pth   ./models/
```

> `.pth` が存在しないゲームタイプは変換スクリプトが自動的にスキップします。

### ステップ 2: ONNX に変換（ローカルで手動実行）

```bash
python scripts/convert_model.py
```

成功すると以下のように表示されます：

```
[badugi] 読み込み中: models/model_badugi.pth
[badugi] strategy → models/model_badugi_strategy.onnx
[badugi] draw    → models/model_badugi_draw.onnx
[badugi] 完了 (steps=233,536)
[27td] 読み込み中: models/model_27td.pth
[27td] strategy → models/model_27td_strategy.onnx
[27td] draw    → models/model_27td_draw.onnx
[27td] 完了 (steps=73,704)

model_meta.json 更新完了: ['badugi', '27td']
```

### ステップ 3: コミット＆プッシュ

```bash
git add models/
git commit -m "update models: badugi=step300k 27td=step100k"
git push
```

Render のビルドコマンドは `npm install && npm run build` のみです。
変換処理はローカルで完結しているため、Render 側の追加作業は不要です。

---

## サーバー起動時の動作

サーバーが起動すると、全モデルをバックグラウンドでメモリに展開します。

```
サーバー起動
  ↓
必須ENV チェック（NEXTAUTH_SECRET, DATABASE_URL）
  ↓
tournamentManager.init() ...
  ↓
preloadBotModels() を非同期で実行
  ├─ models/model_badugi_strategy.onnx をロード
  ├─ models/model_badugi_draw.onnx をロード
  ├─ models/model_27td_strategy.onnx をロード
  └─ models/model_27td_draw.onnx をロード
```

**起動ログの見方:**

| ログ | 意味 |
|---|---|
| `[BotModel] badugi: モデルをロード中...` | ONNX セッション生成開始 |
| `[BotModel] badugi: ロード完了 (steps=233,536)` | 正常ロード完了。steps はモデルの学習量 |
| `[BotModel] badugi: モデルファイルが見つかりません → ルールベースで動作` | .onnx ファイル未存在 |
| `[BotModel] badugi: ロードエラー → ルールベースで動作 (...)` | ロード失敗・自動フォールバック |

---

## ゲーム中の動作フロー

### ベット（BET フェーズ）

```
BOT のターン
  ↓
buildInfoState() でゲーム状態を 122次元ベクトルに変換
  ↓
strategy_net に入力 → 5次元ロジット出力
  ↓
softmax で確率化 → 合法アクションのみで最大値を選択
  ↓
betAction() でアクション実行
```

アクションの対応：

| 出力インデックス | アクション |
|---|---|
| 0 | fold（フォールド） |
| 1 | check（チェック） |
| 2 | call（コール） |
| 3 | bet（ベット） |
| 4 | raise（レイズ） |

### ドロー（DRAW フェーズ）

```
BOT のターン
  ↓
buildInfoState() でゲーム状態を 122次元ベクトルに変換
  ↓
draw_net に入力 → 各カードごとの sigmoid 出力
  ↓
0.5 以上のインデックスを「捨てる」と判断
  ↓
drawCards() でカード交換実行
```

出力次元数はゲームタイプで異なります：

| ゲームタイプ | draw_net 出力次元 | 意味 |
|---|---|---|
| 27TD | 5次元 | 5枚それぞれの捨て確率 |
| Badugi | 4次元 | 4枚それぞれの捨て確率 |

---

## 開発環境でのデバッグログ

`NODE_ENV !== production` の場合、以下のログが出力されます：

```
# ベット判断（モデル使用時）
[BotModel] badugi bet probs: 0:0.000 1:0.321 2:0.678 3:0.000 4:0.001 → check
[BotManager] badugi bet(model): check

# ドロー判断（モデル使用時）
[BotModel] badugi draw probs: 0:0.000 1:0.000 2:0.000 3:0.000 → discard[]
[BotManager] badugi draw(model): discard[]

# ルールベースフォールバック時
[BotManager] bet model error: ...（エラー内容）
# ※フォールバックログは出力されない（自動で切り替わる）
```

---

## フォールバック動作

以下の場合は自動的にルールベースに切り替わります。
ゲームの進行には影響しません。

| 状況 | 動作 |
|---|---|
| `.onnx` ファイルが存在しない | ルールベース |
| モデルのロードに失敗 | ルールベース |
| 推論中にエラーが発生 | ルールベース |
| モデルが全アクションに 0 確率を返した | ルールベース |

**ルールベースの戦略（フォールバック時）:**

| フェーズ | 戦略 |
|---|---|
| ベット（コール不要） | 80% チェック、20% ベット/レイズ |
| ベット（コール必要） | 85% コール、11% レイズ、4% フォールド |
| ドロー 27TD | 8以上のカード・ペア・フラッシュ構成のカードを捨てる |
| ドロー Badugi | 各スートで最低ランクのカードだけ残す |

---

## 現在のモデル状態確認

`models/model_meta.json` を確認します：

```json
{
  "badugi": {
    "steps": 233536,
    "converted_at": "2026-04-24T11:45:21Z"
  },
  "27td": {
    "steps": 73704,
    "converted_at": "2026-04-24T11:45:26Z"
  }
}
```

またはサーバー起動ログの `[BotModel] ... ロード完了 (steps=...)` で確認できます。

---

## 入力ベクトル（122次元）の内訳

`buildInfoState()` が生成するベクトルの構成です。
モデルの入力と学習時の特徴量が一致していることが重要です。

| # | 内容 | 次元数 | 正規化 |
|---|---|---|---|
| ① | ゲームタイプ one-hot（27TD / A5 / Badugi） | 3 | — |
| ② | ストリート one-hot（PREFLOP / DRAW1 / DRAW2 / DRAW3） | 4 | — |
| ③ | ポジション one-hot（BTN / SB / BB / UTG / HJ / CO） | 6 | — |
| ④ | ポット | 1 | ÷100 |
| ⑤ | 現在のベット額 | 1 | ÷10 |
| ⑥ | ベットカウント（raiseCount） | 1 | ÷5 |
| ⑦ | ポットオッズ | 1 | callAmt÷(pot+callAmt) |
| ⑧ | 自分のスタック | 1 | ÷100 |
| ⑨ | 手札（52次元 one-hot） | 52 | — |
| ⑩ | アクティブプレイヤー数 | 1 | ÷人数 |
| ⑪ | 相手のドロー枚数（5人×4ストリート） | 20 | ÷5（未ドロー=-1） |
| ⑫ | ストリートごとの累積ベット数 | 4 | ÷5 |
| ⑬ | 自分のハンド強度スカラー | 1 | 0〜1 |
| ⑭ | 残りドロー回数 | 1 | ÷3 |
| ⑮ | ベットサイズ（BB倍数） | 1 | ÷2 |
| ⑯ | SPR（スタック/ポット比、上限10） | 1 | ÷10 |
| ⑰ | 相手5人のスタック | 5 | ÷100 |
| ⑱ | フラッシュ危険度 | 1 | 同スート最大枚数÷手牌枚数 |
| ⑲ | ストレート危険度 | 1 | 0〜1（Badugi は常に0） |
| ⑳ | ポジション別アグレッション | 6 | ÷5 |
| ㉑ | 相手のスタンドパットフラグ | 5 | 1=確認済み / 0=ドロー / -1=未ドロー |
| ㉒ | カードクオリティスコア | 5 | 0〜1 |
| **合計** | | **122** | |

**カードの one-hot インデックス計算式:**

```
インデックス = (rank - 2) × 4 + suit
rank: 2=0, 3=1, ..., A=12
suit: S=0, H=1, D=2, C=3
例: 2♠ → (2-2)×4+0 = 0
例: A♣ → (14-2)×4+3 = 51
```

---

## 技術的な注意事項

**ONNX ランタイムについて**

`onnxruntime-node`（ネイティブバイナリ）は Render のネットワーク制限により
インストールできないため、代わりに `onnxruntime-web`（WASM バックエンド）を使用しています。
CPU推論であり、推論速度は BOT の思考時間（0.5〜2秒の遅延）内で十分に完了します。

将来 `onnxruntime-node` が使えるようになった場合は `botModel.js` の
`require('onnxruntime-web')` を `require('onnxruntime-node')` に変更するだけで
切り替えられます。

**Mix モード**

Mix モードでは `room.currentMode` が `'27'` または `'badugi'` に切り替わるため、
それに応じて対応するモデルが自動的に選択されます。

**学習途中モデルの注意点**

27TD（現在 73,704 ステップ）は学習量がまだ少ないため、ルールベースより
判断が不安定な場合があります。ステップ数が増えるにつれて改善されます。
目安として 500,000 ステップ以上で安定した判断ができるようになります。

---

## よくある質問

**Q. `.onnx` ファイルを更新したのにサーバーに反映されない**  
A. Render はプッシュ時に自動デプロイされます。`git push` 後に Render のダッシュボードでデプロイが完了したことを確認してください。

**Q. サーバーログに `ルールベースで動作` と出る**  
A. `.onnx` ファイルが `models/` に存在しないか、ロードに失敗しています。`git push` で `.onnx` ファイルが含まれているか確認してください。

**Q. BOT の行動がおかしい（毎回フォールドするなど）**  
A. 学習ステップ数が少ないため正常です。学習を続けて `model_meta.json` の `steps` が増えていれば学習中です。

**Q. モデルを特定のゲームタイプだけ使いたくない**  
A. 該当の `.onnx` ファイルを削除または別名にリネームすると、そのゲームタイプのみルールベースにフォールバックします。

**Q. convert_model.py 実行時に `ModuleNotFoundError: No module named 'onnxscript'` と出る**  
A. `pip install onnxscript` でインストールしてください。
