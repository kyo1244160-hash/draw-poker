'use strict';

const { log, logDev, logPot } = require('../logger');
const cfg = require('../config');
const { createShuffledDeck } = require('./deck');
const {
  findBoardHiWinners,
  findBoardLoWinners,
  boardHandName,
} = require('./boardEvaluator');

const BOARD_MODES = ['fl_holdem', 'fl_omaha8'];
const PHASES = ['waiting', 'preflop', 'flop', 'turn', 'river', 'showdown'];
const MAX_RAISES = cfg.MAX_RAISES;
const MAX_PLAYERS = cfg.MAX_PLAYERS;

const boardRooms = new Map();
global.__pastisBoardRooms = boardRooms;

function isBoardMode(mode) {
  return BOARD_MODES.includes(mode);
}

function isBoardBettingPhase(phase) {
  return ['preflop', 'flop', 'turn', 'river'].includes(phase);
}

function ensureBoardRoom(roomId, base = {}) {
  if (!boardRooms.has(roomId)) {
    boardRooms.set(roomId, {
      id: roomId,
      mode: base.mode ?? 'horse',
      currentMode: base.currentMode ?? 'fl_holdem',
      players: [],
      pendingPlayers: [],
      deck: [],
      board: [],
      phase: 'waiting',
      pot: 0,
      currentBet: 0,
      betSize: base.smallBet ?? cfg.SMALL_BET,
      raiseCount: 0,
      actionIndex: -1,
      dealerIndex: base.dealerIndex ?? -1,
      fixedDealerIdx: -1,
      fixedSbIdx: -1,
      fixedBbIdx: -1,
      smallBlind: base.smallBlind ?? cfg.SMALL_BLIND,
      bigBlind: base.bigBlind ?? cfg.BIG_BLIND,
      smallBet: base.smallBet ?? cfg.SMALL_BET,
      bigBet: base.bigBet ?? cfg.BIG_BET,
      startingChips: base.startingChips,
      handCount: base.handCount ?? 0,
      _timer: null,
      _timerStart: null,
      _timerLimit: 0,
      _onTimeout: null,
      _potAwarded: false,
      _lastBbId: base._lastBbId ?? null,
      _lastSbId: base._lastSbId ?? null,
      _isTournament: base._isTournament ?? false,
      _tournamentId: base._tournamentId ?? null,
    });
  }
  return boardRooms.get(roomId);
}

function syncFromGameManager(gmRoom, currentMode) {
  const room = ensureBoardRoom(gmRoom.id, gmRoom);
  room.mode = gmRoom.mode;
  room.currentMode = currentMode;
  room.smallBlind = gmRoom.smallBlind;
  room.bigBlind = gmRoom.bigBlind;
  room.smallBet = gmRoom.smallBet;
  room.bigBet = gmRoom.bigBet;
  room.startingChips = gmRoom.startingChips;
  room.handCount = gmRoom.handCount;
  room.dealerIndex = gmRoom.dealerIndex ?? -1;
  room._lastBbId = gmRoom._lastBbId ?? null;
  room._lastSbId = gmRoom._lastSbId ?? null;
  room._isTournament = gmRoom._isTournament ?? gmRoom._tournamentId != null;
  room._tournamentId = gmRoom._tournamentId ?? null;

  if ((gmRoom.pendingPlayers?.length ?? 0) > 0) {
    log(`[board-sync] ${gmRoom.id.slice(-8)} pendingPlayers ${gmRoom.pendingPlayers.length}人を昇格: [${gmRoom.pendingPlayers.map(p => p.name).join(',')}]`);
    for (const pp of gmRoom.pendingPlayers) {
      pp.sittingOut = true;
      pp._boardWaitOnce = true;
      if (!gmRoom.players.some((p) => p.id === pp.id)) gmRoom.players.push(pp);
    }
    gmRoom.pendingPlayers = [];
  }

  const waitOnceById = new Map();
  for (const gp of gmRoom.players) {
    waitOnceById.set(gp.id, !!gp._boardWaitOnce);
    gp._boardWaitOnce = false;
  }

  room.players = gmRoom.players.map((gp) => ({
    id: gp.id,
    name: gp.name,
    accountId: gp.accountId ?? null,
    chips: gp.chips,
    hand: [],
    bet: 0,
    folded: !!gp.sittingOut,
    acted: !!gp.sittingOut,
    sittingOut: !!gp.sittingOut,
    disconnected: gp.disconnected ?? false,
    isBot: !!gp.isBot || String(gp.id).startsWith('tbot::'),
    totalContribution: 0,
    _boardWaitOnce: waitOnceById.get(gp.id) ?? false,
  }));

  log(`[board-sync] room=${gmRoom.id.slice(-8)} mode=${currentMode} dealerIndex=${room.dealerIndex} players=[${room.players.map((p, i) => `${i}:${p.name}:chips${p.chips}:so${p.sittingOut}`).join('|')}]`);
  return room;
}

