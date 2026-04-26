'use strict';
/**
 * botManager.js — サーバーサイドBOT管理
 *
 * 【優先順位】
 *   1. ONNX モデル推論（botModel.js + botInfoState.js）
 *   2. ルールベースフォールバック（モデルが使えない場合）
 */

const { logDev } = require('../logger');
const { buildInfoState } = require('./botInfoState');
const { predictBetAction, predictDraw } = require('./botModel');

const BOT_PREFIX = 'bot::';
let _botCounter  = 0;

const BOT_NAMES = [
  'Bot-Alpha', 'Bot-Beta', 'Bot-Gamma',
  'Bot-Delta', 'Bot-Epsilon', 'Bot-Zeta',
];

function createBotId() { return `${BOT_PREFIX}${Date.now()}-${_botCounter++}`; }
function isBotId(id)   { return typeof id === 'string' && id.startsWith(BOT_PREFIX); }

// ===== カードパース（ルールベース用） =====
function parseCard(code) {
  return { rank: code.slice(0, -1), suit: code.slice(-1) };
}
function rank27Value(rank) {
  return { '2':1,'3':2,'4':3,'5':4,'6':5,'7':6,'8':7,'9':8,'T':9,'J':10,'Q':11,'K':12,'A':13 }[rank] ?? 13;
}
function rankBadugiValue(rank) {
  return { 'A':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13 }[rank] ?? 13;
}

// ===== ルールベース ドロー =====
function decideDraw27Fallback(hand) {
  const cards = hand.map((code, i) => ({ i, ...parseCard(code), val: rank27Value(parseCard(code).rank) }));
  const toDiscard = new Set();
  for (const c of cards) { if (c.val >= 7) toDiscard.add(c.i); }
  const goodCards = cards.filter(c => !toDiscard.has(c.i));
  const byRank = {};
  for (const c of goodCards) { if (!byRank[c.rank]) byRank[c.rank] = []; byRank[c.rank].push(c); }
  for (const group of Object.values(byRank)) {
    if (group.length > 1) for (let j = 1; j < group.length; j++) toDiscard.add(group[j].i);
  }
  const keepCards = cards.filter(c => !toDiscard.has(c.i));
  const bySuit = {};
  for (const c of keepCards) { if (!bySuit[c.suit]) bySuit[c.suit] = []; bySuit[c.suit].push(c); }
  for (const group of Object.values(bySuit)) {
    if (group.length >= 4) { const s = [...group].sort((a,b) => b.val-a.val); toDiscard.add(s[0].i); }
  }
  return [...toDiscard];
}
function decideBadugiDrawFallback(hand) {
  const cards = hand.map((code, i) => ({ i, ...parseCard(code), val: rankBadugiValue(parseCard(code).rank) }));
  // ① スートごとに最低ランクのカードを選ぶ
  const best = {};
  for (const c of cards) { if (!best[c.suit] || c.val < best[c.suit].val) best[c.suit] = c; }
  let keepSet = new Set(Object.values(best).map(c => c.i));
  // ② 選択後に同ランク重複があれば、ランクの高い方（val大）を捨てる
  const keepArr = [...keepSet].map(i => cards[i]);
  const rankSeen = {};
  for (const c of keepArr.sort((a,b) => a.val - b.val)) {
    if (rankSeen[c.val]) { keepSet.delete(c.i); }
    else { rankSeen[c.val] = true; }
  }
  return cards.filter(c => !keepSet.has(c.i)).map(c => c.i);
}

// ===== ルールベース ベット =====
function decideBotBetActionFallback(room, botPlayer) {
  const toCall   = Math.max(0, (room.currentBet || 0) - (botPlayer.bet || 0));
  const canRaise = (room.raiseCount || 0) < 5 && botPlayer.chips > 0
    && room.players.some(op => op.id !== botPlayer.id && !op.folded && !op.sittingOut && op.chips > 0);
  const { randomInt } = require('crypto');
  const r = randomInt(0, 100) / 100;
  if (botPlayer.chips <= 0) return toCall === 0 ? 'check' : 'call';
  if (toCall === 0) {
    if (canRaise && r < 0.20) return room.currentBet === 0 ? 'bet' : 'raise';
    return 'check';
  }
  if (r < 0.04) return 'fold';
  if (canRaise && r < 0.15) return 'raise';
  return 'call';
}

