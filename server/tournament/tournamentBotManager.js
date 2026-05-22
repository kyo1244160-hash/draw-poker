'use strict';
const { log, logDev } = require('../logger');
/**
 * tournamentBotManager.js
 * トーナメント専用サーバーサイドBOT管理
 *
 * ソケット接続なしのバーチャルプレイヤー。
 * gameManager の drawCards / betAction を直接呼び出す。
 * botManager.js の AI ロジックを再利用。
 *
 * 使い方:
 *   const tbm = require('./tournament/tournamentBotManager');
 *   tbm.spawnBotsForTournament(tournament, count);
 *   // ハンド終了後（showdown後）に呼ぶ
 *   tbm.triggerBotActions(tableId);
 */

const {
  getOrCreateRoom,
  drawCards,
  betAction,
  buildGameState,
} = require('../poker/gameManager');

const { decideBotDraw, decideBotDrawWithRoom, decideBotBetAction, decideBotBetAmount } = require('../poker/botManager');

// ===== BOT ID 管理 =====
const BOT_PREFIX = 'tbot::';
let _seq = 0;

function _makeBotId(name) {
  return `${BOT_PREFIX}${name}-${++_seq}`;
}

function isTournamentBotId(id) {
  return typeof id === 'string' && id.startsWith(BOT_PREFIX);
}

// ===== BOT 名プール =====
const BOT_NAME_POOL = [
  'Dealer-Dan', 'Poker-Pete', 'Lucky-Lou', 'Bluff-Bill',
  'Ace-Anna',   'Check-Chris', 'Raise-Ray', 'Call-Carl',
  'Fold-Frank', 'Bet-Betty',
];

function _pickBotName(existingNames) {
  const used = new Set(existingNames);
  for (const name of BOT_NAME_POOL) {
    if (!used.has(name)) return name;
  }
  return `TBot-${_seq}`;
}

// ===== 内部状態 =====
// botId → { tableId, name, hand }
const _bots = new Map();

// tableId → Set<botId>
const _tableBots = new Map();

// ===== BOT スポーン =====
/**
 * テーブルに BOT を追加する
 * @param {string} tableId  - gameManager のルームID
 * @param {string} name     - BOT 名
 * @param {number} chips    - 初期チップ（トーナメントの startingChips）
 * @returns {string} botId
 */
function spawnBot(tableId, name, chips) {
  const { joinRoom } = require('../poker/gameManager');
  const botId = _makeBotId(name);

  joinRoom(tableId, botId, name, { existingChips: chips, accountId: botId });

  _bots.set(botId, { tableId, name });
  if (!_tableBots.has(tableId)) _tableBots.set(tableId, new Set());
  _tableBots.get(tableId).add(botId);

  logDev(`[TBotM] spawn ${name} (${botId}) → ${tableId}`);
  return botId;
}

/**
 * トーナメント開始時に不足人数分 BOT を投入する
 * @param {object} tournament - tournamentManager の tournament オブジェクト
 * @param {number} totalNeeded - トーナメント全体に必要な最低人数
 * @param {number} botsPerTable - テーブルあたりの BOT 数（省略時: 各テーブル 2 人不足分を補完）
 */
function fillBotsForTournament(tournament, botsPerTable = 2) {
  for (const tableId of tournament.tableIds) {
    const room = getOrCreateRoom(tableId);
    if (!room) continue;

    const existingNames = room.players.map(p => p.name);
    const need = Math.max(0, botsPerTable - room.players.filter(p => isTournamentBotId(p.id)).length);

    for (let i = 0; i < need; i++) {
      const name = _pickBotName([...existingNames, ..._bots.values()].map(b => b?.name ?? ''));
      existingNames.push(name);
      spawnBot(tableId, name, tournament.startingChips);
    }
  }
}

// ===== BOT アクション =====
// 二重スケジュール防止マップ: 'tableId::botId' → true
// リングBOTはsocketキューで自然に直列化されるが、
// トーナメントBOTは直接呼び出しのため明示的に管理する
const _pendingBotAction = new Map();

/**
 * テーブル内でターンが来ている BOT に自動アクションを取らせる
 * index.js の _broadcast 後 or showdown 後に呼ぶ
 * @param {string} tableId
 * @param {Function} onActionDone - (tableId, botName, botAction) => void
 */
