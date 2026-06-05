'use strict';
/**
 * botManager.js — サーバーサイドBOT管理（v54bd対応版）
 *
 * 変更点:
 *   - decideBotBetAction: ONNX生出力に equityAdjust 補正を追加
 *   - decideBotDrawWithRoom: 多重ベット時のドロー制限を追加（v54bc相当）
 *
 * 【優先順位】
 *   1. ONNX モデル推論 + equityAdjust 補正
 *   2. ルールベースフォールバック（モデルが使えない場合）
 */

const { logDev } = require('../logger');
const { buildInfoState, getBadugiHand, handStrength } = require('./botInfoState');
const { predictBetAction, predictDraw }               = require('./botModel');
const { equityAdjust }                                = require('./equity_adjust_logic');

/**
 * NLモード判定。gameManager で `room.isNL` フラグを startGame 時に計算して保存しているため、
 * ここでは単純に参照するだけ（単一情報源）。
 * フォールバック: room.isNL が未設定の古い状態（startGame 前）でも安全に false を返す
 */
function isNL(room) {
  return !!(room && (room.isNL || room.currentMode === '27sd' || room.mode === '27sd'));
}

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
function aceLow(rank) {
  return rank === 'A' ? 1 : parseInt(rank) || rankBadugiValue(rank);
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
  const best = {};
  for (const c of cards) { if (!best[c.suit] || c.val < best[c.suit].val) best[c.suit] = c; }
  let keepSet = new Set(Object.values(best).map(c => c.i));
  const keepArr = [...keepSet].map(i => cards[i]);
  const rankSeen = {};
  for (const c of keepArr.sort((a,b) => a.val - b.val)) {
    if (rankSeen[c.val]) { keepSet.delete(c.i); }
    else { rankSeen[c.val] = true; }
  }
  return cards.filter(c => !keepSet.has(c.i)).map(c => c.i);
}

// A-5: 2-7と類似だがA=1（強い）、ストレート・フラッシュ無視
// 8以上のカードを捨て、ペアは最低ランクのみ残す（残りを捨てる）
function decideDrawA5Fallback(hand) {
  const cards = hand.map((code, i) => ({ i, ...parseCard(code), val: rankBadugiValue(parseCard(code).rank) }));
  const toDiscard = new Set();
  // 8以上のカードは捨てる候補
  for (const c of cards) { if (c.val >= 8) toDiscard.add(c.i); }
  const goodCards = cards.filter(c => !toDiscard.has(c.i));
  // 同ランクは最低ランク（=A優先のため val が小さい方）を残す。
  // map順序に依存しないよう、val昇順でソートしてからペア処理
  // 注: A-5では A=val=1 だが、同ランク内のソートはどれを残しても同等
  //     重要なのは「val 大きい方を捨てる」ではなく「ペアの片方を捨てる」こと
  const byRank = {};
  for (const c of goodCards) {
    if (!byRank[c.rank]) byRank[c.rank] = [];
    byRank[c.rank].push(c);
  }
  for (const group of Object.values(byRank)) {
    if (group.length > 1) {
      // ソートして先頭1枚を残し、残りを捨てる（順序非依存）
      const sorted = [...group].sort((a,b) => a.i - b.i);
      for (let j = 1; j < sorted.length; j++) toDiscard.add(sorted[j].i);
    }
  }
  // A-5はストレート・フラッシュ判定なし → スート重複チェック不要
  return [...toDiscard];
}

