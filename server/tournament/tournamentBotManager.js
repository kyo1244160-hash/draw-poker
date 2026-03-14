'use strict';
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

const { decideBotDraw, decideBotBetAction } = require('../poker/botManager');

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

  console.log(`[TBotM] spawn ${name} (${botId}) → ${tableId}`);
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
/**
 * テーブル内でターンが来ている BOT に自動アクションを取らせる
 * index.js の _broadcast 後 or showdown 後に呼ぶ
 * @param {string} tableId
 * @param {Function} onActionDone - (tableId) => void  broadcast を再トリガーするコールバック
 */
function triggerBotActions(tableId, onActionDone) {
  const room = getOrCreateRoom(tableId);
  if (!room || room.phase === 'waiting' || room.phase === 'showdown') return;

  const botIds = _tableBots.get(tableId);
  if (!botIds || botIds.size === 0) return;

  // 現在ターンのプレイヤーを確認
  const currentPlayer = room.players[room.actionIndex];
  if (!currentPlayer || !botIds.has(currentPlayer.id)) return;

  const botId = currentPlayer.id;

  // 遅延を入れてリアルっぽくする（300〜900ms）
  const delay = 300 + Math.random() * 600;
  setTimeout(() => {
    const room2 = getOrCreateRoom(tableId);
    if (!room2) return;
    const cur = room2.players[room2.actionIndex];
    if (!cur || cur.id !== botId) return; // もう他が動いた

    let acted = false;
    if (room2.phase.startsWith('draw')) {
      const indices = decideBotDraw(cur.hand, room2.currentMode);
      acted = !!drawCards(tableId, botId, indices);
    } else if (room2.phase.startsWith('bet')) {
      const action = decideBotBetAction(room2, cur);
      acted = !!betAction(tableId, botId, action);
    }

    if (acted && onActionDone) onActionDone(tableId);
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
    leaveRoom(tableId, botId);
    _bots.delete(botId);
    console.log(`[TBotM] remove bot ${botId} from ${tableId}`);
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
      leaveRoom(tableId, p.id);
      _bots.delete(p.id);
      botIds.delete(p.id);
      eliminated.push(p.id);
      console.log(`[TBotM] bot ${p.name} eliminated (chips=0)`);
    }
  }
  return eliminated;
}

module.exports = {
  spawnBot,
  fillBotsForTournament,
  triggerBotActions,
  removeBots,
  eliminateZeroChipBots,
  isTournamentBotId,
};
