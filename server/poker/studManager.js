/**
 * studManager.js — 7カードスタッド系ゲーム進行マネージャー
 *
 * 対応ゲーム: stud_s（7 Stud Hi）/ stud_e（Stud Hi/Lo 8 or better）/ razz
 *
 * gameManager.js（ドロー系）とは別エンジン。BEAST+ / stud_mix トーナメントで
 * currentMode がスタッド系のとき index.js が studManager にルーティングする。
 *
 * ゲームフロー（フェーズ）:
 *   waiting
 *   → ante（全員アンテ徴収・3rd配布: 裏2・表1）
 *   → bet3rd（ブリングインから開始, smallBet）
 *   → deal4th（表1枚配布）→ bet4th（smallBet, ボードペアでbigBet選択可だが簡略化しsmallBet）
 *   → deal5th（表1枚配布）→ bet5th（bigBet）
 *   → deal6th（表1枚配布）→ bet6th（bigBet）
 *   → deal7th（裏1枚配布）→ bet7th（bigBet）
 *   → showdown
 *
 * カード構造（各プレイヤー）:
 *   cards:   全カード配列（最大7枚）
 *   faceUp:  各カードが表向きか（boolean配列、cards と同じ長さ）
 *     3rd: [false,false,true]
 *     4th: [...,true]  5th,6th: [...,true]  7th: [...,false]
 *
 * ベット構造は gameManager と同じ 5bet-cap フィックスドリミット。
 * 3rd/4th = smallBet、5th以降 = bigBet。
 *
 * ポット精算:
 *   オールイン混在時はサイドポットを正確に計算（gameManager._awardPots と同方式）。
 *   各サイドポットレベルごとに資格者を判定し、stud_e はレベル単位で Hi/Lo スプリット。
 *   全員オールイン時は残りストリートを自動配布（ランナウト）してショーダウンへ。
 */

const { log, logDev, logPot } = require('../logger');
const { createShuffledDeck } = require('./deck');
const cfg = require('../config');
const {
  evaluateStudHand, studHandName,
  findHiWinners, findLoWinners,
  findBringIn, findHighHandFirst,
} = require('./studEvaluator');

const MAX_RAISES  = cfg.MAX_RAISES;
const MAX_PLAYERS = cfg.MAX_PLAYERS;

const STUD_MODES = ['stud_s', 'stud_e', 'razz'];
function isStudMode(mode) { return STUD_MODES.includes(mode); }

// フェーズ定義
const STREETS = ['3rd', '4th', '5th', '6th', '7th'];
const PHASES = [
  'waiting', 'ante',
  'bet3rd',
  'deal4th', 'bet4th',
  'deal5th', 'bet5th',
  'deal6th', 'bet6th',
  'deal7th', 'bet7th',
  'showdown',
];

/** ベットフェーズ → ストリート名 */
function phaseStreet(phase) {
  if (phase === 'bet3rd') return '3rd';
  if (phase === 'bet4th') return '4th';
  if (phase === 'bet5th') return '5th';
  if (phase === 'bet6th') return '6th';
  if (phase === 'bet7th') return '7th';
  return null;
}

/** smallBet ストリートか（3rd/4th） */
function isSmallBetStreet(phase) {
  return phase === 'bet3rd' || phase === 'bet4th';
}

// ==========================================================
// ■ ルームストレージ（gameManager とは別 Map）
// ==========================================================
const studRooms = new Map();
global.__pastisStudRooms = studRooms;

function getStudRoom(roomId) {
  return studRooms.get(roomId) ?? null;
}

/**
 * studManager 用にルームを初期化（gameManager のルームから移行する想定）
 * BEAST+ では1つのテーブルが gameManager と studManager を行き来するため、
 * gameManager のルーム（プレイヤー・チップ・ポジション）を共有元として受け取る。
 */
function ensureStudRoom(roomId, sharedRoom) {
  let room = studRooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      players: [],
      phase: 'waiting',
      pot: 0,
      handCount: 0,
      dealerIndex: -1,
      actionIndex: -1,
      currentBet: 0,
      betSize: 0,
      raiseCount: 0,
      smallBet: cfg.SMALL_BET,
      bigBet: cfg.BIG_BET,
      ante: 0,
      bringInAmount: 0,
      deck: [],
      currentMode: 'stud_s',
      mode: 'stud_s',
      _isTournament: false,
      _tournamentId: null,
      _potAwarded: false,
      _onTimeout: null,
      _timer: null,
      _timerLimit: 0,
      _timerStart: 0,
      startingChips: sharedRoom?.startingChips ?? (cfg.STARTING_BB * cfg.BB_VALUE),
    };
    studRooms.set(roomId, room);
  }
  return room;
}

// ==========================================================
// ■ ハンド開始
// ==========================================================

/**
 * スタッドハンド開始
 * @param {object} room studManager のルーム（ensureStudRoom 済み）
 * @param {function} onTimeout タイムアウトコールバック (roomId, phase, socketId)
 */