function syncToGameManager(gmRoom) {
  const room = boardRooms.get(gmRoom.id);
  if (!room) return;
  const chipByAccount = new Map();
  const chipById = new Map();
  for (const p of room.players) {
    if (p.accountId) chipByAccount.set(p.accountId, p.chips);
    if (p.id) chipById.set(p.id, p.chips);
  }
  for (const gp of gmRoom.players) {
    if (gp.accountId && chipByAccount.has(gp.accountId)) gp.chips = chipByAccount.get(gp.accountId);
    else if (chipById.has(gp.id)) gp.chips = chipById.get(gp.id);
  }
  gmRoom.handCount = room.handCount;
  gmRoom.phase = room.phase === 'showdown' ? 'showdown' : gmRoom.phase;
  gmRoom.currentMode = room.currentMode;
  gmRoom._lastBbId = room._lastBbId ?? gmRoom._lastBbId;
  gmRoom._lastSbId = room._lastSbId ?? gmRoom._lastSbId;
}

function startBoardHand(room, onTimeout, opts = {}) {
  if (!room) return null;
  const activePlayers = room.players.filter((p) => !p.sittingOut && p.chips > 0);
  if (activePlayers.length < 2) return null;

  room.deck = createShuffledDeck();
  room.board = [];
  room.phase = 'preflop';
  room.pot = 0;
  room.currentBet = 0;
  room.raiseCount = 1;
  room.betSize = room.smallBet;
  room.actionIndex = -1;
  room._potAwarded = false;
  room._onBoardShowdownCalled = false;
  room._onTimeout = onTimeout;
  if (!opts.skipHandCountIncrement) room.handCount += 1;

  const holeCount = room.currentMode === 'fl_omaha8' ? 4 : 2;
  for (const p of room.players) {
    const waitThisHand = !!p._boardWaitOnce;
    p._boardWaitOnce = false;
    p.hand = (p.sittingOut || waitThisHand) ? [] : room.deck.splice(0, holeCount);
    p.bet = 0;
    p.folded = !!p.sittingOut || waitThisHand;
    p.acted = !!p.sittingOut || waitThisHand;
    p.totalContribution = 0;
    if (waitThisHand) p.sittingOut = true;
  }

  const blinds = assignBlindsByBB(room);
  room.dealerIndex = blinds.dealerIndex;
  room.fixedDealerIdx = blinds.dealerIndex;
  room.fixedSbIdx = blinds.sbIndex;
  room.fixedBbIdx = blinds.bbIndex;
  room._sbDead = blinds.sbDead;

  if (!blinds.sbDead) postBlind(room, blinds.sbIndex, room.smallBlind);
  postBlind(room, blinds.bbIndex, room.bigBlind);
  room._lastSbId = room.players[blinds.sbIndex]?.id ?? null;
  room._lastBbId = room.players[blinds.bbIndex]?.id ?? null;
  room.currentBet = room.bigBlind;

  for (const p of room.players) {
    p.acted = !!p.sittingOut || !!p.folded || p.chips <= 0;
  }
  const isHeadsUp = activePlayers.length === 2;
  room.players[blinds.sbIndex].acted = false;
  room.players[blinds.bbIndex].acted = false;
  room.actionIndex = isHeadsUp ? blinds.sbIndex : nextActiveFrom(room, blinds.bbIndex);
  startTimer(room);
  log(`[BOARD-ROUND] room=${room.id.slice(-8)} mode=${room.currentMode} hand=${room.handCount} players=${activePlayers.length}`);
  return room;
}

