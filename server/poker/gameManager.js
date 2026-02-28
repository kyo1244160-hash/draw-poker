/**
 * gameManager.js — ゲーム状態管理
 *
 * 2種類のゲームを管理します:
 *   - 2-7 Triple Draw: 5枚 × 3回ドロー、ローボール
 *   - Badugi:          4枚 × 3回ドロー、ローボール（スート全異なりが強い）
 *
 * 共通ゲームフロー:
 *   waiting → draw1 → bet1 → draw2 → bet2 → draw3 → bet3 → showdown
 *
 * ベット: フィックスドリミット / SB+BB 制
 * チップ: 毎ゲーム 100BB にリセット
 * タイマー: config.js の DRAW_TIME_LIMIT / BET_TIME_LIMIT で制御
 */

const { createShuffledDeck }          = require('./deck');
const { evaluate27Hand, evaluateBadugiHand, findWinner } = require('./handEvaluator');
const cfg                              = require('../config');

// ===== 定数（config.js から計算）=====
const BB           = cfg.BB_VALUE;                         // 1BB のチップ値
const STARTING_CHIPS = cfg.STARTING_BB * BB;               // 開始チップ（100BB）
const SMALL_BLIND  = Math.round(cfg.SMALL_BLIND_BB  * BB); // SB
const BIG_BLIND    = Math.round(cfg.BIG_BLIND_BB    * BB); // BB
const SMALL_BET    = Math.round(cfg.SMALL_BET_BB    * BB); // bet1/bet2
const BIG_BET      = Math.round(cfg.BIG_BET_BB      * BB); // bet3
const MAX_RAISES   = cfg.MAX_RAISES;

/** ゲームフェーズの順序 */
const PHASES = ['waiting','draw1','bet1','draw2','bet2','draw3','bet3','showdown'];

/** 部屋番号 → ゲームモード ('27' or 'badugi') */
function getRoomMode(roomId) {
  // 末尾の数字を抽出。奇数=2-7、偶数=Badugi
  const match = roomId.match(/(\d+)$/);
  if (!match) return '27';
  return parseInt(match[1], 10) % 2 === 0 ? 'badugi' : '27';
}

/** 1ゲームで配るカード枚数（2-7: 5枚、Badugi: 4枚）*/
function handSize(mode) {
  return mode === 'badugi' ? 4 : 5;
}

/** 役名を返す（モードに応じて）*/
function evaluateHand(hand, mode) {
  if (mode === 'badugi') return evaluateBadugiHand(hand);
  return evaluate27Hand(hand);
}

// ===== ルームストレージ =====
/** roomId → Room オブジェクトのマップ */
const rooms = new Map();

/**
 * ルームを取得する。存在しない場合は新規作成する。
 * @param {string} roomId
 * @returns {Room}
 */
function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id:           roomId,
      mode:         getRoomMode(roomId), // '27' または 'badugi'
      players:      [],  // ServerPlayer[]
      deck:         [],
      phase:        'waiting',
      pot:          0,
      dealerIndex:  -1,  // BTN（ディーラー）のインデックス
      actionIndex:  -1,  // 現在アクション中プレイヤーのインデックス
      currentBet:   0,   // このベットラウンドの最高ベット額
      raiseCount:   0,   // このベットラウンドのレイズ回数
      betSize:      SMALL_BET,
      _potAwarded:  false, // ポット付与済みフラグ
      _timer:       null,  // タイムアウトタイマーの参照
      _timerStart:  null,  // タイマー開始時刻（ms）
      _timerLimit:  0,     // 現在のタイムリミット（秒）
    });
  }
  return rooms.get(roomId);
}

/**
 * プレイヤーをルームに追加する。
 * 同名プレイヤーが既存の場合は socket.id を更新（再接続対応）。
 * @returns {boolean} 新規追加なら true
 */
