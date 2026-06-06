const { log, logDev, logPot } = require('../logger');

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
const { evaluate27Hand, evaluateA5Hand, evaluateBadugiHand, findWinner, findWinners } = require('./handEvaluator');
const cfg                                                = require('../config');
const { randomInt } = require('crypto');

// ===== 定数 =====
const SMALL_BLIND = cfg.SMALL_BLIND;
const BIG_BLIND   = cfg.BIG_BLIND;
const SMALL_BET   = cfg.SMALL_BET;   // 10
const BIG_BET     = cfg.BIG_BET;     // 20
const MAX_RAISES  = cfg.MAX_RAISES;  // 5（5bet-cap: raiseCount 1〜5）
const MAX_PLAYERS = cfg.MAX_PLAYERS; // 6
const STARTING_CHIPS = cfg.STARTING_BB * cfg.BB_VALUE;

/**
 * フェーズ一覧
 * bet2以降はビッグベット（draw2を超えた後）
 * Triple Draw系: 2-7TD / A-5 / Badugi（4ベットラウンド・3ドロー）
 */
const PHASES = ['waiting','bet0','draw1','bet1','draw2','bet2','draw3','bet3','showdown'];

/**
 * 27 Single Draw 用フェーズ（2ベットラウンド・1ドロー）
 * プリドロー → 1回ドロー → ベット → ショーダウン
 */
const PHASES_SD = ['waiting','bet0','draw1','bet1','showdown'];

/** モード別フェーズ配列を取得 */
function getPhases(mode) {
  return mode === '27sd' ? PHASES_SD : PHASES;
}

/** ノーリミットモード判定 */
function isNoLimitMode(mode) {
  return mode === '27sd';
}

function _roomIsNL(room) {
  return isNoLimitMode(room.currentMode || room.mode);
}

/**
 * Mix系モード判定（複数ゲームをローテーションする親モード）
 * - 'mix'      : 2-7TD ↔ Badugi（2ゲーム）
 * - 'mix3'     : 2-7TD → Badugi → A-5（3ゲーム）
 * - 'beast+'   : Badugi → StudHi/Lo → A-5 → 7Stud → 2-7TD → Razz（6ゲーム）
 * - 'stud_mix' : 7Stud → StudHi/Lo → Razz（3ゲーム・スタッドのみ）
 * 将来mix4等を追加する場合はここに追加するだけで全箇所の判定が更新される。
 */
function isMixMode(mode) {
  return mode === 'mix' || mode === 'mix3' || mode === 'beast+' || mode === 'stud_mix';
}

/** スタッド系モード判定（studManager にルーティングすべきモード） */
const STUD_MODES = ['stud_s', 'stud_e', 'razz'];
function isStudMode(mode) {
  return STUD_MODES.includes(mode);
}

/** ビッグベットフェーズか判定（draw2以降） */
function isBigBetPhase(phase) {
  return phase === 'bet2' || phase === 'bet3';
}

/** roomId からゲームモードを取得 */
function getRoomMode(roomId) {
  if (roomId.includes('3card'))  return '3card';
  if (roomId.includes('badugi')) return 'badugi';
  if (roomId.includes('mix3'))   return 'mix3';
  if (roomId.includes('mix'))    return 'mix';
  if (roomId.includes('27sd'))   return '27sd';
  if (roomId.includes('a5'))     return 'a5';
  return '27';
}

/** 手札枚数 — 全モード5枚（Badugiのみ4枚） */
function handSize(mode) { return mode === 'badugi' ? 4 : 5; }

/** 役判定 */
function evaluateHand(hand, mode) {
  if (mode === 'badugi') return evaluateBadugiHand(hand);
  if (mode === 'a5')     return evaluateA5Hand(hand);
  // '27' と '27sd' は同じ判定
  return evaluate27Hand(hand);
}

/**
 * mix モードの現在ゲームモード
 * mix      : 2-7TD ↔ Badugi（2ゲームローテ）
 * mix3     : 2-7TD → Badugi → A-5（3ゲームローテ）
 * beast+   : Badugi → StudHi/Lo → A-5 → 7Stud → 2-7TD → Razz（6ゲームローテ）
 * stud_mix : 7Stud → StudHi/Lo → Razz（3ゲームローテ・スタッドのみ）
 *
 * スタッド系（stud_s/stud_e/razz）を返した場合、呼び出し側（index.js）が
 * studManager にルーティングする。
 */
// ===== 【002/008 修正】Mix系モードのローテーションシーケンス定義 =====
// 各 mix 親モードが順番に切り替えるサブモードの配列。
// この配列の index を room._modeSeqIndex で管理する（人数非依存）。
const MIX_SEQUENCES = {
  'beast+':   ['badugi', 'stud_e', 'a5', 'stud_s', '27', 'razz'],
  'stud_mix': ['stud_s', 'stud_e', 'razz'],
  'mix3':     ['27', 'badugi', 'a5'],
  'mix':      ['27', 'badugi'],
};

/** mix親モードのシーケンス配列を返す（非mixなら null） */
function getMixSequence(mode) {
  return MIX_SEQUENCES[mode] ?? null;
}

/**
 * mix モードの現在ゲームモード
 * mix      : 2-7TD ↔ Badugi（2ゲームローテ）
 * mix3     : 2-7TD → Badugi → A-5（3ゲームローテ）
 * beast+   : Badugi → StudHi/Lo → A-5 → 7Stud → 2-7TD → Razz（6ゲームローテ）
 * stud_mix : 7Stud → StudHi/Lo → Razz（3ゲームローテ・スタッドのみ）
 *
 * 【002/008 修正】人数非依存。room._modeSeqIndex を参照してモードを決定する。
 * 旧実装は Math.floor(handCount / players.length) でモードを計算していたため、
 * テーブルバランスで人数が変わると同じ handCount でもモードがズレ、
 * ハンド途中のゲーム切替（008）や razz→stud_s 誤判定（002）を引き起こした。
 *
 * スタッド系（stud_s/stud_e/razz）を返した場合、呼び出し側（index.js）が
 * studManager にルーティングする。
 *
 * 副作用なし（純粋な読み取り）。カウンタの前進は advanceModeRotation で行う。
 */
function getMixCurrentMode(room) {
  const seq = getMixSequence(room.mode);
  if (!seq) return room.mode;  // 非mix
  const idx = ((room._modeSeqIndex ?? 0) % seq.length + seq.length) % seq.length;
  return seq[idx];
}

/**
 * 【002/008 修正】モードローテーションを1ステップ進めるか判定し、必要なら進める。
 * 各モードを「モード開始時の人数」分のハンド続ける（従来仕様の意図を踏襲）。
 * ただし継続ハンド数はモード開始時に固定するため、途中の人数変動で揺れない。
 *
 * ハンド開始の直前（startGame 内）で呼ぶこと。
 * @returns {string} 確定した現在モード
 */
/**
 * ディーラーボタンを次のアクティブプレイヤーへ1つ進める純粋関数。
 * startGame（ドロー系）とスタッド経路（index.js）の両方から呼ぶことで、
 * どちらのゲームでもボタンが毎ハンド移動することを保証する。
 *
 * - dealerIndex < 0（初回）: アクティブプレイヤーからランダムに選ぶ
 * - それ以降: 現在位置から時計回りで次の非 sittingOut プレイヤーへ
 *
 * @param {object} room gameManager のルーム
 * @returns {number} 新しい dealerIndex
 */
function advanceDealerButton(room) {
  if (!room.players || room.players.length === 0) {
    room.dealerIndex = -1;
    return -1;
  }
  if (room.dealerIndex < 0) {
    const activeIndices = room.players
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !p.sittingOut)
      .map(({ i }) => i);
    room.dealerIndex = activeIndices.length > 0
      ? activeIndices[randomInt(activeIndices.length)]
      : 0;
  } else {
    let next = (room.dealerIndex + 1) % room.players.length;
    for (let t = 0; t < room.players.length; t++) {
      if (!room.players[next]?.sittingOut) break;
      next = (next + 1) % room.players.length;
    }
    room.dealerIndex = next;
  }
  return room.dealerIndex;
}

