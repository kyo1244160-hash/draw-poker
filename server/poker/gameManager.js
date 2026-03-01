/**
 * gameManager.js — ゲーム状態管理
 *
 * 対応ゲーム:
 *   '27'     — 2-7 Triple Draw（5枚 × 3回ドロー）
 *   'badugi' — Badugi（4枚 × 3回ドロー）
 *   'mix'    — BTN一周ごとに 2-7 ↔ Badugi 切替
 *
 * ゲームフロー:
 *   waiting → bet0(プリドロー) → draw1 → bet1 → draw2 → bet2 → draw3 → bet3 → showdown
 *
 * ベット額（フィックスドリミット / 5bet-cap）:
 *   bet0/bet1: SMALL_BET単位（10, 20, 30, 40, 50）
 *   bet2:      SMALL_BET単位（draw2前まで）
 *   bet3:      BIG_BET単位（20, 40, 60, 80, 100）
 *   ※ draw2以降（bet2, bet3）はビッグベット
 *
 * タイムアウト:
 *   ドロー: 現在クライアントが選択中のカードを交換（selectedIndicesを保持）
 *   ベット: フォールド
 *
 * 参加制限: 最大6人
 */

const { createShuffledDeck, shuffleDeck }                             = require('./deck');
const { evaluate27Hand, evaluateBadugiHand, findWinner } = require('./handEvaluator');
const cfg                                                = require('../config');

// ===== 定数 =====
const SMALL_BLIND = cfg.SMALL_BLIND;
const BIG_BLIND   = cfg.BIG_BLIND;
const SMALL_BET   = cfg.SMALL_BET;   // 10
const BIG_BET     = cfg.BIG_BET;     // 20
const MAX_RAISES  = cfg.MAX_RAISES;  // 4（5bet-cap）
const MAX_PLAYERS = cfg.MAX_PLAYERS; // 6
const STARTING_CHIPS = cfg.STARTING_BB * cfg.BB_VALUE;

/**
 * フェーズ一覧
 * bet2以降はビッグベット（draw2を超えた後）
 */
const PHASES = ['waiting','bet0','draw1','bet1','draw2','bet2','draw3','bet3','showdown'];

/** ビッグベットフェーズか判定（draw2以降） */
function isBigBetPhase(phase) {
  return phase === 'bet2' || phase === 'bet3';
}

/** roomId からゲームモードを取得 */
function getRoomMode(roomId) {
  if (roomId.includes('badugi')) return 'badugi';
  if (roomId.includes('mix'))    return 'mix';
  return '27';
}

/** 手札枚数 */
function handSize(mode) { return mode === 'badugi' ? 4 : 5; }

/** 役判定 */
function evaluateHand(hand, mode) {
  return mode === 'badugi' ? evaluateBadugiHand(hand) : evaluate27Hand(hand);
}

/** mix モードの現在ゲームモード */
function getMixCurrentMode(room) {
  const cycle = Math.floor(room.handCount / Math.max(1, room.players.length)) % 2;
  return cycle === 0 ? '27' : 'badugi';
}

// ===== ルームストレージ =====
const rooms = new Map();

function getOrCreateRoom(roomId, opts = {}) {
  if (!rooms.has(roomId)) {
    const baseMode = getRoomMode(roomId);
    rooms.set(roomId, {
      id:             roomId,
      label:          opts.label          ?? roomId,
      mode:           baseMode,
      currentMode:    baseMode === 'mix' ? '27' : baseMode,
      password:       opts.password       ?? null,
      isUserCreated:  opts.isUserCreated  ?? false,
      players:        [],
      pendingPlayers: [],
      deck:           [],
      phase:          'waiting',
      pot:            0,
      dealerIndex:    -1,
      actionIndex:    -1,
      currentBet:     0,
      raiseCount:     0,
      betSize:        SMALL_BET,
      handCount:      0,
      discardPile:   [],  // 捨て札（デッキ切れ時にリシャッフル）
      _potAwarded:    false,
      _timer:         null,
      _timerStart:    null,
      _timerLimit:    0,
      _onTimeout:     null,
      // ドローフェーズでの各プレイヤーの選択中カードインデックスを管理
      // { socketId: number[] } タイムアウト時にこれを使って交換する
      _selectedIndices: {},
    });
  }
  return rooms.get(roomId);
}

/**
 * プレイヤー参加
 * @returns {'active'|'pending'|'reconnected'|'full'}
 */