function joinRoom(roomId, socketId, name) {
  const room = getOrCreateRoom(roomId);
  const existing = room.players.find((p) => p.name === name);
  if (existing) {
    existing.id = socketId;
    return false; // 再接続
  }
  room.players.push({
    id:             socketId,
    name,
    chips:          STARTING_CHIPS, // 100BB でスタート
    hand:           [],
    bet:            0,
    folded:         false,
    acted:          false,
    drewThisRound:  false,
    drawCount:      null, // このドローで交換した枚数（他プレイヤーに通知）
  });
  return true; // 新規追加
}

// ==========================================================
// ■ ゲーム開始
// ==========================================================

/**
 * ゲームを開始する。
 * - チップを 100BB にリセット
 * - デッキをシャッフルして各プレイヤーに配布
 * - SB/BB をポスト
 * - draw1 フェーズへ移行
 *
 * @param {string}   roomId
 * @param {Function} onTimeout - タイムアウト時に呼ばれるコールバック (roomId, phase, playerId) => void
 * @returns {Room|null}
 */
function startGame(roomId, onTimeout) {
  const room = rooms.get(roomId);
  if (!room || room.players.length < 2) return null;

  // --- チップを毎ゲーム 100BB にリセット ---
  for (const p of room.players) {
    p.chips = STARTING_CHIPS;
  }

  // --- デッキ・ポット初期化 ---
  room.deck         = createShuffledDeck();
  room.pot          = 0;
  room._potAwarded  = false;
  room._onTimeout   = onTimeout; // タイムアウトコールバックを保存

  // --- ディーラーボタンを時計回りに1つ進める ---
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;

  // --- 全プレイヤーのゲーム状態をリセットして手札を配る ---
  const size = handSize(room.mode);
  for (const p of room.players) {
    p.hand          = room.deck.splice(0, size); // 2-7: 5枚, Badugi: 4枚
    p.bet           = 0;
    p.folded        = false;
    p.acted         = false;
    p.drewThisRound = false;
    p.drawCount     = null;
  }

  // --- SB / BB をポスト（強制ベット）---
  const sbIndex = (room.dealerIndex + 1) % room.players.length;
  const bbIndex = (room.dealerIndex + 2) % room.players.length;
  _postBlind(room, sbIndex, SMALL_BLIND);
  _postBlind(room, bbIndex, BIG_BLIND);

  // --- draw1 フェーズへ移行（SBから行動）---
  room.phase        = 'draw1';
  room.currentBet   = 0;
  room.raiseCount   = 0;
  room.actionIndex  = sbIndex;
  _resetDrawRound(room);

  // --- タイマーをセット ---
  _startTimer(room);

  return room;
}

/** ブラインドをポストする（チップを強制徴収）*/
function _postBlind(room, idx, amount) {
  const p      = room.players[idx];
  const actual = Math.min(amount, p.chips);
  p.chips     -= actual;
  p.bet       += actual;
  room.pot    += actual;
}

/** ドローラウンドの「済み」フラグをリセット */
function _resetDrawRound(room) {
  for (const p of room.players) p.drewThisRound = false;
}

/** ベットラウンドの状態をリセット */
function _resetBetRound(room, betSize) {
  room.currentBet = 0;
  room.raiseCount = 0;
  room.betSize    = betSize;
  for (const p of room.players) { p.bet = 0; p.acted = false; }
}

// ==========================================================
// ■ タイマー管理
// ==========================================================

/**
 * 現在のフェーズに応じたタイマーをセット
 * 制限時間が 0 の場合はタイマーなし
 */
function _startTimer(room) {
  _clearTimer(room); // 既存タイマーをクリア

  const limitSec = room.phase.startsWith('draw')
    ? cfg.DRAW_TIME_LIMIT
    : cfg.BET_TIME_LIMIT;

  if (limitSec <= 0 || !room._onTimeout) return; // タイマーなし設定

  room._timerStart = Date.now();
  room._timerLimit = limitSec;
  room._timer      = setTimeout(() => {
    // タイムアウト → 自動アクションを実行
    const currentPlayer = room.players[room.actionIndex];
    if (!currentPlayer) return;
    if (room._onTimeout) {
      room._onTimeout(room.id, room.phase, currentPlayer.id);
    }
  }, limitSec * 1000);
}