function postBlind(room, idx, amount) {
  const p = room.players[idx];
  if (!p || p.sittingOut || p.folded) return;
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet += actual;
  p.totalContribution += actual;
  room.pot += actual;
}

function assignBlindsByBB(room) {
  const activeCount = room.players.filter((p) => !p.sittingOut && !p.folded).length;
  if (activeCount === 2) {
    const sbIndex = room.dealerIndex;
    return {
      dealerIndex: room.dealerIndex,
      sbIndex,
      bbIndex: nextActiveFrom(room, sbIndex),
      sbDead: false,
    };
  }

  let prevBbIdx = room._lastBbId ? room.players.findIndex((p) => p.id === room._lastBbId) : -1;
  if (prevBbIdx < 0) {
    const sbIndex = nextActiveFrom(room, room.dealerIndex);
    const bbIndex = nextActiveFrom(room, sbIndex);
    return { dealerIndex: room.dealerIndex, sbIndex, bbIndex, sbDead: false };
  }

  const bbIndex = nextActiveFrom(room, prevBbIdx);
  const sbIndex = prevBbIdx;
  const prevSbIdx = room._lastSbId ? room.players.findIndex((p) => p.id === room._lastSbId) : -1;
  const dealerIndex = prevSbIdx >= 0 ? prevSbIdx : prevActiveFrom(room, sbIndex);
  const sb = room.players[sbIndex];
  return { dealerIndex, sbIndex, bbIndex, sbDead: !(sb && !sb.sittingOut && !sb.folded) };
}

function boardBetAction(roomId, socketId, action) {
  const room = boardRooms.get(roomId);
  if (!room || !isBoardBettingPhase(room.phase)) return null;
  const myIndex = room.players.findIndex((p) => p.id === socketId);
  if (myIndex !== room.actionIndex) return null;
  const player = room.players[myIndex];
  if (!player || player.folded || player.sittingOut) return null;
  const toCall = Math.max(0, room.currentBet - player.bet);

  if (action === 'fold') {
    if (toCall === 0) return null;
    player.folded = true;
    player.acted = true;
  } else if (action === 'check') {
    if (toCall > 0) return null;
    player.acted = true;
  } else if (action === 'call') {
    const actual = Math.min(toCall, player.chips);
    player.chips -= actual;
    player.bet += actual;
    player.totalContribution += actual;
    room.pot += actual;
    player.acted = true;
  } else if (action === 'bet' || action === 'raise') {
    if (player.chips <= 0) {
      player.acted = true;
    } else if (room.raiseCount >= MAX_RAISES) {
      const actual = Math.min(toCall, player.chips);
      player.chips -= actual;
      player.bet += actual;
      player.totalContribution += actual;
      room.pot += actual;
      player.acted = true;
    } else {
      if (action === 'bet' && room.currentBet > 0) return null;
      if (action === 'raise' && room.currentBet <= 0) return null;
      const target = room.currentBet + room.betSize;
      const need = Math.max(0, target - player.bet);
      const actual = Math.min(need, player.chips);
      player.chips -= actual;
      player.bet += actual;
      player.totalContribution += actual;
      room.pot += actual;
      const prevBet = room.currentBet;
      room.currentBet = Math.max(room.currentBet, player.bet);
      if (actual >= need && room.currentBet > prevBet) {
        room.raiseCount += 1;
        for (let i = 0; i < room.players.length; i++) {
          const op = room.players[i];
          if (i !== myIndex && !op.folded && !op.sittingOut && op.chips > 0) op.acted = false;
        }
      }
      player.acted = true;
    }
  } else {
    return null;
  }

  clearTimer(room);
  advanceBetAction(room);
  return room;
}