function startStudHand(room, onTimeout, opts = {}) {
  const activePlayers = room.players.filter((p) => !p.sittingOut);
  if (activePlayers.length < 2) return null;

  room.deck         = createShuffledDeck();
  room.pot          = 0;
  room._potAwarded  = false;
  room._onTimeout   = onTimeout;
  // handCount: 呼び出し側で既に確定済みの場合は増やさない（モード基準統一のため）。
  // 単体テストや単独起動時は従来通りここで +1 する。
  if (!opts.skipHandCountIncrement) room.handCount += 1;

  // ブラインドレベルからアンテ・ブリングイン額を算出
  // アンテ = smallBet/4（端数切り捨て、最低1）、ブリングイン = smallBet/2（最低2）
  room.ante          = Math.max(1, Math.floor(room.smallBet / 4));
  room.bringInAmount = Math.max(2, Math.floor(room.smallBet / 2));

  log(`[STUD-ROUND] room=${room.id.slice(-12)} mode=${room.currentMode} hand=${room.handCount} players=${activePlayers.length} ante=${room.ante} bringIn=${room.bringInAmount}`);

  // カードリセット・アンテ徴収
  for (const p of room.players) {
    p.cards   = [];
    p.faceUp  = [];
    p.bet     = 0;
    p.folded  = !!p.sittingOut;
    p.acted   = !!p.sittingOut;
    p.totalContribution = 0;
    p.isBringIn = false;
    if (!p.sittingOut) {
      const a = Math.min(room.ante, p.chips);
      p.chips -= a; room.pot += a; p.totalContribution += a;
    }
  }

  // 3rd street 配布: 裏2枚 + 表1枚
  for (const p of activePlayers) {
    p.cards  = [room.deck.shift(), room.deck.shift(), room.deck.shift()];
    p.faceUp = [false, false, true];
  }

  // ブリングイン判定（3rdのドアカード = 表向き1枚 = cards[2]）
  const bringInTarget = findBringIn(
    activePlayers.map((p) => ({ id: p.id, upCard: p.cards[2] })),
    room.currentMode
  );

  room.phase      = 'bet3rd';
  room.currentBet = room.bringInAmount;
  room.betSize    = room.smallBet;
  room.raiseCount = 0;

  // ブリングインを強制ポスト
  const biIdx = room.players.findIndex((p) => p.id === bringInTarget);
  if (biIdx >= 0) {
    const p = room.players[biIdx];
    const actual = Math.min(room.bringInAmount, p.chips);
    p.chips -= actual; p.bet += actual; room.pot += actual; p.totalContribution += actual;
    p.isBringIn = true;
  }

  // ポジション記録（スタッドはブリングインが起点、ボタンは便宜上ブリングイン者）
  room.dealerIndex    = biIdx;
  room.fixedDealerIdx = biIdx;
  room.bringInIndex   = biIdx;

  // acted 初期化（ブリングイン者も option のため acted=false）
  for (const p of room.players) {
    p.acted = (p.sittingOut || p.folded) ? true : false;
  }

  // アクション開始 = ブリングインの左隣
  room.actionIndex = _nextActive(room, biIdx);
  _startTimer(room);

  return room;
}

// ==========================================================
// ■ ベットアクション
// ==========================================================

function studBetAction(roomId, socketId, action, amount) {
  const room = studRooms.get(roomId);
  if (!room || !room.phase.startsWith('bet')) return null;
  const myIndex = room.players.findIndex((p) => p.id === socketId);
  if (myIndex !== room.actionIndex) return null;
  const player = room.players[myIndex];
  if (!player || player.folded) return null;

  const toCall = room.currentBet - player.bet;

  if (action === 'fold') {
    if (toCall === 0) return null; // チェック可能な場面のフォールド禁止
    player.folded = true; player.acted = true;

  } else if (action === 'check') {
    if (toCall > 0) return null;
    player.acted = true;

  } else if (action === 'call') {
    const actual = Math.min(toCall, player.chips);
    player.chips -= actual; player.bet += actual; room.pot += actual;
    player.totalContribution += actual;
    player.acted = true;

  } else if (action === 'bet' || action === 'raise') {
    if (player.chips <= 0) {
      player.acted = true;
    } else if (room.raiseCount >= MAX_RAISES) {
      // キャップ → コール扱い
      const actual = Math.min(toCall, player.chips);
      player.chips -= actual; player.bet += actual; room.pot += actual;
      player.totalContribution += actual;
      player.acted = true;
    } else {
      // 3rd でブリングインのみの場合（currentBet=bringIn < smallBet）の "completion" 対応:
      //   completion は currentBet を smallBet まで引き上げる
      let betTotal;
      if (room.phase === 'bet3rd' && room.currentBet < room.betSize) {
        // completion: smallBet まで引き上げ
        betTotal = room.betSize;
      } else {
        betTotal = room.currentBet + room.betSize;
      }
      const needed = betTotal - player.bet;
      const actual = Math.min(needed, player.chips);
      player.chips -= actual; player.bet += actual; room.pot += actual;
      player.totalContribution += actual;
      const prevBet = room.currentBet;
      room.currentBet = Math.max(room.currentBet, player.bet);
      if (actual >= needed) {
        room.raiseCount++;
        for (let i = 0; i < room.players.length; i++) {
          if (i !== myIndex && !room.players[i].folded && !room.players[i].sittingOut) {
            room.players[i].acted = false;
          }
        }
      } else if (room.currentBet > prevBet) {
        for (let i = 0; i < room.players.length; i++) {
          const op = room.players[i];
          if (i !== myIndex && !op.folded && !op.sittingOut && op.bet < room.currentBet) {
            op.acted = false;
          }
        }
      }
      player.acted = true;
    }
  } else { return null; }

  _clearTimer(room);
  _advanceBetAction(room);
  return room;
}

