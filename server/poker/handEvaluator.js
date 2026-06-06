/**
 * handEvaluator.js — ポーカー役判定モジュール
 *
 * 2種類のゲームの役判定を提供します：
 *   1. 2-7 Triple Draw （ローボール: 低い手が強い）
 *   2. Badugi          （4枚 + ローボール + スート全異なりが理想）
 */

// ===== 共通定数 =====

/**
 * 2-7 Triple Draw 用ランク順（A は最高位 = 最弱）
 * Badugi では使用しないこと
 */
const RANK_ORDER = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

/**
 * Badugi 専用ランク順（A は最低位 = 最強）
 * Badugi はローボール + A は 1 扱い
 * 最強手: A(1)-2-3-4
 */
const RANK_ORDER_BADUGI = {
  'A': 1,
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13,
};

/**
 * A-5 Triple Draw 用ランク順（A は最低位 = 最強）
 * ストレート・フラッシュは無視されるローボール
 * 最強手: A-2-3-4-5
 */
const RANK_ORDER_A5 = {
  'A': 1,
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13,
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
  // 2-7 ローボール専用の役名
  // ノーペアのみ「〇ロー」（最大カードで表示）
  const cat = get27Category(hand);
  if (cat === 0) {
    // ノーペア: 最大カードを特定して「X ロー」と表示
    const nums = hand.map((c) => RANK_ORDER[c[0]]).sort((a, b) => b - a);
    const rankName = {2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K',14:'A'};
    return rankName[nums[0]] + ' ロー';
  }
  const names = [
    '', 'ワンペア', 'ツーペア', 'スリーカード',
    'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ',
  ];
  return names[cat] ?? '不明';
}

/**
 * 2-7 の2手を比較する
 * @returns {number} 負: handA が強い, 正: handB が強い, 0: 引き分け
 */
function compare27Hands(handA, handB) {
  const catA = get27Category(handA);
  const catB = get27Category(handB);
  if (catA !== catB) return catA - catB; // カテゴリが低いほど強い

  const groupedCats = new Set([1, 2, 3, 6, 7]);
  if (groupedCats.has(catA)) {
    return compareLowGroupedHands(handA, handB, RANK_ORDER, catA);
  }

  // 同カテゴリ → カードを降順に並べて順番に比較（低いほど強い）
  const numsA = handA.map((c) => RANK_ORDER[c[0]]).sort((a, b) => b - a);
  const numsB = handB.map((c) => RANK_ORDER[c[0]]).sort((a, b) => b - a);
  for (let i = 0; i < numsA.length; i++) {
    if (numsA[i] !== numsB[i]) return numsA[i] - numsB[i];
  }
  return 0;
}

// ==========================================================
// ■ A-5 Triple Draw 役判定
//   ローボール: 数字が低いほど強い
//   A は常に低い（強い） — A=1扱い
//   ストレート・フラッシュは無視（役にならない）
//   最強の手: A-2-3-4-5
// ==========================================================

/**
 * A-5 の手カテゴリを返す（小さいほど強い）
 * ストレート・フラッシュを無視するため、カテゴリ数が2-7より少ない
 *  0: ノーペア（最強）
 *  1: ワンペア
 *  2: ツーペア
 *  3: スリーカード
 *  4: フルハウス
 *  5: フォーカード
 */
function getA5Category(hand) {
  if (!hand || hand.length !== 5) return 5;

  const ranks = hand.map((c) => c[0]);
  const nums  = ranks.map((r) => RANK_ORDER_A5[r]).sort((a, b) => a - b);

  // 枚数カウント（ペア判定用）
  const cnt = {};
  for (const n of nums) cnt[n] = (cnt[n] ?? 0) + 1;
  const freq = Object.values(cnt).sort((a, b) => b - a);

  if (freq[0] === 4)                      return 5; // フォーカード
  if (freq[0] === 3 && freq[1] === 2)     return 4; // フルハウス
  if (freq[0] === 3)                      return 3; // スリーカード
  if (freq[0] === 2 && freq[1] === 2)     return 2; // ツーペア
  if (freq[0] === 2)                      return 1; // ワンペア
  return 0;                                         // ノーペア（最強）
}

/** A-5 の役名（日本語）を返す */
function evaluateA5Hand(hand) {
  const cat = getA5Category(hand);
  if (cat === 0) {
    // ノーペア: 最大カードを特定して「X ロー」と表示
    const nums = hand.map((c) => RANK_ORDER_A5[c[0]]).sort((a, b) => b - a);
    const rankName = {1:'A',2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K'};
    return rankName[nums[0]] + ' ロー';
  }
  const names = [
    '', 'ワンペア', 'ツーペア', 'スリーカード',
    'フルハウス', 'フォーカード',
  ];
  return names[cat] ?? '不明';
}

/**
 * A-5 の2手を比較する
 * @returns {number} 負: handA が強い, 正: handB が強い, 0: 引き分け
 */
function compareA5Hands(handA, handB) {
  const catA = getA5Category(handA);
  const catB = getA5Category(handB);
  if (catA !== catB) return catA - catB;

  if (catA !== 0) {
    return compareLowGroupedHands(handA, handB, RANK_ORDER_A5, catA);
  }

  // 同カテゴリ → カードを降順に並べて順番に比較（低いほど強い、A=1）
  const numsA = handA.map((c) => RANK_ORDER_A5[c[0]]).sort((a, b) => b - a);
  const numsB = handB.map((c) => RANK_ORDER_A5[c[0]]).sort((a, b) => b - a);
  for (let i = 0; i < numsA.length; i++) {
    if (numsA[i] !== numsB[i]) return numsA[i] - numsB[i];
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
 * 同ランク・同スートを除去し、最も強い（低ランク・最大枚数）組み合わせを返す
 *
 * 貪欲法（低ランク優先）は「同ランクのどのスートを選ぶか」によって
 * 後続カードのスート重複が変わるため最適解にならない場合がある。
 * 手札は常に4枚なので全部分集合（最大16通り）を総当たりで評価する。
 *
 * @param {string[]} hand - 4枚の手札
 * @returns {{ cards: string[], count: number }} 有効カードとその枚数
 */
function getBadugiEffective(hand) {
  if (!hand || hand.length === 0) return { cards: [], count: 0 };

  let best = [];

  // 全部分集合を評価（hand.length <= 4 なので最大 2^4 = 16 通り）
  for (let mask = 1; mask < (1 << hand.length); mask++) {
    const selected = hand.filter((_, i) => mask & (1 << i));
    const ranks = selected.map((c) => c[0]);
    const suits = selected.map((c) => c.slice(-1));

    // ランク・スートがすべて異なる組み合わせだけ有効
    if (new Set(ranks).size !== ranks.length) continue;
    if (new Set(suits).size !== suits.length) continue;

    if (selected.length > best.length) {
      // 枚数が多ければ無条件で更新
      best = selected;
    } else if (selected.length === best.length) {
      // 同枚数の場合: 最大ランクから順に比較し、小さい方（強い方）を採用
      // Badugi では A=1（最低位）なので RANK_ORDER_BADUGI を使用
      const numsNew  = selected.map((c) => RANK_ORDER_BADUGI[c[0]]).sort((a, b) => b - a);
      const numsBest = best.map((c) => RANK_ORDER_BADUGI[c[0]]).sort((a, b) => b - a);
      for (let i = 0; i < numsNew.length; i++) {
        if (numsNew[i] < numsBest[i]) { best = selected; break; }
        if (numsNew[i] > numsBest[i]) break;
      }
    }
  }

  return { cards: best, count: best.length };
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
  // Badugi では A=1（最低位）なので RANK_ORDER_BADUGI を使用
  const numsA = effA.cards.map((c) => RANK_ORDER_BADUGI[c[0]]).sort((a, b) => b - a);
  const numsB = effB.cards.map((c) => RANK_ORDER_BADUGI[c[0]]).sort((a, b) => b - a);
  for (let i = 0; i < numsA.length; i++) {
    if (numsA[i] !== numsB[i]) return numsA[i] - numsB[i];
  }
  return 0;
}

// ==========================================================
// ■ 共通ユーティリティ
// ==========================================================

function lowGroupedKey(hand, rankOrder, category) {
  const cnt = {};
  for (const c of hand) {
    const n = rankOrder[c[0]];
    cnt[n] = (cnt[n] ?? 0) + 1;
  }
  const ranksByCount = (count) => Object.entries(cnt)
    .filter(([, v]) => v === count)
    .map(([r]) => Number(r))
    .sort((a, b) => b - a);

  if (category === 1) {
    const pair = ranksByCount(2)[0];
    const kickers = ranksByCount(1);
    return [pair, ...kickers];
  }
  if (category === 2) {
    const pairs = ranksByCount(2);
    const kicker = ranksByCount(1)[0];
    return [...pairs, kicker];
  }
  if (category === 3) {
    const trips = ranksByCount(3)[0];
    const kickers = ranksByCount(1);
    return [trips, ...kickers];
  }
  if (category === 4) {
    const trips = ranksByCount(3)[0];
    const pair = ranksByCount(2)[0];
    return [trips, pair];
  }
  if (category === 6) {
    const trips = ranksByCount(3)[0];
    const pair = ranksByCount(2)[0];
    return [trips, pair];
  }
  if (category === 5 || category === 7) {
    const quads = ranksByCount(4)[0];
    const kicker = ranksByCount(1)[0];
    return [quads, kicker];
  }
  return hand.map((c) => rankOrder[c[0]]).sort((a, b) => b - a);
}

function compareLowGroupedHands(handA, handB, rankOrder, category) {
  const keyA = lowGroupedKey(handA, rankOrder, category);
  const keyB = lowGroupedKey(handB, rankOrder, category);
  for (let i = 0; i < Math.max(keyA.length, keyB.length); i++) {
    const av = keyA[i] ?? 0;
    const bv = keyB[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * プレイヤーリストから勝者の socketId を返す（引き分け時は先頭のみ返す）
 * @param {Array}    players   - { id, hand }[] フォールドしていないプレイヤー
 * @param {'27'|'badugi'} mode - ゲームモード
 */
function findWinner(players, mode = '27') {
  const winners = findWinners(players, mode);
  return winners.length > 0 ? winners[0].id : null;
}

/**
 * プレイヤーリストから同点を含む全勝者を返す（スプリットポット対応）
 * @param {Array}    players   - { id, hand }[] フォールドしていないプレイヤー
 *   ⚠️ 注意: draw系は players[].hand を使う。スタッド系(studEvaluator)は
 *   players[].cards を使うため、混同しないこと（技術的負債・将来統一予定）。
 * @param {'27'|'badugi'|'a5'} mode - ゲームモード
 * @returns {Array} 最強手を持つプレイヤーの配列（引き分けなら複数）
 */
function findWinners(players, mode = '27') {
  if (!players || players.length === 0) return [];
  const compare = mode === 'badugi' ? compareBadugiHands
                : mode === 'a5'     ? compareA5Hands
                : compare27Hands;

  let best = [players[0]];
  for (let i = 1; i < players.length; i++) {
    const cmp = compare(players[i].hand, best[0].hand);
    if (cmp < 0) {
      best = [players[i]]; // players[i] の方が強い → 更新
    } else if (cmp === 0) {
      best.push(players[i]); // 引き分け → 追加
    }
  }
  return best;
}

module.exports = {
  // 2-7 Triple Draw
  evaluate27Hand,
  compare27Hands,
  get27Category,
  // A-5 Triple Draw
  evaluateA5Hand,
  compareA5Hands,
  getA5Category,
  // Badugi
  evaluateBadugiHand,
  compareBadugiHands,
  getBadugiEffective,
  // 共通
  findWinner,
  findWinners,
  RANK_ORDER,
  RANK_ORDER_A5,
};
