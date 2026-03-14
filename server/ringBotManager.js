'use strict';
/**
 * ringBotManager.js — リングゲーム用ボット管理（管理画面から制御）
 *
 * 管理画面から部屋・台数を指定してボットを追加・削除できる。
 * bot.js の BotPlayer ロジックを流用する。
 */

const { io } = require('socket.io-client');
const { decideBotDraw, decideBotBetAction } = require('./poker/botManager');

const SERVER     = process.env.BOT_SERVER || 'http://localhost:3000';
const BOT_SECRET = process.env.BOT_SECRET ?? 'pastis-internal-bot';

const BOT_NAMES = [
  'Bot-Alpha', 'Bot-Beta', 'Bot-Gamma', 'Bot-Delta', 'Bot-Epsilon', 'Bot-Zeta',
  'Bot-Eta', 'Bot-Theta', 'Bot-Iota', 'Bot-Kappa', 'Bot-Lambda', 'Bot-Mu',
];

// roomId → Bot[] のMap
const _rooms = new Map();
// botId(連番) → Bot
const _bots  = new Map();
let _seq = 0;

class RingBot {
  constructor(roomId, name) {
    this.id       = ++_seq;
    this.roomId   = roomId;
    this.name     = name;
    this.socket   = null;
    this.hand     = [];
    this.mode     = '27';
    this.stopped  = false;
  }

  start() {
    if (this.stopped) return;
    this.socket = io(SERVER, {
      path:       '/socket.io',
      transports: ['websocket'],
      auth:       { token: `bot:${BOT_SECRET}`, botName: this.name },
    });
    const s = this.socket;

    s.on('connect', () => {
      console.log(`[ringBot] ${this.name} 接続 → ${this.roomId}`);
      s.emit('joinRoom', { roomId: this.roomId, name: this.name, password: '' });
    });

    s.on('joinError', ({ message }) => {
      console.warn(`[ringBot] ${this.name} 入室失敗: ${message}`);
    });

    s.on('gameState', ({ players, meta }) => {
      const me = players.find(p => p.isSelf);
      if (me?.hand) this.hand = me.hand.filter(c => c !== '??');
      if (meta?.currentMode) this.mode = meta.currentMode;
      if (!me || me.folded || !me.isMyTurn) return;

      const phase = meta?.phase ?? '';

      if (phase.startsWith('draw')) {
        setTimeout(() => {
          const indices = decideBotDraw(this.hand, this.mode);
          s.emit('drawCards', { roomId: this.roomId, indices });
        }, 500 + Math.random() * 1000);
      } else if (phase.startsWith('bet')) {
        setTimeout(() => {
          // meta を room 相当、me を botPlayer 相当として渡す
          const fakeRoom = {
            currentBet: meta?.currentBet ?? 0,
            raiseCount: meta?.raiseCount ?? 0,
          };
          const fakePlayer = {
            bet: me.bet ?? 0,
          };
          const action = decideBotBetAction(fakeRoom, fakePlayer);
          s.emit('betAction', { roomId: this.roomId, action });
        }, 400 + Math.random() * 1200);
      }
    });

    s.on('kicked', () => {
      if (!this.stopped) {
        console.log(`[ringBot] ${this.name} kicked → 3秒後に再接続`);
        setTimeout(() => this.start(), 3000);
      }
    });

    s.on('disconnect', () => {
      console.log(`[ringBot] ${this.name} 切断`);
    });
  }

  stop() {
    this.stopped = true;
    try { this.socket?.disconnect(); } catch(_) {}
  }

  toJSON() {
    return {
      id:       this.id,
      roomId:   this.roomId,
      name:     this.name,
      connected: this.socket?.connected ?? false,
    };
  }
}

/** 指定部屋にボットを追加 */
function addBots(roomId, count) {
  if (!_rooms.has(roomId)) _rooms.set(roomId, []);
  const existing = _rooms.get(roomId);
  const usedNames = new Set(existing.map(b => b.name));

  const added = [];
  for (let i = 0; i < count; i++) {
    const name = BOT_NAMES.find(n => !usedNames.has(n)) ?? `Bot-${_seq + 1}`;
    usedNames.add(name);
    const bot = new RingBot(roomId, name);
    existing.push(bot);
    _bots.set(bot.id, bot);
    setTimeout(() => bot.start(), i * 700);
    added.push(bot.toJSON());
  }
  return added;
}

/** ボットIDで個別削除 */
function removeBot(botId) {
  const bot = _bots.get(botId);
  if (!bot) return false;
  bot.stop();
  _bots.delete(botId);
  const room = _rooms.get(bot.roomId);
  if (room) {
    const idx = room.findIndex(b => b.id === botId);
    if (idx !== -1) room.splice(idx, 1);
    if (room.length === 0) _rooms.delete(bot.roomId);
  }
  return true;
}

/** 部屋のボットを全削除 */
function removeAllBots(roomId) {
  const room = _rooms.get(roomId);
  if (!room) return 0;
  const count = room.length;
  room.forEach(b => { b.stop(); _bots.delete(b.id); });
  _rooms.delete(roomId);
  return count;
}

/** 全ボット一覧 */
function listBots() {
  return [..._bots.values()].map(b => b.toJSON());
}

