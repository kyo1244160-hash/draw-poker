/**
 * handEvaluator.js — ポーカー役判定モジュール
 *
 * 2種類のゲームの役判定を提供します：
 *   1. 2-7 Triple Draw （ローボール: 低い手が強い）
 *   2. Badugi          （4枚 + ローボール + スート全異なりが理想）
 */

// ===== 共通定数 =====

/** ランクの強さ（2が最低、Aが最高）*/
const RANK_ORDER = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

// ==========================================================
// ■ 2-7 Triple Draw 役判定
//   ローボール: 数字が低いほど強い
//   A は常に高い（弱い）
//   フラッシュ・ストレートも弱い手扱い
//   最強の手: 2-3-4-5-7 異スート
// ==========================================================

/**
 * 2-7 の手カテゴリを返す（小さいほど強い）
 *  0: ノーペア（最強）
 *  1: ワンペア
 *  2: ツーペア
 *  3: スリーカード
 *  4: ストレート
 *  5: フラッシュ
 *  6: フルハウス
 *  7: フォーカード
 *  8: ストレートフラッシュ（最弱）
 */
function get27Category(hand) {
  if (!hand || hand.length !== 5) return 8;

  const ranks = hand.map((c) => c[0]);
  const suits = hand.map((c) => c[1]);
  const nums  = ranks.map((r) => RANK_ORDER[r]).sort((a, b) => a - b);

  const isFlush    = suits.every((s) => s === suits[0]);
  const isStraight = nums[4] - nums[0] === 4 && new Set(nums).size === 5;

  // 枚数カウント（ペア判定用）
  const cnt = {};
  for (const n of nums) cnt[n] = (cnt[n] ?? 0) + 1;
  const freq = Object.values(cnt).sort((a, b) => b - a);

  if (isFlush && isStraight)              return 8; // ストレートフラッシュ（最弱）
  if (freq[0] === 4)                      return 7; // フォーカード
  if (freq[0] === 3 && freq[1] === 2)     return 6; // フルハウス
  if (isFlush)                            return 5; // フラッシュ
  if (isStraight)                         return 4; // ストレート
  if (freq[0] === 3)                      return 3; // スリーカード
  if (freq[0] === 2 && freq[1] === 2)     return 2; // ツーペア
  if (freq[0] === 2)                      return 1; // ワンペア
  return 0;                                         // ノーペア（最強）
}

/** 2-7 の役名（日本語）を返す */
function evaluate27Hand(hand) {
  const names = [
    'ノーペア', 'ワンペア', 'ツーペア', 'スリーカード',
    'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ',
  ];
  return names[get27Category(hand)] ?? '不明';
}

/**
 * 2-7 の2手を比較する
 * @returns {number} 負: handA が強い, 正: handB が強い, 0: 引き分け
 */
function compare27Hands(handA, handB) {
  const catA = get27Category(handA);
  const catB = get27Category(handB);
  if (catA !== catB) return catA - catB; // カテゴリが低いほど強い

  // 両方ノーペア → 最大カードから順に比較（低いほど強い）
  if (catA === 0) {
    const numsA = handA.map((c) => RANK_ORDER[c[0]]).sort((a, b) => b - a);
    const numsB = handB.map((c) => RANK_ORDER[c[0]]).sort((a, b) => b - a);
    for (let i = 0; i < 5; i++) {
      if (numsA[i] !== numsB[i]) return numsA[i] - numsB[i];
    }
  }
  return 0;
}

// ==========================================================
// ■ Badugi 役判定
//   4枚のカードを使うゲーム
//   強い手の条件（優先度順）:
//     1. 有効カード枚数が多いほど強い（4枚 > 3枚 > 2枚 > 1枚）
//     2. 同枚数なら最大ランクが低いほど強い
//     3. 同最大ランクなら2番目に大きいランクが低いほど強い...
//
//   「有効カード」= ランク重複なし、かつスート重複なしの最大組み合わせ
//   最強の手: A(♠)2(♥)3(♦)4(♣) — 4枚・全スート異なり・全ランク低い
// ==========================================================

/**
 * Badugi の有効カード（バドゥギ構成）を取り出す
 * 同ランク・同スートを除去し、最も強い（低ランク）組み合わせを返す
 *
 * @param {string[]} hand - 4枚の手札
 * @returns {{ cards: string[], count: number }} 有効カードとその枚数
 */
function getBadugiEffective(hand) {
  if (!hand || hand.length === 0) return { cards: [], count: 0 };

  // ランク昇順でソート（低いほど優先）
  const sorted = [...hand].sort((a, b) => RANK_ORDER[a[0]] - RANK_ORDER[b[0]]);

  const usedRanks = new Set();
  const usedSuits = new Set();
  const effective = [];

  for (const card of sorted) {
    const rank = card[0];
    const suit = card.slice(-1);
    // ランク・スートが未使用のカードだけ採用
    if (!usedRanks.has(rank) && !usedSuits.has(suit)) {
      effective.push(card);
      usedRanks.add(rank);
      usedSuits.add(suit);
    }
  }

  return { cards: effective, count: effective.length };
}

/** Badugi の役名（日本語）を返す */
function evaluateBadugiHand(hand) {
  const { count } = getBadugiEffective(hand);
  // 有効枚数に応じた呼称
  if (count === 4) return 'バドゥギ（4枚）';
  if (count === 3) return '3カードバドゥギ';
  if (count === 2) return '2カードバドゥギ';
  return '1カードバドゥギ';
}

/**
 * Badugi の2手を比較する
 * @returns {number} 負: handA が強い, 正: handB が強い, 0: 引き分け
 */
function compareBadugiHands(handA, handB) {
  const effA = getBadugiEffective(handA);
  const effB = getBadugiEffective(handB);

  // 有効枚数が多いほど強い
  if (effA.count !== effB.count) return effB.count - effA.count; // 多い方が強い

  // 同枚数 → 最大ランクから順に比較（低いほど強い）
  const numsA = effA.cards.map((c) => RANK_ORDER[c[0]]).sort((a, b) => b - a);
  const numsB = effB.cards.map((c) => RANK_ORDER[c[0]]).sort((a, b) => b - a);
  for (let i = 0; i < numsA.length; i++) {
    if (numsA[i] !== numsB[i]) return numsA[i] - numsB[i];
  }
  return 0;
}

// ==========================================================
// ■ 共通ユーティリティ
// ==========================================================

/**
 * プレイヤーリストから勝者の socketId を返す
 * @param {Array}    players   - { id, hand }[] フォールドしていないプレイヤー
 * @param {'27'|'badugi'} mode - ゲームモード
 */
function findWinner(players, mode = '27') {
  if (!players || players.length === 0) return null;
  const compare = mode === 'badugi' ? compareBadugiHands : compare27Hands;

  let winner = players[0];
  for (let i = 1; i < players.length; i++) {
    if (compare(players[i].hand, winner.hand) < 0) {
      winner = players[i]; // players[i] の方が強い
    }
  }
  return winner.id;
}

module.exports = {
  // 2-7 Triple Draw
  evaluate27Hand,
  compare27Hands,
  get27Category,
  // Badugi
  evaluateBadugiHand,
  compareBadugiHands,
  getBadugiEffective,
  // 共通
  findWinner,
  RANK_ORDER,
};
