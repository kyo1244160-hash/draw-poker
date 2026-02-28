/**
 * gameManager.js — ゲーム状態管理
 *
 * 対応ゲーム:
 *   '27'     — 2-7 Triple Draw（5枚 × 3回ドロー）
 *   'badugi' — Badugi（4枚 × 3回ドロー）
 *   'mix'    — BTNが1周するごとに 2-7 ↔ Badugi を交互切替
 *
 * ゲームフロー（プリドローベット追加）:
 *   waiting → bet0 → draw1 → bet1 → draw2 → bet2 → draw3 → bet3 → showdown
 *
 * ベット:
 *   - フィックスドリミット / SB+BB制
 *   - bet0/bet1/bet2: SMALL_BET（1BB）
 *   - bet3: BIG_BET（2BB）
 *   - 5bet-cap（ベット1回 + レイズ4回まで）
 *
 * 参加制限: 最大6人
 */

const { createShuffledDeck }                             = require('./deck');
const { evaluate27Hand, evaluateBadugiHand, findWinner } = require('./handEvaluator');
const cfg                                                = require('../config');

// ===== 定数 =====
const BB             = cfg.BB_VALUE;
const STARTING_CHIPS = cfg.STARTING_BB * BB;
const SMALL_BLIND    = Math.round(cfg.SMALL_BLIND_BB * BB);
const BIG_BLIND      = Math.round(cfg.BIG_BLIND_BB  * BB);
const SMALL_BET      = Math.round(cfg.SMALL_BET_BB  * BB);
const BIG_BET        = Math.round(cfg.BIG_BET_BB    * BB);
const MAX_RAISES     = 4;   // 5bet-cap = ベット1回 + レイズ4回
const MAX_PLAYERS    = 6;   // 最大参加人数

/**
 * ゲームフェーズの順序
 * bet0 = プリドロー（カード配布直後）のベットラウンド
 */
const PHASES = ['waiting','bet0','draw1','bet1','draw2','bet2','draw3','bet3','showdown'];

/** roomId からベースゲームモードを返す */
function getRoomMode(roomId) {
  if (roomId.includes('badugi')) return 'badugi';
  if (roomId.includes('mix'))    return 'mix';
  return '27';
}

/** 手札枚数（モードごと）*/
function handSize(mode) {
  return mode === 'badugi' ? 4 : 5;
}

/** 役判定（モードごと）*/
function evaluateHand(hand, mode) {
  return mode === 'badugi' ? evaluateBadugiHand(hand) : evaluate27Hand(hand);
}

/** mix モードで現在のゲームモードを返す（handCountとプレイヤー数で切替）*/
function getMixCurrentMode(room) {
  const cycle = Math.floor(room.handCount / Math.max(1, room.players.length)) % 2;
  return cycle === 0 ? '27' : 'badugi';
}

// ===== ルームストレージ =====
const rooms = new Map();

/**
 * ルームを取得（なければ新規作成）
 */
function getOrCreateRoom(roomId, opts = {}) {
  if (!rooms.has(roomId)) {
    const baseMode = getRoomMode(roomId);
    rooms.set(roomId, {
      id:            roomId,
      label:         opts.label          ?? roomId,
      mode:          baseMode,
      currentMode:   baseMode === 'mix' ? '27' : baseMode,
      password:      opts.password       ?? null,
      isUserCreated: opts.isUserCreated  ?? false,
      players:       [],
      pendingPlayers:[],
      deck:          [],
      phase:         'waiting',
      pot:           0,
      dealerIndex:   -1,
      actionIndex:   -1,
      currentBet:    0,
      raiseCount:    0,
      betSize:       SMALL_BET,
      handCount:     0,
      _potAwarded:   false,
      _timer:        null,
      _timerStart:   null,
      _timerLimit:   0,
      _onTimeout:    null,
    });
  }
  return rooms.get(roomId);
}

/**
 * プレイヤーをルームに参加させる。
 * - 最大6人制限
 * - ゲーム進行中は pendingPlayers に追加
 * - SBとBTNの間への着席は1ハンド待機
 *
 * @returns {'active'|'pending'|'reconnected'|'full'} 参加結果
 */
