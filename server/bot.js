/**
 * bot.js — テスト用ボットプレイヤー
 *
 * ─────────────────────────────────────────
 *  通常テーブル
 * ─────────────────────────────────────────
 *   node server/bot.js 27-room-1 3
 *   node server/bot.js badugi-room-1 5
 *
 * ─────────────────────────────────────────
 *  FastFold テーブル（zoom-*）
 * ─────────────────────────────────────────
 *   node server/bot.js zoom-27 6
 *   node server/bot.js zoom-badugi 6
 *   node server/bot.js zoom-mix 6
 *
 *   FastFold確率を指定する場合:
 *   FAST_FOLD_RATE=0.8 node server/bot.js zoom-27 6
 *     0.0 = FastFoldしない（通常ベットのみ）
 *     0.5 = 50%の確率でFastFold（デフォルト）
 *     1.0 = 必ずFastFold
 *
 * ─────────────────────────────────────────
 *  FastFold動作フロー
 * ─────────────────────────────────────────
 *   1. z:join でプール参加 → 待機列へ
 *   2. 6人集まると z:assigned でテーブルにアサイン
 *   3. ベットフェーズ中に確率で z:fastFold を送信
 *      → 待機列に戻り、また6人集まり次第テーブルへ
 *   4. showdown後も自動で待機列へ戻る
 */

const { io } = require('socket.io-client');

const ROOM_ID   = process.argv[2] || '27-room-1';
const BOT_COUNT = Math.min(parseInt(process.argv[3]) || 2, 6);
const SERVER    = process.env.BOT_SERVER || 'http://localhost:3000';

const IS_ZOOM        = ROOM_ID.startsWith('zoom-');
const FAST_FOLD_RATE = parseFloat(process.env.FAST_FOLD_RATE ?? '0.0');

const BOT_NAMES = ['Bot-Alpha', 'Bot-Beta', 'Bot-Gamma', 'Bot-Delta', 'Bot-Epsilon', 'Bot-Zeta'];

const C = {
  reset:'\x1b[0m', dim:'\x1b[2m', green:'\x1b[32m',
  yellow:'\x1b[33m', cyan:'\x1b[36m', red:'\x1b[31m',
  bold:'\x1b[1m', magenta:'\x1b[35m',
};

// ========== カード評価ヘルパー ==========

function cardRank(card) {
  const r = card[0];
  if (r === 'A') return 14; if (r === 'K') return 13;
  if (r === 'Q') return 12; if (r === 'J') return 11;
  if (r === 'T') return 10;
  return parseInt(r);
}
function cardSuit(card) { return card[card.length - 1]; }

function get27DiscardIndices(hand) {
  const cnt = {};
  hand.forEach(c => { const r = cardRank(c); cnt[r] = (cnt[r]||0)+1; });
  const out = [];
  hand.forEach((card, i) => {
    const r = cardRank(card);
    if (r === 14 || r >= 8) { out.push(i); return; }
    if (cnt[r] > 1) { cnt[r]--; out.push(i); }
  });
  return out;
}

function getBadugiDiscardIndices(hand) {
  const usedS = new Set(), usedR = new Set();
  const keep = new Array(hand.length).fill(false);
  [...hand.map((c,i)=>({i,r:cardRank(c),s:cardSuit(c)}))].sort((a,b)=>a.r-b.r)
    .forEach(({i,r,s}) => {
      if (!usedS.has(s) && !usedR.has(r)) { keep[i]=true; usedS.add(s); usedR.add(r); }
    });
  return hand.map((_,i)=>i).filter(i=>!keep[i]);
}

// ========== Bot クラス ==========

class Bot {
  constructor(name) {
    this.name          = name;
    this.socket        = null;
    this.hand          = [];
    this.mode          = '27';
    this.poolId        = IS_ZOOM ? ROOM_ID : null;
    this.currentTable  = null;
    this.hasFastFolded = false;
    this._pendingJoin  = false;
  }

  log(msg, color='') {
    const t = new Date().toLocaleTimeString('ja-JP',{hour12:false});
    console.log(`${C.dim}[${t}]${C.reset} ${color}[${this.name}]${C.reset} ${msg}`);
  }