/** タイマーをクリア */
function _clearTimer(room) {
  if (room._timer) {
    clearTimeout(room._timer);
    room._timer      = null;
    room._timerStart = null;
    room._timerLimit = 0;
  }
}

/** タイマーの残り秒数を返す */
function getTimerRemaining(room) {
  if (!room._timerStart || !room._timerLimit) return null;
  const elapsed = (Date.now() - room._timerStart) / 1000;
  return Math.max(0, room._timerLimit - elapsed);
}

// ==========================================================
// ■ ドロー処理
// ==========================================================

/**
 * カードを交換（ドロー）する。
 * 必ず自分のターンでのみ呼べる。
 * 0 枚指定 = スタンドパット（交換なし）。
 *
 * @param {string}   roomId
 * @param {string}   socketId
 * @param {number[]} indices - 交換するカードの手札インデックス（0始まり）
 * @returns {Room|null}
 */
function drawCards(roomId, socketId, indices) {
  const room = rooms.get(roomId);
  if (!room || !room.phase.startsWith('draw')) return null;

  // 自分のターンでなければ拒否
  const myIndex = room.players.findIndex((p) => p.id === socketId);
  if (myIndex !== room.actionIndex) return null;

  const player = room.players[myIndex];
  if (player.drewThisRound || player.folded) return null;

  // 有効なインデックスのみ（重複除去・範囲チェック）
  const maxCards = handSize(room.mode); // 2-7: 5, Badugi: 4
  const validIndices = [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < maxCards);

  // 指定インデックスのカードを新しいカードに交換
  for (const i of validIndices) {
    const newCard = room.deck.shift();
    if (newCard) player.hand[i] = newCard;
  }
  player.drewThisRound = true;
  player.drawCount     = validIndices.length; // 交換枚数（他プレイヤーに通知）

  _clearTimer(room); // タイマーをクリア
  _advanceDrawAction(room); // 次のプレイヤーへ
  return room;
}

/**
 * ドロー行動を次のプレイヤーに進める。
 * 全員完了したら次のフェーズへ移行。
 */
function _advanceDrawAction(room) {
  const active = room.players.filter((p) => !p.folded);

  // 全員ドロー完了 → 次フェーズへ
  if (active.every((p) => p.drewThisRound)) {
    _nextPhase(room);
    return;
  }

  // 次のまだドローしていないアクティブプレイヤーを探す
  let next = (room.actionIndex + 1) % room.players.length;
  while (room.players[next].folded || room.players[next].drewThisRound) {
    next = (next + 1) % room.players.length;
  }
  room.actionIndex = next;
  _startTimer(room); // タイマーをリセット
}

// ==========================================================
// ■ ベット処理
// ==========================================================

/**
 * ベットアクションを処理する。
 * action: 'fold' | 'check' | 'call' | 'bet' | 'raise'
 *
 * @returns {Room|null}
 */
