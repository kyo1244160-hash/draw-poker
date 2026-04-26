'use strict';
/**
 * server/poker/botInfoState.js
 * ゲーム状態 → 122次元情報ベクトル変換
 *
 * 学習コード (poker_trainer/engine/game_state.py) の
 * to_info_state() を完全移植したもの。
 *
 * 【入力ベクトル構成 122次元】
 * ① game_type(3)  ② street(4)  ③ position(6)
 * ④ pot(1)  ⑤ current_bet(1)  ⑥ bet_count(1)  ⑦ pot_odds(1)  ⑧ stack(1)
 * ⑨ hand(52)  ⑩ active_players(1)  ⑪ opponent_draws(20)  ⑫ street_bets(4)
 * ⑬ hand_strength(1)  ⑭ draws_remaining(1)  ⑮ bet_size(1)  ⑯ spr(1)
 * ⑰ opponent_stacks(5)  ⑱ flush_risk(1)  ⑲ straight_risk(1)
 * ⑳ position_aggression(6)  ㉑ opponent_standpat(5)  ㉒ card_quality(5)
 *
 * 【カード形式】
 * サーバー: "2S", "AH", "TC" (ランク文字 + スート文字)
 * スート: S=0 H=1 D=2 C=3
 * ランク: 2〜9=数値, T=10, J=11, Q=12, K=13, A=14
 */

// ============================================================
// カードパース
// ============================================================

const RANK_MAP = {
  '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
  'T':10,'J':11,'Q':12,'K':13,'A':14,
};
const SUIT_MAP = { 'S':0, 'H':1, 'D':2, 'C':3 };

function parseCard(code) {
  if (!code || code === '??' || code.length < 2) return null;
  const rankStr = code.slice(0, -1);
  const suitStr = code.slice(-1).toUpperCase();
  const rank = RANK_MAP[rankStr.toUpperCase()];
  const suit = SUIT_MAP[suitStr];
  if (rank === undefined || suit === undefined) return null;
  return { rank, suit };
}

// ============================================================
// ゲームタイプ / ストリート / ポジション
// ============================================================

// GameType one-hot: [27TD=0, A5=1, Badugi=2]
function gameTypeVec(mode) {
  if (mode === '27')     return [1,0,0];
  if (mode === 'a5')     return [0,1,0];
  if (mode === 'badugi') return [0,0,1];
  return [1,0,0]; // デフォルト27
}

// Street one-hot: [PREFLOP=0, DRAW1=1, DRAW2=2, DRAW3=3]
function streetIndex(phase) {
  // 学習: PREFLOP=0, DRAW1=1, DRAW2=2, DRAW3=3
  // サーバー: bet0=PREFLOP, draw1/bet1=DRAW1, draw2/bet2=DRAW2, draw3/bet3=DRAW3
  if (!phase) return 0;
  if (phase === 'bet0' || phase === 'preflop') return 0;
  if (phase === 'draw1' || phase === 'bet1')   return 1;
  if (phase === 'draw2' || phase === 'bet2')   return 2;
  if (phase === 'draw3' || phase === 'bet3')   return 3;
  return 0;
}

function streetVec(phase) {
  const idx = streetIndex(phase);
  return [0,1,2,3].map(i => i === idx ? 1.0 : 0.0);
}

// ドロー残り回数
function drawsRemaining(phase) {
  // 学習: PREFLOP→3, DRAW1→2, DRAW2→1, DRAW3→0
  if (!phase || phase === 'bet0' || phase === 'preflop') return 3;
  if (phase === 'draw1' || phase === 'bet1') return 2;
  if (phase === 'draw2' || phase === 'bet2') return 1;
  if (phase === 'draw3' || phase === 'bet3') return 0;
  return 0;
}

// ポジション: BTN=0 SB=1 BB=2 UTG=3 HJ=4 CO=5
// roomのプレイヤー配列からポジションを推定する
function positionIndex(room, player) {
  const active = room.players.filter(p => !p.folded && !p.sittingOut);
  const n = active.length;
  if (n === 0) return 0;
  const dealerIdx = room.dealerIndex ?? 0;
  // プレイヤーのglobal index
  const globalIdx = room.players.findIndex(p => p.id === player.id);
  if (globalIdx < 0) return 0;
  // dealerから何番目か（0=BTN, 1=SB, 2=BB, 3=UTG ...）
  const offset = (globalIdx - dealerIdx + room.players.length) % room.players.length;
  return Math.min(offset, 5);
}

