/**
 * server/logger.js
 * ログ出力ユーティリティ
 *
 * dev(IS_DEV=true) : 全ログを出力
 * prod(IS_DEV=false): 重要ログのみ出力（[pot][betAction-debug][deck][TBotM][broadcast]等は抑制）
 *
 * 使い方:
 *   const { log, logDev, logPot } = require('./logger');
 *   log('[TM] ...')        // 本番・開発ともに出力
 *   logDev('[balance] ...') // 開発時のみ出力
 *   logPot('[pot] ...')    // 開発時のみ出力（ポット計算詳細）
 */

const IS_DEV = process.env.NODE_ENV !== 'production';

/** 本番・開発ともに出力する重要ログ */
function log(...args) {
  console.log(...args);
}

/** 開発時のみ出力するデバッグログ */
function logDev(...args) {
  if (IS_DEV) console.log(...args);
}

/** ポット計算詳細ログ（[pot-display]等、開発時のみ） */
function logPot(...args) {
  if (IS_DEV) console.log(...args);
}

module.exports = { log, logDev, logPot, IS_DEV };