function joinRoom(roomId, socketId, name) {
  const room = getOrCreateRoom(roomId);

  // 再接続
  const existing = room.players.find((p) => p.name === name);
  if (existing) { existing.id = socketId; return 'reconnected'; }
  const existingPending = room.pendingPlayers.find((p) => p.name === name);
  if (existingPending) { existingPending.id = socketId; return 'pending'; }

  // 6人制限
  if (room.players.length + room.pendingPlayers.length >= MAX_PLAYERS) {
    return 'full';
  }

  const newPlayer = {
    id: socketId, name,
    chips: STARTING_CHIPS,
    hand: [], bet: 0, folded: false,
    acted: false, drewThisRound: false, drawCount: null,
    sittingOut: false,
  };

  const inProgress = PHASES.indexOf(room.phase) > 0 && room.phase !== 'showdown';
  if (inProgress) {
    room.pendingPlayers.push(newPlayer);
    return 'pending';
  }

  room.players.push(newPlayer);

  // showdown中の着席位置チェック（BTN-SB間は1ハンド待機）
  if (room.phase === 'showdown' && room.dealerIndex >= 0 && room.players.length > 2) {
    const myIdx = room.players.length - 1;
    const sbIdx = _nextActiveFromSafe(room, room.dealerIndex);
    if (myIdx <= sbIdx) newPlayer.sittingOut = true;
  }

  return 'active';
}

// ==========================================================
// ■ ゲーム開始
// ==========================================================

function startGame(roomId, onTimeout) {
  const room = rooms.get(roomId);
  if (!room) return null;

  // pending → active
  for (const p of room.pendingPlayers) room.players.push(p);
  room.pendingPlayers = [];
  for (const p of room.players) p.sittingOut = false;

  const activePlayers = room.players.filter((p) => !p.sittingOut);
  if (activePlayers.length < 2) return null;

  // mix モード切替
  if (room.mode === 'mix') room.currentMode = getMixCurrentMode(room);
  else room.currentMode = room.mode;

  // リセット
  room.deck             = createShuffledDeck();
  room.discardPile      = [];  // 捨て札をリセット
  room.pot              = 0;
  room._potAwarded      = false;
  room._onTimeout       = onTimeout;
  room._selectedIndices = {};
  room.handCount       += 1;

  // ディーラーボタン前進
  if (room.dealerIndex < 0) {
    room.dealerIndex = 0;
  } else {
    let next = (room.dealerIndex + 1) % room.players.length;
    for (let t = 0; t < room.players.length; t++) {
      if (!room.players[next]?.sittingOut) break;
      next = (next + 1) % room.players.length;
    }
    room.dealerIndex = next;
  }

  // 手札配布・リセット
  const size = handSize(room.currentMode);
  for (const p of room.players) {
    p.chips         = STARTING_CHIPS;
    p.hand          = p.sittingOut ? [] : room.deck.splice(0, size);
    p.bet           = 0;
    p.folded        = !!p.sittingOut;
    p.acted         = !!p.sittingOut;
    p.drewThisRound = false;
    p.drawCount     = null;
  }

  // SB / BB ポスト
  const sbIndex = _nextActiveFromSafe(room, room.dealerIndex);
  const bbIndex = _nextActiveFromSafe(room, sbIndex);
  _postBlind(room, sbIndex, SMALL_BLIND);
  _postBlind(room, bbIndex, BIG_BLIND);

  // bet0（プリドロー）フェーズへ: UTG（BBの左）から
  const utgIndex = _nextActiveFromSafe(room, bbIndex);
  room.phase      = 'bet0';
  room.currentBet = BIG_BLIND;
  room.raiseCount = 0;
  room.betSize    = SMALL_BET;
  // BBはオプション権あり（acted = false のまま）
  room.players[bbIndex].acted = false;
  room.actionIndex = utgIndex;
  _startTimer(room);

  return room;
}

function _postBlind(room, idx, amount) {
  const p = room.players[idx];
  if (!p) return;
  const actual = Math.min(amount, p.chips);
  p.chips -= actual; p.bet += actual; room.pot += actual;
}

/**
 * 次のアクティブプレイヤーのインデックスを安全に返す
 * （負インデックス・folded・sittingOut をスキップ）
 */
function _nextActiveFromSafe(room, fromIndex) {
  const len = room.players.length;
  if (len === 0) return 0;
  const start = ((fromIndex % len) + len) % len;
  let next = (start + 1) % len;
  for (let t = 0; t < len; t++) {
    const p = room.players[next];
    if (p && !p.folded && !p.sittingOut) return next;
    next = (next + 1) % len;
  }
  return next;
}