function _advanceBetAction(room) {
  const active = room.players.filter((p) => !p.folded && !p.sittingOut);
  // 全員フォールドで1人だけ残った → ランナウト不要、その場で総取り確定
  // （buildStudGameState の contestants.length===1 パスが精算する）
  if (active.length <= 1) {
    _clearTimer(room);
    room.phase = 'showdown';
    room.actionIndex = -1;
    return;
  }

  // アクション可能（chips>0）な未行動者で判定する。
  // オールイン済み(chips<=0)はアクションできないため allActed の対象外。
  const canAct = active.filter((p) => p.chips > 0);
  const allActed = canAct.every((p) => p.acted);
  if (allActed) { _nextPhase(room); return; }

  let next = (room.actionIndex + 1) % room.players.length;
  for (let t = 0; t < room.players.length; t++) {
    const p = room.players[next];
    // chips<=0（オールイン）は手番をスキップ。これを怠るとタイムアウトまでフリーズ。
    if (p && !p.folded && !p.sittingOut && !p.acted && p.chips > 0) {
      room.actionIndex = next;
      _startTimer(room);
      return;
    }
    next = (next + 1) % room.players.length;
  }
  // 見つからない → フェーズ進行
  _nextPhase(room);
}

// ==========================================================
// ■ フェーズ進行（ストリート配布）
// ==========================================================

function _nextPhase(room) {
  _clearTimer(room);
  const idx = PHASES.indexOf(room.phase);
  let next = PHASES[idx + 1] ?? 'showdown';

  // deal フェーズはカード配布して即座に次の bet フェーズへ
  while (next && next.startsWith('deal')) {
    _dealStreet(room, next);
    const di = PHASES.indexOf(next);
    next = PHASES[di + 1] ?? 'showdown';
  }

  room.phase = next;

  if (next === 'showdown') {
    room.actionIndex = -1;
    _runoutToShowdown(room);
    return;
  }

  // 全員オールイン判定: アクション可能（chips>0）な未フォールドプレイヤーが
  // 1人以下なら、これ以上ベッティングは発生しない。残りストリートを
  // 全て配ってショーダウンへ直行する（実ポーカーのランナウト相当）。
  const activeNotFolded = room.players.filter((p) => !p.folded && !p.sittingOut);
  const canActCount = activeNotFolded.filter((p) => p.chips > 0).length;
  if (activeNotFolded.length >= 2 && canActCount <= 1) {
    _runoutToShowdown(room);
    return;
  }

  // 新しいベットラウンド開始
  const street = phaseStreet(next);
  room.currentBet = 0;
  room.raiseCount = 0;
  room.betSize = isSmallBetStreet(next) ? room.smallBet : room.bigBet;
  for (const p of room.players) {
    p.bet = 0;
    // 【フリーズ防止】オールイン済み（chips<=0）のプレイヤーは以降アクション不可。
    // acted=false に戻すと _advanceBetAction が手番を回してタイムアウトまで
    // 待ち続け、テーブルがフリーズする。chips<=0 は acted=true 固定にする。
    p.acted = (p.sittingOut || p.folded || p.chips <= 0) ? true : false;
  }

  // 4th street以降は最強の見えている手から先頭アクション
  const active = room.players.filter((p) => !p.folded && !p.sittingOut);
  const firstId = findHighHandFirst(
    active.map((p) => ({ id: p.id, upCards: p.cards.filter((c, i) => p.faceUp[i]) })),
    room.currentMode
  );
  const firstIdx = room.players.findIndex((p) => p.id === firstId);
  room.actionIndex = firstIdx >= 0 ? firstIdx : _nextActive(room, room.dealerIndex);
  _startTimer(room);
}

/**
 * 残りのストリートを全て配ってショーダウンへ直行する。
 * 全員オールイン時、または showdown 到達時に各プレイヤーが7枚未満の場合に呼ぶ。
 * 未フォールドプレイヤーが必ず7枚（3rd〜7th）持つよう補完する。
 */
