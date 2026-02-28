/**
 * handEvaluator.js
 * 2-7 トリプルドロー ローボール役判定
 *
 * ルール:
 *   - 数字が低いほど強い（2が最強、A は常に高い=弱い）
 *   - フラッシュ・ストレートは「悪い手」（ノーペアより弱い）
 *   - 最強の手: 2-3-4-5-7 異なるスート
 *
 * カテゴリ（小さいほど強い）:
 *   0: ノーペア（最強）
 *   1: ワンペア
 *   2: ツーペア
 *   3: スリーカード
 *   4: ストレート
 *   5: フラッシュ
 *   6: フルハウス
 *   7: フォーカード
 *   8: ストレートフラッシュ（最弱）
 */

const RANK_ORDER = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

function getHandCategory(hand) {
  if (!hand || hand.length !== 5) return 8;

  const ranks = hand.map((c) => c[0]);
  const suits = hand.map((c) => c[1]);
  const rankNums = ranks.map((r) => RANK_ORDER[r]).sort((a, b) => a - b);

  const isFlush = suits.every((s) => s === suits[0]);
  const isStraight =
    rankNums[4] - rankNums[0] === 4 && new Set(rankNums).size === 5;

  const counts = {};
  for (const r of rankNums) counts[r] = (counts[r] ?? 0) + 1;
  const freq = Object.values(counts).sort((a, b) => b - a);

  if (isFlush && isStraight) return 8;
  if (freq[0] === 4) return 7;
  if (freq[0] === 3 && freq[1] === 2) return 6;
  if (isFlush) return 5;
  if (isStraight) return 4;
  if (freq[0] === 3) return 3;
  if (freq[0] === 2 && freq[1] === 2) return 2;
  if (freq[0] === 2) return 1;
  return 0;
}

function evaluateHand(hand) {
  const names = [
    'ノーペア', 'ワンペア', 'ツーペア', 'スリーカード',
    'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ',
  ];
  return names[getHandCategory(hand)] ?? '不明';
}

/**
 * 2手を比較（負: handA が強い, 正: handB が強い, 0: 引き分け）
 */
function compareHands(handA, handB) {
  const catA = getHandCategory(handA);
  const catB = getHandCategory(handB);
  if (catA !== catB) return catA - catB;

  // どちらもノーペア → 最高カードから順に比較（低い方が強い）
  if (catA === 0) {
    const numsA = handA.map((c) => RANK_ORDER[c[0]]).sort((a, b) => b - a);
    const numsB = handB.map((c) => RANK_ORDER[c[0]]).sort((a, b) => b - a);
    for (let i = 0; i < 5; i++) {
      if (numsA[i] !== numsB[i]) return numsA[i] - numsB[i];
    }
  }
  return 0;
}

function findWinner(players) {
  if (!players || players.length === 0) return null;
  let winner = players[0];
  for (let i = 1; i < players.length; i++) {
    if (compareHands(players[i].hand, winner.hand) < 0) winner = players[i];
  }
  return winner.id;
}

function getHandRank(hand) {
  return 8 - getHandCategory(hand);
}

module.exports = { evaluateHand, getHandRank, getHandCategory, compareHands, findWinner };
