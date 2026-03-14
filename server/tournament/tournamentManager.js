'use strict';
/**
 * tournamentManager.js
 * トーナメント全体の管理・スケジュール・テーブル生成・脱落検出・ブラインドレベルアップ
 *
 * 依存: gameManager.js（room プロパティ化済み）
 */

const {
  getOrCreateRoom,
  joinRoom: joinPokerRoom,
  leaveRoom,
  startGame,
  getAllRooms,
} = require('../poker/gameManager');

const { getSchedule } = require('./blindSchedule');

// ===== 内部ステート =====
// tournamentId → Tournament オブジェクト
const tournaments = new Map();

// roomId → tournamentId （どのトーナメントのテーブルかを逆引き）
const roomToTournament = new Map();

// Socket.IO の io インスタンス（init で設定）
let _io = null;
// タイムアウトハンドラファクトリ（index.js から注入）
let _makeTimeoutHandler = null;

function init(io, makeTimeoutHandler) {
  _io = io;
  _makeTimeoutHandler = makeTimeoutHandler ?? null;
}

// ===== Tournament オブジェクト構造 =====
// {
//   id:              string,
//   name:            string,
//   mode:            '27' | 'badugi' | 'mix',
//   startingChips:   number,
//   scheduleId:      string,
//   levels:          BlindLevel[],        // メモリにコピー済み
//   currentLevelIdx: number,              // 現在のレベルインデックス
//   levelStartedAt:  number,             // Date.now() ms
//   pendingLevelUp:  boolean,
//   tableIds:        string[],           // 現在のテーブル roomId 一覧
//   eliminationOrder: AccountId[],       // 脱落順（早い順）
//   totalPlayers:    number,
//   status:          'running' | 'finished',
//   _levelTimer:     NodeJS.Timeout | null,
// }

// ===== テーブル名生成 =====
let _tableSeq = 0;
function _makeTableId(tournamentId) {
  _tableSeq += 1;
  return `t-${tournamentId}-${_tableSeq}`;
}

// ===== テーブル作成 =====
function _createTable(tournament, playerInfos) {
  const tableId = _makeTableId(tournament.id);
  const lv = tournament.levels[tournament.currentLevelIdx];

  // gameManager にトーナメント用パラメータを渡して部屋を作成
  const room = getOrCreateRoom(tableId, {
    isUserCreated:  false,
    isZoomTable:    false,
    label:          `${tournament.name} Table`,
    smallBlind:     lv.sb,
    bigBlind:       lv.bb,
    smallBet:       lv.smallBet,
    bigBet:         lv.bigBet,
    startingChips:  tournament.startingChips,
    // トーナメントフラグ
    _tournamentId:  tournament.id,
    _isTournament:  true,
  });

  // 各プレイヤーをテーブルに参加させる
  for (const { accountId, nickname, chips } of playerInfos) {
    joinPokerRoom(tableId, accountId, nickname, { existingChips: chips, accountId });
  }

  tournament.tableIds.push(tableId);
  roomToTournament.set(tableId, tournament.id);
  return tableId;
}

// ===== プレイヤーを均等にテーブルへ割り振り =====
const MAX_PER_TABLE = 6;

function _assignTables(tournament, players) {
  // 必要テーブル数
  const tableCount = Math.ceil(players.length / MAX_PER_TABLE);
  const shuffled = [...players].sort(() => Math.random() - 0.5);

  const tables = [];
  for (let i = 0; i < tableCount; i++) tables.push([]);
  shuffled.forEach((p, idx) => tables[idx % tableCount].push(p));

  const tableIds = [];
  for (const group of tables) {
    tableIds.push(_createTable(tournament, group));
  }
  return tableIds;
}

// ===== トーナメント開始 =====
/**
 * @param {object} opts
 * @param {string}   opts.id             - tournament DB id
 * @param {string}   opts.name
 * @param {string}   opts.mode           - '27'|'badugi'|'mix'
 * @param {number}   opts.startingChips
 * @param {string}   opts.scheduleId     - blind schedule id
 * @param {object[]} opts.players        - [{ accountId, nickname }]
 * @param {object}   opts.scheduleData   - levels array from DB (optional, overrides scheduleId lookup)
 */