function advanceBetAction(room) {
  const active = room.players.filter((p) => !p.folded && !p.sittingOut);
  if (active.length <= 1) {
    room.phase = 'showdown';
    clearTimer(room);
    return;
  }
  if (active.every((p) => p.acted || p.chips <= 0)) {
    nextPhase(room);
    return;
  }
  let next = (room.actionIndex + 1) % room.players.length;
  for (let t = 0; t < room.players.length; t++) {
    const p = room.players[next];
    if (p && !p.folded && !p.sittingOut && !p.acted && p.chips > 0) break;
    next = (next + 1) % room.players.length;
  }
  room.actionIndex = next;
  startTimer(room);
}

function nextPhase(room) {
  const idx = PHASES.indexOf(room.phase);
  const next = PHASES[idx + 1] ?? 'showdown';
  room.phase = next;
  if (next === 'flop') room.board.push(...room.deck.splice(0, 3));
  else if (next === 'turn' || next === 'river') room.board.push(...room.deck.splice(0, 1));

  if (next === 'showdown') {
    clearTimer(room);
    return;
  }

  resetBetRound(room, next === 'turn' || next === 'river' ? room.bigBet : room.smallBet);
  room.actionIndex = nextActiveFrom(room, room.fixedDealerIdx);
  startTimer(room);
}

function resetBetRound(room, betSize) {
  room.currentBet = 0;
  room.raiseCount = 0;
  room.betSize = betSize;
  for (const p of room.players) {
    p.bet = 0;
    p.acted = !!p.sittingOut || !!p.folded || p.chips <= 0;
  }
}

function nextActiveFrom(room, fromIndex) {
  const len = room.players.length;
  let next = ((fromIndex % len) + len + 1) % len;
  for (let t = 0; t < len; t++) {
    const p = room.players[next];
    if (p && !p.sittingOut && !p.folded) return next;
    next = (next + 1) % len;
  }
  return next;
}

function prevActiveFrom(room, fromIndex) {
  const len = room.players.length;
  let prev = ((fromIndex % len) + len - 1) % len;
  for (let t = 0; t < len; t++) {
    const p = room.players[prev];
    if (p && !p.sittingOut && !p.folded) return prev;
    prev = (prev - 1 + len) % len;
  }
  return prev;
}

function startTimer(room) {
  clearTimer(room);
  const limitSec = cfg.BET_TIME_LIMIT;
  if (limitSec <= 0 || !room._onTimeout) return;
  room._timerStart = Date.now();
  room._timerLimit = limitSec;
  room._timer = setTimeout(() => {
    const cur = room.players[room.actionIndex];
    if (cur && room._onTimeout) room._onTimeout(room.id, room.phase, cur.id);
  }, limitSec * 1000);
}

function clearTimer(room) {
  if (room._timer) clearTimeout(room._timer);
  room._timer = null;
  room._timerStart = null;
  room._timerLimit = 0;
}

function getTimerRemaining(room) {
  if (!room._timerStart || !room._timerLimit) return null;
  return Math.max(0, room._timerLimit - (Date.now() - room._timerStart) / 1000);
}