function positionVec(posIdx) {
  return [0,1,2,3,4,5].map(i => i === posIdx ? 1.0 : 0.0);
}

// ============================================================
// 手札エンコード（52次元 one-hot）
// ============================================================

function handVec(hand) {
  const vec = new Array(52).fill(0.0);
  for (const code of hand) {
    const c = parseCard(code);
    if (!c) continue;
    const idx = (c.rank - 2) * 4 + c.suit;
    if (idx >= 0 && idx < 52) vec[idx] = 1.0;
  }
  return vec;
}

// ============================================================
// ハンド強度スカラー
// ============================================================

function handStrength27td(hand) {
  const cards = hand.map(parseCard).filter(Boolean);
  if (cards.length < 5) return 0.5;

  const ranks = cards.map(c => c.rank).sort((a,b) => a-b);
  const rankCnt = {};
  const suitCnt = {};
  for (const c of cards) {
    rankCnt[c.rank] = (rankCnt[c.rank] || 0) + 1;
    suitCnt[c.suit] = (suitCnt[c.suit] || 0) + 1;
  }

  const flush    = Object.values(suitCnt).some(v => v === 5);
  const uniqRanks = [...new Set(ranks)].sort((a,b) => a-b);
  const straight = uniqRanks.length === 5 && (uniqRanks[4] - uniqRanks[0]) === 4;

  const counts = Object.values(rankCnt).sort((a,b) => b-a);

  // カテゴリ（低いほど強い 27TDルール）
  let cat;
  if (flush && straight) cat = 8;
  else if (counts[0] === 4) cat = 7;
  else if (counts[0] === 3 && counts[1] === 2) cat = 6;
  else if (flush) cat = 5;
  else if (straight) cat = 4;
  else if (counts[0] === 3) cat = 3;
  else if (counts[0] === 2 && counts[1] === 2) cat = 2;
  else if (counts[0] === 2) cat = 1;
  else cat = 0; // ノーペア

  if (cat > 0) return 0.0;

  // ノーペアの場合のみ強度計算
  const rankSum = ranks.reduce((s,r) => s+r, 0);
  const minSum  = 21; // 2+3+4+5+7（ストレートにならない最小）
  const maxSum  = 59; // 14+13+12+11+9
  return Math.max(0, Math.min(1, 1 - (rankSum - minSum) / (maxSum - minSum)));
}

function aceLow(rank) { return rank === 14 ? 1 : rank; }

// Badugiの有効手を取得（全部分集合の総当たり）
function getBadugiHand(hand) {
  const cards = hand.map(parseCard).filter(Boolean);
  let best = [];
  let bestScore = null;

  for (let size = cards.length; size >= 1; size--) {
    const combos = combinations(cards, size);
    for (const combo of combos) {
      const ranks = combo.map(c => aceLow(c.rank));
      const suits = combo.map(c => c.suit);
      if (new Set(ranks).size === size && new Set(suits).size === size) {
        const score = [...ranks].sort((a,b) => b-a);
        if (!bestScore || size > best.length ||
            (size === best.length && scoreLess(score, bestScore))) {
          best = combo;
          bestScore = score;
        }
      }
    }
    if (best.length > 0) break;
  }
  return best;
}

function scoreLess(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k-1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

function handStrengthBadugi(hand) {
  const effective = getBadugiHand(hand);
  const count = effective.length;
  if (count === 0) return 0.0;

  const ranks    = effective.map(c => aceLow(c.rank)).sort((a,b) => a-b);
  const maxRank  = ranks[ranks.length - 1];
  const rankScore = Math.max(0, (13 - maxRank) / 12.0);

  if (count === 4) return 0.55 + rankScore * 0.45;
  if (count === 3) {
    if (maxRank <= 7) return 0.30 + rankScore * 0.15;
    if (maxRank <= 9) { const t = (9 - maxRank) / 2.0; return 0.18 + t * 0.11; }
    return 0.05 + Math.max(0, (13 - maxRank) / 3.0) * 0.12;
  }
  if (count === 2) return 0.02 + rankScore * 0.06;
  return rankScore * 0.02;
}

function handStrength(hand, mode) {
  if (!hand || hand.length === 0) return 0.5;
  if (mode === 'badugi') return handStrengthBadugi(hand);
  return handStrength27td(hand);
}

// ============================================================
// フラッシュ/ストレートリスク
// ============================================================

function flushRisk(hand) {
  const cards = hand.map(parseCard).filter(Boolean);
  if (cards.length === 0) return 0.0;
  const suitCnt = {};
  for (const c of cards) suitCnt[c.suit] = (suitCnt[c.suit] || 0) + 1;
  return Math.max(...Object.values(suitCnt)) / cards.length;
}

function straightRisk(hand, mode) {
  if (mode === 'badugi') return 0.0;
  const cards = hand.map(parseCard).filter(Boolean);
  if (cards.length < 2) return 0.0;
  const ranks = [...new Set(cards.map(c => c.rank))].sort((a,b) => a-b);
  let maxRun = 1, curRun = 1;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] === ranks[i-1] + 1) { curRun++; maxRun = Math.max(maxRun, curRun); }
    else curRun = 1;
  }
  return Math.min(1.0, (maxRun - 1) / 4.0);
}