function advanceModeRotation(room) {
  const seq = getMixSequence(room.mode);
  if (!seq) return room.mode;  // 非mixは何もしない

  // 未初期化（新規ルーム/最初のハンド）: 現人数で継続ハンド数を確定
  if (!room._modeHandsTotal || room._modeHandsTotal <= 0) {
    room._modeSeqIndex   = room._modeSeqIndex ?? 0;
    room._modeHandsTotal = Math.max(1, room.players.length);
    room._modeHandsDone  = 0;
    logDev(`[mode-rot] init mode=${seq[room._modeSeqIndex % seq.length]} seqIdx=${room._modeSeqIndex} handsTotal=${room._modeHandsTotal}`);
    return getMixCurrentMode(room);
  }

  // 現モードのハンドを消化済み → 次モードへ進む
  if (room._modeHandsDone >= room._modeHandsTotal) {
    const prevMode = getMixCurrentMode(room);
    room._modeSeqIndex   = (room._modeSeqIndex + 1) % seq.length;
    room._modeHandsTotal = Math.max(1, room.players.length);  // 新モード開始時の人数で再固定
    room._modeHandsDone  = 0;
    const newMode = getMixCurrentMode(room);
    log(`[mode-rot] ${room.id.slice(-8)} ${prevMode} → ${newMode} (seqIdx=${room._modeSeqIndex}, handsTotal=${room._modeHandsTotal})`);
  }
  return getMixCurrentMode(room);
}

/**
 * 次ハンドの currentMode を「先読み」する（カウンタを進めずに計算）。
 * index.js が startGame 前に「次がスタッドか？」を判定するために使用。
 * startStudHand に切り替えるべきかを startGame 呼び出し前に知る必要があるため。
 *
 * 【002/008 修正】handCount 操作トリックを廃止。advanceModeRotation と同じ
 * 判定を副作用なしで先読みする。
 */
function peekNextMode(room) {
  const seq = getMixSequence(room.mode);
  if (!seq) return room.mode;
  // 未初期化なら現 seqIndex のモード
  if (!room._modeHandsTotal || room._modeHandsTotal <= 0) {
    return getMixCurrentMode(room);
  }
  // 現モードを消化しきっていれば次モードを先読み
  if ((room._modeHandsDone ?? 0) >= room._modeHandsTotal) {
    const nextIdx = ((room._modeSeqIndex ?? 0) + 1) % seq.length;
    return seq[nextIdx];
  }
  return getMixCurrentMode(room);
}

// ===== ルームストレージ =====
const rooms = new Map();
// API Route から参照できるよう global に公開（webpack バンドル境界対策）
global.__pastisRooms = rooms;

