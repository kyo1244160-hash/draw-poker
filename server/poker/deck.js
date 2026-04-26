/**
 * deck.js
 * デッキの生成・シャッフル処理
 */

const { randomInt } = require('crypto'); // Math.random() より予測困難な暗号論的乱数
const SUITS = ['S', 'H', 'D', 'C']; // スペード・ハート・ダイヤ・クラブ
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];

/**
 * 52枚のデッキを生成する
 * カード表記: ランク + スート (例: 'AS'=Aスペード, 'TC'=10クラブ)
 */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

/**
 * Fisher-Yates アルゴリズムでデッキをシャッフル（暗号論的乱数使用）
 */
function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1); // crypto.randomInt: 上限exclusive
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * シャッフル済みの新しいデッキを返す
 */
function createShuffledDeck() {
  return shuffleDeck(createDeck());
}

module.exports = { createDeck, shuffleDeck, createShuffledDeck };
