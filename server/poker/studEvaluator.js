/**
 * studEvaluator.js — 7カードスタッド系の手役判定
 *
 * 対応ゲーム:
 *   'stud_s' — 7 Card Stud Hi（ハイハンド: 通常のポーカー役、強い手が勝ち）
 *   'stud_e' — Stud Eight or Better（Hi/Lo スプリット: ロークオリファイア8以下）
 *   'razz'   — Razz（A-5 ロー、7枚から最良の5枚ローを作る、ストレート/フラッシュ無視）
 *
 * 7枚から最良の5枚を選ぶ点が draw 系（手札=役）と根本的に異なる。
 *
 * ⚠️ フィールド名の注意（技術的負債・要将来統一）:
 *   本モジュールの勝者判定関数（findHiWinners/findLoWinners）は
 *   players[].cards を参照する。一方 handEvaluator.js（draw系）は
 *   players[].hand を参照する。同じ「プレイヤーの手札」概念で名前が異なるため、
 *   呼び出し側はモジュールごとに正しいフィールド名を渡すこと。
 *   将来テスト拡充後に 'cards' へ統一することを推奨。
 *
 * ハイハンドの強さ表現:
 *   { cat, tiebreak } の比較で勝敗を決める。
 *   cat: カテゴリ（大きいほど強い、0=ハイカード 〜 8=ストレートフラッシュ）
 *   tiebreak: 同カテゴリ内のキッカー配列（降順、大きいほど強い）
 *
 * ローハンドの強さ表現（A-5方式・8 or better / Razz共通）:
 *   { qualifies, ranks } — ranks は昇順の5枚（小さいほど強い）
 *   ※ Razz は qualifier 無し（必ず成立）。stud_e のローは8以下5枚が条件。
 */

// ハイ用ランク（Aは最高）
const RANK_HI = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

// ロー用ランク（Aは最低=1）
const RANK_LO = {
  'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13,
};

const RANK_NAME = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

/** 全 k 枚の組み合わせを列挙 */
function combinations(arr, k) {
  const result = [];
  const n = arr.length;
  if (k > n) return result;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    result.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return result;
}

// ==========================================================
// ■ ハイハンド評価（5枚）
// ==========================================================

/**
 * 5枚のハイハンドを評価
 * @returns {{cat:number, tiebreak:number[]}} cat大きいほど強い
 *   8: ストレートフラッシュ
 *   7: フォーカード
 *   6: フルハウス
 *   5: フラッシュ
 *   4: ストレート
 *   3: スリーカード
 *   2: ツーペア
 *   1: ワンペア
 *   0: ハイカード
 */
function evalHi5(hand) {
  const nums  = hand.map((c) => RANK_HI[c[0]]).sort((a, b) => b - a);
  const suits = hand.map((c) => c.slice(-1));

  // ストレート・フラッシュは5枚揃って初めて成立する。
  // 中間ストリート（3-4枚）では誤って成立させない。
  const hasFive = hand.length >= 5;
  const isFlush = hasFive && suits.every((s) => s === suits[0]);

  // ストレート判定（A-2-3-4-5 のホイール対応）
  const uniq = [...new Set(nums)].sort((a, b) => b - a);
  let isStraight = false;
  let straightHigh = 0;
  if (hasFive && uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) { isStraight = true; straightHigh = uniq[0]; }
    // ホイール: A-5-4-3-2 （A=14 を 1 扱い）
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) {
      isStraight = true; straightHigh = 5;
    }
  }

  // 枚数カウント
  const cnt = {};
  for (const n of nums) cnt[n] = (cnt[n] ?? 0) + 1;
  // [count, rank] でソート: count降順 → rank降順
  const groups = Object.entries(cnt)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const freq = groups.map((g) => g.count);

  if (isStraight && isFlush) return { cat: 8, tiebreak: [straightHigh] };
  if (freq[0] === 4)         return { cat: 7, tiebreak: [groups[0].rank, groups[1].rank] };
  if (freq[0] === 3 && freq[1] === 2) return { cat: 6, tiebreak: [groups[0].rank, groups[1].rank] };
  if (isFlush)               return { cat: 5, tiebreak: nums };
  if (isStraight)            return { cat: 4, tiebreak: [straightHigh] };
  if (freq[0] === 3)         return { cat: 3, tiebreak: [groups[0].rank, ...groups.slice(1).map((g) => g.rank)] };
  if (freq[0] === 2 && freq[1] === 2) return { cat: 2, tiebreak: [groups[0].rank, groups[1].rank, groups[2].rank] };
  if (freq[0] === 2)         return { cat: 1, tiebreak: [groups[0].rank, ...groups.slice(1).map((g) => g.rank)] };
  return { cat: 0, tiebreak: nums };
}

