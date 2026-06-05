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

const fs = require('fs');
const path = require('path');

const IS_DEV = process.env.NODE_ENV !== 'production';
const LOG_DIR = path.join(process.cwd(), 'logs');
const STUD_LOG_FILE = path.join(LOG_DIR, 'stud-debug.log');
const MAX_STUD_LOG_BYTES = Number(process.env.STUD_DEBUG_LOG_MAX_BYTES ?? 5 * 1024 * 1024);

function _rotateIfNeeded(file) {
  if (!Number.isFinite(MAX_STUD_LOG_BYTES) || MAX_STUD_LOG_BYTES <= 0) return;
  try {
    const stat = fs.statSync(file);
    if (stat.size < MAX_STUD_LOG_BYTES) return;
    const rotated = `${file}.1`;
    try { fs.rmSync(rotated, { force: true }); } catch {}
    fs.renameSync(file, rotated);
  } catch {
    // ファイル未作成などはそのまま新規作成に任せる
  }
}

function _appendLine(file, args) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    _rotateIfNeeded(file);
    const line = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // ログ書き込み失敗でゲーム進行を止めない
  }
}

/** 本番・開発ともに出力する重要ログ */
function log(...args) {
  console.log(...args);
  if (typeof args[0] === 'string' && args[0].startsWith('[stud-')) {
    _appendLine(STUD_LOG_FILE, args);
  }
}

/** 開発時のみ出力するデバッグログ */
function logDev(...args) {
  if (IS_DEV) console.log(...args);
}

/** ポット計算詳細ログ（[pot-display]等、開発時のみ） */
function logPot(...args) {
  if (IS_DEV) console.log(...args);
}

function logStud(...args) {
  console.log(...args);
  _appendLine(STUD_LOG_FILE, args);
}

module.exports = { log, logDev, logPot, logStud, IS_DEV };