function _runoutToShowdown(room) {
  _clearTimer(room);
  const active = room.players.filter((p) => !p.folded && !p.sittingOut);
  // 各プレイヤーを7枚まで配布（3rdで3枚配布済み → 残り最大4枚）
  // faceUp パターン: index 0,1=down, 2=up(door), 3,4,5=up, 6=down(7th)
  const FACEUP_BY_INDEX = [false, false, true, true, true, true, false];
  let guard = 0;
  while (active.some((p) => p.cards.length < 7) && room.deck.length > 0 && guard < 30) {
    guard++;
    for (const p of active) {
      if (p.cards.length >= 7) continue;
      const card = room.deck.shift();
      if (!card) break;
      const i = p.cards.length;
      p.cards.push(card);
      p.faceUp.push(FACEUP_BY_INDEX[i] ?? true);
    }
  }
  room.phase = 'showdown';
  room.actionIndex = -1;
}

function _dealStreet(room, dealPhase) {
  const active = room.players.filter((p) => !p.folded && !p.sittingOut);
  const isSeventh = dealPhase === 'deal7th';
  for (const p of active) {
    const card = room.deck.shift();
    if (!card) continue;
    p.cards.push(card);
    p.faceUp.push(!isSeventh); // 7thのみ裏向き
  }
}

// ==========================================================
// ■ ショーダウン・ポット配布（Hi/Lo スプリット対応）
// ==========================================================

function _awardStudPots(room, contestants) {
  logPot(`[stud-pot] ===== _awardStudPots START room=${room.id.slice(-8)} mode=${room.currentMode} pot=${room.pot} =====`);

  if (contestants.length === 0) { room.pot = 0; return; }

  // 1人だけ残った場合は総取り
  if (contestants.length === 1) {
    contestants[0].chips += room.pot;
    logPot(`[stud-pot] single winner ${contestants[0].name} += ${room.pot}`);
    room.pot = 0;
    return;
  }

  const mode = room.currentMode;
  // サイドポット境界 = sittingOut を除く全プレイヤーの totalContribution
  // （フォールド済みプレイヤーの拠出も正しくポットに含めるため allPlayers を使う）
  const allPlayers = room.players.filter((p) => !p.sittingOut);
  const allLevels = allPlayers
    .map((p) => p.totalContribution ?? 0)
    .filter((c) => c > 0);
  const levels = [...new Set(allLevels)].sort((a, b) => a - b);

  logPot(`[stud-pot] allPlayers: ${allPlayers.map(p => `${p.name}(contrib=${p.totalContribution ?? 0},folded=${p.folded})`).join(', ')}`);
  logPot(`[stud-pot] levels: [${levels.join(', ')}]`);

  // 端数受け取りの基準: ブリングイン（dealerIndex）位置を起点に時計回りで最初の勝者
  const _ref = room.dealerIndex >= 0 ? room.dealerIndex : 0;

  let totalAwarded = 0;
  let prevLevel = 0;

  for (const level of levels) {
    // このレベルに拠出したプレイヤー数（フォールド含む全員）
    const contributors = allPlayers.filter((p) => (p.totalContribution ?? 0) >= level).length;
    const potSize = (level - prevLevel) * contributors;
    const cappedPot = Math.min(potSize, room.pot - totalAwarded);
    if (cappedPot <= 0) { prevLevel = level; continue; }

    // このポットを争う資格のある未フォールドプレイヤー
    const eligible = contestants.filter((p) => (p.totalContribution ?? 0) >= level);

    if (eligible.length === 0) {
      // フォールバック: contestants 全体で精算
      _awardSinglePot(room, contestants, contestants, cappedPot, mode, _ref, `level${level}-fallback`);
    } else {
      _awardSinglePot(room, allPlayers, eligible, cappedPot, mode, _ref, `level${level}`);
    }

    totalAwarded += cappedPot;
    prevLevel = level;
  }

  // 余り（最高レベル超過分）
  const remainder = room.pot - totalAwarded;
  if (remainder > 0) {
    _awardSinglePot(room, allPlayers, contestants, remainder, mode, _ref, 'remainder');
    totalAwarded += remainder;
  }

  logPot(`[stud-pot] totalAwarded=${totalAwarded} (pot was ${room.pot})`);
  logPot(`[stud-pot] ===== END chips: ${contestants.map(p => `${p.name}=${p.chips}`).join(', ')} =====`);
  room.pot = 0;
}

/**
 * 単一の（サイド）ポットを精算する。
 * stud_e は Hi/Lo スプリット、razz/stud_s は単独勝者。
 * @param {object}   room
 * @param {Array}    seatRef    端数受け取り順の基準となるプレイヤー配列（座席順）
 * @param {Array}    eligible   このポットを争う未フォールドプレイヤー
 * @param {number}   amount     このポットの金額
 * @param {string}   mode
 * @param {number}   refIdx     端数基準の座席インデックス
 * @param {string}   label      ログ用ラベル
 */
