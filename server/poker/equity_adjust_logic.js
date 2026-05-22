'use strict';
/**
 * equity_adjust_logic.js
 *
 * Python側 poker_trainer/ai/deep_cfr_agent.py の _equity_adjust() を
 * JavaScript に完全移植したもの。
 *
 * ONNXモデルのNN生出力（softmax確率）を補正して、実用的なBOT行動を実現する。
 *
 * 使い方:
 *   const { equityAdjust } = require('./equity_adjust_logic');
 *   const adjusted = equityAdjust(probs, room, botPlayer, mode, legalActions);
 *   // adjusted: length=5 の Float32Array [fold, check, call, bet, raise]
 */

const { handStrength, getBadugiHand } = require('./botInfoState');

// アクションインデックス
const IDX = { fold:0, check:1, call:2, bet:3, raise:4 };

// ================================================================
// calc_draw_fv: ドロー改善期待値（BET/RAISE判断用）
// Python: calc_draw_fv() in deep_cfr_agent.py
// ================================================================
function calcDrawFv(mode, strength, drawsRem) {
  if (strength >= 0.55) return 0.0;
  if (mode === 'badugi') {
    if (strength >= 0.30) return drawsRem * 0.10;
    if (strength >= 0.18) return drawsRem * 0.10;
    if (strength >= 0.05) return drawsRem * 0.13;
    return drawsRem * 0.05;
  } else {
    // 27TD / A5TD
    if (strength >= 0.30) return drawsRem * 0.08;
    if (strength >= 0.18) return drawsRem * 0.06;
    if (strength >= 0.05) return drawsRem * 0.04;
    return drawsRem * 0.02;
  }
}

// ================================================================
// drawsRemaining: 残りドロー回数
// ================================================================
function drawsRemainingFromPhase(phase) {
  if (!phase || phase === 'bet0' || phase === 'preflop') return 3;
  if (phase === 'draw1' || phase === 'bet1') return 2;
  if (phase === 'draw2' || phase === 'bet2') return 1;
  return 0;
}

function streetIndexFromPhase(phase) {
  if (!phase || phase === 'bet0' || phase === 'preflop') return 0;
  if (phase === 'draw1' || phase === 'bet1') return 1;
  if (phase === 'draw2' || phase === 'bet2') return 2;
  return 3;
}

// ================================================================
// estimate_opponent_range_strength: 相手レンジ推定
// Python: equity_helpers.estimate_opponent_range_strength()
// ================================================================
function estimateOpponentRangeStrength(room, myPlayerId) {
  try {
    const totalBets = (room.streetBetCounts || [0,0,0,0]).reduce((a,b) => a+b, 0);
    const activeOpponents = (room.players || []).filter(
      p => !p.folded && !p.sittingOut && p.id !== myPlayerId
    ).length;
    if (activeOpponents === 0) return 0.50;

    let base = 0.35 + Math.min(0.40, totalBets * 0.08);

    // スタンドパット相手の影響
    const streetIdx = streetIndexFromPhase(room.phase);
    let standpatCount = 0;
    for (const p of (room.players || [])) {
      if (p.id === myPlayerId || p.folded || p.sittingOut) continue;
      const drawCounts = p.drawCounts || [];
      const drawIdx = streetIdx - 1;
      if (drawIdx >= 0 && drawIdx < drawCounts.length && drawCounts[drawIdx] === 0) {
        standpatCount++;
      }
    }
    if (standpatCount > 0) {
      base = Math.min(0.85, base + 0.10 * standpatCount);
    }
    return Math.min(0.95, Math.max(0.20, base));
  } catch (e) {
    return 0.50;
  }
}

function relativeStrength(myStr, oppRange) {
  const diff = myStr - oppRange;
  return 1.0 / (1.0 + Math.exp(-diff * 6.0));
}

// ================================================================
// applyMixedStrategy: パターン読み対策
// Python: equity_helpers.apply_mixed_strategy()
// ================================================================
function applyMixedStrategy(probs, strength, legalActions) {
  const out = Float32Array.from(probs);
  const legalSet = new Set(legalActions);

  // 中強度でのスロープレイ（CHECK優先）
  if (strength >= 0.40 && strength <= 0.65) {
    if (legalSet.has('check') && legalSet.has('bet')) {
      const shift = Math.min(0.20, out[IDX.bet] * 0.25);
      out[IDX.bet]   = Math.max(0, out[IDX.bet]   - shift);
      out[IDX.check] = out[IDX.check] + shift;
    }
  }

  // 強い手のレイズトラップ（たまにCALL）
  if (strength > 0.85 && legalSet.has('call') && legalSet.has('raise')) {
    const shift = Math.min(0.20, out[IDX.raise] * 0.25);
    out[IDX.raise] = Math.max(0, out[IDX.raise] - shift);
    out[IDX.call]  = out[IDX.call] + shift;
  }

  // 弱い手の限定セミブラフ
  if (strength < 0.20 && legalSet.has('raise') && legalSet.has('fold')) {
    if (out[IDX.fold] > 0.70 && out[IDX.raise] < 0.05) {
      out[IDX.fold]  = Math.max(0, out[IDX.fold]  - 0.10);
      out[IDX.raise] = out[IDX.raise] + 0.10;
    }
  }
  return out;
}

