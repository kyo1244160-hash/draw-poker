/**
 * config.js — Poker Room Pastis サーバー設定
 *
 * このファイルを編集することで制限時間・ベット額などを変更できます。
 * サーバー再起動後に反映されます。
 */

module.exports = {
  SITE_NAME: 'Poker Room Pastis',

  // ===== 部屋設定 =====
  ROOM_COUNT: 10,
  MAX_PLAYERS: 6,       // 1部屋の最大参加人数

  // ===== チップ設定 =====
  BB_VALUE:     10,     // 1BB = 10チップ
  STARTING_BB:  100,    // 開始チップ = 100BB = 1000チップ

  // ===== ブラインド =====
  SMALL_BLIND:  5,      // SB（固定値）
  BIG_BLIND:    10,     // BB（固定値）

  // ===== ベット額（フィックスドリミット）=====
  // スモールベット: bet0（プリドロー）・bet1・bet2
  //   段階的ベット: 10, 20, 30, 40, 50（ベット + レイズ×4 = 5段階）
  SMALL_BET:    10,     // スモールベットの1単位

  // ビッグベット: bet3（最終ベット）draw2以降
  //   段階的ベット: 20, 40, 60, 80, 100（ベット + レイズ×4 = 5段階）
  BIG_BET:      20,     // ビッグベットの1単位

  // 5bet-cap: ベット1回 + レイズ4回 = 最大5アクション
  // ⚠️ 変更禁止: MAX_RAISES=5 かつ raiseCount は bet0 で 1 スタート が正しい設定。
  //   MAX_RAISES=4 にすると 4/5 でレイズ不可（5bet目が打てない）バグになる。
  //   MAX_RAISES=5 のまま raiseCount を 0 スタートにすると BET60 まで可能になるバグになる。
  MAX_RAISES:   5,  // raiseCount が 5 に達したらキャップ（1〜5段階、表示は1/5〜5/5）

  // ===== 制限時間（秒）=====
  // 0 にするとタイマーなし
  DRAW_TIME_LIMIT: 30,  // ドロー（カード交換）の制限時間
  BET_TIME_LIMIT:  30,  // ベットアクションの制限時間

  // タイムアウト時のデフォルトアクション
  // DRAW: 現在選択中のカードを交換（サーバーから selectedIndices を受け取る）
  // BET:  'fold'（フォールド扱い）
  BET_TIMEOUT_ACTION: 'fold',
};