// ============================================================
// カードクオリティスコア（5次元）
// ============================================================

function cardQualityScores(hand, mode) {
  const cards = hand.map(parseCard).filter(Boolean);
  const scores = [];

  if (mode === '27' || mode === 'a5') {
    const useAceLow = mode === 'a5';
    const rankCnt = {}, suitCnt = {};
    for (const c of cards) {
      const r = useAceLow ? aceLow(c.rank) : c.rank;
      rankCnt[r] = (rankCnt[r] || 0) + 1;
      suitCnt[c.suit] = (suitCnt[c.suit] || 0) + 1;
    }
    for (const c of cards) {
      const r = useAceLow ? aceLow(c.rank) : c.rank;
      let rankScore;
      if (mode === '27') {
        rankScore = r <= 7 ? (14 - r) / 12.0 : Math.max(0, (14 - r) / 12.0) * 0.5;
      } else {
        rankScore = Math.max(0, (13 - r) / 12.0);
      }
      const dupPenalty   = rankCnt[r] > 1 ? 0.3 : 0.0;
      const flushPenalty = suitCnt[c.suit] >= 4 ? 0.2 : 0.0;
      scores.push(Math.max(0, rankScore - dupPenalty - flushPenalty));
    }
  } else {
    // Badugi
    const rankCnt = {}, suitCnt = {};
    for (const c of cards) {
      const r = aceLow(c.rank);
      rankCnt[r] = (rankCnt[r] || 0) + 1;
      suitCnt[c.suit] = (suitCnt[c.suit] || 0) + 1;
    }
    const badugiSet = new Set(getBadugiHand(hand).map(c => `${c.rank}${c.suit}`));

    for (const c of cards) {
      const r = aceLow(c.rank);
      const key = `${c.rank}${c.suit}`;
      const hasDupRank = rankCnt[r] > 1;
      const hasDupSuit = suitCnt[c.suit] > 1;
      if (hasDupRank || hasDupSuit) {
        scores.push(Math.max(0, (8 - r) / 20.0));
      } else {
        let rankScore = Math.max(0.08, (13 - r) / 12.0 + 0.08);
        if (badugiSet.has(key)) rankScore = Math.min(1.0, rankScore + 0.1);
        scores.push(rankScore);
      }
    }
  }

  while (scores.length < 5) scores.push(0.0);
  return scores.slice(0, 5);
}

// ============================================================
// メイン: buildInfoState
// ============================================================

/**
 * room と player から 122 次元の Float32Array を生成する
 *
 * @param {object} room       - gameManager の room オブジェクト
 * @param {object} player     - room.players 内の自分プレイヤー
 * @param {string} mode       - '27' | 'badugi' | 'mix'（mix は currentMode で判断済み）
 * @returns {Float32Array}    - 122 次元ベクトル
 */