function _awardSinglePot(room, seatRef, eligible, amount, mode, refIdx, label) {
  if (amount <= 0 || eligible.length === 0) return;
  const evalList = eligible.map((p) => ({ id: p.id, cards: p.cards }));

  if (mode === 'razz') {
    const winners = findLoWinners(evalList, 'razz');
    _splitPotChips(room, seatRef, eligible, winners, amount, refIdx, `${label}:razz-lo`);
  } else if (mode === 'stud_s') {
    const winners = findHiWinners(evalList, 'stud_s');
    _splitPotChips(room, seatRef, eligible, winners, amount, refIdx, `${label}:stud-hi`);
  } else { // stud_e: Hi/Lo
    const hiWinners = findHiWinners(evalList, 'stud_e');
    const loWinners = findLoWinners(evalList, 'stud_e');
    if (loWinners.length === 0) {
      // ロー不成立 → ハイ総取り
      _splitPotChips(room, seatRef, eligible, hiWinners, amount, refIdx, `${label}:hi-only`);
    } else {
      // ハイ/ロー折半（端数はハイ側へ）
      const loShare = Math.floor(amount / 2);
      const hiShare = amount - loShare; // 端数はハイ
      _splitPotChips(room, seatRef, eligible, hiWinners, hiShare, refIdx, `${label}:hi`);
      _splitPotChips(room, seatRef, eligible, loWinners, loShare, refIdx, `${label}:lo`);
    }
  }
}

/**
 * 金額を勝者で等分し、奇数チップは基準座席から時計回りで最初の勝者へ。
 * @param {Array}    seatRef   座席順の基準配列
 * @param {Array}    eligible  資格者（id解決用）
 * @param {string[]} winnerIds 勝者id
 */
function _splitPotChips(room, seatRef, eligible, winnerIds, amount, refIdx, label) {
  if (!winnerIds || winnerIds.length === 0 || amount <= 0) return;
  const winners = eligible.filter((p) => winnerIds.includes(p.id));
  if (winners.length === 0) return;

  const share = Math.floor(amount / winners.length);
  const odd = amount - share * winners.length;

  // 端数受け取り者: 基準座席から時計回りで最初に見つかる勝者
  const n = seatRef.length;
  let oddWinner = winners[0];
  let minDist = Infinity;
  for (const w of winners) {
    const idx = seatRef.indexOf(w);
    if (idx < 0) continue;
    const dist = ((idx - refIdx) % n + n) % n;
    if (dist < minDist) { minDist = dist; oddWinner = w; }
  }

  for (const w of winners) {
    const got = share + (w === oddWinner ? odd : 0);
    w.chips += got;
    logPot(`[stud-pot] ${label}: ${w.name} += ${got}${w === oddWinner && odd > 0 ? ` (incl ${odd} odd)` : ''}`);
  }
}

// ==========================================================
// ■ ゲーム状態のビルド（buildGameState 互換）
// ==========================================================

/**
 * gameManager.buildGameState と同じ [...playerStates, meta] 配列を返す。
 * カード公開ロジックがスタッド特有:
 *   - 自分: 全カード見える（faceUp 情報も渡してダウン/アップを区別）
 *   - 他人: 表向きカードのみ実カード、裏向きは '??'
 *   - フォールド者: 全カード '??'（アップカードも隠す）
 *   - showdown: contested なら全員の全カード公開
 */