function betAction(roomId, socketId, action) {
  const room = rooms.get(roomId);
  if (!room || !room.phase.startsWith('bet')) return null;

  // 自分のターンでなければ拒否
  const myIndex = room.players.findIndex((p) => p.id === socketId);
  if (myIndex !== room.actionIndex) return null;

  const player = room.players[myIndex];
  if (player.folded) return null;

  const toCall = room.currentBet - player.bet; // コールに必要な額

  if (action === 'fold') {
    // フォールド: 手を降りる
    player.folded = true;
    player.acted  = true;

  } else if (action === 'check') {
    // チェック: ベット額が揃っている場合のみ可能
    if (toCall > 0) return null; // チェック不可
    player.acted = true;

  } else if (action === 'call') {
    // コール: 現在の最高ベット額に合わせる
    const actual = Math.min(toCall, player.chips);
    player.chips -= actual;
    player.bet   += actual;
    room.pot     += actual;
    player.acted  = true;

  } else if (action === 'bet' || action === 'raise') {
    // ベット/レイズ: betSize 分だけ上乗せ
    if (room.raiseCount >= MAX_RAISES && action === 'raise') {
      // レイズ上限に達した場合はコールに変換
      const actual = Math.min(toCall, player.chips);
      player.chips -= actual;
      player.bet   += actual;
      room.pot     += actual;
      player.acted  = true;
    } else {
      const betTotal  = room.currentBet + room.betSize; // 新しい最高ベット額
      const needed    = betTotal - player.bet;
      const actual    = Math.min(needed, player.chips);
      player.chips   -= actual;
      player.bet     += actual;
      room.pot       += actual;
      room.currentBet = player.bet;
      room.raiseCount += 1;
      player.acted    = true;
      // レイズ後は他のアクティブプレイヤーの acted をリセット（再アクションが必要）
      for (let i = 0; i < room.players.length; i++) {
        if (i !== myIndex && !room.players[i].folded) {
          room.players[i].acted = false;
        }
      }
    }
  } else {
    return null; // 不正なアクション
  }

  _clearTimer(room);
  _advanceBetAction(room);
  return room;
}

/**
 * ベット行動を次のプレイヤーに進める。
 * 全員アクション完了かつベット額が揃ったら次フェーズへ。
 */
function _advanceBetAction(room) {
  const active = room.players.filter((p) => !p.folded);

  // アクティブが1人だけ → その人の勝ち
  if (active.length <= 1) {
    _clearTimer(room);
    room.phase = 'showdown';
    return;
  }

  // 全員 acted かつ ベット額が揃った → 次フェーズへ
  const allActed   = active.every((p) => p.acted);
  const betsEqual  = active.every((p) => p.bet === active[0].bet);
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
  _startTimer(room);
}

// ==========================================================
// ■ フェーズ遷移
// ==========================================================

/** 現在のフェーズから次のフェーズへ進む */
function _nextPhase(room) {
  const idx  = PHASES.indexOf(room.phase);
  const next = PHASES[idx + 1] ?? 'showdown';
  room.phase = next;

  if (next.startsWith('draw')) {
    // ドローフェーズへ: SBから行動
    _resetDrawRound(room);
    const sbIndex    = (room.dealerIndex + 1) % room.players.length;
    room.actionIndex = _nextActive(room, sbIndex - 1);
    _startTimer(room);

  } else if (next.startsWith('bet')) {
    // ベットフェーズへ: bet3 のみ bigBet を使用
    const betSize    = (next === 'bet3') ? BIG_BET : SMALL_BET;
    _resetBetRound(room, betSize);
    const sbIndex    = (room.dealerIndex + 1) % room.players.length;
    room.actionIndex = _nextActive(room, sbIndex - 1);
    _startTimer(room);

  } else if (next === 'showdown') {
    // ショーダウン: タイマー不要
    _clearTimer(room);
  }
}

/** 次のアクティブ（フォールドしていない）プレイヤーのインデックスを返す */
function _nextActive(room, fromIndex) {
  let next = (fromIndex + 1) % room.players.length;
  while (room.players[next].folded) {
    next = (next + 1) % room.players.length;
  }
  return next;
}

// ==========================================================
// ■ ゲーム状態をクライアント向けにビルド
// ==========================================================

/**
 * 各プレイヤーに送るゲーム状態を生成する。
 * - 自分の手札と役は常に公開
 * - 他プレイヤーの手札はショーダウン前は '??' で隠す
 * - ショーダウン時のみ勝者に pot を付与（1回だけ）
 *
 * @param {Room}   room
 * @param {string} requesterId - 受信者の socketId
 * @returns {Array} プレイヤー配列 + メタオブジェクト
 */