function startTournament(opts) {
  const { id, name, mode, startingChips, scheduleId, players, scheduleData } = opts;

  if (tournaments.has(id)) {
    console.warn(`[TM] Tournament ${id} already running`);
    return null;
  }

  // ブラインドスケジュールをメモリにコピー
  let levels;
  if (scheduleData && Array.isArray(scheduleData)) {
    levels = scheduleData;
  } else {
    const schedule = getSchedule(scheduleId);
    levels = schedule.levels;
  }

  const tournament = {
    id,
    name,
    mode,
    startingChips,
    scheduleId,
    levels,
    currentLevelIdx: 0,
    levelStartedAt:  Date.now(),
    pendingLevelUp:  false,
    tableIds:        [],
    eliminationOrder: [],
    totalPlayers:    players.length,
    status:          'running',
    _levelTimer:     null,
  };

  tournaments.set(id, tournament);

  // テーブル割り当て
  const playerInfos = players.map(p => ({
    accountId: p.accountId,
    nickname:  p.nickname,
    chips:     startingChips,
  }));
  _assignTables(tournament, playerInfos);

  // 全テーブルでゲーム開始（onTimeoutを渡してタイムアウト処理を有効化）
  for (const tableId of tournament.tableIds) {
    const onTimeout = _makeTimeoutHandler ? _makeTimeoutHandler(tableId) : null;
    startGame(tableId, onTimeout);
  }

  // ブラインドレベルアップタイマー開始
  _startLevelTimer(tournament);

  console.log(`[TM] Tournament ${id} started: ${players.length} players, ${tournament.tableIds.length} tables`);

  // クライアントへ開始通知
  _broadcastTournamentStatus(tournament);

  return tournament;
}

// ===== ブラインドレベルアップタイマー =====
function _startLevelTimer(tournament) {
  if (tournament._levelTimer) clearTimeout(tournament._levelTimer);
  tournament._levelTimer = null;

  const lv = tournament.levels[tournament.currentLevelIdx];
  if (!lv || lv.durationMinutes === 0) return; // 最終レベル

  const ms = lv.durationMinutes * 60 * 1000;
  tournament.levelStartedAt = Date.now();

  tournament._levelTimer = setTimeout(() => {
    _pendingLevelUp(tournament.id);
  }, ms);
}

/**
 * レベルアップを「次のハンド開始まで保留」にセット
 * ハンド開始時に gameManager のコールバックからチェックする
 */
function _pendingLevelUp(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (!t || t.status !== 'running') return;

  t.pendingLevelUp = true;
  console.log(`[TM] ${tournamentId}: blind level-up pending`);
}

/**
 * ハンド開始直前に呼ばれる（server/index.js の startGame コールバック等から）
 * pendingLevelUp があれば全テーブルのブラインドを更新する
 */
function applyPendingLevelUp(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (!t || !t.pendingLevelUp || t.status !== 'running') return false;

  t.pendingLevelUp  = false;
  t.currentLevelIdx = Math.min(t.currentLevelIdx + 1, t.levels.length - 1);

  const lv = t.levels[t.currentLevelIdx];
  console.log(`[TM] ${tournamentId}: blind level up → Lv${lv.level} sb=${lv.sb} bb=${lv.bb}`);

  // 全テーブルのブラインドを更新
  for (const tableId of t.tableIds) {
    const room = getOrCreateRoom(tableId);
    room.smallBlind    = lv.sb;
    room.bigBlind      = lv.bb;
    room.smallBet      = lv.smallBet;
    room.bigBet        = lv.bigBet;
  }

  // 次レベルのタイマー開始
  _startLevelTimer(t);

  // 全クライアントへブラインド更新通知
  _broadcastBlindUpdate(t);

  return true;
}

// ===== 脱落検出 =====
/**
 * ハンド終了後（showdown 後）に各テーブルで呼ぶ
 * チップが 0 以下のプレイヤーを脱落扱いにする
 */
