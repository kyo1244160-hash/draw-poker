/**
 * server/poker/threeCardEvaluator.js
 * スリーカードポーカー 手役判定
 *
 * カード表記: ランク + スート (例: 'AS'=Aスペード, 'TC'=10クラブ)
 * ランク: A 2 3 4 5 6 7 8 9 T J Q K
 * スート: S H D C
 *
 * 手役強さ（スリーカードポーカー標準）:
 *   6: ストレートフラッシュ
 *   5: スリーオブアカインド
 *   4: ストレート
 *   3: フラッシュ
 *   2: ワンペア
 *   1: ハイカード
 *
 * ※ スリーカードポーカーでは ストレート > フラッシュ（通常とは逆）
 *    確率: ストレート < フラッシュ なので強さが逆転している
 *
 * 6カードボーナス 手役（5枚ベストハンド: 標準ポーカー役）:
 *   8: ロイヤルフラッシュ
 *   7: ストレートフラッシュ
 *   6: フォーオブアカインド
 *   5: フルハウス
 *   4: フラッシュ
 *   3: ストレート
 *   2: スリーオブアカインド
 *   0: それ以下（負け）
 */

// ランク値（A=14 がデフォルト、ストレート判定では A=1 も使用）
const RANK_VALUE = {
  'A': 14, 'K': 13, 'Q': 12, 'J': 11, 'T': 10,
  '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2,
};

function parseCard(code) {
  return { rank: code[0], suit: code[1], value: RANK_VALUE[code[0]] };
}

// ===== 3枚手役判定 =====

/**
 * 3枚の手役を評価する
 * @param {string[]} hand 3枚のカード
 * @returns {{ rank: number, values: number[], label: string }}
 *   rank: 手役強さ (1-6)
 *   values: 比較用降順ランク値配列
 */
function evaluateThreeCardHand(hand) {
  const cards  = hand.map(parseCard);
  const vals   = cards.map(c => c.value).sort((a, b) => b - a);
  const suits  = cards.map(c => c.suit);
  const isFlush    = suits[0] === suits[1] && suits[1] === suits[2];
  const isStraight = _isStraight3(vals);

  if (isFlush && isStraight) {
    return { rank: 6, values: vals, label: 'ストレートフラッシュ' };
  }
  // フリークエンシーで重複チェック
  const freq = _freq(vals);
  if (freq[0] === 3) {
    return { rank: 5, values: vals, label: 'スリーオブアカインド' };
  }
  if (isStraight) {
    return { rank: 4, values: vals, label: 'ストレート' };
  }
  if (isFlush) {
    return { rank: 3, values: vals, label: 'フラッシュ' };
  }
  if (freq[0] === 2) {
    // ペアのランクを先頭に、キッカーを後ろに
    const pairVal   = _pairValue(vals);
    const kicker    = vals.filter(v => v !== pairVal);
    return { rank: 2, values: [pairVal, ...kicker], label: 'ワンペア' };
  }
  return { rank: 1, values: vals, label: 'ハイカード' };
}

/** 3枚のストレート判定（A-2-3 と A-K-Q も含む） */
function _isStraight3(sortedDesc) {
  const [a, b, c] = sortedDesc;
  // 通常のストレート
  if (a - b === 1 && b - c === 1) return true;
  // A-2-3（A=14, 2=2, 3=3 → 14,3,2）
  if (a === 14 && b === 3 && c === 2) return true;
  return false;
}

/** ストレートの場合の最大値（A-2-3 は 3 扱い） */
function _straightHigh3(sortedDesc) {
  const [a, b, c] = sortedDesc;
  if (a === 14 && b === 3 && c === 2) return 3;
  return a;
}

/** 出現頻度の降順配列 */
function _freq(vals) {
  const map = {};
  for (const v of vals) map[v] = (map[v] ?? 0) + 1;
  return Object.values(map).sort((a, b) => b - a);
}

/** ペアの値を返す */
function _pairValue(vals) {
  const map = {};
  for (const v of vals) map[v] = (map[v] ?? 0) + 1;
  for (const [k, cnt] of Object.entries(map)) {
    if (cnt >= 2) return Number(k);
  }
  return 0;
}

/**
 * 2つの3枚手を比較する
 * @returns {number} 正=player勝ち, 0=引き分け, 負=dealer勝ち
 */
function compareThreeCardHands(playerHand, dealerHand) {
  const ph = evaluateThreeCardHand(playerHand);
  const dh = evaluateThreeCardHand(dealerHand);

  if (ph.rank !== dh.rank) return ph.rank - dh.rank;

  // 同ランク: ストレート系は最大値で比較（A-2-3 は 3-high）
  if (ph.rank === 4 || ph.rank === 6) { // ストレート / ストレートフラッシュ
    const pHigh = _straightHigh3(ph.values);
    const dHigh = _straightHigh3(dh.values);
    return pHigh - dHigh;
  }

  // それ以外: values 配列を順番に比較
  for (let i = 0; i < ph.values.length; i++) {
    if (ph.values[i] !== dh.values[i]) return ph.values[i] - dh.values[i];
  }
  return 0; // 完全引き分け
}

/**
 * ディーラーがクイーン以上を持つか（参加判定）
 * @param {string[]} hand 3枚
 */