function joinRoom(roomId, socketId, name) {
  const room = getOrCreateRoom(roomId);

  // 再接続チェック
  const existing = room.players.find((p) => p.name === name);
  if (existing) { existing.id = socketId; return 'reconnected'; }
  const existingPending = room.pendingPlayers.find((p) => p.name === name);
  if (existingPending) { existingPending.id = socketId; return 'pending'; }

  // 合計人数チェック（active + pending）
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

  // ゲーム進行中は pending へ
  const inProgress = PHASES.indexOf(room.phase) > 0 && room.phase !== 'showdown';
  if (inProgress) {
    room.pendingPlayers.push(newPlayer);
    return 'pending';
  }

  room.players.push(newPlayer);

  // showdown フェーズでの着席位置チェック
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

/**
 * ゲームを開始する。
 * pending → active へ昇格、sittingOut クリア、チップリセット、
 * ディーラーボタン前進、カード配布、ブラインドポスト、bet0 フェーズへ。
 */
function startGame(roomId, onTimeout) {
  const room = rooms.get(roomId);
  if (!room) return null;

  // pending → active
  for (const p of room.pendingPlayers) room.players.push(p);
  room.pendingPlayers = [];

  // sittingOut クリア
  for (const p of room.players) p.sittingOut = false;

  const activePlayers = room.players.filter((p) => !p.sittingOut);
  if (activePlayers.length < 2) return null;

  // mix モード切替
  if (room.mode === 'mix') room.currentMode = getMixCurrentMode(room);
  else room.currentMode = room.mode;

  // リセット
  room.deck        = createShuffledDeck();
  room.pot         = 0;
  room._potAwarded = false;
  room._onTimeout  = onTimeout;
  room.handCount  += 1;

  // ディーラーボタンを進める（安全版）
  if (room.dealerIndex < 0) {
    room.dealerIndex = 0;
  } else {
    let next  = (room.dealerIndex + 1) % room.players.length;
    let tries = 0;
    while (room.players[next]?.sittingOut && tries < room.players.length) {
      next = (next + 1) % room.players.length;
      tries++;
    }
    room.dealerIndex = next;
  }

  // 手札配布・プレイヤーリセット
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

  // ===== bet0（プリドロー）フェーズへ =====
  // UTG（BBの左）から行動開始
  const utgIndex = _nextActiveFromSafe(room, bbIndex);
  room.phase       = 'bet0';
  room.currentBet  = BIG_BLIND;   // BBが既にポストしているので最低コール額はBB
  room.raiseCount  = 0;
  room.betSize     = SMALL_BET;
  // BBはまだ acted = false（オプション権のため）
  room.players[bbIndex].acted = false;
  room.actionIndex = utgIndex;
  _startTimer(room);

  return room;
}

function _postBlind(room, idx, amount) {
  const p      = room.players[idx];
  if (!p) return;
  const actual = Math.min(amount, p.chips);
  p.chips     -= actual;
  p.bet       += actual;
  room.pot    += actual;
}

/**
 * 指定インデックスの次のアクティブ（未フォールド・非待機）プレイヤーを返す。
 * 安全版: players 配列が空でも crashed しない。
 */
function _nextActiveFromSafe(room, fromIndex) {
  const len = room.players.length;
  if (len === 0) return 0;
  // fromIndex を 0〜len-1 に正規化
  const start = ((fromIndex % len) + len) % len;
  let next    = (start + 1) % len;
  let tries   = 0;
  while (tries < len) {
    const p = room.players[next];
    if (p && !p.folded && !p.sittingOut) return next;
    next = (next + 1) % len;
    tries++;
  }
  return next; // 全員フォールドの場合でも返す
}

function _resetDrawRound(room) {
  for (const p of room.players) if (!p.sittingOut) p.drewThisRound = false;
}

function _resetBetRound(room, betSize) {
  room.currentBet = 0;
  room.raiseCount = 0;
  room.betSize    = betSize;
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
  room._timerStart = null;
  room._timerLimit = 0;
}

function getTimerRemaining(room) {
  if (!room._timerStart || !room._timerLimit) return null;
  return Math.max(0, room._timerLimit - (Date.now() - room._timerStart) / 1000);
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
  for (const i of validIndices) {
    const newCard = room.deck.shift();
    if (newCard) player.hand[i] = newCard;
  }
  player.drewThisRound = true;
  player.drawCount     = validIndices.length;

  _clearTimer(room);
  _advanceDrawAction(room);
  return room;
}

function _advanceDrawAction(room) {
  const active = room.players.filter((p) => !p.folded && !p.sittingOut);
  if (active.every((p) => p.drewThisRound)) { _nextPhase(room); return; }
  let next = (room.actionIndex + 1) % room.players.length;
  let tries = 0;
  while (tries < room.players.length) {
    const p = room.players[next];
    if (p && !p.folded && !p.sittingOut && !p.drewThisRound) break;
    next = (next + 1) % room.players.length;
    tries++;
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
    // 5bet-cap: raiseCount >= MAX_RAISES(4) ならコールに強制
    if (room.raiseCount >= MAX_RAISES && action === 'raise') {
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
      // 他のアクティブプレイヤーの acted をリセット
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

  let next  = (room.actionIndex + 1) % room.players.length;
  let tries = 0;
  while (tries < room.players.length) {
    const p = room.players[next];
    if (p && !p.folded && !p.sittingOut && !p.acted) break;
    next = (next + 1) % room.players.length;
    tries++;
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
    _resetBetRound(room, next === 'bet3' ? BIG_BET : SMALL_BET);
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

  // SB/BBインデックスを安全に計算
  const sbIdx = room.dealerIndex >= 0 ? _nextActiveFromSafe(room, room.dealerIndex)     : -1;
  const bbIdx = sbIdx >= 0             ? _nextActiveFromSafe(room, sbIdx)               : -1;

  const playerStates = room.players.map((p) => {
    const isSelf   = p.id === requesterId;
    const reveal   = isShowdown || isSelf;
    const isMyTurn = !isShowdown && currentPlayer != null && p.id === currentPlayer.id;
    const toCall   = isBetPhase ? Math.max(0, room.currentBet - p.bet) : 0;
    const myIdx    = room.players.indexOf(p);

    return {
      id:            p.id,
      name:          p.name,
      chips:         p.chips,
      bet:           p.bet,
      folded:        p.folded,
      sittingOut:    p.sittingOut,
      hand:          reveal ? p.hand : p.hand.map(() => '??'),
      isSelf, isMyTurn,
      drewThisRound: p.drewThisRound,
      drawCount:     p.drawCount,
      result:        reveal && p.hand.length > 0 && !p.folded
                       ? evaluateHand(p.hand, room.currentMode) : undefined,
      isWinner:      isShowdown && p.id === winnerId,
      isDealer:      myIdx === room.dealerIndex,
      isSB:          myIdx === sbIdx && sbIdx >= 0,
      isBB:          myIdx === bbIdx && bbIdx >= 0,
      ...(isSelf ? {
        toCall,
        canCheck: isBetPhase && toCall === 0,
        canRaise: isBetPhase && room.raiseCount < MAX_RAISES,
        betSize:  room.betSize,
      } : {}),
      ...(isMyTurn ? { timerRemaining } : {}),
    };
  });

  const meta = {
    _meta:          true,
    phase:          room.phase,
    mode:           room.mode,
    currentMode:    room.currentMode,
    pot:            room.pot,
    currentBet:     room.currentBet,
    betSize:        room.betSize,
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
// ■ 退室 / 削除
// ==========================================================

function leaveRoom(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    const idx = room.players.findIndex((p) => p.id === socketId);
    if (idx !== -1) {
      const player     = room.players[idx];
      const inProgress = PHASES.indexOf(room.phase) > 0 && room.phase !== 'showdown';

      if (inProgress) {
        player.folded = true;
        player.acted  = true;
        if (room.actionIndex === idx) {
          _clearTimer(room);
          if (room.phase.startsWith('draw'))     _advanceDrawAction(room);
          else if (room.phase.startsWith('bet')) _advanceBetAction(room);
        }
        // アクションインデックスを補正（削除後にずれないよう）
        if (room.actionIndex > idx) room.actionIndex--;
      }

      room.players.splice(idx, 1);
      room.pendingPlayers = room.pendingPlayers.filter((p) => p.id !== socketId);

      if (room.players.length === 0) {
        _clearTimer(room);
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
  const active = room.players.filter((p) => !p.sittingOut).length + room.pendingPlayers.length;
  return active >= 2;
}

function getAllRooms() { return rooms; }

module.exports = {
  getOrCreateRoom, joinRoom, leaveRoom,
  startGame, drawCards, betAction,
  buildGameState, removePlayer, canAutoStart, getAllRooms,
  getRoomMode,
  STARTING_CHIPS, SMALL_BLIND, BIG_BLIND, SMALL_BET, BIG_BET, MAX_PLAYERS,
};