function checkEliminations(tableId) {
  const tournamentId = roomToTournament.get(tableId);
  if (!tournamentId) return;
  const t = tournaments.get(tournamentId);
  if (!t || t.status !== 'running') return;

  const { getOrCreateRoom: getRoom } = require('../poker/gameManager');
  const room = getRoom(tableId);
  if (!room) return;

  const eliminated = room.players.filter(p => p.chips <= 0 && !p.folded);
  for (const p of eliminated) {
    _eliminatePlayer(t, tableId, p);
  }

  // 全体で1人になったらトーナメント終了
  const remaining = _countRemaining(t);
  if (remaining <= 1) {
    _finishTournament(t);
  }
}

function _eliminatePlayer(tournament, tableId, player) {
  const rank = tournament.totalPlayers - tournament.eliminationOrder.length;
  tournament.eliminationOrder.push(player.accountId ?? player.id);

  console.log(`[TM] ${tournament.id}: ${player.name} eliminated, rank=${rank}`);

  // テーブルから退場
  leaveRoom(tableId, player.id);

  // 脱落通知
  if (_io) {
    const sock = _io.sockets.sockets.get(player.id);
    if (sock) {
      sock.emit('t:eliminated', {
        rank,
        totalPlayers: tournament.totalPlayers,
      });
    }
  }
}

function _countRemaining(tournament) {
  let count = 0;
  for (const tableId of tournament.tableIds) {
    const room = getOrCreateRoom(tableId);
    if (room) count += room.players.length;
  }
  return count;
}

// ===== トーナメント終了 =====
function _finishTournament(tournament) {
  tournament.status = 'finished';
  if (tournament._levelTimer) clearTimeout(tournament._levelTimer);
  tournament._levelTimer = null;

  // 最終順位確定（残っているプレイヤーが1位）
  const rankings = [];
  for (const tableId of tournament.tableIds) {
    const room = getOrCreateRoom(tableId);
    if (room) {
      for (const p of room.players) {
        rankings.push({ accountId: p.accountId ?? p.id, nickname: p.name, rank: 1, chips: p.chips });
      }
    }
  }
  // 脱落順から下位を追加
  for (let i = tournament.eliminationOrder.length - 1; i >= 0; i--) {
    const rank = tournament.totalPlayers - i;
    rankings.push({ accountId: tournament.eliminationOrder[i], rank });
  }

  console.log(`[TM] ${tournament.id}: finished`);

  // 全テーブルに終了通知
  if (_io) {
    for (const tableId of tournament.tableIds) {
      _io.to(tableId).emit('t:tournamentFinished', { rankings });
    }
  }

  // テーブルをメモリから削除
  _cleanupTables(tournament);
}

function _cleanupTables(tournament) {
  const { rooms } = require('../poker/gameManager');
  for (const tableId of tournament.tableIds) {
    roomToTournament.delete(tableId);
    if (rooms) rooms.delete(tableId);
  }
  tournament.tableIds = [];
}

// ===== ステータス通知 =====
function _broadcastTournamentStatus(tournament) {
  if (!_io) return;
  const remaining = _countRemaining(tournament);
  const totalChips = tournament.totalPlayers * tournament.startingChips;
  const averageStack = remaining > 0 ? Math.floor(totalChips / remaining) : 0;

  const payload = {
    tournamentId:     tournament.id,
    totalPlayers:     tournament.totalPlayers,
    remainingPlayers: remaining,
    averageStack,
  };

  for (const tableId of tournament.tableIds) {
    _io.to(tableId).emit('t:tournamentStatus', payload);
  }
}

function _broadcastBlindUpdate(tournament) {
  if (!_io) return;
  const lv      = tournament.levels[tournament.currentLevelIdx];
  const nextLv  = tournament.levels[tournament.currentLevelIdx + 1] ?? null;
  const elapsed = Date.now() - tournament.levelStartedAt;
  const remaining = lv.durationMinutes > 0
    ? Math.max(0, Math.floor((lv.durationMinutes * 60 * 1000 - elapsed) / 1000))
    : 0;

  const payload = {
    level:              lv.level,
    sb:                 lv.sb,
    bb:                 lv.bb,
    smallBet:           lv.smallBet,
    bigBet:             lv.bigBet,
    secondsToNextLevel: lv.durationMinutes === 0 ? 0 : remaining,
    isLastLevel:        lv.durationMinutes === 0,
    nextSb:             nextLv?.sb   ?? null,
    nextBb:             nextLv?.bb   ?? null,
  };

  for (const tableId of tournament.tableIds) {
    _io.to(tableId).emit('t:blindUpdate', payload);
  }
}