/** ボット名を変更する */
function renameBot(botId, newName) {
  const bot = _bots.get(botId);
  if (!bot) return false;
  const oldName = bot.name;
  bot.name = newName;
  // gameManager のルーム内プレイヤー名も更新（socket.id で検索）
  if (bot.socket?.id) {
    const { renamePlayer } = require('./poker/gameManager');
    renamePlayer(bot.roomId, bot.socket.id, newName);
  }
  console.log(`[ringBot] rename #${botId}: ${oldName} → ${newName}`);
  return true;
}


// ==========================================================
// ■ FastFold（Zoom）ボット管理
// ==========================================================

const FAST_FOLD_RATE = 0.5; // 50%の確率でFastFold

// poolId → FastFoldBot[]
const _ffRooms = new Map();
// botId → FastFoldBot
const _ffBots  = new Map();

class FastFoldBot {
  constructor(poolId, name) {
    this.id            = ++_seq;
    this.poolId        = poolId;
    this.name          = name;
    this.socket        = null;
    this.hand          = [];
    this.mode          = '27';
    this.currentTable  = null;
    this.hasFastFolded = false;
    this._pendingJoin  = false;
    this.stopped       = false;
  }

  start() {
    if (this.stopped) return;
    this.socket = io(SERVER, {
      path:       '/socket.io',
      transports: ['websocket'],
      auth:       { token: `bot:${BOT_SECRET}`, botName: this.name },
    });
    const s = this.socket;

    s.on('connect', () => {
      console.log(`[ffBot] ${this.name} 接続 → pool:${this.poolId}`);
      this._joinPool();
    });

    s.on('z:assigned', ({ roomId }) => {
      this.currentTable  = roomId;
      this.hasFastFolded = false;
      this._pendingJoin  = false;
    });

    s.on('z:waiting', () => {
      this.currentTable  = null;
      this.hasFastFolded = false;
      this._pendingJoin  = false;
    });

    s.on('joinError', ({ message }) => {
      console.warn(`[ffBot] ${this.name} 入室失敗: ${message}`);
    });

    s.on('gameState', ({ players, meta }) => {
      const me = players.find(p => p.isSelf);
      if (me?.hand) this.hand = me.hand.filter(c => c !== '??');
      if (meta?.currentMode) this.mode = meta.currentMode;
      if (!me || me.folded || !me.isMyTurn) return;

      const phase = meta?.phase ?? '';

      if (phase.startsWith('draw')) {
        setTimeout(() => {
          if (!this.currentTable) return;
          const indices = decideBotDraw(this.hand, this.mode);
          s.emit('drawCards', { roomId: this.currentTable, indices });
        }, 500 + Math.random() * 1000);
      } else if (phase.startsWith('bet')) {
        setTimeout(() => {
          if (!this.currentTable) return;
          // FastFold判定
          if (!this.hasFastFolded && Math.random() < FAST_FOLD_RATE) {
            this.hasFastFolded = true;
            s.emit('z:fastFold', { poolId: this.poolId });
          } else {
            const fakeRoom   = { currentBet: meta?.currentBet ?? 0, raiseCount: meta?.raiseCount ?? 0 };
            const fakePlayer = { bet: me.bet ?? 0 };
            const action = decideBotBetAction(fakeRoom, fakePlayer);
            s.emit('betAction', { roomId: this.currentTable, action });
          }
        }, 400 + Math.random() * 1200);
      }
    });

    s.on('kicked', () => {
      if (!this.stopped) {
        console.log(`[ffBot] ${this.name} kicked → 3秒後に再接続`);
        setTimeout(() => this.start(), 3000);
      }
    });

    s.on('disconnect', () => {
      console.log(`[ffBot] ${this.name} 切断`);
    });
  }

  _joinPool() {
    if (this._pendingJoin) return;
    this._pendingJoin = true;
    this.socket.emit('z:join', { poolId: this.poolId, name: this.name });
  }

  stop() {
    this.stopped = true;
    try { this.socket?.disconnect(); } catch (_) {}
  }

  toJSON() {
    return { id: this.id, roomId: this.poolId, name: this.name, connected: this.socket?.connected ?? false, isFastFold: true };
  }
}

function addFastFoldBots(poolId, count) {
  if (!_ffRooms.has(poolId)) _ffRooms.set(poolId, []);
  const existing = _ffRooms.get(poolId);
  const usedNames = new Set(existing.map(b => b.name));

  const added = [];
  for (let i = 0; i < count; i++) {
    const name = BOT_NAMES.find(n => !usedNames.has(n)) ?? `FFBot-${_seq + 1}`;
    usedNames.add(name);
    const bot = new FastFoldBot(poolId, name);
    existing.push(bot);
    _ffBots.set(bot.id, bot);
    setTimeout(() => bot.start(), i * 700);
    added.push(bot.toJSON());
  }
  return added;
}

function removeFastFoldBots(poolId) {
  const room = _ffRooms.get(poolId);
  if (!room) return 0;
  const count = room.length;
  room.forEach(b => { b.stop(); _ffBots.delete(b.id); });
  _ffRooms.delete(poolId);
  return count;
}

function listFastFoldBots() {
  return [..._ffBots.values()].map(b => b.toJSON());
}

module.exports = { addBots, removeBot, removeAllBots, listBots, renameBot, addFastFoldBots, removeFastFoldBots, listFastFoldBots };