function _resetDrawRound(room) {
  for (const p of room.players) if (!p.sittingOut) p.drewThisRound = false;
  room._selectedIndices = {}; // 選択中インデックスもリセット
}

function _resetBetRound(room, betSize) {
  room.currentBet = 0; room.raiseCount = 0; room.betSize = betSize;
  for (const p of room.players) {
    if (!p.sittingOut && !p.folded) { p.bet = 0; p.acted = false; }
  }
}

// ==========================================================
// ■ タイマー
// ==========================================================

function _startTimer(room) {
  _clearTimer(room);
  const limitSec = room.phase.startsWith('draw') ? cfg.DRAW_TIME_LIMIT : cfg.BET_TIME_LIMIT;
  if (limitSec <= 0 || !room._onTimeout) return;
  room._timerStart = Date.now();
  room._timerLimit = limitSec;
  room._timer = setTimeout(() => {
    const cur = room.players[room.actionIndex];
    if (cur && room._onTimeout) room._onTimeout(room.id, room.phase, cur.id);
  }, limitSec * 1000);
}

function _clearTimer(room) {
  if (room._timer) { clearTimeout(room._timer); room._timer = null; }
  room._timerStart = null; room._timerLimit = 0;
}

function getTimerRemaining(room) {
  if (!room._timerStart || !room._timerLimit) return null;
  return Math.max(0, room._timerLimit - (Date.now() - room._timerStart) / 1000);
}

/**
 * クライアントから送られた「現在の選択中カードインデックス」を保存する。
 * タイムアウト時にこれを使って自動交換する。
 */
function updateSelectedIndices(roomId, socketId, indices) {
  const room = rooms.get(roomId);
  if (!room || !room.phase.startsWith('draw')) return;
  room._selectedIndices[socketId] = indices;
}

// ==========================================================
// ■ ドロー
// ==========================================================

function drawCards(roomId, socketId, indices) {
  const room = rooms.get(roomId);
  if (!room || !room.phase.startsWith('draw')) return null;
  const myIndex = room.players.findIndex((p) => p.id === socketId);
  if (myIndex !== room.actionIndex) return null;
  const player = room.players[myIndex];
  if (!player || player.drewThisRound || player.folded) return null;

  const maxCards     = handSize(room.currentMode);
  const validIndices = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < maxCards);
  // 交換するカードを先に捨て札へ
  _discardCards(room, validIndices.map((i) => player.hand[i]));
  for (const i of validIndices) {
    const newCard = _drawFromDeck(room);
    if (newCard) player.hand[i] = newCard;
  }
  player.drewThisRound = true;
  player.drawCount     = validIndices.length;
  // 交換完了後は選択インデックスをクリア
  delete room._selectedIndices[socketId];

  _clearTimer(room);
  _advanceDrawAction(room);
  return room;
}


/**
 * デッキからカードを1枚引く。
 * デッキが切れた場合は捨て札（discardPile）をシャッフルして再利用する。
 * 捨て札もない場合は null を返す。
 */
function _drawFromDeck(room) {
  if (room.deck.length === 0) {
    if (!room.discardPile || room.discardPile.length === 0) {
      console.warn('[deck] デッキも捨て札も空です');
      return null;
    }
    // 捨て札をシャッフルして新しいデッキとして使用
    room.deck = shuffleDeck([...room.discardPile]);
    room.discardPile = [];
    console.log(`[deck] 捨て札 ${room.deck.length}枚をリシャッフルしました`);
  }
  return room.deck.shift() ?? null;
}

/**
 * 交換前のカードを捨て札に追加する。
 */
function _discardCards(room, cards) {
  if (!room.discardPile) room.discardPile = [];
  for (const c of cards) {
    if (c && c !== '??') room.discardPile.push(c);
  }
}

function _advanceDrawAction(room) {
  const active = room.players.filter((p) => !p.folded && !p.sittingOut);
  if (active.every((p) => p.drewThisRound)) { _nextPhase(room); return; }
  let next = (room.actionIndex + 1) % room.players.length;
  for (let t = 0; t < room.players.length; t++) {
    const p = room.players[next];
    if (p && !p.folded && !p.sittingOut && !p.drewThisRound) break;
    next = (next + 1) % room.players.length;
  }
  room.actionIndex = next;
  _startTimer(room);
}

