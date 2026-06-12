'use strict';

const {
  bestHi,
  bestLo,
  compareHi,
  compareLo,
} = require('./studEvaluator');

function combinations(arr, k) {
  const out = [];
  if (!Array.isArray(arr) || k > arr.length) return out;
  const walk = (start, picked) => {
    if (picked.length === k) {
      out.push([...picked]);
      return;
    }
    for (let i = start; i <= arr.length - (k - picked.length); i++) {
      picked.push(arr[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

function evaluateHoldem(playerCards, boardCards) {
  const cards = [...(playerCards || []), ...(boardCards || [])];
  const hi = bestHi(cards);
  return {
    hi,
    lo: null,
    name: hiName(hi?.ev),
    bestCards: hi?.cards ?? [],
  };
}

function evaluateOmaha8(playerCards, boardCards) {
  const holeCombos = combinations(playerCards || [], 2);
  const boardCombos = combinations(boardCards || [], 3);
  let bestHiResult = null;
  let bestLoResult = null;

  for (const hole of holeCombos) {
    for (const board of boardCombos) {
      const five = [...hole, ...board];
      const hi = bestHi(five);
      if (!bestHiResult || compareHi(hi.ev, bestHiResult.hi.ev) < 0) {
        bestHiResult = { hi, cards: five };
      }
      const lo = bestLo(five, true);
      if (lo.qualifies && (!bestLoResult || compareLo(lo, bestLoResult.lo) < 0)) {
        bestLoResult = { lo, cards: five };
      }
    }
  }

  return {
    hi: bestHiResult?.hi ?? null,
    lo: bestLoResult?.lo ?? { qualifies: false, ranks: [] },
    name: `${hiName(bestHiResult?.hi?.ev)}${bestLoResult ? ` / Lo ${loName(bestLoResult.lo)}` : ''}`,
    bestCards: bestHiResult?.cards ?? [],
    lowCards: bestLoResult?.cards ?? [],
  };
}

function compareBoardHiEval(a, b) {
  return compareHi(a.hi.ev, b.hi.ev);
}

function compareBoardLoEval(a, b) {
  return compareLo(a.lo, b.lo);
}

function findBoardHiWinners(players, boardCards, mode) {
  const evals = players
    .filter((p) => !p.folded && !p.sittingOut)
    .map((p) => ({
      id: p.id,
      ev: mode === 'fl_omaha8'
        ? evaluateOmaha8(p.hand, boardCards)
        : evaluateHoldem(p.hand, boardCards),
    }))
    .filter((e) => e.ev.hi);
  if (evals.length === 0) return [];

  let best = [evals[0]];
  for (let i = 1; i < evals.length; i++) {
    const cmp = compareBoardHiEval(evals[i].ev, best[0].ev);
    if (cmp < 0) best = [evals[i]];
    else if (cmp === 0) best.push(evals[i]);
  }
  return best.map((e) => e.id);
}

function findBoardLoWinners(players, boardCards, mode) {
  if (mode !== 'fl_omaha8') return [];
  const evals = players
    .filter((p) => !p.folded && !p.sittingOut)
    .map((p) => ({ id: p.id, ev: evaluateOmaha8(p.hand, boardCards) }))
    .filter((e) => e.ev.lo?.qualifies);
  if (evals.length === 0) return [];

  let best = [evals[0]];
  for (let i = 1; i < evals.length; i++) {
    const cmp = compareBoardLoEval(evals[i].ev, best[0].ev);
    if (cmp < 0) best = [evals[i]];
    else if (cmp === 0) best.push(evals[i]);
  }
  return best.map((e) => e.id);
}

const HI_CAT_NAME = [
  'ハイカード', 'ワンペア', 'ツーペア', 'スリーカード',
  'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ',
];
const RANK_NAME = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

function hiName(ev) {
  return ev ? (HI_CAT_NAME[ev.cat] ?? 'ハイカード') : '';
}

function loName(lo) {
  if (!lo?.qualifies) return 'ノークオリファイ';
  return [...lo.ranks].sort((a, b) => b - a).map((n) => RANK_NAME[n]).join('-');
}

function boardHandName(playerCards, boardCards, mode) {
  const ev = mode === 'fl_omaha8'
    ? evaluateOmaha8(playerCards, boardCards)
    : evaluateHoldem(playerCards, boardCards);
  return ev.name;
}

module.exports = {
  evaluateHoldem,
  evaluateOmaha8,
  findBoardHiWinners,
  findBoardLoWinners,
  boardHandName,
  combinations,
};