function buildBoardGameState(room, requesterId) {
  const isShowdown = room.phase === 'showdown';
  if (isShowdown && !room._potAwarded) {
    awardBoardPots(room);
    room._potAwarded = true;
  }
  const currentPlayer = room.actionIndex >= 0 ? room.players[room.actionIndex] : null;
  const isBetPhase = isBoardBettingPhase(room.phase);
  const timerRemaining = getTimerRemaining(room);
  const hiWinnerIds = isShowdown ? new Set(findBoardHiWinners(room.players, room.board, room.currentMode)) : new Set();
  const loWinnerIds = isShowdown ? new Set(findBoardLoWinners(room.players, room.board, room.currentMode)) : new Set();

  const players = room.players.map((p, idx) => {
    const isSelf = p.id === requesterId;
    const reveal = isSelf || (isShowdown && !p.folded);
    const toCall = isBetPhase ? Math.max(0, room.currentBet - p.bet) : 0;
    const isMyTurn = !isShowdown && currentPlayer?.id === p.id;
    return {
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      sittingOut: p.sittingOut,
      disconnected: p.disconnected ?? false,
      hand: reveal ? p.hand : p.hand.map(() => '??'),
      isSelf,
      isMyTurn,
      isDealer: idx === room.fixedDealerIdx,
      isSB: idx === room.fixedSbIdx,
      isBB: idx === room.fixedBbIdx,
      isWinner: isShowdown && (hiWinnerIds.has(p.id) || loWinnerIds.has(p.id)),
      result: reveal && !p.folded ? boardHandName(p.hand, room.board, room.currentMode) : undefined,
      ...(isSelf ? {
        toCall: p.chips <= 0 ? 0 : toCall,
        canCheck: isBetPhase && (toCall === 0 || p.chips <= 0),
        canRaise: isBetPhase && p.chips > 0 && room.raiseCount < MAX_RAISES
          && room.players.some((op) => op.id !== p.id && !op.folded && !op.sittingOut && op.chips > 0),
        isAllIn: p.chips <= 0 && !p.folded,
        betSize: room.betSize,
      } : {}),
      ...(isMyTurn ? { timerRemaining } : {}),
    };
  });

  const meta = {
    _meta: true,
    phase: room.phase,
    mode: room.mode,
    currentMode: room.currentMode,
    isBoard: true,
    isStud: false,
    pot: room.pot,
    pots: room.pot > 0 ? [{ amount: room.pot, label: 'ポット' }] : [],
    currentBet: room.currentBet,
    betSize: room.betSize,
    raiseCount: room.raiseCount,
    maxRaises: MAX_RAISES,
    dealerIndex: room.fixedDealerIdx,
    handCount: room.handCount,
    board: [...room.board],
    street: room.phase,
    timerRemaining,
    timerLimit: room._timerLimit,
    pendingPlayers: room.pendingPlayers.map((p) => p.name),
    playerCount: room.players.length,
    maxPlayers: MAX_PLAYERS,
    roomId: room.id,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
  };
  return [...players, meta];
}

function awardBoardPots(room) {
  if (room._potAwarded) return;
  const active = room.players.filter((p) => !p.folded && !p.sittingOut);
  if (active.length === 0) return;
  if (active.length === 1 || room.board.length < 5) {
    active[0].chips += room.pot;
    room.pot = 0;
    return;
  }

  const allPlayers = room.players.filter((p) => !p.sittingOut);
  const levels = [...new Set(allPlayers.map((p) => p.totalContribution ?? 0).filter((n) => n > 0))].sort((a, b) => a - b);
  let totalAwarded = 0;
  let prev = 0;
  for (const level of levels) {
    const contributors = allPlayers.filter((p) => (p.totalContribution ?? 0) >= level).length;
    const amount = Math.min((level - prev) * contributors, room.pot - totalAwarded);
    if (amount <= 0) break;
    const eligible = active.filter((p) => (p.totalContribution ?? 0) >= level);
    awardSinglePot(room, allPlayers, eligible.length ? eligible : active, amount);
    totalAwarded += amount;
    prev = level;
  }
  const remainder = room.pot - totalAwarded;
  if (remainder > 0) awardSinglePot(room, allPlayers, active, remainder);
  logPot(`[board-pot] room=${room.id.slice(-8)} mode=${room.currentMode} awarded=${room.pot}`);
  room.pot = 0;
}