// ==========================================================
// ■ ベット（5bet-cap）
// ==========================================================

function betAction(roomId, socketId, action) {
  const room = rooms.get(roomId);
  if (!room || !room.phase.startsWith('bet')) return null;
  const myIndex = room.players.findIndex((p) => p.id === socketId);
  if (myIndex !== room.actionIndex) return null;
  const player = room.players[myIndex];
  if (!player || player.folded) return null;

  const toCall = room.currentBet - player.bet;

  if (action === 'fold') {
    player.folded = true; player.acted = true;

  } else if (action === 'check') {
    if (toCall > 0) return null;
    player.acted = true;

  } else if (action === 'call') {
    const actual = Math.min(toCall, player.chips);
    player.chips -= actual; player.bet += actual; room.pot += actual;
    player.acted = true;

  } else if (action === 'bet' || action === 'raise') {
    // 5bet-cap 超過はコールに変換
    if (room.raiseCount >= MAX_RAISES) {
      const actual = Math.min(toCall, player.chips);
      player.chips -= actual; player.bet += actual; room.pot += actual;
      player.acted = true;
    } else {
      const betTotal = room.currentBet + room.betSize;
      const needed   = betTotal - player.bet;
      const actual   = Math.min(needed, player.chips);
      player.chips -= actual; player.bet += actual; room.pot += actual;
      room.currentBet = player.bet;
      room.raiseCount++;
      player.acted = true;
      // 他プレイヤーの acted をリセット
      for (let i = 0; i < room.players.length; i++) {
        if (i !== myIndex && !room.players[i].folded && !room.players[i].sittingOut) {
          room.players[i].acted = false;
        }
      }
    }
  } else { return null; }

  _clearTimer(room);
  _advanceBetAction(room);
  return room;
}

function _advanceBetAction(room) {
  const active = room.players.filter((p) => !p.folded && !p.sittingOut);
  if (active.length <= 1) { _clearTimer(room); room.phase = 'showdown'; return; }

  const allActed  = active.every((p) => p.acted);
  const betsEqual = active.every((p) => p.bet === active[0].bet);
  if (allActed && betsEqual) { _nextPhase(room); return; }

  let next = (room.actionIndex + 1) % room.players.length;
  for (let t = 0; t < room.players.length; t++) {
    const p = room.players[next];
    if (p && !p.folded && !p.sittingOut && !p.acted) break;
    next = (next + 1) % room.players.length;
  }
  room.actionIndex = next;
  _startTimer(room);
}

// ==========================================================
// ■ フェーズ遷移
// ==========================================================

function _nextPhase(room) {
  const idx  = PHASES.indexOf(room.phase);
  const next = PHASES[idx + 1] ?? 'showdown';
  room.phase = next;

  if (next.startsWith('draw')) {
    _resetDrawRound(room);
    room.actionIndex = _nextActiveFromSafe(room, room.dealerIndex);
    _startTimer(room);
  } else if (next.startsWith('bet')) {
    // draw2以降（bet2, bet3）はビッグベット
    const betSize = isBigBetPhase(next) ? BIG_BET : SMALL_BET;
    _resetBetRound(room, betSize);
    room.actionIndex = _nextActiveFromSafe(room, room.dealerIndex);
    _startTimer(room);
  } else if (next === 'showdown') {
    _clearTimer(room);
  }
}

// ==========================================================
// ■ ゲーム状態ビルド
// ==========================================================