/** ハイの強さ比較（負: A強い, 正: B強い, 0: 引分）
 *  注意: 異なる枚数で評価された手同士の比較は想定していない。
 *  bestHi は5枚未満でも実カードで評価する（中間ストリート表示用）が、
 *  勝者判定(findHiWinners)は必ずショーダウン=全員7枚の状態でのみ呼ばれるため、
 *  枚数の異なる手が比較されることは実ゲームでは発生しない。
 *  将来フォールド者を含めて比較する等の変更を加える場合は枚数を揃えること。 */
function compareHi(a, b) {
  if (a.cat !== b.cat) return b.cat - a.cat;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] ?? 0;
    const bv = b.tiebreak[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}

/** 7枚から最良のハイ5枚を選ぶ */
function bestHi(cards) {
  // 5枚未満（中間ストリート）: ダミーで水増しすると存在しないペア等を捏造してしまうため、
  // 実際の手札だけで評価する。evalHi5 のカウント/ストレート判定は枚数非依存で動作する
  // （uniq.length===5 でないとストレート/フラッシュにならないため、3-4枚では自然に役なし）。
  if (!cards || cards.length === 0) {
    return { ev: { cat: 0, tiebreak: [0] }, cards: [] };
  }
  if (cards.length < 5) {
    return { ev: evalHi5(cards), cards: [...cards] };
  }
  const combos = combinations(cards, 5);
  let best = null;
  for (const c of combos) {
    const ev = evalHi5(c);
    if (!best || compareHi(ev, best.ev) < 0) best = { ev, cards: c };
  }
  return best;
}

const HI_CAT_NAME = [
  'ハイカード', 'ワンペア', 'ツーペア', 'スリーカード',
  'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ',
];

// ==========================================================
// ■ ローハンド評価（A-5方式 / 8 or better / Razz）
// ==========================================================

/**
 * 7枚から最良のロー5枚を選ぶ（A-5 ローボール、ストレート/フラッシュ無視）
 * @param {string[]} cards
 * @param {boolean}  requireEightOrBetter  true なら 8以下5枚が条件（stud_e用）
 * @param {boolean}  [bestEffort=false]  true なら5枚未満でも現状の最良ローを返す（Razz中間ストリート表示用）
 * @returns {{qualifies:boolean, ranks:number[], partial?:boolean}}
 *   ranks: 昇順（最大5枚）。比較時は降順に並べ替えて高い方から比較、低いほど強い
 *   partial: true の場合、5枚未満の途中経過（Razz中間ストリート）
 */
function bestLo(cards, requireEightOrBetter, bestEffort = false) {
  // 各ランクで最も低い5枚（重複ランクは1枚のみ有効）を貪欲に選ぶ
  // ロー最良 = 重複しない最も低い5ランク
  const byRank = new Map();
  for (const c of cards) {
    const r = RANK_LO[c[0]];
    if (!byRank.has(r)) byRank.set(r, c);
  }
  const uniqRanks = [...byRank.keys()].sort((a, b) => a - b);

  if (uniqRanks.length < 5) {
    // bestEffort（Razz中間ストリート表示）: 揃っているランクだけで部分的な手を返す。
    // Razz には qualifier が無く、最終的に必ず手が成立するため「ノークオリファイ」とは呼ばない。
    if (bestEffort) {
      return { qualifies: false, partial: true, ranks: uniqRanks.slice(0, 5) };
    }
    return { qualifies: false, ranks: [] };
  }

  const five = uniqRanks.slice(0, 5);
  if (requireEightOrBetter && five[4] > 8) return { qualifies: false, ranks: [] };

  return { qualifies: true, ranks: five };
}

/** ローの強さ比較（負: A強い, 正: B強い, 0: 引分。低いほど強い） */
function compareLo(a, b) {
  // 高い方のカードから比較し、低い方が強い
  const ra = [...a.ranks].sort((x, y) => y - x);
  const rb = [...b.ranks].sort((x, y) => y - x);
  for (let i = 0; i < 5; i++) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return 0;
}

/** ロー手の表示名（例: "8-6-4-2-A"） */
function loName(lo) {
  if (!lo.qualifies) return 'ノークオリファイ';
  const desc = [...lo.ranks].sort((a, b) => b - a);
  return desc.map((n) => RANK_NAME[n]).join('-');
}

// ==========================================================
// ■ 公開API: モード別の勝者判定
// ==========================================================

/**
 * 1人分の手を評価して { hi, lo } を返す
 * @param {string[]} cards 最大7枚
 * @param {'stud_s'|'stud_e'|'razz'} mode
 */