function triggerBotActions(tableId, onActionDone) {
  const room = getOrCreateRoom(tableId);
  if (!room || room.phase === 'waiting' || room.phase === 'showdown') return;

  const botIds = _tableBots.get(tableId);
  if (!botIds || botIds.size === 0) {
    logDev(`[TBotM] ${tableId.slice(-8)} phase=${room.phase} botIds=empty → skip`);
    return;
  }

  // 現在ターンのプレイヤーを確認（リングBOTの me.isMyTurn チェックに相当）
  const currentPlayer = room.players[room.actionIndex];
  if (!currentPlayer || !botIds.has(currentPlayer.id)) {
    const curName = currentPlayer?.name ?? 'none';
    logDev(`[TBotM] ${tableId.slice(-8)} phase=${room.phase} turn=${curName} (not BOT) → skip`);
    log(`[bot-chain] END table=${tableId.slice(-8)} phase=${room.phase} → human turn=${curName}`);
    return;
  }

  const botId = currentPlayer.id;
  const pendingKey = `${tableId}::${botId}`;

  // 同じBOTのアクションが既にスケジュール済みならスキップ
  if (_pendingBotAction.has(pendingKey)) {
    logDev(`[TBotM] ${tableId.slice(-8)} ${currentPlayer.name} pending → skip duplicate`);
    return;
  }
  _pendingBotAction.set(pendingKey, true);
  logDev(`[TBotM] ${tableId.slice(-8)} phase=${room.phase} → schedule ${currentPlayer.name}`);

  // リングBOT同等の遅延（500〜1500ms）
  const delay = 500 + Math.random() * 1000;
  setTimeout(async () => {
    _pendingBotAction.delete(pendingKey);

    const room2 = getOrCreateRoom(tableId);
    if (!room2) { logDev(`[TBotM] ${tableId.slice(-8)} room gone`); return; }

    // タイマー発火時にフェーズが進行中でない場合はスキップ
    // （showdown / waiting に変わっていたら次のハンドで再トリガーされる）
    if (room2.phase === 'waiting' || room2.phase === 'showdown') {
      logDev(`[TBotM] ${tableId.slice(-8)} phase=${room2.phase} → skip (not actionable)`);
      return;
    }

    const cur = room2.players[room2.actionIndex];
    // ターンが変わっていたらスキップ
    if (!cur || cur.id !== botId) {
      logDev(`[TBotM] ${tableId.slice(-8)} turn changed → skip`);
      return;
    }

    let acted = false;
    let doneAction = null;
    if (room2.phase.startsWith('draw')) {
      // モデル推論（room あり版）
      const indices = await decideBotDrawWithRoom(room2, cur, room2.currentMode);
      acted = !!drawCards(tableId, botId, indices);
      log(`[BOT-DEBUG] ${cur.name}(${room2.currentMode}) DRAW hand=[${(cur.hand||[]).join(',')}] discard=[${indices.join(',')}] phase=${room2.phase}`);
      logDev(`[TBotM] ${tableId.slice(-8)} ${cur.name} draw ${indices.length}枚 acted=${acted}`);
    } else if (room2.phase.startsWith('bet')) {
      // モデル推論（async）
      const action = await decideBotBetAction(room2, cur);
      // NLモードならベット/レイズ額を決定
      const amount = decideBotBetAmount(room2, cur, action);
      acted = !!betAction(tableId, botId, action, amount);
      if (acted) doneAction = action;
      log(`[BOT-DEBUG] ${cur.name}(${room2.currentMode}) BET action=${action}${amount?' amt='+amount:''} hand=[${(cur.hand||[]).join(',')}] chips=${cur.chips} pot=${room2.pot} currentBet=${room2.currentBet} phase=${room2.phase}`);
      logDev(`[TBotM] ${tableId.slice(-8)} ${cur.name} ${action} acted=${acted} chips=${cur.chips}`);
    }

    if (acted && onActionDone) onActionDone(tableId, cur.name, doneAction);
  }, delay);
}

// ===== BOT 退場 =====
/**
 * テーブルの全 BOT を除去する（テーブル解体時）
 */
function removeBots(tableId) {
  const { leaveRoom } = require('../poker/gameManager');
  const botIds = _tableBots.get(tableId);
  if (!botIds) return;
  for (const botId of botIds) {
    leaveRoom(botId); // 第1引数が socketId（tableId は不要）
    _bots.delete(botId);
    logDev(`[TBotM] remove bot ${botId} from ${tableId}`);
  }
  _tableBots.delete(tableId);
}

/**
 * チップが 0 以下になった BOT を脱落させる（checkEliminations 相当）
 * @returns {string[]} 脱落した botId 一覧
 */
function eliminateZeroChipBots(tableId) {
  const room = getOrCreateRoom(tableId);
  if (!room) return [];
  const botIds = _tableBots.get(tableId) ?? new Set();
  const eliminated = [];
  const { leaveRoom } = require('../poker/gameManager');

  for (const p of room.players) {
    if (botIds.has(p.id) && p.chips <= 0) {
      leaveRoom(p.id); // 第1引数が socketId（tableId は不要）
      _bots.delete(p.id);
      botIds.delete(p.id);
      eliminated.push(p.id);
      logDev(`[TBotM] bot ${p.name} eliminated (chips=0)`);
    }
  }
  return eliminated;
}

/**
 * BOT を別テーブルへ移動する（balanceTables から呼ばれる）
 * _bots / _tableBots マップを更新して triggerBotActions が正しく動くようにする
 * @param {string} botId    - BOT の ID（tbot:: プレフィックス付き）
 * @param {string} fromTableId
 * @param {string} toTableId
 */
function moveBot(botId, fromTableId, toTableId) {
  // _bots マップのtableIdを更新
  const info = _bots.get(botId);
  if (info) {
    _bots.set(botId, { ...info, tableId: toTableId });
  }

  // 移動元の _tableBots から削除
  const fromSet = _tableBots.get(fromTableId);
  if (fromSet) {
    fromSet.delete(botId);
    if (fromSet.size === 0) _tableBots.delete(fromTableId);
  }

  // 移動先の _tableBots に追加
  if (!_tableBots.has(toTableId)) _tableBots.set(toTableId, new Set());
  _tableBots.get(toTableId).add(botId);

  logDev(`[TBotM] moveBot ${botId} ${fromTableId.slice(-8)} → ${toTableId.slice(-8)}`);
}

/** テーブルのBOT IDセットを返す */
function getBotIds(tableId) {
  return _tableBots.get(tableId) ?? new Set();
}

module.exports = {
  spawnBot,
  fillBotsForTournament,
  triggerBotActions,
  removeBots,
  eliminateZeroChipBots,
  isTournamentBotId,
  moveBot,
  getBotIds,
};