function getOrCreateRoom(roomId, opts = {}) {
  if (!rooms.has(roomId)) {
    const baseMode = opts.mode ?? getRoomMode(roomId);
    const initialCurrentMode = isMixMode(baseMode) ? '27' : baseMode;
    rooms.set(roomId, {
      id:             roomId,
      label:          opts.label          ?? roomId,
      mode:           baseMode,
      // mix/mix3 はゲーム種ローテのため startGame で確定。それまでは安全側でデフォルト2-7を入れる。
      // 'mix3' を currentMode に直接入れると evaluateHand 等で意図しないフォールバックが起きる。
      currentMode:    initialCurrentMode,
      // NL（ノーリミット）判定: gameManager と botManager の単一情報源として room に保存。
      // startGame で currentMode が確定したタイミングで更新される。
      isNL:           isNoLimitMode(initialCurrentMode),
      password:       opts.password       ?? null,
      isUserCreated:  opts.isUserCreated  ?? false,
      isZoomTable:    opts.isZoomTable    ?? false,
      _isTournament:  opts._isTournament  ?? false,
      _tournamentId:  opts._tournamentId  ?? null,
      _onHandStart:   null,   // tournamentManager が set する
      players:        [],
      pendingPlayers: [],
      deck:           [],
      phase:          'waiting',
      pot:            0,
      dealerIndex:    -1,
      // ゲーム開始時に固定するポジション情報（フォールドしても変わらない）
      fixedDealerIdx: -1,
      fixedSbIdx:     -1,
      fixedBbIdx:     -1,
      actionIndex:    -1,
      currentBet:     0,
      raiseCount:     0,
      // NL用: 最後のフルレイズ額（次のミニマムレイズ算出に使用）。startGame でBBに初期化される
      lastRaiseSize:  0,
      smallBlind:     opts.smallBlind    ?? SMALL_BLIND,
      bigBlind:       opts.bigBlind      ?? BIG_BLIND,
      smallBet:       opts.smallBet      ?? SMALL_BET,
      bigBet:         opts.bigBet        ?? BIG_BET,
      startingChips:  opts.startingChips ?? STARTING_CHIPS,
      betSize:        opts.smallBet      ?? SMALL_BET,
      handCount:      0,
      // ===== 【002/008 修正】モードローテーション専用カウンタ =====
      // 旧実装は getMixCurrentMode が Math.floor(handCount / players.length) で
      // モードを決めていたため、テーブルバランス（人数変動）で players.length が
      // 変わると同じ handCount でもモードがズレた。
      //   - 008: ハンド途中/切替時にモードが変わる
      //   - 002: razz のつもりが stud_s 等にズレ、A♠保持者が誤ってBI判定される
      // 恒久対応: 人数に依存しない独立カウンタでローテーションを管理する。
      //   _modeSeqIndex   : 現在のモードのサイクル位置（mix系の配列インデックス）
      //   _modeHandsTotal : 現モードを継続するハンド数（モード開始時の人数で固定）
      //   _modeHandsDone  : 現モードで消化済みのハンド数
      _modeSeqIndex:   0,
      _modeHandsTotal: 0,   // 0 = 未初期化（最初の startGame で確定）
      _modeHandsDone:  0,
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
function joinRoom(roomId, socketId, name, opts = {}) {
  const room = getOrCreateRoom(roomId);

  // 再接続判定: accountId が指定されている場合は accountId 優先で照合する。
  //   理由: 同じトーナメント内で同名プレイヤーが別アカウントから参加するケースで、
  //         name のみで判定すると別人の player.id を上書きしてしまうバグがあった。
  //   accountId がない場合（ゲスト・リング部屋）は従来通り name 照合のフォールバック。
  const existing = opts.accountId
    ? room.players.find((p) => p.accountId === opts.accountId) || room.players.find((p) => p.name === name && !p.accountId)
    : room.players.find((p) => p.name === name);
  if (existing) {
    existing.id = socketId;
    existing.disconnected = false;  // 切断フラグ解除
    // accountId が未設定だった場合は補完する（古い再接続パスの後方互換）
    if (opts.accountId && !existing.accountId) existing.accountId = opts.accountId;
    return 'reconnected';
  }
  const existingPending = opts.accountId
    ? room.pendingPlayers.find((p) => p.accountId === opts.accountId) || room.pendingPlayers.find((p) => p.name === name && !p.accountId)
    : room.pendingPlayers.find((p) => p.name === name);
  if (existingPending) {
    existingPending.id = socketId;
    existingPending.disconnected = false;
    if (opts.accountId && !existingPending.accountId) existingPending.accountId = opts.accountId;
    return 'pending';
  }

  // 6人制限
  if (room.players.length + room.pendingPlayers.length >= MAX_PLAYERS) {
    return 'full';
  }

  const newPlayer = {
    id: socketId, name,
    accountId: opts.accountId ?? null,  // トーナメント用アカウントID
    chips: opts.existingChips ?? room.startingChips,  // チップ持ち越し対応
    hand: [], bet: 0, folded: false,
    acted: false, drewThisRound: false, drawCount: null,
    sittingOut: false,
    timeoutCount: 0,   // 連続タイムアウト回数（3回で退室）
  };

  const inProgress = PHASES.indexOf(room.phase) > 0 && room.phase !== 'showdown';
  if (inProgress) {
    room.pendingPlayers.push(newPlayer);
    return 'pending';
  }

  room.players.push(newPlayer);

  // 【デッドボタン】新規/移動プレイヤーが次ハンドで SB または BTN 位置に就く場合のみ
  // 1ハンド待機させる（トーナメント正式ルール: SB席・BTN席の新規はボタン通過まで待つ。
  // BB席はBBを払って即参加、UTG〜COも即参加）。BB基準のブラインド進行（assignBlindsByBB）
  // により、配列末尾に追加される通常の新規は SB/BTN に就かず、即参加（BB位置ならBB負担）となる。
  // これにより「6人目がSBで入る」「同じ人が連続BB」の両方が発生しない。
  // ヘッズアップ（2人以下）はBTN=SBのため待機なし。BOTは待機させない
  // （BOTが待機すると人数不足でゲームが開始しなくなるため）。
  const _isBot = typeof socketId === 'string' && socketId.startsWith('tbot::');
  if (!_isBot && room.dealerIndex >= 0 && room.players.length > 2) {
    const myIdx = room.players.length - 1;
    if (_shouldWaitForButton(room, myIdx)) {
      newPlayer.sittingOut    = true;
      newPlayer._waitZoneSkip = true;  // startGame でのリセット対象フラグ
    }
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
  // RRoP Rule 16: _waitZoneSkip フラグがあるプレイヤーはこのハンドも待機継続し、
  // フラグをクリアする（次ハンドからは通常参加）。それ以外は全員 sittingOut リセット。
  for (const p of room.players) {
    if (p._waitZoneSkip) {
      p.sittingOut    = true;   // このハンドも待機
      p._waitZoneSkip = false;  // 次ハンドからは参加
    } else {
      p.sittingOut = false;
    }
  }

  const activePlayers = room.players.filter((p) => !p.sittingOut);
  if (activePlayers.length < 2) return null;

  // トーナメント: ハンド開始フック（ブラインドレベルアップ適用）
  // カード配布前に呼ぶことで、新ブラインドが今ハンドから有効になる
  if (room._onHandStart) room._onHandStart(roomId);

  // 進行中のハンドをまたいでブラインドが上昇した場合の適用
  // applyPendingLevelUp がゲーム中テーブルに _pendingBlind を残している場合はここで適用
  if (room._pendingBlind) {
    const pb = room._pendingBlind;
    room.smallBlind = pb.sb;
    room.bigBlind   = pb.bb;
    room.smallBet   = pb.smallBet;
    room.bigBet     = pb.bigBet;
    room._pendingBlind = null;
  }

  // mix モード切替
  // 【002/008 修正】人数非依存のローテーション。advanceModeRotation で
  // 現モードを確定（必要なら次モードへ前進）し、このハンドを消化済みにする。
  if (isMixMode(room.mode)) {
    room.currentMode = advanceModeRotation(room);
    room._modeHandsDone = (room._modeHandsDone ?? 0) + 1;  // このハンドを消化
    logDev(`[mode-rot] ${roomId.slice(-8)} hand開始 mode=${room.currentMode} done=${room._modeHandsDone}/${room._modeHandsTotal} seqIdx=${room._modeSeqIndex}`);
  } else {
    room.currentMode = room.mode;
  }
  // NLフラグ更新: currentMode が確定したので isNL を同期させる
  // （MIX-3 でローテーションした結果が NL になる仕様はないが、将来拡張に備えて常に同期）
  room.isNL = _roomIsNL(room);

  // リセット
  room.deck             = createShuffledDeck();
  room.discardPile      = [];  // 捨て札をリセット
  room.pot              = 0;
  room._potAwarded      = false;
  room._onTimeout       = onTimeout;
  room._selectedIndices = {};
  room.handCount       += 1;

  // ラウンド開始ログ: MIX-3 等で currentMode が変動するため、各ハンドのモードを記録
  // 本番のBOT行動検証や手役判定の追跡に必要
  log(`[ROUND] room=${roomId.slice(-12)} mode=${room.mode} currentMode=${room.currentMode}${room.isNL ? ' (NL)' : ''} hand=${room.handCount} players=${room.players.length}`);

  // ディーラーボタン前進（共通関数。スタッド経路も同じ関数を使う）
  advanceDealerButton(room);

  // 手札配布・リセット
  // トーナメントテーブルはチップを持ち越す（リセット禁止）
  const size = handSize(room.currentMode);
  for (const p of room.players) {
    if (!room._isTournament) p.chips = room.startingChips;
    p.hand             = p.sittingOut ? [] : room.deck.splice(0, size);
    p.bet              = 0;
    p.folded           = !!p.sittingOut;
    p.acted            = !!p.sittingOut;
    p.drewThisRound    = false;
    p.drawCount        = null;
    p.totalContribution = 0;  // サイドポット計算用: このハンドの総投資額
  }

  // SB / BB ポスト
  // ヘッズアップ特例: BTN(dealer) = SB、相手 = BB
  const isHeadsUp = activePlayers.length === 2;

  let sbIndex, bbIndex;
  let sbDead = false;
  if (isHeadsUp) {
    // ヘッズアップ特例: dealer = BTN = SB。BB基準ロジックは使わない。
    // ボタンは advanceDealerButton（468行）で前進済み。
    sbIndex = room.dealerIndex;
    bbIndex = _nextActiveFromSafe(room, sbIndex);
  } else {
    // 【デッドボタン / BB基準】連続BB禁止・トーナメント正式ルール。
    // 前ハンドBBを基準に BB/SB/BTN を前進させる（assignBlindsByBB）。
    // これにより新規プレイヤーが配列末尾に追加されても BB が必ず前進し、
    // 同じプレイヤーが2ハンド連続でBBを払うことがなくなる。また新規は
    // 次ハンドで BB位置かそれ以降にしか就かず、SB/BTN位置に割り込まない。
    const blinds   = assignBlindsByBB(room);
    room.dealerIndex = blinds.dealerIndex;
    sbIndex = blinds.sbIndex;
    bbIndex = blinds.bbIndex;
    sbDead  = blinds.sbDead;
  }
  // dead SB（SB席が待機中/不在）の場合は SB をポストしない。
  if (!sbDead) _postBlind(room, sbIndex, room.smallBlind);
  _postBlind(room, bbIndex, room.bigBlind);

  // 次ハンドの BB基準計算のために、今ハンドの BB/SB プレイヤーIDを記録。
  room._lastBbId = room.players[bbIndex]?.id ?? null;
  room._lastSbId = room.players[sbIndex]?.id ?? null;

  // ゲーム中に変わらない固定ポジションを記録
  room.fixedDealerIdx = room.dealerIndex;
  room.fixedSbIdx     = sbIndex;
  room.fixedBbIdx     = bbIndex;
  room.isHeadsUp      = isHeadsUp;
  room._sbDead        = sbDead;

  // bet0（プリドロー）フェーズへ
  // 通常: UTG (BB の左隣) から開始し、最後に BB が option を持つ
  // ヘッズアップ: BTN/SB が先行アクション（コール or レイズ）、最後に BB が option を持つ
  const bet0StartIndex = isHeadsUp ? sbIndex : _nextActiveFromSafe(room, bbIndex);
  room.phase      = 'bet0';
  room.currentBet = room.bigBlind;  // BB が既にポスト済み
  // ⚠️ 変更禁止: raiseCount は 1 スタート（BBポストを1bet目として扱う）。
  //   0 スタートにすると bet0 フェーズで6段階分アクション可能になり BET60 まで打てるバグになる。
  room.raiseCount = 1;  // BBポストを1bet目としてカウント（5bet-cap: 1〜5）
  // NL（27sd）はベットサイズ自由。room.smallBet / room.bigBet はリミットゲーム用パラメータで
  // 27sd では UI 表示用のミニマムベットを示すために bigBlind を入れているだけで、ベット制限には使用されない。
  // ⚠️ トーナメント管理画面で 27sd モードに smallBet/bigBet を設定しても完全に無視される（NLは無制限のため）
  room.betSize    = _roomIsNL(room) ? room.bigBlind : room.smallBet;
  // NL: 直近のレイズサイズ初期値 = BB（プリドローの初期レイズはBB単位）
  room.lastRaiseSize = room.bigBlind;

  // 全員の acted を正しく初期化
  for (const p of room.players) {
    if (p.sittingOut || p.folded) {
      p.acted = true;   // 待機中・フォールドはスキップ
    } else if (room.players.indexOf(p) === bbIndex) {
      // BB: ポスト済みだが option 権のため acted = false
      p.acted = false;
    } else if (room.players.indexOf(p) === sbIndex) {
      // SB: ポスト済みだが不足しているので acted = false
      p.acted = false;
    } else {
      p.acted = false;  // その他も未アクション
    }
  }
  room.actionIndex = bet0StartIndex;
  _startTimer(room);

  return room;
}

function _postBlind(room, idx, amount) {
  const p = room.players[idx];
  if (!p) return;
  const actual = Math.min(amount, p.chips);
  p.chips -= actual; p.bet += actual; room.pot += actual; p.totalContribution = (p.totalContribution??0) + actual;
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

/**
 * 前のアクティブプレイヤーのインデックスを安全に返す（反時計回り）。
 * デッドボタン方式で BB から SB / BTN を逆算するために使う。
 */
function _prevActiveFromSafe(room, fromIndex) {
  const len = room.players.length;
  if (len === 0) return 0;
  const start = ((fromIndex % len) + len) % len;
  let prev = (start - 1 + len) % len;
  for (let t = 0; t < len; t++) {
    const p = room.players[prev];
    if (p && !p.folded && !p.sittingOut) return prev;
    prev = (prev - 1 + len) % len;
  }
  return prev;
}

/**
 * 【デッドボタン / BB基準】SB・BB・BTN のインデックスを決定する共通関数。
 *
 * トーナメントの正式ルール（連続BB禁止・デッドボタン）に従い、
 * 「前ハンドのBBプレイヤー」を基準に毎ハンド前進させる:
 *   - 新BB  = 前BBプレイヤーの次のアクティブ（必ず前進 → 連続BB発生しない）
 *   - 新SB  = 前BBプレイヤーの席（その席が非アクティブ＝待機/不在なら dead SB）
 *   - 新BTN = 前SBプレイヤーの席（不在なら反時計回りで近いアクティブ＝dead button相当）
 *
 * 前BB情報（_lastBbId）が無い初回や、前BBが脱落して位置が追えない場合は
 * 従来のボタン方式（dealerIndex 起点）で初期化する。以降は BB基準で回る。
 *
 * ヘッズアップ（アクティブ2人）は呼び出し側で別処理するためここでは扱わない。
 *
 * @returns {{ dealerIndex:number, sbIndex:number, bbIndex:number, sbDead:boolean }}
 */
function assignBlindsByBB(room) {
  const players = room.players;
  // 前ハンドBBの現在位置（脱落・並び替えに強いよう ID で照合）
  let prevBbIdx = -1;
  if (room._lastBbId != null) {
    prevBbIdx = players.findIndex((p) => p.id === room._lastBbId);
  }

  let bbIndex, sbIndex, dealerIndex;

  if (prevBbIdx < 0) {
    // 初回 or 前BB脱落: 従来方式（dealerIndex は呼び出し前に advanceDealerButton 済み）
    sbIndex     = _nextActiveFromSafe(room, room.dealerIndex);
    bbIndex     = _nextActiveFromSafe(room, sbIndex);
    dealerIndex = room.dealerIndex;
  } else {
    // BB基準: 新BB=前BBの次のアクティブ
    bbIndex = _nextActiveFromSafe(room, prevBbIdx);
    // 新SB=前BBの席（旧BB席）。そこが sittingOut/folded なら dead SB だが席基準は維持。
    sbIndex = prevBbIdx;
    // 新BTN=前SBの席（_lastSbId）。脱落していれば SB の手前のアクティブで代替。
    let prevSbIdx = -1;
    if (room._lastSbId != null) prevSbIdx = players.findIndex((p) => p.id === room._lastSbId);
    dealerIndex = prevSbIdx >= 0 ? prevSbIdx : _prevActiveFromSafe(room, sbIndex);
  }

  // SB席が実際にSBを払えるか（dead SB 判定）: そのプレイヤーが非アクティブなら dead
  const sbP = players[sbIndex];
  const sbDead = !(sbP && !sbP.sittingOut && !sbP.folded);

  return { dealerIndex, sbIndex, bbIndex, sbDead };
}

/**
 * 【デッドボタン一貫性】BBアンカー（_lastBbId / _lastSbId）を1つ前進させる。
 *
 * スタッド系ハンド（ブラインドではなくアンティ＋ブリングイン）は startGame を
 * 通らないため、ミックスゲームでスタッドを挟むとドロー系のブラインド順が止まって
 * しまう。スタッドハンド成立時にこの関数を呼ぶことで、ボタンと同様に BBアンカーも
 * 毎ハンド前進し、ドロー系に戻ったときブラインドが正しい位置から再開する。
 *
 * 前BBが脱落して位置を追えない場合は何もしない（次のドロー系ハンドで従来の
 * ボタン方式により再初期化される）。
 */
function advanceBbAnchor(room) {
  if (!room || room._lastBbId == null) return;
  const curIdx = room.players.findIndex((p) => p.id === room._lastBbId);
  if (curIdx < 0) return;
  const nextIdx = _nextActiveFromSafe(room, curIdx);
  room._lastSbId = room._lastBbId;                       // 旧BB → 次ハンドのSB基準
  room._lastBbId = room.players[nextIdx]?.id ?? room._lastBbId;
}

/**
 * RRoP Rule 16: テーブルバランシングで移動してきたプレイヤーの待機ゾーン判定
 *
 * 待機ゾーン = clockwise で dealerIdx（BTN）から sbIdx（SB）まで（両端含む）
 *   - BTN席: 待機（RRoPはTDAと異なりBTN席も待機対象）
 *   - SB席: 待機
 *   - BB席以降（UTG〜CO）: 即参加
 *
 * 巻き戻し例: dealerIdx=4, sbIdx=1, n=6 のとき
 *   待機ゾーン = [4, 5, 0, 1] → myIdx が 4,5,0,1 なら待機
 */
function _isInRRoPWaitZone(myIdx, dealerIdx, sbIdx, n) {
  if (dealerIdx <= sbIdx) {
    // 巻き戻しなし: [dealerIdx, ..., sbIdx]
    return myIdx >= dealerIdx && myIdx <= sbIdx;
  } else {
    // 巻き戻しあり: [dealerIdx, ..., n-1, 0, ..., sbIdx]
    return myIdx >= dealerIdx || myIdx <= sbIdx;
  }
}

/**
 * 【デッドボタン対応】新規/移動プレイヤーが「次ハンドで SB または BTN 位置」に
 * 就くかを判定する。就く場合は1ハンド待機させ、ボタン通過後（CO相当以降）に
 * 参加させる（トーナメント正式ルール: SB席・BTN席の新規はボタン通過まで待つ）。
 *
 * BB基準（assignBlindsByBB と同じ前進規則）で次ハンドの SB/BTN を求める:
 *   次SB  = 前BB席, 次BTN = 前SB席
 * 新規は通常、配列末尾に追加されるため SB/BTN（既存プレイヤーの席）には就かず、
 * この関数は false を返す（＝BB位置かそれ以降で即参加）。テーブルバランシングで
 * 特定席に挿入される稀なケースでのみ true（待機）になる。
 */
function _shouldWaitForButton(room, newIdx) {
  let prevBbIdx = -1;
  if (room._lastBbId != null) {
    prevBbIdx = room.players.findIndex((p) => p.id === room._lastBbId);
  }
  if (prevBbIdx < 0) {
    // 初回 or 前BB不明: 従来のボタン方式で SB/BTN を推定
    const dealerRef = room.fixedDealerIdx >= 0 ? room.fixedDealerIdx : room.dealerIndex;
    const sbRef     = room.fixedSbIdx     >= 0 ? room.fixedSbIdx
                    : _nextActiveFromSafe(room, dealerRef);
    return newIdx === dealerRef || newIdx === sbRef;
  }
  const nextSbIdx = prevBbIdx;  // 次SB = 前BB席
  let prevSbIdx = -1;
  if (room._lastSbId != null) prevSbIdx = room.players.findIndex((p) => p.id === room._lastSbId);
  const nextBtnIdx = prevSbIdx >= 0 ? prevSbIdx : _prevActiveFromSafe(room, nextSbIdx);
  return newIdx === nextSbIdx || newIdx === nextBtnIdx;
}

function _resetDrawRound(room) {
  for (const p of room.players) if (!p.sittingOut) p.drewThisRound = false;
  room._selectedIndices = {}; // 選択中インデックスもリセット
}

function _resetBetRound(room, betSize) {
  room.currentBet = 0; room.raiseCount = 0; room.betSize = betSize;
  // NL用: 直近のレイズサイズ（最初のラウンドはBB）
  room.lastRaiseSize = room.bigBlind || betSize;
  for (const p of room.players) {
    if (!p.sittingOut && !p.folded) {
      // betはpotに移したのでtotalContributionには既に加算済み
      p.bet = 0;
      // チップ0のプレイヤー（オールイン済み）はすでにアクション不要
      p.acted = (p.chips <= 0);
    }
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
  const cur = room.players[room.actionIndex];
  if (room.isZoomTable) {
  }
  room._timer = setTimeout(() => {
    const cur2 = room.players[room.actionIndex];
    if (cur2 && room._onTimeout) room._onTimeout(room.id, room.phase, cur2.id);
  }, limitSec * 1000);
}

function _clearTimer(room) {
  if (room._timer) {
    clearTimeout(room._timer); room._timer = null;
    if (room.isZoomTable) {
      const cur = room.players?.[room.actionIndex];
    }
  }
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
  // M-02: 配列長・要素範囲の検証
  if (!Array.isArray(indices)) return;
  const max = handSize(room.currentMode);
  const safe = [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < max)
    .slice(0, max);  // 最大 handSize 個まで
  room._selectedIndices[socketId] = safe;
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
  // 現在の交換で捨てたカードは、引き終わるまで再シャッフル対象に含めない。
  const currentDiscard = validIndices.map((i) => player.hand[i]).filter((c) => c && c !== '??');
  for (const i of validIndices) {
    const newCard = _drawFromDeck(room);
    if (newCard === null) {
      // デッキ・捨て札ともに枯渇（6人×全枚数交換×3ラウンドの極端なケース）
      console.warn(`[deck] ⚠ ${player.name} のスロット${i}分のカードが不足 → 現手札維持`);
      room.deck = require('./deck').createShuffledDeck().filter(c => {
        const inHands = room.players.flatMap(p => p.hand).filter(Boolean);
        return !inHands.includes(c) && !currentDiscard.includes(c);
      });
      const retryCard = _drawFromDeck(room);
      if (retryCard) player.hand[i] = retryCard;
      // それでも取れない場合は既存の手札スロットをそのまま維持（'??' にしない）
    } else {
      player.hand[i] = newCard;
    }
  }
  _discardCards(room, currentDiscard);
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
    logDev(`[deck] 捨て札 ${room.deck.length}枚をリシャッフルしました`);
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

/**
 * NL（ノーリミット）でのbet/raise処理
 * @returns {boolean} 適用成功時 true、バリデーション失敗時 false
 */
function _applyNLBetRaise(room, player, myIndex, action, amount) {
  const minBet        = room.bigBlind;
  const lastRaiseSize = room.lastRaiseSize || room.bigBlind;
  const minRaise      = room.currentBet + lastRaiseSize;
  const maxBet        = player.bet + player.chips; // オールイン上限

  // 厳密に number 型のみ受け入れ。index.js / tournamentBotManager.js の両経路で
  // number が渡されることを契約とする（防御層は単一化、二重 coercion を排除）
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return false;
  let targetBet = amount;

  // 上限を超える指定はオールインに丸める
  if (targetBet > maxBet) targetBet = maxBet;

  const isAllIn = targetBet === maxBet;
  if (action === 'bet') {
    if (room.currentBet > 0) return false;
    if (!isAllIn && targetBet < minBet) return false;
  } else { // raise
    if (room.currentBet === 0) return false;
    if (!isAllIn && targetBet < minRaise) return false;
  }

  const actual = targetBet - player.bet;
  player.chips -= actual;
  player.bet   += actual;
  room.pot     += actual;
  player.totalContribution = (player.totalContribution ?? 0) + actual;

  const prevBet     = room.currentBet;
  const raiseAmount = player.bet - prevBet;
  room.currentBet   = Math.max(room.currentBet, player.bet);

  // フルレイズ or ショートオールイン
  const isFullRaise = raiseAmount >= lastRaiseSize;
  if (isFullRaise && raiseAmount > 0) {
    room.lastRaiseSize = raiseAmount;
    for (let i = 0; i < room.players.length; i++) {
      if (i !== myIndex && !room.players[i].folded && !room.players[i].sittingOut) {
        room.players[i].acted = false;
      }
    }
    logDev(`[NL] ${player.name} ${action} → ${player.bet} (raise=${raiseAmount}, lastRaiseSize=${room.lastRaiseSize}, pot=${room.pot})`);
  } else if (room.currentBet > prevBet) {
    // ショートオールイン: 再オープン権なし（reopening rule）。lastRaiseSizeは更新しない。
    for (let i = 0; i < room.players.length; i++) {
      const op = room.players[i];
      if (i !== myIndex && !op.folded && !op.sittingOut && op.bet < room.currentBet) {
        op.acted = false;
      }
    }
    logDev(`[NL] ${player.name} short-allin → ${player.bet} (raise=${raiseAmount}, lastRaiseSize unchanged=${lastRaiseSize}, pot=${room.pot})`);
  }
  player.acted = true;
  return true;
}

// ==========================================================
// ■ ベット（5bet-cap / ノーリミット両対応）
// ==========================================================

function betAction(roomId, socketId, action, amount) {
  const room = rooms.get(roomId);
  if (!room || !room.phase.startsWith('bet')) return null;
  const myIndex = room.players.findIndex((p) => p.id === socketId);
  if (myIndex !== room.actionIndex) return null;
  const player = room.players[myIndex];
  if (!player || player.folded) return null;
  // chips=0プレイヤーはshowdown後にcheckEliminationsで脱落するため
  // betActionでのスキップは行わない

  const toCall = room.currentBet - player.bet;
  // room.isNL は startGame で確定される。betAction は bet/draw フェーズで呼ばれるため必ず確定済み。
  const isNL = _roomIsNL(room);
  room.isNL = isNL;

  if (action === 'fold') {
    // ⚠️ チェック可能な場面（toCall=0）でのフォールドは禁止（RRoP準拠）
    if (toCall === 0) return null;
    player.folded = true; player.acted = true;

  } else if (action === 'check') {
    if (toCall > 0) return null;
    player.acted = true;

  } else if (action === 'call') {
    const actual = Math.min(toCall, player.chips);
    player.chips -= actual; player.bet += actual; room.pot += actual;
    player.totalContribution = (player.totalContribution??0) + actual;
    player.acted = true;

  } else if (action === 'bet' || action === 'raise') {
    // chips=0のプレイヤー（すでにオールイン済み）はbet/raiseをcallとして処理
    if (player.chips <= 0) {
      player.acted = true;
    } else if (isNL) {
      // ===== ノーリミット =====
      // amount = ベット/レイズ後のtotalBet額（プレイヤーがそのストリートで投じる累計）
      // 制約:
      //   action='bet'   (currentBet=0): amount >= BB
      //   action='raise' (currentBet>0): amount >= currentBet + lastRaiseSize（ミニマムレイズ）
      //   上限: player.chips + player.bet （オールイン上限）
      const applied = _applyNLBetRaise(room, player, myIndex, action, amount);
      if (!applied) return null;
    // ⚠️ 変更禁止: キャップ判定は >= MAX_RAISES(5)。
    //   > MAX_RAISES にすると raiseCount=5 でもレイズ可能になり BET60 まで打てるバグになる。
    //   canRaise は < MAX_RAISES(5) で raiseCount=4(4/5) でもレイズ可、raiseCount=5(5/5) でレイズ不可。
    } else if (room.raiseCount >= MAX_RAISES) {
      const actual = Math.min(toCall, player.chips);
      player.chips -= actual; player.bet += actual; room.pot += actual;
      player.totalContribution = (player.totalContribution??0) + actual;
      player.acted = true;
    } else {
      const betTotal = room.currentBet + room.betSize;
      const needed   = betTotal - player.bet;
      const actual   = Math.min(needed, player.chips);
      player.chips -= actual; player.bet += actual; room.pot += actual;
      player.totalContribution = (player.totalContribution??0) + actual;
      // currentBetは上がることしかない（ショートオールインで下げない）
      const prevBet = room.currentBet;
      room.currentBet = Math.max(room.currentBet, player.bet);
      if (actual >= needed) {
        // フルレイズ: raiseCount増加 & 全員のacted をリセット（再アクション権あり）
        room.raiseCount++;
        for (let i = 0; i < room.players.length; i++) {
          if (i !== myIndex && !room.players[i].folded && !room.players[i].sittingOut) {
            room.players[i].acted = false;
          }
        }
      } else if (room.currentBet > prevBet) {
        // ショートオールイン: currentBet が上昇した場合、まだ新しいcurrentBetに達していない
        // プレイヤーだけ acted をリセットしてコールを求める（再レイズ権は与えない）
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
  if (active.length <= 1) { _clearTimer(room); room.phase = 'showdown'; return; }

  // 全員がアクション済みならフェーズ進行
  // ショートオールイン後はbetが揃わなくても全員acted=trueで進む
  const allActed = active.every((p) => p.acted);
  if (allActed) { _nextPhase(room); return; }

  // アクションが必要なプレイヤーを探す
  let next = (room.actionIndex + 1) % room.players.length;
  let found = false;
  for (let t = 0; t < room.players.length; t++) {
    const p = room.players[next];
    if (p && !p.folded && !p.sittingOut && !p.acted) { found = true; break; }
    next = (next + 1) % room.players.length;
  }
  // アクション不要（全員acted or folded）なのにここに来た場合は安全にフェーズ進行
  if (!found) { _nextPhase(room); return; }
  room.actionIndex = next;

  // ターンが回ってきたプレイヤーが fastFoldPending なら即フォールドして次へ
  let nextPlayer = room.players[room.actionIndex];
  if (nextPlayer?.fastFoldPending && !nextPlayer.folded) {
    nextPlayer.fastFoldPending = false;
    nextPlayer.folded = true;
    nextPlayer.acted  = true;
    _advanceBetAction(room);
    return;
  }

  // chips=0（オールイン済み）のプレイヤーにターンが来た場合はスキップしてactedにする
  // 再帰ではなくループで処理（スタックオーバーフロー防止）
  let safetyCount = 0;
  while (nextPlayer && nextPlayer.chips <= 0 && !nextPlayer.folded && safetyCount < 20) {
    nextPlayer.acted = true;
    safetyCount++;
    // 全員acted済みか再確認
    const stillActive = room.players.filter(p => !p.folded && !p.sittingOut);
    if (stillActive.every(p => p.acted)) { _nextPhase(room); return; }
    // 次のアクション待ちプレイヤーを探す
    let nextIdx = (room.actionIndex + 1) % room.players.length;
    let foundNext = false;
    for (let t = 0; t < room.players.length; t++) {
      const p = room.players[nextIdx];
      if (p && !p.folded && !p.sittingOut && !p.acted) { foundNext = true; break; }
      nextIdx = (nextIdx + 1) % room.players.length;
    }
    if (!foundNext) { _nextPhase(room); return; }
    room.actionIndex = nextIdx;
    nextPlayer = room.players[room.actionIndex];
  }

  _startTimer(room);
}

// ==========================================================
// ■ フェーズ遷移
// ==========================================================

function _nextPhase(room) {
  // モードに応じたフェーズ列を取得（27sd は短縮版）
  const effectiveMode = room.currentMode || room.mode;
  const phases = getPhases(effectiveMode);
  const idx  = phases.indexOf(room.phase);
  const next = phases[idx + 1] ?? 'showdown';
  room.phase = next;

  if (next.startsWith('draw')) {
    _resetDrawRound(room);
    // ドローラウンド: 通常/ヘッズアップ共にSB(dealer)から先行
    const dealerRef = room.fixedDealerIdx >= 0 ? room.fixedDealerIdx : room.dealerIndex;
    room.actionIndex = _nextActiveFromSafe(room, dealerRef);
    _startTimer(room);
  } else if (next.startsWith('bet')) {
    // NLモード（27sd）はベットサイズ固定なし、betSize=BBをミニマム値として扱う
    // リミットモード: draw2以降（bet2, bet3）はビッグベット
    // 判定は room.isNL に統一（startGame で確定済みの単一情報源）
    let betSize;
    const isNL = _roomIsNL(room);
    room.isNL = isNL;
    if (isNL) {
      betSize = room.bigBlind; // NL: ミニマムベット = BB
    } else {
      betSize = isBigBetPhase(next) ? room.bigBet : room.smallBet;
    }
    _resetBetRound(room, betSize);
    // ベットラウンド（bet1以降）: 通常/ヘッズアップ共にSB(dealer)から先行
    const dealerRef = room.fixedDealerIdx >= 0 ? room.fixedDealerIdx : room.dealerIndex;
    room.actionIndex = _nextActiveFromSafe(room, dealerRef);
    _startTimer(room);
  } else if (next === 'showdown') {
    _clearTimer(room);
  }
}

// ==========================================================
// ■ ゲーム状態ビルド
// ==========================================================

// =====================================================
// サイドポット計算・分配
// allInプレイヤーが混在する場合にメインポット/サイドポットを正しく分配する
// =====================================================
function _awardPots(room, activePlayers) {
  const allPlayers = room.players.filter(p => !p.sittingOut);

  // スプリット境界 = 全プレイヤーの totalContribution を使う（標準サイドポット計算）
  // ※ オールインのみを使うと「AllIn > 相手のcontrib」の場合に誤精算が発生する
  //   例: AllIn=1680, 相手=1600 → levels=[1680] だとpotSize=1680*1=1680が
  //       「AllIn専有分」として計算されるが、実際は両者共通1600*2=3200 + AllIn余剰80 が正しい
  const allLevels = allPlayers
    .map(p => p.totalContribution ?? 0)
    .filter(c => c > 0);
  const levels = [...new Set(allLevels)].sort((a, b) => a - b);

  // ===== ポット計算ログ =====
  logPot(`[pot] ===== _awardPots START roomId=${room.id} pot=${room.pot} =====`);
  logPot(`[pot] allPlayers: ${allPlayers.map(p => `${p.name}(chips=${p.chips},contrib=${p.totalContribution??0},folded=${p.folded})`).join(', ')}`);
  logPot(`[pot] activePlayers: ${activePlayers.map(p => `${p.name}(contrib=${p.totalContribution??0})`).join(', ')}`);
  logPot(`[pot] levels: [${levels.join(', ')}]`);

  // 奇数チップの端数はBTN左隣（SB位置）の勝者が受け取る（標準ポーカールール）
  // fixedDealerIdx が確定している場合はその左隣、未確定は players[0] を基点にする
  const _dealerRef = room.fixedDealerIdx >= 0 ? room.fixedDealerIdx : 0;
  const _sbRef     = room.fixedSbIdx     >= 0 ? room.fixedSbIdx
                   : ((_dealerRef + 1) % allPlayers.length);

  /**
   * スプリットポット分配: ポット額を winners で等分し、奇数チップは
   * BTN 左隣（SB位置）に最も近い勝者が受け取る。
   */
  function _splitPot(amount, winners) {
    if (winners.length === 0) return;
    const share = Math.floor(amount / winners.length);
    const odd   = amount - share * winners.length;

    // BTN左隣（SB側）から時計回りで最初に見つかる勝者が奇数チップを受け取る
    let oddWinner = winners[0];
    let minDist   = Infinity;
    const n = allPlayers.length;
    for (const w of winners) {
      const idx  = allPlayers.indexOf(w);
      const dist = ((idx - _sbRef) % n + n) % n; // SB基点の時計回り距離
      if (dist < minDist) { minDist = dist; oddWinner = w; }
    }

    for (const w of winners) {
      w.chips += share + (w === oddWinner ? odd : 0);
    }
    return winners.map(w => `${w.name}(+${share}${w === oddWinner && odd > 0 ? `+${odd}odd` : ''})`).join(',');
  }

  let totalAwarded = 0;
  let prevLevel = 0;

  for (const level of levels) {
    const contributors = allPlayers.filter(p => (p.totalContribution ?? 0) >= level).length;
    const potSize = (level - prevLevel) * contributors;
    const cappedPot = Math.min(potSize, room.pot - totalAwarded);
    if (cappedPot <= 0) break;

    const eligible = activePlayers.filter(p => (p.totalContribution ?? 0) >= level);
    let winnerName = '(none)';
    if (eligible.length === 0) {
      // eligible が空（fallback）: activePlayers 全体で再判定
      if (activePlayers.length > 0) {
        const safWinners = findWinners(activePlayers, room.currentMode);
        winnerName = _splitPot(cappedPot, safWinners) + ' (fallback)';
      }
    } else {
      const winners = findWinners(eligible, room.currentMode);
      winnerName = _splitPot(cappedPot, winners);
    }
    logPot(`[pot] level=${level} potSize=${potSize} cappedPot=${cappedPot} contributors=${contributors} eligible=[${eligible.map(p=>p.name).join(',')}] winner=${winnerName}`);
    totalAwarded += cappedPot;
    prevLevel = level;
  }

  const remainder = room.pot - totalAwarded;
  if (remainder > 0 && activePlayers.length > 0) {
    const remWinners = findWinners(activePlayers, room.currentMode);
    const remName = _splitPot(remainder, remWinners);
    logPot(`[pot] remainder=${remainder} → ${remName}`);
  }
  logPot(`[pot] totalAwarded=${totalAwarded} remainder=${remainder} pot_after=${0}`);
  logPot(`[pot] chips_after: ${allPlayers.map(p => `${p.name}=${p.chips}`).join(', ')}`);
  logPot(`[pot] ===== _awardPots END =====`);
  room.pot = 0;
}

function buildGameState(room, requesterId) {
  const isShowdown    = room.phase === 'showdown';
  const activePlayers = room.players.filter((p) => !p.folded && !p.sittingOut);
  const winnerIds     = isShowdown ? new Set(findWinners(activePlayers, room.currentMode).map(p => p.id)) : null;

  if (isShowdown && !room._potAwarded) {
    _awardPots(room, activePlayers);
    room._potAwarded = true;
  }

  const currentPlayer  = room.actionIndex >= 0 ? room.players[room.actionIndex] : null;
  const isDrawPhase    = room.phase.startsWith('draw');
  const isBetPhase     = room.phase.startsWith('bet');
  const timerRemaining = getTimerRemaining(room);

  // 固定ポジション（ゲーム開始時に記録、フォールドしても変わらない）
  const sbIdx = room.fixedSbIdx     >= 0 ? room.fixedSbIdx     : -1;
  const bbIdx = room.fixedBbIdx     >= 0 ? room.fixedBbIdx     : -1;
  const dealerIdx = room.fixedDealerIdx >= 0 ? room.fixedDealerIdx : room.dealerIndex;

  const playerStates = room.players.map((p) => {
    const isSelf   = p.id === requesterId;
    // ショーダウン時: フォールドしていないプレイヤーが2人以上いる場合にカードを公開
    // activePlayers はchips>0を含まないケースがあるため、未フォールド全員でカウント
    // オールイン（chips=0）プレイヤーも手札公開対象に含める
    const notFolded = room.players.filter(q => !q.folded && !q.sittingOut);
    const isContested = notFolded.length >= 2;
    const reveal   = isSelf || (isShowdown && !p.folded && isContested);
    const isMyTurn = !isShowdown && currentPlayer != null && p.id === currentPlayer.id;
    const toCall   = isBetPhase ? Math.max(0, room.currentBet - p.bet) : 0;
    const myIdx    = room.players.indexOf(p);

    return {
      id: p.id, name: p.name, chips: p.chips, bet: p.bet,
      folded: p.folded, sittingOut: p.sittingOut,
      disconnected: p.disconnected ?? false,
      hand: reveal ? p.hand : p.hand.map(() => '??'),
      isSelf, isMyTurn,
      drewThisRound: p.drewThisRound, drawCount: p.drawCount,
      // スタッドモード（stud_s/stud_e/razz）はstudManagerが手役名を担当するため
      // gameManager側では evaluateHand を呼ばない（ドロー系専用関数のため誤評価防止）
      result: reveal && p.hand.length > 0 && !p.folded && !isStudMode(room.currentMode)
                ? evaluateHand(p.hand, room.currentMode) : undefined,
      isWinner:  isShowdown && winnerIds != null && winnerIds.has(p.id),
      isDealer:  myIdx === dealerIdx,
      isSB:      myIdx === sbIdx && sbIdx >= 0,
      isBB:      myIdx === bbIdx && bbIdx >= 0,
      ...(isSelf ? {
        toCall:   p.chips <= 0 ? 0 : toCall,  // chips=0はコール不要（オールイン済み）
        canCheck: isBetPhase && (toCall === 0 || p.chips <= 0),
        isAllIn:  p.chips <= 0 && !p.folded,  // chips=0のオールイン状態
    // ⚠️ 変更禁止: raiseCount < MAX_RAISES(5) のときのみレイズ可。
    //   raiseCount=4(4/5) → レイズ可、raiseCount=5(5/5) → レイズ不可（キャップ）
    // 相手が全員フォールドorオールイン（chips<=0）の場合もレイズ不可
    // NLモード（27sd）はraiseCount上限なし
    canRaise: isBetPhase && p.chips > 0
      && (_roomIsNL(room) || room.raiseCount < MAX_RAISES)
      && room.players.some(op => op.id !== p.id && !op.folded && !op.sittingOut && op.chips > 0),
        betSize:  room.betSize,
        // NL用情報: クライアントがベット額入力UIを構築するために必要
        isNL:     _roomIsNL(room),
        ...(_roomIsNL(room) ? {
          minBet:        room.bigBlind,
          minRaiseTotal: room.currentBet + (room.lastRaiseSize || room.bigBlind),
          maxBetTotal:   p.bet + p.chips,
        } : {}),
      } : {}),
      ...(isMyTurn ? { timerRemaining } : {}),
    };
  });

  // サイドポット計算（表示用）
  // chips=0のプレイヤー（真のオールイン）が存在する場合のみ分割表示
  // フォールドしたプレイヤーのブラインド残が原因の誤検知を防ぐ
  const _potsForDisplay = (() => {
    if (room.pot <= 0) return [];
    const allP = room.players.filter(p => !p.sittingOut);
    // オールインがない場合は単純ポット表示
    // ※ !p.folded を外す: fastFold でオールイン後フォールドしたプレイヤーも
    //   chips=0 として検出し、サイドポット表示が消えるバグを防ぐ
    const hasRealAllIn = allP.some(p => p.chips <= 0);
    if (!hasRealAllIn) return [{ amount: room.pot, label: 'ポット' }];

    // 境界 = オールインプレイヤーの totalContribution のみ
    // （全プレイヤーを使うとベット中の中途半端な contrib が余分なエントリを生む）
    const allInLevels = allP
      .filter(p => p.chips <= 0)
      .map(p => p.totalContribution ?? 0)
      .filter(c => c > 0);
    if (allInLevels.length === 0) return [{ amount: room.pot, label: 'ポット' }];
    const levels = [...new Set(allInLevels)].sort((a, b) => a - b);

    // room.pot には p.bet が既に加算済み（betAction で room.pot += actual と同時更新）
    // p.bet を足すと二重計上になるため room.pot をそのまま使う
    const virtualPot = room.pot;

    // ===== 表示用ポットログ =====
    logPot(`[pot-display] phase=${room.phase} room.pot=${room.pot} virtualPot=${virtualPot} levels=[${levels.join(',')}]`);
    logPot(`[pot-display] players: ${allP.map(p => `${p.name}(chips=${p.chips},bet=${p.bet??0},contrib=${p.totalContribution??0},folded=${p.folded})`).join(', ')}`);

    // A〜Z の26件分用意（バランス時に一時的に7人超になっても数字ラベルが出ないよう対策）
    const SIDE_POT_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => `サイドポット${c}`);
    // インデックス超過時のフォールバックも文字ベースで生成
    const _sideLabel = (idx) => SIDE_POT_LABELS[idx] ?? `サイドポット${String.fromCharCode(65 + idx)}`;

    // 各レベルの金額 = Σ min(contrib, level) - totalCalc
    // （フォールド済みプレイヤーの部分的な contrib も正確に算入する正しい計算式）
    const result = [];
    let totalCalc = 0;
    for (let li = 0; li < levels.length; li++) {
      const level = levels[li];
      const amount = allP.reduce((sum, p) => sum + Math.min(p.totalContribution ?? 0, level), 0);
      const capped = Math.min(amount - totalCalc, virtualPot - totalCalc);
      if (capped <= 0) break;
      const label = li === 0 ? 'メインポット' : _sideLabel(li - 1);
      logPot(`[pot-display] li=${li} level=${level} amount=${amount} capped=${capped} label=${label}`);
      result.push({ amount: capped, label });
      totalCalc += capped;
    }
    // 残額 = 最高オールインレベル超えプレイヤーのみ参加できるサイドポット
    const rem = virtualPot - totalCalc;
    const remLabel = result.length === 0 ? 'ポット' : _sideLabel(result.length - 1);
    if (rem > 0) {
      logPot(`[pot-display] rem=${rem} label=${remLabel}`);
      result.push({ amount: rem, label: remLabel });
    }
    logPot(`[pot-display] result: ${JSON.stringify(result)}`);
    return result.length > 1 ? result : [{ amount: virtualPot, label: 'ポット' }];
  })();

  // pending待機中のリクエスター自身もstateに追加（isSelf=true, isPendingPlayer=true）
  const pendingSelf = requesterId
    ? room.pendingPlayers.find(p => p.id === requesterId)
    : null;
  if (pendingSelf) {
    playerStates.push({
      id: pendingSelf.id, name: pendingSelf.name, chips: pendingSelf.chips,
      bet: 0, folded: false, sittingOut: false, disconnected: false,
      hand: [], isSelf: true, isMyTurn: false,
      drewThisRound: false, drawCount: null,
      isWinner: false, isDealer: false, isSB: false, isBB: false,
      isPendingPlayer: true,
      toCall: 0, canCheck: false, canRaise: false, betSize: room.betSize,
    });
  }

  // ===== 【001/008 修正】isStud を currentMode から導出して明示設定 =====
  // 旧実装は isStud フィールド自体を設定せず undefined（falsy）にしていた。
  // クライアントは meta.isStud だけで Stud/Draw UI を分岐するため、
  // 「currentMode=stud_e なのに isStud=undefined」という矛盾した meta が
  // ドロー側 buildGameState 経由で届くと、スタッド進行中でもドローUIに切り替わる。
  // 恒久対応: isStud を currentMode から一意に導出し、単一の真実の源にする。
  // これにより currentMode と isStud の不整合を構造的に排除する。
  const _isStudByMode = isStudMode(room.currentMode);
  if (_isStudByMode) {
    // ドロー側 buildGameState がスタッドモードで呼ばれた = 誤ルーティングの兆候。
    // 観測のためログを出す（恒久的にはこの経路に来ないのが正常）。
    logDev(`[isStud-guard] buildGameState(DRAW) called with stud currentMode=${room.currentMode} room=${(room.id||'').slice(-8)} phase=${room.phase} → isStud:true を明示設定`);
  }

  const meta = {
    _meta: true,
    phase:          room.phase,
    mode:           room.mode,
    currentMode:    room.currentMode,
    // 【001/008】currentMode から導出。スタッド系なら必ず true。
    isStud:         _isStudByMode,
    pot:            room.pot,
    pots:           _potsForDisplay,
    currentBet:     room.currentBet,
    betSize:        room.betSize,
    // raiseCount: bet0は1スタート（BBポスト=1）、bet1〜は0スタート。maxRaises=5。
    // クライアント表示: raiseCount / maxRaises = "1/5"〜"5/5"
    // ⚠️ 変更禁止: クライアント側の表示式は raiseCount/maxRaises（+1 不要）
    raiseCount:     room.raiseCount,
    maxRaises:      MAX_RAISES,
    dealerIndex:    dealerIdx,   // 固定値（フォールドで変わらない）
    handCount:      room.handCount,
    timerRemaining, timerLimit: room._timerLimit,
    pendingPlayers: room.pendingPlayers.map((p) => p.name),
    playerCount:    room.players.length,
    maxPlayers:     MAX_PLAYERS,
    roomId:         room.id,  // クライアント側でroomIdフィルタリングに使用
    // NL対応情報
    isNL:           _roomIsNL(room),
    bigBlind:       room.bigBlind,
    lastRaiseSize:  room.lastRaiseSize || room.bigBlind,
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
        // splice後のインデックスずれを補正（advance後のindexも対象）
        if (room.actionIndex > idx) room.actionIndex--;
      }

      room.players.splice(idx, 1);
      room.pendingPlayers = room.pendingPlayers.filter((p) => p.id !== socketId);
      delete room._selectedIndices[socketId];

      // プレイヤー削除後、固定インデックスをズレないよう補正
      // 退室プレイヤー自身が SB/BB/Dealer だった場合は -1（無効）にする
      if      (room.fixedDealerIdx === idx) room.fixedDealerIdx = -1;
      else if (room.fixedDealerIdx  >  idx) room.fixedDealerIdx--;
      if      (room.fixedSbIdx === idx) room.fixedSbIdx = -1;
      else if (room.fixedSbIdx  >  idx) room.fixedSbIdx--;
      if      (room.fixedBbIdx === idx) room.fixedBbIdx = -1;
      else if (room.fixedBbIdx  >  idx) room.fixedBbIdx--;

      const activeAfterLeave = room.players.filter((p) => !p.sittingOut && !p.folded).length;
      const totalAfterLeave  = room.players.length + room.pendingPlayers.length;

      if (room.players.length === 0) {
        _clearTimer(room);
        // 全員退出 → フェーズをリセットして次の入室に備える
        room.phase          = 'waiting';
        room.pot            = 0;
        room.dealerIndex    = -1;
        room.actionIndex    = -1;
        room.fixedDealerIdx = -1;
        room.fixedSbIdx     = -1;
        room.fixedBbIdx     = -1;
        room.deck           = [];
        room.discardPile    = [];
        room._potAwarded    = false;
        room._selectedIndices = {};
        if (room.isUserCreated) rooms.delete(roomId);
      } else if (room.phase === 'showdown' && activeAfterLeave + room.pendingPlayers.length < 2) {
        // showdown中に退室してゲーム開始不可な人数になった → waitingにリセット
        _clearTimer(room);
        room.phase       = 'waiting';
        room.pot         = 0;
        room.actionIndex = -1;
        room.deck        = [];
        room.discardPile = [];
        room._potAwarded = false;
        room._selectedIndices = {};
        for (const p of room.players) { p.sittingOut = false; p.hand = []; p.bet = 0; p.folded = false; p.drewThisRound = false; p.drawCount = null; }
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

// ==========================================================
// ■ FastFold（ターン外でも即フォールド）
// ==========================================================

/**
 * FastFold: ターン中・外を問わず即座にフォールドしてルームから削除する。
 * - 自分のターン中なら betAction('fold') と同等の処理をしてから退室
 * - ターン外なら folded フラグを立てた上で退室（手番を次に進める）
 * @returns {string|null} roomId or null
 */
function fastFoldPlayer(socketId, targetRoomId = null) {
  for (const [roomId, room] of rooms.entries()) {
    // ZoomTable: targetRoomId が指定されている場合はそのルームのみ処理
    // （旧テーブルに folded=true が残っている場合のスキップ誤検知を防ぐ）
    if (targetRoomId && roomId !== targetRoomId) continue;

    const idx = room.players.findIndex((p) => p.id === socketId);
    if (idx === -1) continue;
    const player = room.players[idx];

    const inBetPhase = room.phase.startsWith('bet');
    if (!inBetPhase) {
      return null;
    }
    if (player.folded) {
      return null;
    }

    // 自分のターン中なら即フォールド
    if (room.actionIndex === idx) {
      player.folded = true;
      player.acted  = true;
      _clearTimer(room);
      _advanceBetAction(room);
      return roomId;
    }

    // ZoomTable: ターン外でも即時フォールド（fastFoldPendingを使わない）
    // fastFoldPendingを使うと「旧テーブルで後から自動フォールド」が発動して
    // 新テーブルに移動済みのFujitaが「勝手にフォールド扱いにされる」バグが発生
    if (room.isZoomTable) {
        player.folded = true;
      player.acted  = true;
      // タイマーはそのまま（現在のアクションプレイヤーのタイマーを維持）
      return roomId;
    }
    // 通常テーブル: 従来通りfastFoldPendingを使う
    player.fastFoldPending = true;
    return roomId;
  }
  return null;
}

function canAutoStart(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  if (room.phase !== 'showdown' && room.phase !== 'waiting') return false;
  // startGame の先頭で sittingOut = false にリセットするため、
  // showdown・waiting いずれも全プレイヤーを参加人数に含めてよい。
  // （_waitZoneSkip プレイヤーは startGame 1回目で sittingOut のまま失敗しても
  //    _waitZoneSkip がクリアされるため、2回目の startGame で必ず active になる）
  return room.players.length + room.pendingPlayers.length >= 2;
}

function getAllRooms() { return rooms; }

/**
 * タイムアウト発生時にカウンターを増加し、3回で退室フラグを返す
 * @returns {boolean} true なら退室させる
 */
function incrementTimeout(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  const player = room.players.find((p) => p.id === socketId);
  if (!player) return false;
  player.timeoutCount = (player.timeoutCount || 0) + 1;
  return player.timeoutCount >= 3;
}

/** アクション成功時にカウンターをリセット */
function resetTimeout(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const player = room.players.find((p) => p.id === socketId);
  if (player) player.timeoutCount = 0;
}

function getRoom(roomId) { return rooms.get(roomId) || null; }

/** トーナメント終了後のテーブルをメモリから削除する */
function deleteRoom(roomId) { rooms.delete(roomId); }

/**
 * 指定ルーム内のプレイヤー名を変更する（BOT名変更用）
 * @returns {boolean} 変更できたら true
 */
function renamePlayer(roomId, playerId, newName) {
  const room = rooms.get(roomId);
  if (!room) return false;
  const player = [...room.players, ...room.pendingPlayers].find(p => p.id === playerId);
  if (!player) return false;
  player.name = newName;
  return true;
}

/**
 * ポット未配布のショーダウン済みルームを強制精算する。
 * BOTのみのテーブルでは _broadcast が buildGameState を呼ばないため
 * _awardPots が実行されず chips が更新されないケースへの対処。
 * balanceTables / checkEliminations の前に呼ぶことでチップを正しく確定させる。
 */
function ensurePotsAwarded(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'showdown' || room._potAwarded) return;
  const activePlayers = room.players.filter((p) => !p.folded && !p.sittingOut);
  _awardPots(room, activePlayers);
  room._potAwarded = true;
}

module.exports = {
  getOrCreateRoom, joinRoom, leaveRoom, fastFoldPlayer,
  startGame, drawCards, betAction, updateSelectedIndices,
  buildGameState, removePlayer, canAutoStart, getAllRooms,
  incrementTimeout, resetTimeout,
  getRoomMode, getRoom, deleteRoom, renamePlayer,
  ensurePotsAwarded,
  // モード判定（他モジュールから共有利用するため公開）
  isNoLimitMode, isMixMode, isStudMode, peekNextMode, getMixCurrentMode,
  advanceModeRotation, advanceDealerButton, advanceBbAnchor, assignBlindsByBB, getMixSequence,
  STUD_MODES,
  STARTING_CHIPS, SMALL_BLIND, BIG_BLIND, SMALL_BET, BIG_BET, MAX_PLAYERS,
};