function evaluateStudHand(cards, mode) {
  if (mode === 'razz') {
    // Razz: ローのみ（qualifier 無し）。A-5、ストレート/フラッシュ無視。
    // bestEffort=true で5枚未満の中間ストリートでも現状の最良ローを返す。
    const lo = bestLo(cards, false, true);
    return { hi: null, lo };
  }
  if (mode === 'stud_e') {
    // Hi/Lo スプリット
    return { hi: bestHi(cards), lo: bestLo(cards, true) };
  }
  // stud_s: ハイのみ
  return { hi: bestHi(cards), lo: null };
}

/**
 * 表示用の役名を返す
 */
function studHandName(cards, mode) {
  const ev = evaluateStudHand(cards, mode);
  if (mode === 'razz') {
    // Razz は qualifier 無し。5枚揃えば確定ロー、未満なら現状のカードを低い順に表示。
    if (ev.lo.qualifies) return loName(ev.lo);
    if (ev.lo.ranks && ev.lo.ranks.length > 0) {
      // 中間ストリート: 現状の最良ロー候補を表示（例: "9-8-2"）
      const desc = [...ev.lo.ranks].sort((a, b) => b - a);
      return desc.map((n) => RANK_NAME[n]).join('-');
    }
    return '—';
  }
  if (mode === 'stud_e') {
    const hiName = ev.hi ? HI_CAT_NAME[ev.hi.ev.cat] : '';
    const loStr  = ev.lo.qualifies ? ` / Lo ${loName(ev.lo)}` : '';
    return hiName + loStr;
  }
  return ev.hi ? HI_CAT_NAME[ev.hi.ev.cat] : '';
}

/**
 * ハイ側の勝者を返す（スプリットポット対応・引き分けは複数）
 * @param {Array<{id,cards}>} players フォールドしていないプレイヤー
 * @param {string} mode
 * @returns {string[]} 勝者idの配列（ハイがないモードでは空）
 */
function findHiWinners(players, mode) {
  if (mode === 'razz') return [];
  if (!players || players.length === 0) return [];
  const evals = players.map((p) => ({ id: p.id, hi: bestHi(p.cards).ev }));
  let best = [evals[0]];
  for (let i = 1; i < evals.length; i++) {
    const cmp = compareHi(evals[i].hi, best[0].hi);
    if (cmp < 0) best = [evals[i]];
    else if (cmp === 0) best.push(evals[i]);
  }
  return best.map((e) => e.id);
}

/**
 * ロー側の勝者を返す（Razz は全員ロー成立、stud_e は8以下のみ）
 * @returns {string[]} 勝者idの配列（ロー成立者がいなければ空）
 */
function findLoWinners(players, mode) {
  if (mode === 'stud_s') return [];
  if (!players || players.length === 0) return [];
  const requireQual = mode === 'stud_e';

  if (mode === 'razz') {
    // Razz は qualifier 無し。全員が必ずロー手を持つ（7枚で5ユニーク未満の
    // 極端なケースでも bestEffort で部分手を作り、ペア込みで比較する）。
    // ペアが多いほど弱いローとして扱うため、ユニークランク数が多い方を優先。
    const evals = players.map((p) => {
      const lo = bestLo(p.cards, false, true);
      return { id: p.id, lo, uniqCount: lo.ranks.length };
    });
    // ユニーク5枚揃っている者を優先。揃っていなければペアを含む最良手で比較。
    const maxUniq = Math.max(...evals.map((e) => e.uniqCount));
    const eligible = evals.filter((e) => e.uniqCount === maxUniq);
    let best = [eligible[0]];
    for (let i = 1; i < eligible.length; i++) {
      const cmp = compareLo(eligible[i].lo, best[0].lo);
      if (cmp < 0) best = [eligible[i]];
      else if (cmp === 0) best.push(eligible[i]);
    }
    return best.map((e) => e.id);
  }

  const evals = players
    .map((p) => ({ id: p.id, lo: bestLo(p.cards, requireQual) }))
    .filter((e) => e.lo.qualifies);
  if (evals.length === 0) return [];
  let best = [evals[0]];
  for (let i = 1; i < evals.length; i++) {
    const cmp = compareLo(evals[i].lo, best[0].lo);
    if (cmp < 0) best = [evals[i]];
    else if (cmp === 0) best.push(evals[i]);
  }
  return best.map((e) => e.id);
}

/**
 * 3rd Street のブリングイン対象を判定
 * stud_s / stud_e: 最も低いアップカード（ドアカード）を持つプレイヤー
 *   ※同ランクはスート順 S>H>D>C で最も低い側
 * razz: 最も高いアップカードを持つプレイヤー
 * @param {Array<{id, upCard}>} players upCard は3rd streetの表向き1枚
 * @returns {string|null} ブリングイン対象のid
 */