function buildStudGameState(room, requesterId) {
  const isShowdown = room.phase === 'showdown';
  const contestants = room.players.filter((p) => !p.folded && !p.sittingOut);

  if (isShowdown && !room._potAwarded) {
    _awardStudPots(room, contestants);
    room._potAwarded = true;
  }

  let winnerIds = null;
  if (isShowdown) {
    winnerIds = new Set();
    const evalList = contestants.map((p) => ({ id: p.id, cards: p.cards }));
    if (room.currentMode === 'razz') {
      findLoWinners(evalList, 'razz').forEach((id) => winnerIds.add(id));
    } else if (room.currentMode === 'stud_s') {
      findHiWinners(evalList, 'stud_s').forEach((id) => winnerIds.add(id));
    } else {
      findHiWinners(evalList, 'stud_e').forEach((id) => winnerIds.add(id));
      findLoWinners(evalList, 'stud_e').forEach((id) => winnerIds.add(id));
    }
    if (contestants.length === 1) winnerIds.add(contestants[0].id);
  }

  const currentPlayer = room.actionIndex >= 0 ? room.players[room.actionIndex] : null;
  const isBetPhase = room.phase.startsWith('bet');
  const timerRemaining = _getTimerRemaining(room);
  const dealerIdx = room.fixedDealerIdx >= 0 ? room.fixedDealerIdx : room.dealerIndex;

  const playerStates = room.players.map((p) => {
    const isSelf = p.id === requesterId;
    const isContested = contestants.length >= 2;
    const revealAll = isSelf || (isShowdown && !p.folded && isContested);
    const isMyTurn = !isShowdown && currentPlayer != null && p.id === currentPlayer.id;
    const toCall = isBetPhase ? Math.max(0, room.currentBet - p.bet) : 0;
    const myIdx = room.players.indexOf(p);

    // カード配列の構築: 各カードに faceUp 情報を持たせて配信
    // クライアントは { code, up } で表示判定する
    const handCards = (p.cards || []).map((code, i) => {
      const up = p.faceUp[i];
      if (p.folded && !isSelf) {
        // フォールド者: アップカードも隠す
        return { code: '??', up: false, folded: true };
      }
      if (revealAll) {
        return { code, up };
      }
      // 他人: 表向きのみ実カード
      return { code: up ? code : '??', up };
    });

    return {
      id: p.id, name: p.name, chips: p.chips, bet: p.bet,
      folded: p.folded, sittingOut: p.sittingOut,
      disconnected: p.disconnected ?? false,
      // hand は { code, up } のオブジェクト配列（gameManager は string配列だが
      // StudTable は studCards を参照する。互換のため hand にも code 配列を入れる）
      hand: handCards.map((c) => c.code),
      studCards: handCards,
      isSelf, isMyTurn,
      isBringIn: p.isBringIn ?? false,
      result: revealAll && p.cards && p.cards.length >= 3 && !p.folded
        ? studHandName(p.cards, room.currentMode) : undefined,
      isWinner: isShowdown && winnerIds != null && winnerIds.has(p.id),
      isDealer: myIdx === dealerIdx,
      isSB: false, isBB: false,
      ...(isSelf ? (() => {
        const _canRaise = isBetPhase && p.chips > 0
          && room.raiseCount < MAX_RAISES
          && room.players.some((op) => op.id !== p.id && !op.folded && !op.sittingOut && op.chips > 0);
        // 3rd street でブリングインのみ（currentBet < betSize）の場合、
        // bet/raise アクションは「コンプリート」（smallBet まで引き上げ）になる。
        // それ以外は通常のレイズ（currentBet + betSize）。
        const _isComplete = room.phase === 'bet3rd' && room.currentBet < room.betSize;
        const _raiseTotal = _isComplete ? room.betSize : (room.currentBet + room.betSize);
        // 実際に必要なチップ（コール/レイズ時に投じる額）
        const _raiseCost  = Math.max(0, _raiseTotal - p.bet);
        return {
          toCall: p.chips <= 0 ? 0 : Math.min(toCall, p.chips),
          canCheck: isBetPhase && (toCall === 0 || p.chips <= 0),
          isAllIn: p.chips <= 0 && !p.folded,
          canRaise: _canRaise,
          // UI表示用: コンプリートかレイズかの区別と、投じるチップ額
          isComplete: _isComplete,
          raiseToTotal: _raiseTotal,
          raiseCost: Math.min(_raiseCost, p.chips),
          betSize: room.betSize,
          isNL: false,
        };
      })() : {}),
      ...(isMyTurn ? { timerRemaining } : {}),
    };
  });

  const meta = {
    _meta: true,
    phase: room.phase,
    mode: room.mode,
    currentMode: room.currentMode,
    isStud: true,
    street: phaseStreet(room.phase) || (isShowdown ? 'showdown' : null),
    pot: room.pot,
    pots: room.pot > 0 ? [{ amount: room.pot, label: 'ポット' }] : [],
    currentBet: room.currentBet,
    betSize: room.betSize,
    raiseCount: room.raiseCount,
    maxRaises: MAX_RAISES,
    dealerIndex: dealerIdx,
    bringInIndex: room.bringInIndex ?? -1,
    ante: room.ante,
    bringInAmount: room.bringInAmount,
    handCount: room.handCount,
    timerRemaining, timerLimit: room._timerLimit,
    pendingPlayers: [],
    playerCount: room.players.length,
    maxPlayers: MAX_PLAYERS,
    roomId: room.id,
    isNL: false,
  };

  return [...playerStates, meta];
}

// ==========================================================
// ■ タイマー
// ==========================================================

function _startTimer(room) {
  _clearTimer(room);
  const limit = cfg.BET_TIME_LIMIT;
  if (limit <= 0 || !room._onTimeout) { room._timerLimit = 0; return; }
  room._timerLimit = limit;
  room._timerStart = Date.now();
  room._timer = setTimeout(() => {
    // 発火時点で actionIndex を再読み込みする（クロージャで古い player を
    // 捕捉しないため。gameManager._startTimer と同方式）
    const cur = room.players[room.actionIndex];
    if (cur && room._onTimeout) room._onTimeout(room.id, room.phase, cur.id);
  }, limit * 1000);
}

function _clearTimer(room) {
  if (room._timer) { clearTimeout(room._timer); room._timer = null; }
}

function _getTimerRemaining(room) {
  if (!room._timerLimit || !room._timerStart) return null;
  const elapsed = (Date.now() - room._timerStart) / 1000;
  return Math.max(0, Math.ceil(room._timerLimit - elapsed));
}

