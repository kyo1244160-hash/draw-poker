/**
 * gameManager.js
 * 2-7 トリプルドロー
 *
 * ゲームフロー:
 *   waiting
 *   → draw1  (ドロー1回目: BTNの左=SBから順番)
 *   → bet1   (ベット1回目: SBから)
 *   → draw2
 *   → bet2
 *   → draw3
 *   → bet3
 *   → showdown
 *
 * ベット: フィックスドリミット
 *   - bet1/bet2: smallBet (BB×1)
 *   - bet3: bigBet (BB×2)
 *   - 1ラウンドにベット1回+レイズ3回まで
 *
 * ポジション:
 *   BTN(ディーラー) → SB → BB → UTG...
 *   ドロー/ベットの行動順: SBから時計回り
 */

const { createShuffledDeck } = require('./deck');
const { evaluateHand, findWinner } = require('./handEvaluator');

const rooms = new Map();

// ベット額設定
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const SMALL_BET = 10;  // bet1, bet2
const BIG_BET = 20;    // bet3
const MAX_RAISES = 3;  // 1ラウンドのレイズ上限
const STARTING_CHIPS = 1000;

const PHASES = ['waiting','draw1','bet1','draw2','bet2','draw3','bet3','showdown'];

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      players: [],   // { id, name, chips, hand, bet, folded, acted, drewThisRound, drawCount }
      deck: [],
      phase: 'waiting',
      pot: 0,
      dealerIndex: -1,   // BTNのplayers[]インデックス
      actionIndex: -1,   // 現在アクション中のplayers[]インデックス
      currentBet: 0,     // このラウンドの最高ベット額
      raiseCount: 0,     // このラウンドのレイズ回数
      betSize: SMALL_BET,
    });
  }
  return rooms.get(roomId);
}

function joinRoom(roomId, socketId, name) {
  const room = getOrCreateRoom(roomId);
  const existing = room.players.find((p) => p.name === name);
  if (existing) { existing.id = socketId; return false; }
  room.players.push({
    id: socketId, name,
    chips: STARTING_CHIPS,
    hand: [], bet: 0, folded: false,
    acted: false, drewThisRound: false, drawCount: null,
  });
  return true;
}

// ===== ゲーム開始 =====
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.players.length < 2) return null;

  // デッキリセット
  room.deck = createShuffledDeck();
  room.pot = 0;

  // ディーラーボタンを進める
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;

  // 全プレイヤーリセット
  for (const p of room.players) {
    p.hand = room.deck.splice(0, 5);
    p.bet = 0; p.folded = false;
    p.acted = false; p.drewThisRound = false; p.drawCount = null;
  }

  // SB/BBポスト
  const sbIndex = (room.dealerIndex + 1) % room.players.length;
  const bbIndex = (room.dealerIndex + 2) % room.players.length;
  _postBlind(room, sbIndex, SMALL_BLIND);
  _postBlind(room, bbIndex, BIG_BLIND);

  // draw1: SBから順番 (acted フラグをリセット済み)
  room.phase = 'draw1';
  room.currentBet = 0;
  room.raiseCount = 0;
  room.actionIndex = sbIndex;
  _resetDrawRound(room);

  return room;
}

function _postBlind(room, idx, amount) {
  const p = room.players[idx];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet += actual;
  room.pot += actual;
}

function _resetDrawRound(room) {
  for (const p of room.players) p.drewThisRound = false;
}

function _resetBetRound(room, betSize) {
  room.currentBet = 0;
  room.raiseCount = 0;
  room.betSize = betSize;
  for (const p of room.players) { p.bet = 0; p.acted = false; }
}

// ===== ドロー =====
function drawCards(roomId, socketId, indices) {
  const room = rooms.get(roomId);
  if (!room || !room.phase.startsWith('draw')) return null;

  // 自分のターンかチェック
  const myIndex = room.players.findIndex((p) => p.id === socketId);
  if (myIndex !== room.actionIndex) return null;

  const player = room.players[myIndex];
  if (player.drewThisRound || player.folded) return null;

  // カード交換（0〜5枚）
  const validIndices = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < 5);
  for (const i of validIndices) {
    const newCard = room.deck.shift();
    if (newCard) player.hand[i] = newCard;
  }
  player.drewThisRound = true;
  player.drawCount = validIndices.length;

  // 次のアクティブプレイヤーへ
  _advanceDrawAction(room);
  return room;
}

function _advanceDrawAction(room) {
  const activePlayers = room.players.filter((p) => !p.folded);
  // 全員ドロー完了したら次フェーズへ
  if (activePlayers.every((p) => p.drewThisRound)) {
    _nextPhase(room);
    return;
  }
  // 次のまだドローしていないアクティブプレイヤーを探す
  let next = (room.actionIndex + 1) % room.players.length;
  while (room.players[next].folded || room.players[next].drewThisRound) {
    next = (next + 1) % room.players.length;
  }
  room.actionIndex = next;
}