function dealerQualifies(hand) {
  const result = evaluateThreeCardHand(hand);
  // ペア以上は必ず参加
  if (result.rank >= 2) return true;
  // ハイカード: 最大値がQ(12)以上で参加
  return result.values[0] >= 12;
}

// ===== アンテボーナス =====
// プレイヤー自身の3枚手が対象（勝敗無関係）
const ANTE_BONUS = {
  6: 5,  // ストレートフラッシュ
  5: 4,  // スリーオブアカインド
  4: 1,  // ストレート
};

function getAnteBonus(hand) {
  const result = evaluateThreeCardHand(hand);
  return ANTE_BONUS[result.rank] ?? 0;
}

// ===== ペアプラス配当 =====
const PAIR_PLUS_PAYOUT = {
  6: 40,  // ストレートフラッシュ
  5: 30,  // スリーオブアカインド
  4: 6,   // ストレート
  3: 3,   // フラッシュ
  2: 1,   // ワンペア
};

function getPairPlusPayout(hand) {
  const result = evaluateThreeCardHand(hand);
  return PAIR_PLUS_PAYOUT[result.rank] ?? 0;
}

// ===== 6カードボーナス =====
// プレイヤー3枚 + ディーラー3枚 = 6枚から最強5枚手を作る
const SIX_CARD_PAYOUT = {
  8: 1000,  // ロイヤルフラッシュ
  7: 200,   // ストレートフラッシュ
  6: 50,    // フォーオブアカインド
  5: 25,    // フルハウス
  4: 15,    // フラッシュ
  3: 10,    // ストレート
  2: 5,     // スリーオブアカインド
};

/**
 * 6枚から最強の5枚手を評価する
 */
function evaluateSixCardBonus(playerHand, dealerHand) {
  const allCards = [...playerHand, ...dealerHand]; // 6枚
  let best = null;

  // C(6,5) = 6通りの組み合わせ
  for (let skip = 0; skip < 6; skip++) {
    const five = allCards.filter((_, i) => i !== skip);
    const result = _evaluateFiveCardHand(five);
    if (!best || result.rank > best.rank ||
       (result.rank === best.rank && _compareFive(result.values, best.values) > 0)) {
      best = result;
    }
  }
  return best;
}

function getSixCardBonusPayout(playerHand, dealerHand) {
  const result = evaluateSixCardBonus(playerHand, dealerHand);
  return SIX_CARD_PAYOUT[result.rank] ?? 0;
}

/** 5枚手の評価（標準ポーカー役） */
function _evaluateFiveCardHand(hand) {
  const cards   = hand.map(parseCard);
  const vals    = cards.map(c => c.value).sort((a, b) => b - a);
  const suits   = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // ストレート判定（A-2-3-4-5 も含む）
  const isStraight = _isStraight5(vals);

  const freq    = {};
  for (const v of vals) freq[v] = (freq[v] ?? 0) + 1;
  const counts  = Object.values(freq).sort((a, b) => b - a);
  const groups  = Object.entries(freq)
    .sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))
    .map(e => ({ v: Number(e[0]), c: e[1] }));

  // ロイヤルフラッシュ
  if (isFlush && isStraight && vals[0] === 14 && vals[1] === 13) {
    return { rank: 8, values: vals, label: 'ロイヤルフラッシュ' };
  }
  if (isFlush && isStraight) {
    return { rank: 7, values: [_straight5High(vals), ...vals.slice(1)], label: 'ストレートフラッシュ' };
  }
  if (counts[0] === 4) {
    const quad   = groups[0].v;
    const kicker = groups[1].v;
    return { rank: 6, values: [quad, quad, quad, quad, kicker], label: 'フォーオブアカインド' };
  }
  if (counts[0] === 3 && counts[1] === 2) {
    const trip = groups[0].v;
    const pair = groups[1].v;
    return { rank: 5, values: [trip, trip, trip, pair, pair], label: 'フルハウス' };
  }
  if (isFlush) {
    return { rank: 4, values: vals, label: 'フラッシュ' };
  }
  if (isStraight) {
    return { rank: 3, values: [_straight5High(vals), ...vals.slice(1)], label: 'ストレート' };
  }
  if (counts[0] === 3) {
    const trip    = groups[0].v;
    const kickers = groups.slice(1).map(g => g.v);
    return { rank: 2, values: [trip, trip, trip, ...kickers], label: 'スリーオブアカインド' };
  }
  // 2ペア以下は6カードボーナスの対象外（rank 0 = 負け）
  return { rank: 0, values: vals, label: 'ノーペア以下' };
}

function _isStraight5(sortedDesc) {
  const [a, b, c, d, e] = sortedDesc;
  if (a - b === 1 && b - c === 1 && c - d === 1 && d - e === 1) return true;
  // A-2-3-4-5（A=14, 2-5: 5,4,3,2）
  if (a === 14 && b === 5 && c === 4 && d === 3 && e === 2) return true;
  return false;
}

function _straight5High(sortedDesc) {
  const [a, , , , e] = sortedDesc;
  if (a === 14 && e === 2) return 5; // A-2-3-4-5
  return a;
}

function _compareFive(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

module.exports = {
  evaluateThreeCardHand,
  compareThreeCardHands,
  dealerQualifies,
  getAnteBonus,
  getPairPlusPayout,
  getSixCardBonusPayout,
  evaluateSixCardBonus,
};
