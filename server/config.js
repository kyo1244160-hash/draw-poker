/**
 * config.js — Poker Room Pastis サーバー設定
 *
 * このファイルを編集することで、制限時間やベット額などを変更できます。
 * サーバー再起動後に反映されます。
 */

module.exports = {
  // ===== サイト設定 =====
  SITE_NAME: 'Poker Room Pastis',

  // ===== 部屋設定 =====
  // 部屋の総数（奇数番号 = 2-7 Triple Draw, 偶数番号 = Badugi）
  ROOM_COUNT: 10,

  // ===== チップ設定 =====
  // 1BBあたりのチップ単位
  BB_VALUE: 10,          // 1BB = 10チップ
  // 毎ゲーム開始時に配るチップ量（100BB固定）
  STARTING_BB: 100,      // → 100 × BB_VALUE = 1000チップ

  // ===== ブラインド設定 =====
  // SMALL_BLIND = 0.5BB, BIG_BLIND = 1BB
  SMALL_BLIND_BB: 0.5,   // SB = 5チップ
  BIG_BLIND_BB: 1,       // BB = 10チップ

  // ===== ベット設定（フィックスドリミット）=====
  SMALL_BET_BB: 1,       // bet1/bet2 = 1BB = 10チップ
  BIG_BET_BB: 2,         // bet3      = 2BB = 20チップ
  MAX_RAISES: 3,         // 1ラウンドのレイズ上限回数

  // ===== 制限時間設定（秒）=====
  // 0 を設定すると制限時間なし
  DRAW_TIME_LIMIT: 30,   // ドロー（カード交換）の制限時間（秒）
  BET_TIME_LIMIT: 30,    // ベットアクションの制限時間（秒）

  // 制限時間切れ時のデフォルトアクション
  DRAW_TIMEOUT_ACTION: 'standpat',  // 'standpat'（交換なし）
  BET_TIMEOUT_ACTION: 'check',      // 'check' または 'fold'
};