const SUIT_ORDER = { S: 4, H: 3, D: 2, C: 1 }; // 高い順

function findBringIn(players, mode) {
  if (!players || players.length === 0) return null;
  const valid = players.filter((p) => p.upCard);
  if (valid.length === 0) return null;

  const score = (c) => RANK_HI[c[0]] * 10 + SUIT_ORDER[c.slice(-1)];

  if (mode === 'razz') {
    // 最も高いカードがブリングイン
    let target = valid[0];
    for (const p of valid) if (score(p.upCard) > score(target.upCard)) target = p;
    return target.id;
  }
  // stud_s / stud_e: 最も低いカードがブリングイン
  let target = valid[0];
  for (const p of valid) if (score(p.upCard) < score(target.upCard)) target = p;
  return target.id;
}

/**
 * 4th street以降の先頭アクション者（最強の見えている手）を判定
 * stud_s / stud_e: 最強のアップカード組
 * razz: 最弱（最もローに近い）のアップカード組
 * @param {Array<{id, upCards}>} players upCards は表向きカードの配列
 * @returns {string|null}
 */
function findHighHandFirst(players, mode) {
  if (!players || players.length === 0) return null;
  const valid = players.filter((p) => p.upCards && p.upCards.length > 0);
  if (valid.length === 0) return null;

  if (mode === 'razz') {
    // 最もローに近い（=弱いハイ）アップカード組が先頭
    let best = valid[0];
    for (let i = 1; i < valid.length; i++) {
      if (compareRazzBoard(valid[i].upCards, best.upCards) < 0) best = valid[i];
    }
    return best.id;
  }
  // stud_s / stud_e: 最強のアップカード組（ペア等含む）が先頭
  let best = valid[0];
  for (let i = 1; i < valid.length; i++) {
    if (compareBoardHi(valid[i].upCards, best.upCards) < 0) best = valid[i];
  }
  return best.id;
}

/** 表向きカード同士のハイ比較（ペア等を考慮、負: A強い） */
function compareBoardHi(a, b) {
  const evA = evalBoardPartial(a);
  const evB = evalBoardPartial(b);
  return compareHi(evA, evB);
}

/** 任意枚数の表向きカードを簡易ハイ評価（2〜4枚） */
function evalBoardPartial(cards) {
  const nums = cards.map((c) => RANK_HI[c[0]]).sort((a, b) => b - a);
  const cnt = {};
  for (const n of nums) cnt[n] = (cnt[n] ?? 0) + 1;
  const groups = Object.entries(cnt)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const freq = groups.map((g) => g.count);
  let cat = 0;
  if (freq[0] === 4) cat = 7;
  else if (freq[0] === 3 && freq[1] === 2) cat = 6;
  else if (freq[0] === 3) cat = 3;
  else if (freq[0] === 2 && freq[1] === 2) cat = 2;
  else if (freq[0] === 2) cat = 1;
  return { cat, tiebreak: groups.map((g) => g.rank) };
}

/** Razzボード比較（最もローに近い側が先頭。負: A が先頭向き=強い） */
function compareRazzBoard(a, b) {
  // ペアはRazzでは弱い。ローとして高いカードから比較し低い方が先頭
  const la = razzBoardRanks(a);
  const lb = razzBoardRanks(b);
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    const av = la[i] ?? 99;
    const bv = lb[i] ?? 99;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/** Razz用: 表向きカードをロー評価向けに降順で返す（ペアは高く扱う） */
function razzBoardRanks(cards) {
  // ペアがあるとローとして弱くなる → ペアを構成するランクを優先的に高く
  const nums = cards.map((c) => RANK_LO[c[0]]);
  const cnt = {};
  for (const n of nums) cnt[n] = (cnt[n] ?? 0) + 1;
  // ペア有無で重み付け: ペアを持つランクは「悪い」ので先に来るよう降順 + ペア優先
  const sorted = [...nums].sort((a, b) => {
    if (cnt[b] !== cnt[a]) return cnt[b] - cnt[a]; // ペア数多い方を先（弱い）
    return b - a; // 高いランクを先（弱い）
  });
  return sorted;
}

module.exports = {
  evaluateStudHand,
  studHandName,
  findHiWinners,
  findLoWinners,
  findBringIn,
  findHighHandFirst,
  // テスト用にエクスポート
  bestHi,
  bestLo,
  compareHi,
  compareLo,
  evalHi5,
  RANK_HI,
  RANK_LO,
};