function buildGameState(room, requesterId) {
  const isShowdown   = room.phase === 'showdown';
  const activePlayers = room.players.filter((p) => !p.folded);
  const winnerId     = isShowdown
    ? findWinner(activePlayers, room.mode)
    : null;

  // ショーダウン時にポットを勝者に付与（1回だけ実行）
  if (isShowdown && winnerId && !room._potAwarded) {
    const winner = room.players.find((p) => p.id === winnerId);
    if (winner) winner.chips += room.pot;
    room._potAwarded = true;
  }

  const currentPlayer = room.players[room.actionIndex];
  const isDrawPhase   = room.phase.startsWith('draw');
  const isBetPhase    = room.phase.startsWith('bet');
  const timerRemaining = getTimerRemaining(room); // 残り秒数（null = タイマーなし）

  const playerStates = room.players.map((p) => {
    const isSelf   = (p.id === requesterId);
    const reveal   = isShowdown || isSelf;
    const isMyTurn = !isShowdown && currentPlayer && (p.id === currentPlayer.id);
    const toCall   = isBetPhase ? Math.max(0, room.currentBet - p.bet) : 0;

    return {
      id:             p.id,
      name:           p.name,
      chips:          p.chips,
      bet:            p.bet,
      folded:         p.folded,
      // 手札: 自分 or ショーダウン時のみ公開、それ以外は '??' で隠す
      hand:           reveal ? p.hand : p.hand.map(() => '??'),
      isSelf,
      isMyTurn,
      drewThisRound:  p.drewThisRound,
      drawCount:      p.drawCount,   // 他プレイヤーに見せる交換枚数
      result:         (reveal && p.hand.length > 0 && !p.folded)
                        ? evaluateHand(p.hand, room.mode)
                        : undefined,
      isWinner:       isShowdown && p.id === winnerId,
      // ポジションバッジ
      isDealer: room.players.indexOf(p) === room.dealerIndex,
      isSB:     room.players.indexOf(p) === (room.dealerIndex + 1) % room.players.length,
      isBB:     room.players.indexOf(p) === (room.dealerIndex + 2) % room.players.length,
      // 自分だけに送るベット情報
      ...(isSelf ? {
        toCall,
        canCheck: isBetPhase && toCall === 0,
        canRaise: isBetPhase && room.raiseCount < MAX_RAISES,
        betSize:  room.betSize,
      } : {}),
      // タイマー情報（自分のターンの場合のみ）
      ...(isMyTurn ? { timerRemaining } : {}),
    };
  });

  // メタ情報（フェーズ・ポット・ベット額など）
  const meta = {
    _meta:        true,
    phase:        room.phase,
    mode:         room.mode,        // '27' or 'badugi'
    pot:          room.pot,
    currentBet:   room.currentBet,
    betSize:      room.betSize,
    raiseCount:   room.raiseCount,
    dealerIndex:  room.dealerIndex,
    timerRemaining,                 // 全員に残り時間を送信
    timerLimit:   room._timerLimit, // 制限時間の総秒数
  };

  return [...playerStates, meta];
}

// ==========================================================
// ■ プレイヤー削除
// ==========================================================

/**
 * 切断したプレイヤーを全ルームから削除する。
 * ルームが空になった場合はルーム自体を削除する。
 * @returns {string|null} 削除が行われたルームID
 */
function removePlayer(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    const before = room.players.length;
    room.players = room.players.filter((p) => p.id !== socketId);
    if (room.players.length < before) {
      if (room.players.length === 0) {
        _clearTimer(room);
        rooms.delete(roomId);
      }
      return roomId;
    }
  }
  return null;
}

// ===== エクスポート =====
module.exports = {
  getOrCreateRoom,
  joinRoom,
  startGame,
  drawCards,
  betAction,
  buildGameState,
  removePlayer,
  getRoomMode,
  // 定数（外部参照用）
  STARTING_CHIPS, SMALL_BLIND, BIG_BLIND, SMALL_BET, BIG_BET,
};