function buildInfoState(room, player, mode) {
  const state = [];
  const MAX_RAISES = 5;

  // ① ゲームタイプ (3)
  state.push(...gameTypeVec(mode));

  // ② ストリート (4)
  state.push(...streetVec(room.phase));

  // ③ ポジション (6)
  const posIdx = positionIndex(room, player);
  state.push(...positionVec(posIdx));

  // BB基準正規化（リング・トーナメント共通で学習時スケールに合わせる）
  // 学習時: BB=1.0, stack=100 → pot/100=0.015, currentBet/10=0.1, stack/100=1.0
  // リング: BB=10, stack=1000 → pot/(BB*100), currentBet/(BB*10), stack/startingChips
  // トーナメントLv1: BB=400, stack=5000 → 同様に一致
  const BB         = room.bigBlind || 10;
  const startChips = room.startingChips || (room.players.reduce((s,p)=>Math.max(s,p.chips||0),0) || 1000);

  // ④ ポット (1)
  state.push((room.pot || 0) / (BB * 100));

  // ⑤ 現在のベット (1)
  state.push((room.currentBet || 0) / (BB * 10));

  // ⑥ ベットカウント (1)
  state.push((room.raiseCount || 0) / MAX_RAISES);

  // ⑦ ポットオッズ (1)
  const callAmt = Math.max(0, (room.currentBet || 0) - (player.bet || 0));
  const potOdds = (room.pot + callAmt) > 0 ? callAmt / (room.pot + callAmt) : 0.0;
  state.push(potOdds);

  // ⑧ スタック (1)
  state.push((player.chips || 0) / startChips);

  // ⑨ 手札 52次元 (52)
  state.push(...handVec(player.hand || []));

  // ⑩ アクティブプレイヤー数 (1)
  const active = room.players.filter(p => !p.folded && !p.sittingOut);
  state.push(active.length / Math.max(room.players.length, 1));

  // ⑪ 対戦相手のドロー枚数（5人×4ストリート=20次元）
  const opponents = room.players.filter(p => p.id !== player.id && !p.sittingOut);
  const opps5 = opponents.slice(0, 5);
  for (let i = 0; i < 5; i++) {
    const opp = opps5[i];
    for (let s = 0; s < 4; s++) {
      if (!opp) { state.push(0.0); continue; }
      const drawCounts = opp.drawCounts || [];
      if (s < drawCounts.length) {
        state.push(drawCounts[s] / 5.0);
      } else {
        state.push(-1.0);
      }
    }
  }

  // ⑫ ストリートごとの累積ベット数（4次元）
  const streetBets = room.streetBetCounts || [0,0,0,0];
  for (let s = 0; s < 4; s++) {
    state.push((streetBets[s] || 0) / MAX_RAISES);
  }

  // ⑬ ハンド強度 (1)
  state.push(handStrength(player.hand || [], mode));

  // ⑭ 残りドロー回数 (1)
  state.push(drawsRemaining(room.phase) / 3.0);

  // ⑮ ベットサイズ (1)
  // 学習: small_bet=1.0=1BB→0.5, big_bet=2.0=2BB→1.0  → betSize/(BB*2) で統一
  const betSize = room.betSize || BB;
  state.push(betSize / (BB * 2));

  // ⑯ SPR（スタック/ポット比）上限10 (1)
  const spr = Math.min((player.chips || 0) / Math.max(room.pot || 1, 0.01), 10.0) / 10.0;
  state.push(spr);

  // ⑰ 相手5人のスタック (5)
  for (let i = 0; i < 5; i++) {
    state.push(opps5[i] ? (opps5[i].chips || 0) / startChips : 0.0);
  }

  // ⑱ フラッシュ危険度 (1)
  state.push(flushRisk(player.hand || []));

  // ⑲ ストレート危険度 (1)
  state.push(straightRisk(player.hand || [], mode));

  // ⑳ ポジション別アグレッション（6ポジション）(6)
  const posAgg = room.positionAggression || {};
  for (let p = 0; p < 6; p++) {
    state.push(Math.min((posAgg[p] || 0) / MAX_RAISES, 1.0));
  }

  // ㉑ 対戦相手のスタンドパット（5次元）
  const streetIdx = streetIndex(room.phase);
  for (let i = 0; i < 5; i++) {
    const opp = opps5[i];
    if (!opp) { state.push(0.0); continue; }
    if (streetIdx < 1) { state.push(0.0); continue; }  // プリフロップ
    const drawIdx = streetIdx - 1; // DRAW1=0, DRAW2=1, DRAW3=2
    const drawCounts = opp.drawCounts || [];
    if (drawIdx < drawCounts.length) {
      state.push(drawCounts[drawIdx] === 0 ? 1.0 : 0.0);
    } else {
      state.push(-1.0);
    }
  }

  // ㉒ カードクオリティスコア（5次元）
  state.push(...cardQualityScores(player.hand || [], mode));

  if (state.length !== 122) {
    throw new Error(`buildInfoState: expected 122 dims, got ${state.length}`);
  }

  return new Float32Array(state);
}

module.exports = { buildInfoState, parseCard, getBadugiHand, handStrength };