  connect() {
    this.socket = io(SERVER, { path:'/socket.io', transports:['websocket'] });
    const s = this.socket;

    s.on('connect', () => {
      this.log('接続', C.green);
      if (IS_ZOOM) {
        this._joinPool();
      } else {
        s.emit('joinRoom', { roomId: ROOM_ID, name: this.name, password: '' });
      }
    });

    s.on('z:assigned', ({ roomId }) => {
      this.currentTable  = roomId;
      this.hasFastFolded = false;
      this.log(`${C.bold}🎮 テーブルアサイン${C.reset} → ${roomId}`, C.cyan);
    });

    s.on('z:waiting', ({ waitingCount, totalCount }) => {
      this.log(`⏳ 待機列 (待機:${waitingCount} / 計:${totalCount})`, C.dim);
      this._pendingJoin  = false;
      this.currentTable  = null;  // テーブルから戻った（showdown後またはFastFold後）
      this.hasFastFolded = false;
    });

    // ── 共通 ──────────────────────────────────
    s.on('joinError', ({ message }) => {
      this.log(`入室失敗: ${message}`, C.red);
    });

    s.on('gameStarted', () => {
      this.hasFastFolded = false;
      this.log('ゲーム開始', C.green);
    });

    s.on('gameState', ({ players, meta }) => {
      const me = players.find(p => p.isSelf);
      if (me?.hand) this.hand = me.hand.filter(c => c !== '??');
      if (meta?.currentMode) this.mode = meta.currentMode;
      if (!me || me.folded) return;

      const phase = meta?.phase ?? '';

      if (phase.startsWith('draw') && me.isMyTurn) {
        this._doDraw();
      } else if (phase.startsWith('bet') && me.isMyTurn) {
        if (IS_ZOOM && !this.hasFastFolded && Math.random() < FAST_FOLD_RATE) {
          this._doFastFold();
        } else {
          this._doBet(me, meta);
        }
      }
    });

    s.on('showdown', () => {
      this.log('ショーダウン', C.dim);
      // FastFoldテーブル: FastFoldしなかった場合は同じテーブルで次のゲームが即座に始まるため
      // currentTable はリセットしない。FastFold済みの場合はすでにz:waitingで待機列に戻っている。
      this.hasFastFolded = false;
    });

    s.on('kicked', ({ reason } = {}) => {
      this.log(`kicked (${reason ?? 'unknown'}) → 3秒後に再接続`, C.yellow);
      this.currentTable  = null;
      this.hasFastFolded = false;
      setTimeout(() => this.connect(), 3000);
    });

    s.on('disconnect', () => {
      this.log('切断', C.dim);
    });
  }

  _joinPool() {
    if (this._pendingJoin) return;
    this._pendingJoin = true;
    this.log(`プール参加: ${this.poolId}`, C.cyan);
    this.socket.emit('z:join', { poolId: this.poolId, name: this.name });
  }

  _doDraw() {
    setTimeout(() => {
      const roomId = IS_ZOOM ? this.currentTable : ROOM_ID;
      if (!roomId) return;
      const indices = this.mode === 'badugi'
        ? getBadugiDiscardIndices(this.hand)
        : get27DiscardIndices(this.hand);
      this.log(`🃏 draw ${indices.length}枚 [${this.hand.join(' ')}]`, C.dim);
      this.socket.emit('drawCards', { roomId, indices });
    }, 500 + Math.random() * 1000);
  }

  _doBet(me, meta) {
    setTimeout(() => {
      const roomId = IS_ZOOM ? this.currentTable : ROOM_ID;
      if (!roomId) return;
      const toCall   = me.toCall   ?? 0;
      const canRaise = me.canRaise ?? false;
      const canCheck = me.canCheck ?? false;
      const rand     = Math.random();
      let action;
      if (canCheck) {
        action = rand < 0.8 ? 'check' : (canRaise ? 'bet' : 'check');
      } else if (toCall > 0) {
        if      (rand < 0.10)              action = 'fold';
        else if (rand < 0.80 || !canRaise) action = 'call';
        else                               action = 'raise';
      } else {
        action = 'check';
      }
      this.log(`${action} (toCall:${toCall})`, C.dim);
      this.socket.emit('betAction', { roomId, action });
    }, 400 + Math.random() * 1200);
  }

  _doFastFold() {
    setTimeout(() => {
      if (!this.poolId) return;
      this.hasFastFolded = true;
      this.log(`${C.bold}⚡ FastFold!${C.reset} → 待機列へ戻る`, C.magenta);
      this.socket.emit('z:fastFold', { poolId: this.poolId });
      // currentTable はリセットしない
      // folded状態で元テーブルに残り続けるため、showdown後に z:waiting が来てリセットされる
    }, 200 + Math.random() * 600);
  }
}

// ========== 起動 ==========

if (IS_ZOOM) {
  console.log(`${C.bold}${C.cyan}⚡ FastFoldボット ${BOT_COUNT}体 → ${ROOM_ID}${C.reset}  (${SERVER})`);
  console.log(`   FastFold確率: ${(FAST_FOLD_RATE*100).toFixed(0)}%  (変更: FAST_FOLD_RATE=0.0〜1.0)`);
  if (BOT_COUNT < 6) {
    console.log(`   ${C.yellow}⚠️  6人必要です。あと${6-BOT_COUNT}人が人間プレイヤーかボットで参加すると開始します${C.reset}`);
  } else {
    console.log(`   ✅ 6体いるので自動的にテーブルが開始します`);
  }
} else {
  console.log(`${C.bold}🤖 通常ボット ${BOT_COUNT}体 → ${ROOM_ID}${C.reset}  (${SERVER})`);
}
console.log('');

const bots = [];
for (let i = 0; i < BOT_COUNT; i++) {
  const bot = new Bot(BOT_NAMES[i]);
  setTimeout(() => bot.connect(), i * 700);
  bots.push(bot);
}

process.on('SIGINT', () => {
  console.log(`\n${C.yellow}🛑 ボット終了中...${C.reset}`);
  bots.forEach(b => b.socket?.disconnect());
  setTimeout(() => process.exit(0), 500);
});