// ===== ベット =====
function betAction(roomId, socketId, action, raiseAmount) {
  const room = rooms.get(roomId);
  if (!room || !room.phase.startsWith('bet')) return null;

  const myIndex = room.players.findIndex((p) => p.id === socketId);
  if (myIndex !== room.actionIndex) return null;

  const player = room.players[myIndex];
  if (player.folded) return null;

  const toCall = room.currentBet - player.bet;

  if (action === 'fold') {
    player.folded = true;
    player.acted = true;
  } else if (action === 'check') {
    // チェック可能なのは自分のベット額 = currentBet のとき
    if (toCall > 0) return null;
    player.acted = true;
  } else if (action === 'call') {
    const actual = Math.min(toCall, player.chips);
    player.chips -= actual;
    player.bet += actual;
    room.pot += actual;
    player.acted = true;
  } else if (action === 'bet' || action === 'raise') {
    if (room.raiseCount >= MAX_RAISES && action === 'raise') {
      // レイズ上限に達したらコールに変換
      const actual = Math.min(toCall, player.chips);
      player.chips -= actual;
      player.bet += actual;
      room.pot += actual;
      player.acted = true;
    } else {
      const betTotal = room.currentBet + room.betSize;
      const needed = betTotal - player.bet;
      const actual = Math.min(needed, player.chips);
      player.chips -= actual;
      player.bet += actual;
      room.pot += actual;
      room.currentBet = player.bet;
      room.raiseCount += 1;
      player.acted = true;
      // 他プレイヤーのactedをリセット（再びアクションが回る）
      for (let i = 0; i < room.players.length; i++) {
        if (i !== myIndex && !room.players[i].folded) room.players[i].acted = false;
      }
    }
  }

  _advanceBetAction(room);
  return room;
}

function _advanceBetAction(room) {
  const activePlayers = room.players.filter((p) => !p.folded);

  // 1人だけ残ったらそのプレイヤーの勝ち
  if (activePlayers.length <= 1) {
    room.phase = 'showdown';
    return;
  }

  // 全アクティブが acted && bet 揃ったら次フェーズへ
  const allActed = activePlayers.every((p) => p.acted);
  const betsEqual = activePlayers.every((p) => p.bet === activePlayers[0].bet);
  if (allActed && betsEqual) {
    _nextPhase(room);
    return;
  }

  // 次のアクションが必要なプレイヤーを探す
  let next = (room.actionIndex + 1) % room.players.length;
  while (room.players[next].folded || room.players[next].acted) {
    next = (next + 1) % room.players.length;
  }
  room.actionIndex = next;
}

function _nextPhase(room) {
  const idx = PHASES.indexOf(room.phase);
  const next = PHASES[idx + 1] ?? 'showdown';
  room.phase = next;

  if (next.startsWith('draw')) {
    _resetDrawRound(room);
    // ドロー順: SBから（BTNの左）
    const sbIndex = (room.dealerIndex + 1) % room.players.length;
    room.actionIndex = _nextActive(room, sbIndex - 1);
  } else if (next.startsWith('bet')) {
    // bet3 は bigBet、それ以外は smallBet
    const betSize = next === 'bet3' ? BIG_BET : SMALL_BET;
    _resetBetRound(room, betSize);
    // ベット順: SBから
    const sbIndex = (room.dealerIndex + 1) % room.players.length;
    room.actionIndex = _nextActive(room, sbIndex - 1);
  } else if (next === 'showdown') {
    // 何もしない
  }
}

function _nextActive(room, fromIndex) {
  let next = (fromIndex + 1) % room.players.length;
  while (room.players[next].folded) {
    next = (next + 1) % room.players.length;
  }
  return next;
}

// ===== ゲーム状態をクライアント向けに生成 =====
function buildGameState(room, requesterId) {
  const isShowdown = room.phase === 'showdown';
  const winnerId = isShowdown ? findWinner(room.players.filter((p) => !p.folded)) : null;

  // ショーダウン時に勝者にポットを付与（1回だけ）
  if (isShowdown && winnerId && !room._potAwarded) {
    const winner = room.players.find((p) => p.id === winnerId);
    if (winner) winner.chips += room.pot;
    room._potAwarded = true;
  }

  const currentPlayer = room.players[room.actionIndex];
  const isDrawPhase = room.phase.startsWith('draw');
  const isBetPhase = room.phase.startsWith('bet');

  return room.players.map((p) => {
    const isSelf = p.id === requesterId;
    const reveal = isShowdown || isSelf;
    const isMyTurn = !isShowdown && currentPlayer && p.id === currentPlayer.id;
    const toCall = isBetPhase ? Math.max(0, room.currentBet - p.bet) : 0;
    const canCheck = isBetPhase && toCall === 0;
    const canRaise = isBetPhase && room.raiseCount < MAX_RAISES;

    return {
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      hand: reveal ? p.hand : p.hand.map(() => '??'),
      isSelf,
      isMyTurn,
      drewThisRound: p.drewThisRound,
      drawCount: p.drawCount,        // 他プレイヤーに通知する交換枚数
      result: reveal && p.hand.length === 5 && !p.folded ? evaluateHand(p.hand) : undefined,
      isWinner: isShowdown && p.id === winnerId,
      // ポジション情報
      isDealer: room.players.indexOf(p) === room.dealerIndex,
      isSB: room.players.indexOf(p) === (room.dealerIndex + 1) % room.players.length,
      isBB: room.players.indexOf(p) === (room.dealerIndex + 2) % room.players.length,
      // ゲーム情報（isSelf の人だけに詳細を付与）
      ...(isSelf ? {
        toCall,
        canCheck,
        canRaise,
        betSize: room.betSize,
      } : {}),
    };
  }).concat([{
    // ルームメタ情報を特別フィールドで付与（プレイヤー配列外）
    _meta: true,
    phase: room.phase,
    pot: room.pot,
    currentBet: room.currentBet,
    betSize: room.betSize,
    raiseCount: room.raiseCount,
    dealerIndex: room.dealerIndex,
  }]);
}

function removePlayer(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    const before = room.players.length;
    room.players = room.players.filter((p) => p.id !== socketId);
    if (room.players.length < before) {
      if (room.players.length === 0) rooms.delete(roomId);
      return roomId;
    }
  }
  return null;
}

module.exports = {
  getOrCreateRoom, joinRoom,
  startGame, drawCards, betAction,
  buildGameState, removePlayer,
  SMALL_BLIND, BIG_BLIND, SMALL_BET, BIG_BET, STARTING_CHIPS,
};