/**
 * テーブルの gameState を全プレイヤー（および観戦者）へ配信する
 * BOT追加後・startTournament後など、index.js の _broadcast が呼べない場合に使う
 */
function broadcastTableState(tableId) {
  if (!_io) return;
  const { buildGameState, getOrCreateRoom: getRoom } = require('../poker/gameManager');
  const room = getRoom(tableId);
  if (!room) return;

  for (const player of [...room.players, ...room.pendingPlayers]) {
    const s = _io.sockets.sockets.get(player.id);
    if (!s) continue;
    const state   = buildGameState(room, player.id);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    s.emit('gameState', { players, meta });
  }
}

// ===== クエリ API =====
function isTournamentTable(tableId) {
  return roomToTournament.has(tableId);
}

function getTournamentByTable(tableId) {
  const id = roomToTournament.get(tableId);
  return id ? tournaments.get(id) : null;
}

function getTournament(tournamentId) {
  return tournaments.get(tournamentId) ?? null;
}

/**
 * accountId からそのプレイヤーが着席しているテーブルIDを返す
 * @returns {string|null}
 */
function getTableForPlayer(tournamentId, accountId) {
  const t = tournaments.get(tournamentId);
  if (!t) return null;
  const { getOrCreateRoom: getRoom } = require('../poker/gameManager');
  for (const tableId of t.tableIds) {
    const room = getRoom(tableId);
    if (!room) continue;
    // player.id は最初 accountId で登録され、joinRoom後にsocket.idに更新される
    // player.accountId は _createTable で opts.accountId を渡していないため null
    // → p.id（初期値=accountId）または p.accountId または p.name で検索
    const found = room.players.find(p =>
      p.id === accountId ||
      p.accountId === accountId ||
      p.name === accountId
    );
    if (found) return tableId;
  }
  return null;
}

/**
 * 現在のブラインド情報を取得（接続直後の初回配信用）
 */
function getCurrentBlindPayload(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (!t) return null;

  const lv     = t.levels[t.currentLevelIdx];
  const nextLv = t.levels[t.currentLevelIdx + 1] ?? null;
  const elapsed = Date.now() - t.levelStartedAt;
  const remaining = lv.durationMinutes > 0
    ? Math.max(0, Math.floor((lv.durationMinutes * 60 * 1000 - elapsed) / 1000))
    : 0;

  return {
    level:              lv.level,
    sb:                 lv.sb,
    bb:                 lv.bb,
    smallBet:           lv.smallBet,
    bigBet:             lv.bigBet,
    secondsToNextLevel: lv.durationMinutes === 0 ? 0 : remaining,
    isLastLevel:        lv.durationMinutes === 0,
    nextSb:             nextLv?.sb ?? null,
    nextBb:             nextLv?.bb ?? null,
  };
}

/**
 * 強制退場（タイムアウトキック・管理者キック）
 * index.js の _makeTimeoutHandler から呼ばれる
 */
function handleForcedLeave(tableId, playerId, reason) {
  const tournamentId = roomToTournament.get(tableId);
  if (!tournamentId) {
    leaveRoom(tableId, playerId);
    return;
  }
  const t = tournaments.get(tournamentId);
  if (!t) {
    leaveRoom(tableId, playerId);
    return;
  }

  const { getOrCreateRoom: getRoom } = require('../poker/gameManager');
  const room = getRoom(tableId);
  const player = room?.players.find(p => p.id === playerId);

  if (player) {
    console.log(`[TM] ${tournamentId}: forced leave ${player.name} (${reason})`);
    _eliminatePlayer(t, tableId, player);
    const remaining = _countRemaining(t);
    if (remaining <= 1) _finishTournament(t);
  } else {
    leaveRoom(tableId, playerId);
  }
}

module.exports = {
  init,
  startTournament,
  applyPendingLevelUp,
  checkEliminations,
  handleForcedLeave,
  isTournamentTable,
  getTournamentByTable,
  getTournament,
  getTableForPlayer,
  getCurrentBlindPayload,
  broadcastTableState,
  _broadcastTournamentStatus,
  _broadcastBlindUpdate,
};