// ===== ルールベース ベット =====
function decideBotBetActionFallback(room, botPlayer) {
  const toCall   = Math.max(0, (room.currentBet || 0) - (botPlayer.bet || 0));
  // NL（27sd）はraiseCount制限なし
  const nl = isNL(room);
  const canRaise = (nl || (room.raiseCount || 0) < 5) && botPlayer.chips > 0
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

/**
 * NLベット時のレイズ額決定（ルールベース）
 * BB単位でランダム（弱小ベット〜ポット2倍）
 */
function decideNLBetAmountFallback(room, botPlayer) {
  const bb         = room.bigBlind || 10;
  const pot        = room.pot || 0;
  const currentBet = room.currentBet || 0;
  const lastRaise  = room.lastRaiseSize || bb;
  const maxBet     = botPlayer.bet + botPlayer.chips;
  const minTotal   = currentBet === 0 ? bb : currentBet + lastRaise;

  // ショートスタック: ミニマムベット/レイズに届かない → オールイン固定
  // 業界標準準拠で `<`（maxBet === minTotal はミニマムレイズが可能）
  // サーバー側 _applyNLBetRaise は isAllIn=true でminRaise下限を緩和して受理する
  if (maxBet < minTotal) {
    return maxBet;
  }

  const { randomInt } = require('crypto');
  const r = randomInt(0, 100) / 100;
  let target;
  if (currentBet === 0) {
    // オープンベット: BB×2〜BB×4
    target = Math.floor(bb * (2 + r * 2));
  } else {
    // レイズ: pot/2〜pot×1.5
    const base = Math.max(pot, currentBet * 2);
    target = Math.floor(base * (0.5 + r));
  }
  // 範囲内に収める
  return Math.max(minTotal, Math.min(maxBet, target));
}

// ===== ストリート情報 =====
function streetIndexFromPhase(phase) {
  if (!phase || phase === 'bet0' || phase === 'preflop') return 0;
  if (phase === 'draw1' || phase === 'bet1') return 1;
  if (phase === 'draw2' || phase === 'bet2') return 2;
  return 3;
}

// ===== 合法アクション =====
function getLegalActions(room, player) {
  const toCall   = Math.max(0, (room.currentBet || 0) - (player.bet || 0));
  // NL（27sd）は raiseCount キャップなし
  const nl = isNL(room);
  const canRaise = (nl || (room.raiseCount || 0) < 5) && player.chips > 0
    && room.players.some(op => op.id !== player.id && !op.folded && !op.sittingOut && op.chips > 0);
  const actions = [];
  if (toCall === 0) { actions.push('check'); if (canRaise) actions.push('bet'); }
  else { if (player.chips > 0) actions.push('fold'); actions.push('call'); if (canRaise) actions.push('raise'); }
  return actions;
}

// normalizeMode: ONNXモデルキーに対応するモードに正規化
// 'a5' と '27sd' は **現時点では** 専用モデルがなく、'27' モデルにフォールバック。
// ただし学習予定あり: A-5 / 27SD 専用モデルが追加されたら、ここに新しいキーを追加する。
// 注意: 現状の運用では decideBotBetAction が rm==='a5' || rm==='27sd' で早期 return するため、
//      この関数の '27' フォールバック結果は実際には推論に使われない。
//      モデル追加時は normalizeMode の戻り値を 'a5'/'27sd' に変更し、早期 return も解除すること。
function normalizeMode(mode) {
  if (mode === 'badugi') return 'badugi';
  return '27'; // a5, 27sd, 27 すべて27モデルを使用（学習後は要修正）
}

// rawMode: 元のモードを保持（ルールベース判定で使用）
function rawMode(mode) {
  if (mode === 'badugi') return 'badugi';
  if (mode === 'a5')     return 'a5';
  if (mode === '27sd')   return '27sd';
  return '27';
}

// ============================================================
// 公開インターフェース
// ============================================================

/** ドロー判断（room なし版 → ルールベース） */
async function decideBotDraw(hand, mode) {
  const rm = rawMode(mode);
  if (rm === 'badugi') return decideBadugiDrawFallback(hand);
  if (rm === 'a5')     return decideDrawA5Fallback(hand);
  return decideDraw27Fallback(hand);
}

/** ドロー判断（room あり版 → モデル優先 + 多重ベット防御） */
async function decideBotDrawWithRoom(room, botPlayer, mode) {
  const nm   = normalizeMode(mode);
  const rm   = rawMode(mode);
  const hand = botPlayer.hand || [];

  // A-5モードは専用フォールバック（モデルなしのためルールベース固定）
  if (rm === 'a5') {
    return decideDrawA5Fallback(hand);
  }

  // ==== v54bc: 多重ベット防御（Badugiのみ） ====
  // 直前のベットラウンドで 3-bet 以上 → 弱い手のドロー枚数を制限
  if (nm === 'badugi') {
    const streetIdx    = streetIndexFromPhase(room.phase);
    const prevStreetIdx = Math.max(0, streetIdx - 1);
    const prevBetCount = (room.streetBetCounts || [0,0,0,0])[prevStreetIdx] || 0;

    if (prevBetCount >= 3 && hand.length > 0) {
      const str      = handStrength(hand, nm);
      const bestHand = getBadugiHand(hand);

      if (bestHand.length >= 4) {
        logDev(`[BotManager] badugi draw: 多重ベット防御 → 4枚完成スタンドパット`);
        return [];
      }
      if (str <= 0.35) {
        logDev(`[BotManager] badugi draw: 多重ベット防御 → 弱手スノー (str=${str.toFixed(3)})`);
        return [];
      }
      if (bestHand.length === 3) {
        // 1枚交換のみ許可（最弱カードを1枚捨てる）
        const keepIds  = new Set(bestHand.map(c => `${c.rank}${c.suit}`));
        const excess   = hand
          .map((code, i) => ({ code, i }))
          .filter(({ code }) => {
            const r = code.slice(0, -1);
            const s = code.slice(-1);
            return !keepIds.has(`${r}${s}`);
          });
        if (excess.length > 0) {
          logDev(`[BotManager] badugi draw: 多重ベット防御 → 3枚手1枚交換 [${excess[0].i}]`);
          return [excess[0].i];
        }
        return [];
      }
      // 2枚以下バドゥーギ → スタンドパット
      logDev(`[BotManager] badugi draw: 多重ベット防御 → 2枚以下スタンドパット`);
      return [];
    }
  }

  // ==== モデル推論 ====
  try {
    const infoState = buildInfoState(room, botPlayer, nm);
    const indices   = await predictDraw(nm, infoState);
    if (indices !== null) {
      // パターンA対処: モデルがスタンドパットを出力したがルールでは捨て牌があるケース
      if (indices.length === 0) {
        const fallback = nm === 'badugi' ? decideBadugiDrawFallback(hand) : decideDraw27Fallback(hand);
        if (fallback.length > 0) {
          logDev(`[BotManager] ${nm} draw: model=standpat → rule-override discard[${fallback}]`);
          return fallback;
        }
      }
      // Badugi後処理: 残ったカードに重複があれば上書き
      if (nm === 'badugi' && indices.length > 0 && indices.length < hand.length) {
        const kept = hand
          .filter((_, i) => !indices.includes(i))
          .map(code => ({ rank: code.slice(0,-1), suit: code.slice(-1) }))
          .filter(Boolean);
        if (kept.length >= 2) {
          const ranks = kept.map(c => (c.rank === 'A' ? 1 : parseInt(c.rank) || 10));
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

/** ベット判断（モデル優先 + equityAdjust 補正） */
async function decideBotBetAction(room, botPlayer) {
  const nm           = normalizeMode(room.currentMode || '27');
  const rm           = rawMode(room.currentMode || '27');
  const legalActions = getLegalActions(room, botPlayer);

  // A-5 / 27SD は専用モデルがないため、誤った推論を避けて直接ルールベースへ。
  // (Aの扱い・フェーズ数・NLベット構造が学習時と異なるため、27モデルでの推論は信頼できない)
  if (rm === 'a5' || rm === '27sd') {
    return decideBotBetActionFallback(room, botPlayer);
  }

  try {
    const infoState = buildInfoState(room, botPlayer, nm);

    // ==== ONNX 推論で生の確率を取得 ====
    // predictBetAction は argmax を返すが、ここでは確率配列が必要
    // → botModel.js の predictBetAction を確率配列返却版に変更するか、
    //   ここで直接 session を使う。現状は predictBetAction の結果を参考に
    //   equityAdjust で上書きする。
    //
    // 【実装メモ】
    // botModel.js の predictBetAction が argmax を返す現状では、
    // 確率配列を取得するために session を直接呼ぶ必要がある。
    // 以下は botModel.js に getRawProbs 関数を追加した場合の実装。
    // getRawProbs が使えない場合は predictBetAction の結果をそのまま使う。
    let rawProbs = null;
    try {
      const { getSession } = require('./botModel');
      const sess   = await getSession(nm);
      if (sess) {
        const { Tensor } = require('onnxruntime-web');
        const tensor = new Tensor('float32', infoState, [1, 122]);
        const result = await sess.strategy.run({ input: tensor });
        const logits = Array.from(result.output.data);
        const maxL   = Math.max(...logits);
        const exps   = logits.map(l => Math.exp(l - maxL));
        const sumE   = exps.reduce((s, e) => s + e, 0);
        rawProbs     = exps.map(e => e / sumE);
      }
    } catch (e) {
      logDev(`[BotManager] getRawProbs error: ${e.message}`);
    }

    if (rawProbs) {
      // equityAdjust を適用
      const adjusted = equityAdjust(rawProbs, room, botPlayer, nm, legalActions);

      // 合法アクション内で最大確率のアクションを選択
      const IDX = { fold:0, check:1, call:2, bet:3, raise:4 };
      let bestAction = legalActions[0];
      let bestProb   = -1;
      for (const a of legalActions) {
        if (adjusted[IDX[a]] > bestProb) {
          bestProb   = adjusted[IDX[a]];
          bestAction = a;
        }
      }
      logDev(`[BotManager] ${nm} bet(model+equity): ${bestAction}`);
      return bestAction;
    }

    // rawProbs が取れなかった場合は predictBetAction にフォールバック
    const action = await predictBetAction(nm, infoState, legalActions);
    if (action) {
      logDev(`[BotManager] ${nm} bet(model): ${action}`);
      return action;
    }
  } catch (err) { logDev(`[BotManager] bet model error: ${err.message}`); }

  return decideBotBetActionFallback(room, botPlayer);
}

function getNextBotName(roomId, existingPlayers) {
  const used = new Set(existingPlayers.map(p => p.name));
  for (const name of BOT_NAMES) { if (!used.has(name)) return name; }
  return `Bot-${_botCounter}`;
}

/**
 * NLベット時のレイズ/ベット額を返す。
 * 通常モード（リミット）では使われない。
 * BOT呼び出し元: betAction(roomId, botId, action, amount) の amount に渡す。
 */
function decideBotBetAmount(room, botPlayer, action) {
  const nl = isNL(room);
  if (!nl || (action !== 'bet' && action !== 'raise')) return undefined;
  return decideNLBetAmountFallback(room, botPlayer);
}

module.exports = {
  createBotId, isBotId,
  decideBotDraw, decideBotDrawWithRoom, decideBotBetAction,
  decideBotBetAmount,
  decideDraw27Fallback, decideBadugiDrawFallback, decideDrawA5Fallback,
  getNextBotName, BOT_NAMES,
};
