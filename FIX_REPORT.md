# Poker Room Pastis 修正レポート
対象: 引き継ぎ後の未解決バグ（001〜008・テーブル一覧）
日付: 2026-05-31 / 回帰テスト: 45 passed, 0 failed（40→45に増加）

---

## 最重要の発見: 複数バグが同一の根本原因だった

**002（Razz で A♠ がBI）・008（ハンド途中でゲーム切替）・001の一部** は、すべて
`gameManager.js` の `getMixCurrentMode` が

```js
const cycle = Math.floor(room.handCount / room.players.length) % 6;
```

と **現在の人数（players.length）に依存してモードを決めていた**ことが原因。

トーナメントではテーブルバランスで人数が頻繁に変わるため、同じ handCount でも
人数が変わるとモードがズレる。検証で実証:

| handCount | 6人 | 5人 | 4人 |
|-----------|-----|-----|-----|
| 30 | razz | badugi | stud_e |

- `razz` のつもりが `stud_s` 等にズレる → A♠ が「最低カード」扱いで誤BI（002）
- ハンド進行中の人数変動でモードが変わる（008）

### 恒久対応
人数に依存しない独立カウンタ方式に再設計:
- `room._modeSeqIndex`（サイクル位置）, `_modeHandsTotal`（モード開始時の人数で固定）, `_modeHandsDone`（消化数）
- `getMixCurrentMode` は副作用なしの読み取りに変更
- `advanceModeRotation(room)` が「各モードを開始時人数分続ける」前進処理を担当
- `peekNextMode` の handCount 操作トリックを廃止

各モードは「開始時に固定した継続ハンド数」を守るため、途中で人数が変わっても揺れない。

---

## 個別修正

### 001/008 — Stud切替なのにドロー表示
- **真因A**: ドロー側 buildGameState の meta に `isStud` フィールドが無く undefined だった。
  クライアントは `meta.isStud` 単独で分岐するため、`currentMode=stud_e` でも
  isStud=undefined の矛盾metaでドローUIに切替。
- **真因B**: 上記モードローテーションのズレ。
- **修正**:
  - `gameManager.js`: meta.isStud を currentMode から導出して明示設定
  - `index.js`: 観戦パスが スタッド中もドロー版を送る問題を `_isStudActive` 振り分けに修正
  - `draw-page.tsx`: `shouldShowStudUI()` を新設。currentMode を権威とする単一の真実の源。
    isStud/currentMode 矛盾を検出してサーバーへ記録するデバッグログ追加

### 002 — Razz で A♠ 保持者がBI
- 上記モードローテーション修正で解消（razz→stud_s 誤判定がなくなる）
- `findBringIn` 自体は正しいことをライブ実行で確認済み
- 回帰テスト追加: 「A♠保持者は単独では絶対にBIにならない」

### 003 — ブリングインに対するボタン表記
- **結論: 現状のコードが正式ルール通り正しい**（変更不要）
- Web確認（pokernews/888poker等）: ブリングインを小ベットに引き上げるのは
  「コンプリート」であり「レイズ」ではない。レイズはコンプリート後の上乗せ。
- 現コードは `room.currentBet < betSize`（未コンプリート時）に「コンプリート」表示で正しい
- ハウスルールとして「レイズ」表記を望む場合のみ変更可（要ご判断）

### 004 — テーブル移動後ハンドが終わらない
- **真因**: スタッド経路は startGame を通らず syncFromGameManager がプレイヤー配列を
  構築するが、**pendingPlayers（移動してきた待機者）を昇格していなかった**。
  移動先がスタッドだと参加できず宙ぶらりんに。
- **修正**: `studManager.js` syncFromGameManager で pendingPlayers を players に昇格し、
  gmRoom 側もクリア。デバッグログ `[stud-sync]` 追加。

### 007 — 「もう1人待っています」固まり
- **真因**: balanceTables は showdown 後にしか呼ばれないが、active<2 のテーブルは
  ハンドが始まらず showdown に到達しないため、永遠に待機（デッドロック）。
  リトライも canAutoStart=false で発火しない。
- **修正**: `index.js` `_tryAutoStart` 冒頭で active<2 かつ複数テーブルを検出したら
  balanceTables を能動的に発火し、他テーブルから集約。多段リトライ付き。
  デバッグログ `[007-fix]` 追加。

### 005 — スマホ版スタッドで自プレイヤーが上に寄る
- **真因**: portrait で自分を楕円配置(ang=90)すると top≈0.72*TH となり下部に空白。
- **修正**: `StudTable.tsx` getPosMobile で portrait時の自プレイヤーを画面下端に直接配置。

### 006 — スマホ版スタッドでボタン上部が途切れる
- **真因**: アクションパネルの予約高さ ACT_H_M=110 が実コンテンツに足りず、
  テーブル領域がパネルに食い込んでボタン上部を覆っていた。
- **修正**: ACT_H_M を 150 に拡大。パネルを `position:relative; zIndex:10` で前面化、
  上部padding確保。`flex:1`→`flexShrink:0` で固定高さ保証。

### テーブル一覧ボタン
- **情報取得失敗**: スタッド進行中はチップが studRooms 側にあり、APIがドロー側 rooms の
  古いチップ（または空）を返していた。
  → `tables-api.ts` をスタッド対応に。studRooms 進行中はそちらのチップを優先。
  → クライアントに HTTP ステータス別エラー表示（503=準備中 等）とデバッグログ追加。
- **誤タップ**: テーブル一覧ボタンをアクションボタンから区切り線＋余白(14px)で分離。

---

## デバッグログ一覧（本番で grep して追跡可能）
| タグ | 場所 | 用途 |
|------|------|------|
| `[mode-rot]` | gameManager/index | モードローテーションの遷移追跡 |
| `[isStud-guard]` | gameManager | ドロー経路がスタッドmodeで呼ばれた誤りの検出 |
| `[spectate]` | index | 観戦時のstud/draw振り分け確認 |
| `[gameState]` / `isStud-mismatch` | draw-page(client) | isStud/currentMode矛盾の検出 |
| `[stud-sync]` | studManager | pendingPlayers昇格の追跡 |
| `[007-fix]` | index | デッドロック解消のbalanceTables発火追跡 |
| `[tableList]` | StudTable(client) | テーブル一覧取得の成否 |

## 変更ファイル
- server/index.js
- server/poker/gameManager.js
- server/poker/studManager.js
- scripts/test-poker-logic.js（テスト45件に拡張）
- app/tournament/[id]/draw/page.tsx （→ draw-page.tsx）
- components/StudTable.tsx
- components/TableListModal.tsx
- pages/api/tournament/[id]/tables.ts （→ tables-api.ts）

## デプロイ時の注意
- draw-page.tsx は `app/tournament/[id]/draw/page.tsx` へ配置
- tables-api.ts は `pages/api/tournament/[id]/tables.ts` へ配置
- 既存進行中ルームへの後方互換: 新フィールド(_modeSeqIndex等)が無い場合も
  advanceModeRotation が未初期化を検知して初期化するため安全
