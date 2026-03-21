/**
 * botManager.js — サーバーサイドBOT管理
 *
 * BOTはソケット接続なしのバーチャルプレイヤー。
 * gameManager の drawCards / betAction を直接呼び出してアクションを行う。
 *
 * 戦略:
 *   2-7 lowball: 低カード(2-7)を保持、高カード/ペア/フラッシュを捨てる
 *   Badugi:      異なるスート低カードを保持、重複スート/高カードを捨てる
 *   Bet:         チェック/コール中心、稀にレイズ、ほぼフォールドしない
 */

const BOT_PREFIX = 'bot::';
let _botCounter  = 0;

const BOT_NAMES = [
  'Bot-Alpha', 'Bot-Beta', 'Bot-Gamma',
  'Bot-Delta', 'Bot-Epsilon', 'Bot-Zeta',
];

function createBotId() {
  return `${BOT_PREFIX}${Date.now()}-${_botCounter++}`;
}

function isBotId(id) {
  return typeof id === 'string' && id.startsWith(BOT_PREFIX);
}

// ===== カードパース =====
function parseCard(code) {
  // code例: '2s', 'Th', 'Kd', 'As'
  const rank = code.slice(0, -1);
  const suit = code.slice(-1);
  return { rank, suit };
}

// 2-7 lowball でのランク強さ（低いほど良い）
// 2=1(最良), 3=2, ..., 7=6, 8=7, 9=8, T=9, J=10, Q=11, K=12, A=13(最悪)
function rank27Value(rank) {
  const map = { '2':1,'3':2,'4':3,'5':4,'6':5,'7':6,'8':7,'9':8,'T':9,'J':10,'Q':11,'K':12,'A':13 };
  return map[rank] ?? 13;
}

// Badugi でのランク強さ（低いほど良い）
// A=1(最良), 2=2, ..., K=13(最悪)
function rankBadugiValue(rank) {
  const map = { 'A':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13 };
  return map[rank] ?? 13;
}

// ===== 2-7 ドロー戦略 =====
function decideDraw27(hand) {
  const cards = hand.map((code, i) => ({ i, ...parseCard(code), val: rank27Value(parseCard(code).rank) }));
  const toDiscard = new Set();

  // 1. 高いカード(8以上 or A)を捨てる
  for (const c of cards) {
    if (c.val >= 7) toDiscard.add(c.i); // 8,9,T,J,Q,K,A
  }

  // 2. 残りカードのペア/トリップス → 重複ランクは1枚だけ残す
  const goodCards = cards.filter(c => !toDiscard.has(c.i));
  const byRank = {};
  for (const c of goodCards) {
    if (!byRank[c.rank]) byRank[c.rank] = [];
    byRank[c.rank].push(c);
  }
  for (const group of Object.values(byRank)) {
    if (group.length > 1) {
      // ランクが同じなら後のものを全て捨てる
      for (let j = 1; j < group.length; j++) toDiscard.add(group[j].i);
    }
  }

  // 3. フラッシュ回避 → 残りカードで同スートが4枚以上あれば1枚捨てる
  const keepCards = cards.filter(c => !toDiscard.has(c.i));
  const bySuit = {};
  for (const c of keepCards) {
    if (!bySuit[c.suit]) bySuit[c.suit] = [];
    bySuit[c.suit].push(c);
  }
  for (const group of Object.values(bySuit)) {
    if (group.length >= 4) {
      // 最も価値の低い（valが高い）カードを捨てる
      const sorted = [...group].sort((a, b) => b.val - a.val);
      toDiscard.add(sorted[0].i);
    }
  }

  return [...toDiscard];
}

// ===== Badugi ドロー戦略 =====
function decideBadugiDraw(hand) {
  const cards = hand.map((code, i) => ({ i, ...parseCard(code), val: rankBadugiValue(parseCard(code).rank) }));

  // 各スートで最も低いランクのカードだけ残す → それ以外を捨てる
  const bestBySuit = {};
  for (const c of cards) {
    if (!bestBySuit[c.suit] || c.val < bestBySuit[c.suit].val) {
      bestBySuit[c.suit] = c;
    }
  }
  const keepSet = new Set(Object.values(bestBySuit).map(c => c.i));
  return cards.filter(c => !keepSet.has(c.i)).map(c => c.i);
}

// ===== ドロー決定 =====
function decideBotDraw(hand, mode) {
  const indices = mode === 'badugi' ? decideBadugiDraw(hand) : decideDraw27(hand);
  // 最大5枚(27)/4枚(badugi) = 全枚数交換でも問題ない
  return indices;
}

// ===== ベット決定 =====
function decideBotBetAction(room, botPlayer) {
  const toCall = Math.max(0, room.currentBet - botPlayer.bet);
  // chips=0のオールイン済みBOTはチェック/コールのみ（レイズ不可）
  const canRaise = room.raiseCount < 5 && botPlayer.chips > 0
    && room.players.some(op => op.id !== botPlayer.id && !op.folded && !op.sittingOut && op.chips > 0);
  const r = Math.random();

  // chips=0（オールイン済み）の場合はcheck/callのみ
  if (botPlayer.chips <= 0) {
    return toCall === 0 ? 'check' : 'call';
  }

  if (toCall === 0) {
    // チェックまたはベット可能
    if (canRaise && r < 0.20) return room.currentBet === 0 ? 'bet' : 'raise'; // 20%ベット/レイズ
    return 'check';  // 80%チェック
  } else {
    // コールまたはレイズ/フォールド
    if (r < 0.04) return 'fold';  // 4%フォールド
    if (canRaise && r < 0.15) return 'raise'; // 11%レイズ
    return 'call';   // 85%コール
  }
}

// ===== 使用済みBOT名を追跡 =====
const _usedNames = new Map(); // roomId → Set<name>

function getNextBotName(roomId, existingPlayers) {
  const used = new Set(existingPlayers.map(p => p.name));
  for (const name of BOT_NAMES) {
    if (!used.has(name)) return name;
  }
  // 全名前が使用中なら番号付き
  return `Bot-${_botCounter}`;
}

module.exports = { createBotId, isBotId, decideBotDraw, decideBotBetAction, getNextBotName, BOT_NAMES };