function awardSinglePot(room, seatRef, eligible, amount) {
  const hiIds = findBoardHiWinners(eligible, room.board, room.currentMode);
  const loIds = findBoardLoWinners(eligible, room.board, room.currentMode);
  if (room.currentMode === 'fl_omaha8' && loIds.length > 0) {
    splitChips(room, seatRef, hiIds, Math.floor(amount / 2));
    splitChips(room, seatRef, loIds, amount - Math.floor(amount / 2));
  } else {
    splitChips(room, seatRef, hiIds, amount);
  }
}

function splitChips(room, seatRef, winnerIds, amount) {
  if (!winnerIds.length || amount <= 0) return;
  const winners = winnerIds.map((id) => room.players.find((p) => p.id === id)).filter(Boolean);
  const share = Math.floor(amount / winners.length);
  const odd = amount - share * winners.length;
  const sbRef = room.fixedSbIdx >= 0 ? room.fixedSbIdx : 0;
  let oddWinner = winners[0];
  let minDist = Infinity;
  for (const w of winners) {
    const idx = seatRef.findIndex((p) => p.id === w.id);
    const dist = ((idx - sbRef) % seatRef.length + seatRef.length) % seatRef.length;
    if (dist < minDist) {
      minDist = dist;
      oddWinner = w;
    }
  }
  for (const w of winners) w.chips += share + (w === oddWinner ? odd : 0);
}

function ensureBoardPotsAwarded(roomId) {
  const room = boardRooms.get(roomId);
  if (!room || room.phase !== 'showdown' || room._potAwarded) return;
  awardBoardPots(room);
  room._potAwarded = true;
}

function finishBoardHand(roomId) {
  const room = boardRooms.get(roomId);
  if (!room) return;
  clearTimer(room);
  room.phase = 'waiting';
  room.actionIndex = -1;
  room.board = [];
  room.deck = [];
  room.pot = 0;
  room.currentBet = 0;
  room.raiseCount = 0;
  for (const p of room.players) {
    p.hand = [];
    p.bet = 0;
    p.folded = false;
    p.acted = false;
    p.totalContribution = 0;
    p.sittingOut = false;
  }
}

function boardLeaveRoom(roomId, socketId) {
  const room = boardRooms.get(roomId);
  if (!room) return null;
  const idx = room.players.findIndex((p) => p.id === socketId);
  if (idx < 0) return room;
  const p = room.players[idx];
  if (isBoardBettingPhase(room.phase) && !p.folded) {
    p.folded = true;
    p.acted = true;
    if (room.actionIndex === idx) advanceBetAction(room);
  }
  room.players.splice(idx, 1);
  if (room.actionIndex > idx) room.actionIndex -= 1;
  return room;
}

function updateBoardPlayerSocketId(roomId, accountId, nickname, newSocketId) {
  const room = boardRooms.get(roomId);
  if (!room) return false;
  const p = room.players.find((x) => (accountId && x.accountId === accountId) || (!accountId && nickname && x.name === nickname));
  if (!p) return false;
  p.id = newSocketId;
  p.disconnected = false;
  return true;
}

function getBoardRoom(roomId) {
  return boardRooms.get(roomId) ?? null;
}

module.exports = {
  BOARD_MODES,
  boardRooms,
  isBoardMode,
  isBoardBettingPhase,
  ensureBoardRoom,
  syncFromGameManager,
  syncToGameManager,
  startBoardHand,
  boardBetAction,
  buildBoardGameState,
  ensureBoardPotsAwarded,
  finishBoardHand,
  boardLeaveRoom,
  updateBoardPlayerSocketId,
  getBoardRoom,
};