// ===== 合法アクション =====
function getLegalActions(room, player) {
  const toCall   = Math.max(0, (room.currentBet || 0) - (player.bet || 0));
  const canRaise = (room.raiseCount || 0) < 5 && player.chips > 0
    && room.players.some(op => op.id !== player.id && !op.folded && !op.sittingOut && op.chips > 0);
  const actions = [];
  if (toCall === 0) { actions.push('check'); if (canRaise) actions.push('bet'); }
  else { if (player.chips > 0) actions.push('fold'); actions.push('call'); if (canRaise) actions.push('raise'); }
  return actions;
}

function normalizeMode(mode) { return mode === 'badugi' ? 'badugi' : '27'; }

// ============================================================
// 公開インターフェース
// ============================================================

/** ドロー判断（room なし版 → ルールベース） */
async function decideBotDraw(hand, mode) {
  const nm = normalizeMode(mode);
  return nm === 'badugi' ? decideBadugiDrawFallback(hand) : decideDraw27Fallback(hand);
}

/** ドロー判断（room あり版 → モデル優先） */
async function decideBotDrawWithRoom(room, botPlayer, mode) {
  const nm   = normalizeMode(mode);
  const hand = botPlayer.hand || [];
  try {
    const infoState = buildInfoState(room, botPlayer, nm);
    const indices   = await predictDraw(nm, infoState);
    if (indices !== null) {
      // パターンA対処: モデルがスタンドパットを出力したが
      // ルールベースでは捨て牌があるケース（AA・高カード多数など）を上書き
      if (indices.length === 0) {
        const fallback = nm === 'badugi' ? decideBadugiDrawFallback(hand) : decideDraw27Fallback(hand);
        if (fallback.length > 0) {
          logDev(`[BotManager] ${nm} draw: model=standpat → rule-override discard[${fallback}]`);
          return fallback;
        }
      }
      // Badugi後処理: 残ったカードに同ランク/同スートがあれば上書き
      // （モデルが捨て牌を出したが残りに重複が生じるケースを修正）
      if (nm === 'badugi' && indices.length > 0 && indices.length < hand.length) {
        const kept = hand.filter((_, i) => !indices.includes(i)).map(parseCard).filter(Boolean);
        if (kept.length >= 2) {
          const ranks = kept.map(c => aceLow(c.rank));
          const suits = kept.map(c => c.suit);
          const hasDupRank = new Set(ranks).size < ranks.length;
          const hasDupSuit = new Set(suits).size < suits.length;
          if (hasDupRank || hasDupSuit) {
            const fallback = decideBadugiDrawFallback(hand);
            logDev(`[BotManager] badugi draw: kept has dup → rule-override discard[${fallback}]`);
            return fallback;
          }
        }
      }
      logDev(`[BotManager] ${nm} draw(model): discard[${indices.join(',')}]`);
      return indices;
    }
  } catch (err) { logDev(`[BotManager] draw model error: ${err.message}`); }
  return nm === 'badugi' ? decideBadugiDrawFallback(hand) : decideDraw27Fallback(hand);
}

/** ベット判断（モデル優先） */
async function decideBotBetAction(room, botPlayer) {
  const nm = normalizeMode(room.currentMode || '27');
  try {
    const infoState    = buildInfoState(room, botPlayer, nm);
    const legalActions = getLegalActions(room, botPlayer);
    const action       = await predictBetAction(nm, infoState, legalActions);
    if (action) { logDev(`[BotManager] ${nm} bet(model): ${action}`); return action; }
  } catch (err) { logDev(`[BotManager] bet model error: ${err.message}`); }
  return decideBotBetActionFallback(room, botPlayer);
}

function getNextBotName(roomId, existingPlayers) {
  const used = new Set(existingPlayers.map(p => p.name));
  for (const name of BOT_NAMES) { if (!used.has(name)) return name; }
  return `Bot-${_botCounter}`;
}

module.exports = { createBotId, isBotId, decideBotDraw, decideBotDrawWithRoom, decideBotBetAction, decideDraw27Fallback, decideBadugiDrawFallback, getNextBotName, BOT_NAMES };