// ================================================================
// applyPositionAdjust: ポジション別補正
// Python: equity_helpers.apply_position_adjust()
// ================================================================
// position: 0=BTN, 1=SB, 2=BB, 3=UTG, 4=HJ, 5=CO
const LATE_POSITIONS  = new Set([0, 4, 5]); // BTN, HJ, CO
const EARLY_POSITIONS = new Set([3]);         // UTG

function applyPositionAdjust(probs, posIdx, streetIdx, legalActions) {
  const out = Float32Array.from(probs);
  const legalSet = new Set(legalActions);

  if (streetIdx === 0) {
    if (LATE_POSITIONS.has(posIdx)) {
      if (legalSet.has('fold')) {
        const shift = Math.min(0.10, out[IDX.fold] * 0.15);
        out[IDX.fold] = Math.max(0, out[IDX.fold] - shift);
        if (legalSet.has('raise')) out[IDX.raise] += shift * 0.6;
        if (legalSet.has('call'))  out[IDX.call]  += shift * 0.4;
      }
    } else if (EARLY_POSITIONS.has(posIdx)) {
      if (legalSet.has('fold') && legalSet.has('call')) {
        const transfer = Math.min(0.08, out[IDX.call] * 0.30);
        out[IDX.call] -= transfer;
        out[IDX.fold] += transfer;
      }
    }
  } else {
    if (LATE_POSITIONS.has(posIdx)) {
      if (legalSet.has('bet') && !legalSet.has('raise') && legalSet.has('check')) {
        const transfer = Math.min(0.10, out[IDX.check] * 0.20);
        out[IDX.check] -= transfer;
        out[IDX.bet]   += transfer;
      }
    }
  }
  return out;
}

// ================================================================
// normalize: 合法アクションのみで正規化
// ================================================================
function normalize(probs, legalActions) {
  const out = Float32Array.from(probs);
  let total = 0;
  for (const a of legalActions) total += out[IDX[a]];
  if (total > 1e-6) {
    for (const a of legalActions) out[IDX[a]] /= total;
  } else {
    for (const a of legalActions) out[IDX[a]] = 1.0 / legalActions.length;
  }
  return out;
}