/** タイムアウト時のデフォルトアクション: チェック可能ならチェック、不可ならフォールド */
function handleStudTimeout(roomId, socketId) {
  const room = studRooms.get(roomId);
  if (!room) return null;
  const p = room.players.find((x) => x.id === socketId);
  if (!p) return null;
  const toCall = room.currentBet - p.bet;
  return studBetAction(roomId, socketId, toCall > 0 ? 'fold' : 'check', 0);
}

/**
 * スタッドハンド確定後のリセット。
 * phase を 'waiting' に戻すことで _isStudActive が false を返すようになり、
 * 次ハンド（ドロー系・スタッド系いずれも）が正しいエンジンにルーティングされる。
 *
 * 【重要】これを呼ばないと showdown 状態が studRooms に残留し、
 * BEAST+ でスタッド→ドローに切り替わってもなお _broadcastStud に
 * 誤ルーティングされ続ける（High-1 バグ）。ショーダウン後処理から必ず呼ぶこと。
 *
 * @returns {boolean} リセットを実行したら true
 */
function finishStudHand(roomId) {
  const room = studRooms.get(roomId);
  if (!room) return false;
  // 精算が未実行なら確実に実行（防御的）
  if (room.phase === 'showdown' && !room._potAwarded) {
    const contestants = room.players.filter((p) => !p.folded && !p.sittingOut);
    _awardStudPots(room, contestants);
    room._potAwarded = true;
  }
  _clearTimer(room);
  room.phase       = 'waiting';
  room.actionIndex = -1;
  room.currentBet  = 0;
  room.raiseCount  = 0;
  return true;
}

// ==========================================================
// ■ ヘルパー
// ==========================================================

function _nextActive(room, fromIndex) {
  const len = room.players.length;
  if (len === 0) return -1;
  let next = ((fromIndex % len) + len) % len;
  for (let t = 0; t < len; t++) {
    next = (next + 1) % len;
    const p = room.players[next];
    if (p && !p.folded && !p.sittingOut) return next;
  }
  return fromIndex;
}

/** プレイヤー退室処理 */
function studLeaveRoom(roomId, socketId) {
  const room = studRooms.get(roomId);
  if (!room) return null;
  const idx = room.players.findIndex((p) => p.id === socketId);
  if (idx === -1) return null;

  const inProgress = PHASES.indexOf(room.phase) > 1 && room.phase !== 'showdown';
  if (inProgress) {
    const player = room.players[idx];
    player.folded = true; player.acted = true;
    if (room.actionIndex === idx) {
      _clearTimer(room);
      _advanceBetAction(room);
    }
  }
  // 完全削除はしない（gameManager 側と整合を取るため sittingOut にする運用も可能だが
  // ここでは splice）
  room.players.splice(idx, 1);
  if (room.fixedDealerIdx === idx) room.fixedDealerIdx = -1;
  else if (room.fixedDealerIdx > idx) room.fixedDealerIdx--;
  if (room.actionIndex > idx) room.actionIndex--;

  if (room.players.length === 0) {
    _clearTimer(room);
    room.phase = 'waiting';
    room.pot = 0;
    room.actionIndex = -1;
  }
  return room;
}

// ==========================================================
// ■ gameManager ルームとの同期（案1: ローテーション時同期）
// ==========================================================

/**
 * gameManager のルームから studManager のルームへ
 * プレイヤー・チップ・座席・ブラインドレベルを同期する。
 * BEAST+ / stud_mix がスタッドゲームに切り替わる直前に index.js が呼ぶ。
 *
 * @param {object} gmRoom gameManager のルーム
 * @param {string} currentMode 今ハンドのスタッドモード（stud_s/stud_e/razz）
 */
function syncFromGameManager(gmRoom, currentMode) {
  const room = ensureStudRoom(gmRoom.id, gmRoom);

  // メタ情報を引き継ぐ
  room.mode          = gmRoom.mode;
  room.currentMode   = currentMode;
  room.smallBet      = gmRoom.smallBet;
  room.bigBet        = gmRoom.bigBet;
  room.startingChips = gmRoom.startingChips;
  room.handCount     = gmRoom.handCount;
  room._isTournament = gmRoom._isTournament ?? gmRoom._tournamentId != null;
  room._tournamentId = gmRoom._tournamentId ?? null;

  // プレイヤーを同期（チップ・名前・id・sittingOut を引き継ぐ）
  // 既存の studManager 側プレイヤー配列は破棄し、gameManager の順序で再構築する
  // （座席順を保つため）
  room.players = gmRoom.players.map((gp) => ({
    id:         gp.id,
    name:       gp.name,
    chips:      gp.chips,
    sittingOut: !!gp.sittingOut,
    disconnected: gp.disconnected ?? false,
    isBot:      gp.isBot ?? false,
    accountId:  gp.accountId ?? null,
    // スタッド用フィールドは startStudHand で初期化される
    cards: [], faceUp: [], bet: 0, folded: false, acted: false,
    totalContribution: 0, isBringIn: false,
  }));

  return room;
}