function buildGameState(room, requesterId) {
  const isShowdown    = room.phase === 'showdown';
  const activePlayers = room.players.filter((p) => !p.folded && !p.sittingOut);
  const winnerId      = isShowdown ? findWinner(activePlayers, room.currentMode) : null;

  if (isShowdown && winnerId && !room._potAwarded) {
    const winner = room.players.find((p) => p.id === winnerId);
    if (winner) winner.chips += room.pot;
    room._potAwarded = true;
  }

  const currentPlayer  = room.actionIndex >= 0 ? room.players[room.actionIndex] : null;
  const isDrawPhase    = room.phase.startsWith('draw');
  const isBetPhase     = room.phase.startsWith('bet');
  const timerRemaining = getTimerRemaining(room);

  const sbIdx = room.dealerIndex >= 0 ? _nextActiveFromSafe(room, room.dealerIndex)      : -1;
  const bbIdx = sbIdx >= 0             ? _nextActiveFromSafe(room, sbIdx)                : -1;

  const playerStates = room.players.map((p) => {
    const isSelf   = p.id === requesterId;
    const reveal   = isShowdown || isSelf;
    const isMyTurn = !isShowdown && currentPlayer != null && p.id === currentPlayer.id;
    const toCall   = isBetPhase ? Math.max(0, room.currentBet - p.bet) : 0;
    const myIdx    = room.players.indexOf(p);

    return {
      id: p.id, name: p.name, chips: p.chips, bet: p.bet,
      folded: p.folded, sittingOut: p.sittingOut,
      hand: reveal ? p.hand : p.hand.map(() => '??'),
      isSelf, isMyTurn,
      drewThisRound: p.drewThisRound, drawCount: p.drawCount,
      result: reveal && p.hand.length > 0 && !p.folded
                ? evaluateHand(p.hand, room.currentMode) : undefined,
      isWinner:  isShowdown && p.id === winnerId,
      isDealer:  myIdx === room.dealerIndex,
      isSB:      myIdx === sbIdx && sbIdx >= 0,
      isBB:      myIdx === bbIdx && bbIdx >= 0,
      ...(isSelf ? {
        toCall,
        canCheck: isBetPhase && toCall === 0,
        // 5bet-cap: raiseCount < MAX_RAISES のときのみレイズ可
        canRaise: isBetPhase && room.raiseCount < MAX_RAISES,
        betSize:  room.betSize,
      } : {}),
      ...(isMyTurn ? { timerRemaining } : {}),
    };
  });

  const meta = {
    _meta: true,
    phase:          room.phase,
    mode:           room.mode,
    currentMode:    room.currentMode,
    pot:            room.pot,
    currentBet:     room.currentBet,
    betSize:        room.betSize,
    // レイズ表示: raiseCount（現在のベット段階）, maxRaises（上限）
    // クライアントでは (raiseCount + 1) / (MAX_RAISES + 1) = "1/5" 形式で表示
    raiseCount:     room.raiseCount,
    maxRaises:      MAX_RAISES,
    dealerIndex:    room.dealerIndex,
    handCount:      room.handCount,
    timerRemaining, timerLimit: room._timerLimit,
    pendingPlayers: room.pendingPlayers.map((p) => p.name),
    playerCount:    room.players.length,
    maxPlayers:     MAX_PLAYERS,
  };

  return [...playerStates, meta];
}

// ==========================================================
// ■ 退室
// ==========================================================

function leaveRoom(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    const idx = room.players.findIndex((p) => p.id === socketId);
    if (idx !== -1) {
      const player     = room.players[idx];
      const inProgress = PHASES.indexOf(room.phase) > 0 && room.phase !== 'showdown';

      if (inProgress) {
        player.folded = true; player.acted = true;
        if (room.actionIndex === idx) {
          _clearTimer(room);
          if (room.phase.startsWith('draw'))     _advanceDrawAction(room);
          else if (room.phase.startsWith('bet')) _advanceBetAction(room);
        }
        if (room.actionIndex > idx) room.actionIndex--;
      }

      room.players.splice(idx, 1);
      room.pendingPlayers = room.pendingPlayers.filter((p) => p.id !== socketId);
      delete room._selectedIndices[socketId];

      if (room.players.length === 0) {
        _clearTimer(room);
        // 全員退出 → フェーズをリセットして次の入室に備える
        room.phase       = 'waiting';
        room.pot         = 0;
        room.dealerIndex = -1;
        room.actionIndex = -1;
        room.deck        = [];
        room.discardPile = [];
        room._potAwarded = false;
        room._selectedIndices = {};
        if (room.isUserCreated) rooms.delete(roomId);
      }
      return roomId;
    }

    const pidx = room.pendingPlayers.findIndex((p) => p.id === socketId);
    if (pidx !== -1) {
      room.pendingPlayers.splice(pidx, 1);
      return roomId;
    }
  }
  return null;
}

function removePlayer(socketId) { return leaveRoom(socketId); }

function canAutoStart(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'showdown') return false;
  return room.players.filter((p) => !p.sittingOut).length + room.pendingPlayers.length >= 2;
}

function getAllRooms() { return rooms; }

module.exports = {
  getOrCreateRoom, joinRoom, leaveRoom,
  startGame, drawCards, betAction, updateSelectedIndices,
  buildGameState, removePlayer, canAutoStart, getAllRooms,
  getRoomMode,
  STARTING_CHIPS, SMALL_BLIND, BIG_BLIND, SMALL_BET, BIG_BET, MAX_PLAYERS,
};