// ================================================================
// equityAdjust: メイン補正関数
// Python: DeepCFRAgent._equity_adjust()
//
// @param {number[]} rawProbs  - NN softmax出力 [fold, check, call, bet, raise]
// @param {object}   room      - gameManager の room オブジェクト
// @param {object}   botPlayer - BOT プレイヤーオブジェクト
// @param {string}   mode      - 'badugi' | '27'
// @param {string[]} legalActions - ['fold','check','call','bet','raise'] のサブセット
// @returns {number[]} - 補正後の確率 [fold, check, call, bet, raise]
// ================================================================
function equityAdjust(rawProbs, room, botPlayer, mode, legalActions) {
  let probs = Float32Array.from(rawProbs);
  const legalSet = new Set(legalActions);

  try {
    const hand      = botPlayer.hand || [];
    const strength  = handStrength(hand, mode);
    const drawsRem  = drawsRemainingFromPhase(room.phase);
    const streetIdx = streetIndexFromPhase(room.phase);
    const callAmt   = Math.max(0, (room.currentBet || 0) - (botPlayer.bet || 0));
    const pot       = Math.max(room.pot || 0, 0.01);
    const po        = callAmt > 0 ? callAmt / (pot + callAmt) : 0.0;

    // draw_fv: BET/RAISE判断用の改善期待値
    let drawFv = calcDrawFv(mode, strength, drawsRem);

    // スタンドパット相手の考慮
    let standpatOpponents = 0;
    const drawIdx = streetIdx - 1;
    for (const p of (room.players || [])) {
      if (p.id === botPlayer.id || p.folded || p.sittingOut) continue;
      const dc = p.drawCounts || [];
      if (drawIdx >= 0 && drawIdx < dc.length && dc[drawIdx] === 0) standpatOpponents++;
    }
    if (standpatOpponents > 0) {
      drawFv    *= Math.max(0.3, 1.0 - standpatOpponents * 0.25);
    }

    const effective = strength + drawFv;

    // ==== FOLD補正: effectiveがpo未満 ====
    if (legalSet.has('fold') && callAmt > 0) {
      if (effective < po * 0.85) {
        const boost = Math.min(0.6, (po - effective) * 3.0);
        probs[IDX.fold] += boost;
      }
    }

    // ==== BET/RAISE抑制 ====
    let betThreshold;
    if (mode === 'badugi') {
      const oppDrawing = (room.players || []).some(p =>
        p.id !== botPlayer.id && !p.folded && !p.sittingOut &&
        (!(p.drawCounts || []).length || (p.drawCounts || [])[drawIdx] > 0)
      );
      betThreshold = strength >= 0.55
        ? (oppDrawing || drawsRem >= 1 ? 0.53 : 0.60)
        : 0.40;
    } else {
      // 27TD
      betThreshold = Math.max(0.50, 0.65 - drawsRem * 0.04);
    }

    if (effective < betThreshold) {
      const suppress = Math.min(0.9, (betThreshold - effective) * 3.0);
      for (const a of ['bet', 'raise']) {
        if (legalSet.has(a)) probs[IDX[a]] *= Math.max(0.05, 1.0 - suppress);
      }
    }

    // ==== 強い手のBET/RAISE強化 ====
    let canBoost = true;
    if (mode !== 'badugi' && callAmt > 0) {
      canBoost = effective >= Math.max(0.58, 0.78 - drawsRem * 0.05);
    }
    if (effective > 0.75 && canBoost) {
      for (const a of ['raise', 'bet']) {
        if (legalSet.has(a)) probs[IDX[a]] += 0.15;
      }
    }
    if (effective >= 0.93 && canBoost) {
      for (const a of ['raise', 'bet']) {
        if (legalSet.has(a)) probs[IDX[a]] += 0.30;
      }
    }

    // ==== 27TD: CALL抑制 ====
    if (mode !== 'badugi' && callAmt > 0) {
      const callThreshold = Math.max(0.58, 0.78 - drawsRem * 0.05);
      if (effective < callThreshold && legalSet.has('fold')) {
        const cs = Math.min(0.55, (callThreshold - effective) * 2.5);
        probs[IDX.fold] += cs;
        if (legalSet.has('call')) probs[IDX.call] *= Math.max(0.05, 1.0 - cs * 1.5);
      }
    }

    // ==== Badugi: CALL/RAISE判断 ====
    if (mode === 'badugi') {
      // スタンドパット相手への BET/RAISE 強制抑制
      if (standpatOpponents > 0 && strength < 0.55) {
        for (const a of ['bet', 'raise']) {
          if (legalSet.has(a)) probs[IDX[a]] *= 0.05;
        }
      }
      // FOLD/RAISE判断（v54bb）
      if (callAmt > 0) {
        let minThreshold, decisionStrength;
        if (drawsRem === 0) {
          minThreshold     = 0.55;
          decisionStrength = strength + calcDrawFv(mode, strength, drawsRem);
        } else {
          minThreshold     = Math.max(po, 0.30 - drawsRem * 0.05);
          decisionStrength = strength;
        }
        if (decisionStrength < minThreshold && legalSet.has('fold')) {
          const gap         = minThreshold - decisionStrength;
          const callSuppress = Math.min(0.55, gap * 3.0);
          probs[IDX.fold] += callSuppress;
          if (legalSet.has('call'))
            probs[IDX.call] *= Math.max(0.05, 1.0 - callSuppress * 1.5);
          const raiseSuppress = Math.min(0.90, callSuppress * 1.5);
          for (const a of ['raise', 'bet']) {
            if (legalSet.has(a)) probs[IDX[a]] *= Math.max(0.05, 1.0 - raiseSuppress);
          }
        }
      }
    }

    // ==== 最終ストリート（DRAW3=bet3）: 保守的に ====
    if ((room.phase === 'bet3') && effective < po && legalSet.has('fold')) {
      probs[IDX.fold] += 0.15;
    }

    // ==== 正規化 ====
    probs = normalize(probs, legalActions);

    // ==== v54bd: 戦略強化レイヤー ====

    // ① Hand Range vs Hand
    try {
      const oppRange = estimateOpponentRangeStrength(room, botPlayer.id);
      const rel      = relativeStrength(strength, oppRange);
      if (rel < 0.30 && callAmt > 0 && legalSet.has('fold')) {
        const boost = Math.min(0.25, (0.30 - rel) * 1.5);
        probs[IDX.fold] += boost;
        if (legalSet.has('call'))  probs[IDX.call]  *= Math.max(0.05, 1.0 - boost);
        if (legalSet.has('raise')) probs[IDX.raise] *= Math.max(0.05, 1.0 - boost);
      } else if (rel > 0.80) {
        if (legalSet.has('raise'))      probs[IDX.raise] += Math.min(0.15, (rel - 0.80));
        else if (legalSet.has('bet'))   probs[IDX.bet]   += Math.min(0.15, (rel - 0.80));
      }
    } catch (e) { /* ignore */ }

    // ② Mixed Strategy
    probs = applyMixedStrategy(probs, strength, legalActions);

    // ③ ポジション補正
    try {
      const posIdx = (room.players || []).findIndex(p => p.id === botPlayer.id);
      const dealerIdx = room.dealerIndex ?? 0;
      const n = (room.players || []).filter(p => !p.folded && !p.sittingOut).length;
      const offset = n > 0 ? (posIdx - dealerIdx + (room.players || []).length)
                             % (room.players || []).length : 0;
      probs = applyPositionAdjust(probs, Math.min(offset, 5), streetIdx, legalActions);
    } catch (e) { /* ignore */ }

    // 最終正規化
    probs = normalize(probs, legalActions);

  } catch (e) {
    // 例外時は元のprobsをそのまま返す
  }

  return Array.from(probs);
}

module.exports = { equityAdjust, calcDrawFv, estimateOpponentRangeStrength };