/**
 * スタッドハンド終了後、studManager のチップを gameManager のルームへ書き戻す。
 * 次が再びスタッドでも、ドロー系でも、チップの連続性を保証する。
 *
 * 【重要】照合は accountId を優先する。ハンド進行中に再接続で socket.id（player.id）が
 * 更新されると、id だけで照合するとチップ書き戻しに失敗し、gameManager 側のチップが
 * 古いまま残る → checkEliminations が誤って chips<=0 と判定し、チップが残っている
 * プレイヤーを脱落させる（「スタック残存で飛び扱い」バグ）。
 *
 * @param {object} gmRoom gameManager のルーム
 */
function syncToGameManager(gmRoom) {
  const room = studRooms.get(gmRoom.id);
  if (!room) return;
  // accountId と id の両方でチップを引けるようにする（accountId 優先）
  const chipByAccount = new Map();
  const chipById      = new Map();
  for (const p of room.players) {
    if (p.accountId) chipByAccount.set(p.accountId, p.chips);
    if (p.id)        chipById.set(p.id, p.chips);
  }
  for (const gp of gmRoom.players) {
    if (gp.accountId && chipByAccount.has(gp.accountId)) {
      gp.chips = chipByAccount.get(gp.accountId);
    } else if (chipById.has(gp.id)) {
      gp.chips = chipById.get(gp.id);
    } else {
      // どちらでも一致しない = 同期漏れ。チップを破壊しないよう警告だけ出して既存値を保持。
      log(`[stud-sync] WARN: ${gp.name} (id=${String(gp.id).slice(-8)}, accId=${gp.accountId}) not found in studRoom — chips left as ${gp.chips}`);
    }
  }
  // handCount を同期（studManager 側で +1 されているため）
  gmRoom.handCount = room.handCount;
}

/**
 * 再接続時に studManager 側プレイヤーの socket.id を更新する。
 * gameManager 側だけ id を更新して studManager 側を放置すると、
 * 手番照合（studBetAction の socketId 一致）が失敗して操作不能になり、
 * チップ書き戻し（syncToGameManager）も id 不一致で失敗する。
 *
 * @param {string} roomId
 * @param {string} accountId 照合キー（accountId 優先、なければ nickname）
 * @param {string} nickname
 * @param {string} newSocketId 新しい socket.id
 * @returns {boolean} 更新したら true
 */
function updateStudPlayerSocketId(roomId, accountId, nickname, newSocketId) {
  const room = studRooms.get(roomId);
  if (!room) return false;
  const p = room.players.find(
    (x) => (accountId && x.accountId === accountId) || (nickname && x.name === nickname)
  );
  if (!p) return false;
  if (p.id === newSocketId) return false;
  // 手番中だった場合に備え、actionIndex は配列インデックス基準なので id 変更で影響なし
  p.id = newSocketId;
  if (p.disconnected) p.disconnected = false;
  return true;
}

/**
 * テーブルバランシングでプレイヤーが他テーブルへ移動した際に、
 * studManager 側からも安全に削除する。
 * studLeaveRoom と異なり「フォールド扱い」にはせず、純粋に座席から除く。
 * actionIndex / fixedDealerIdx を正しく調整し、配列だけ縮める不整合を防ぐ。
 *
 * @param {string} roomId
 * @param {string} playerId socket.id
 * @param {string|null} accountId 照合補助
 * @returns {boolean} 削除したら true
 */
function removePlayerForBalance(roomId, playerId, accountId) {
  const room = studRooms.get(roomId);
  if (!room || !Array.isArray(room.players)) return false;
  const idx = room.players.findIndex(
    (p) => p.id === playerId || (accountId && p.accountId === accountId)
  );
  if (idx === -1) return false;

  // 手番だったプレイヤーを消す場合はタイマーを止める（呼び出し側で進行を再判定）
  if (room.actionIndex === idx) _clearTimer(room);

  room.players.splice(idx, 1);

  // インデックス調整（studLeaveRoom と同等）
  if (room.fixedDealerIdx === idx) room.fixedDealerIdx = -1;
  else if (room.fixedDealerIdx > idx) room.fixedDealerIdx--;
  if (room.actionIndex > idx) room.actionIndex--;
  else if (room.actionIndex === idx) room.actionIndex = -1;

  if (room.players.length === 0) {
    _clearTimer(room);
    room.phase = 'waiting';
    room.pot = 0;
    room.actionIndex = -1;
  }
  return true;
}

module.exports = {
  STUD_MODES,
  isStudMode,
  PHASES,
  STREETS,
  phaseStreet,
  studRooms,
  getStudRoom,
  ensureStudRoom,
  startStudHand,
  studBetAction,
  buildStudGameState,
  handleStudTimeout,
  finishStudHand,
  studLeaveRoom,
  syncFromGameManager,
  syncToGameManager,
  updateStudPlayerSocketId,
  removePlayerForBalance,
  _awardStudPots,   // テスト用
  _nextActive,
};
