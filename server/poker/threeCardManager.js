/**
 * server/poker/threeCardManager.js
 * スリーカードポーカー テーブル管理
 *
 * フェーズ:
 *   waiting  → 入室後すぐに betting へ（待機なし）
 *   betting  → ベット配置（タイムアウト30秒）
 *   dealt    → カード配布済み
 *   action   → プレイ/フォールド選択（タイムアウト20秒）
 *   reveal   → ディーラー公開・結果計算
 *   result   → 結果表示（5秒後に次ハンドへ）
 *
 * ポイント通貨: room.players[].points（既存 chips とは別）
 * ディーラーの手: サーバーのみ保持（reveal まで非公開）
 */

const { createShuffledDeck }     = require('./deck');
const {
  evaluateThreeCardHand,
  compareThreeCardHands,
  dealerQualifies,
  getAnteBonus,
  getPairPlusPayout,
  getSixCardBonusPayout,
} = require('./threeCardEvaluator');

const TC_PREFIX     = '3card-room-';
const MAX_PLAYERS   = 6;
const BET_MIN       = 1;    // 最小ベット額（ポイント）
const BET_MAX       = 100;  // 最大ベット額（ポイント）
const BET_TIMEOUT   = 30;   // 秒
const ACTION_TIMEOUT = 20;  // 秒
const RESULT_DELAY  = 5000; // ms（結果表示 → 次ハンド）
const BOT_PREFIX = '3cbot::';
const BOT_NAMES = [
  '3C-Ace', '3C-Betty', '3C-Carl', '3C-Dan', '3C-Eve', '3C-Frank',
  '3C-Gina', '3C-Hoge', '3C-Ivy', '3C-Jack', '3C-Ken', '3C-Lou',
];
let _botSeq = 0;
const _botPending = new Set();

// テーブル Map: roomId → table
const tables = new Map();
global.__pastisThreeCardTables = tables;

// フェーズ変化コールバック（server/index.js が登録）
// (roomId, phase) を受け取り、ブロードキャストや DB 更新を行う
let _onPhaseChange = null;
function setPhaseChangeCallback(fn) { _onPhaseChange = fn; }

/**
 * フェーズ変化を通知する。
 * ユーザーアクション・サーバータイマーのどちらの遷移でも必ず呼ぶこと。
 */
function _notify(t) {
  if (_onPhaseChange) {
    try { _onPhaseChange(t.id, t.phase); }
    catch (e) { console.error('[3CP] phaseChange callback error:', e.message); }
  }
  triggerBotActions(t.id);
}

// ===== ユーティリティ =====

function log(msg)    { console.log(`[3CP] ${msg}`); }
function logDev(msg) { if (process.env.NODE_ENV !== 'production') console.log(`[3CP-dev] ${msg}`); }

function isThreeCardRoom(roomId) {
  return typeof roomId === 'string' && roomId.startsWith(TC_PREFIX);
}

function listRooms() {
  return [...tables.values()];
}

/**
 * テーブルを取得または作成する
 * 既存テーブルが満員の場合は新しいテーブルを生成する
 */
function getOrCreateAvailableRoom() {
  // 空きのあるテーブルを探す
  for (const [, t] of tables) {
    if (t.players.length < MAX_PLAYERS) return t;
  }
  // 全て満員 → 新規作成
  return _createTable();
}

function _nextRoomId() {
  let n = 1;
  while (tables.has(`${TC_PREFIX}${n}`)) n++;
  return `${TC_PREFIX}${n}`;
}

function _createTable() {
  const roomId = _nextRoomId();
  const table = {
    id:            roomId,
    players:       [],   // { socketId, accountId, name, points, bets: {ante,pp,sixCard}, hand, action, result }
    phase:         'waiting',
    dealerHand:    null, // サーバーのみ保持
    deck:          null,
    handCount:     0,
    _betTimer:     null,
    _actionTimer:  null,
    _resultTimer:  null,
  };
  tables.set(roomId, table);
  log(`テーブル作成: ${roomId}`);
  return table;
}

/**
 * テーブルが空になったら削除（room-1 は常設）
 */
function _maybeDeleteTable(roomId) {
  if (roomId === `${TC_PREFIX}1`) return; // 常設テーブルは削除しない
  const t = tables.get(roomId);
  if (!t || t.players.length > 0) return;
  _clearAllTimers(t);
  tables.delete(roomId);
  log(`テーブル削除: ${roomId}`);
}

function _clearAllTimers(t) {
  if (t._betTimer)    { clearTimeout(t._betTimer);    t._betTimer    = null; }
  if (t._actionTimer) { clearTimeout(t._actionTimer); t._actionTimer = null; }
  if (t._resultTimer) { clearTimeout(t._resultTimer); t._resultTimer = null; }
}

// ===== プレイヤー管理 =====

function joinTable(roomId, socketId, name, accountId, currentPoints) {
  const t = tables.get(roomId);
  if (!t) return 'notFound';
  if (t.players.length >= MAX_PLAYERS) return 'full';
  if (t.players.find(p => p.socketId === socketId)) return 'alreadyJoined';

  const player = {
    socketId,
    accountId:  accountId ?? null,
    name,
    points:     currentPoints,  // ゲーム内残ポイント（DBから取得済み）
    bets:       { ante: 0, pp: 0, sixCard: 0 },
    hand:       [],
    action:      null,   // 'play' | 'fold' | null
    result:      null,   // { net, dealerQualified, won, anteBonus, ppPayout, sixCardPayout }
    betReady:    false,  // betting フェーズで確定したか
    startPoints: currentPoints,  // ハンド開始時の残高（真の損益計算用）
  };
  t.players.push(player);
  log(`${name} が ${roomId} に入室 (${t.players.length}/${MAX_PLAYERS})`);

  // waiting 中なら betting 開始
  if (t.phase === 'waiting') {
    _startBetting(t);
  }

  return 'ok';
}

function leaveTable(roomId, socketId) {
  const t = tables.get(roomId);
  if (!t) return;
  const before = t.players.length;
  t.players = t.players.filter(p => p.socketId !== socketId);
  if (t.players.length === before) return;
  log(`ソケット ${socketId.slice(-6)} が ${roomId} から退室 (${t.players.length}/${MAX_PLAYERS})`);

  // 退室により残りプレイヤーが完了条件を満たしている場合、フェーズを進める
  // （切断者を待ってタイムアウトするのを防ぐ）
  if (t.players.length > 0) {
    if (t.phase === 'betting' && t.players.every(p => p.betReady)) {
      _deal(t);
    } else if (t.phase === 'action') {
      const active = t.players.filter(p => p.action !== 'fold_no_bet');
      if (active.length > 0 && active.every(p => p.action !== null)) {
        _reveal(t);
      }
    }
  }

  _maybeDeleteTable(roomId);
}

function getTable(roomId) {
  return tables.get(roomId) ?? null;
}

function _pickBotName(t, preferred = null) {
  const used = new Set(t.players.map(p => p.name));
  if (preferred && !used.has(preferred)) return preferred;
  for (const name of BOT_NAMES) {
    if (!used.has(name)) return name;
  }
  let suffix = 1;
  while (used.has(`3C-Bot-${suffix}`)) suffix++;
  return `3C-Bot-${suffix}`;
}

function addBot(roomId, opts = {}) {
  const t = tables.get(roomId);
  if (!t) return { ok: false, reason: 'notFound' };
  if (t.players.length >= MAX_PLAYERS) return { ok: false, reason: 'full' };

  const socketId = `${BOT_PREFIX}${Date.now()}-${++_botSeq}`;
  const name = _pickBotName(t, opts.name);
  const points = Number.isFinite(Number(opts.points)) ? Math.max(1, Math.floor(Number(opts.points))) : 5000;
  const p = {
    socketId,
    accountId: null,
    name,
    points,
    bets: { ante: 0, pp: 0, sixCard: 0 },
    hand: [],
    action: null,
    result: null,
    betReady: false,
    startPoints: points,
    isBot: true,
  };

  // 進行中のハンドへ途中参加したBOTは次ハンドから参加させる。
  if (t.phase !== 'waiting' && t.phase !== 'betting') {
    p.betReady = true;
    p.action = 'fold_no_bet';
  }

  t.players.push(p);
  log(`BOT ${name} を ${roomId} に追加 (${t.players.length}/${MAX_PLAYERS})`);

  if (t.phase === 'waiting') {
    _startBetting(t);
  } else {
    _notify(t);
  }
  return { ok: true, bot: { id: socketId, roomId, name, points } };
}

function addBots(roomId, count = 1, opts = {}) {
  const added = [];
  const n = Math.min(Math.max(1, parseInt(count, 10) || 1), MAX_PLAYERS);
  for (let i = 0; i < n; i++) {
    const result = addBot(roomId, opts);
    if (!result.ok) break;
    added.push(result.bot);
  }
  return added;
}

function removeBot(roomId, botId) {
  const t = tables.get(roomId);
  if (!t) return false;
  const idx = t.players.findIndex(p => p.socketId === botId && p.isBot);
  if (idx < 0) return false;
  t.players.splice(idx, 1);
  for (const key of [..._botPending]) {
    if (key.includes(`::${botId}::`)) _botPending.delete(key);
  }
  log(`BOT ${botId} を ${roomId} から削除`);
  _notify(t);
  _maybeDeleteTable(roomId);
  return true;
}

function removeBots(roomId) {
  const t = tables.get(roomId);
  if (!t) return 0;
  const before = t.players.length;
  const botIds = new Set(t.players.filter(p => p.isBot).map(p => p.socketId));
  t.players = t.players.filter(p => !p.isBot);
  for (const key of [..._botPending]) {
    for (const id of botIds) {
      if (key.includes(`::${id}::`)) _botPending.delete(key);
    }
  }
  const removed = before - t.players.length;
  if (removed > 0) {
    log(`${roomId} の3CP BOTを ${removed} 体削除`);
    _notify(t);
  }
  _maybeDeleteTable(roomId);
  return removed;
}

function listBots() {
  return [...tables.values()].flatMap(t =>
    t.players.filter(p => p.isBot).map(p => ({
      id: p.socketId,
      roomId: t.id,
      name: p.name,
      points: p.points,
      phase: t.phase,
    }))
  );
}

function _decideBotBet(bot) {
  const ante = Math.min(BET_MAX, Math.max(BET_MIN, Math.min(bot.points, 10)));
  const remaining = bot.points - ante;
  const pp = remaining >= 5 && Math.random() < 0.35 ? 5 : 0;
  const sixCard = remaining - pp >= 5 && Math.random() < 0.25 ? 5 : 0;
  return { ante, pp, sixCard };
}

function _decideBotAction(bot) {
  try {
    const ev = evaluateThreeCardHand(bot.hand);
    // ペア以上はPLAY、Q-6-4以上は概ねPLAY。テスト用途なので少しランダムを残す。
    if ((ev.rank ?? 0) >= 1) return 'play';
    const vals = bot.hand
      .map(c => ({ A: 14, K: 13, Q: 12, J: 11, T: 10 }[c[0]] ?? Number(c[0]) ?? 0))
      .sort((a, b) => b - a);
    if (vals[0] > 12) return 'play';
    if (vals[0] === 12 && (vals[1] > 6 || (vals[1] === 6 && vals[2] >= 4))) return 'play';
    return Math.random() < 0.12 ? 'play' : 'fold';
  } catch {
    return Math.random() < 0.5 ? 'play' : 'fold';
  }
}

function triggerBotActions(roomId) {
  const t = tables.get(roomId);
  if (!t || (t.phase !== 'betting' && t.phase !== 'action')) return;

  const target = t.players.find(p =>
    p.isBot &&
    ((t.phase === 'betting' && !p.betReady) || (t.phase === 'action' && p.action === null))
  );
  if (!target) return;

  const key = `${roomId}::${target.socketId}::${t.handCount}::${t.phase}`;
  if (_botPending.has(key)) return;
  _botPending.add(key);

  const delay = 350 + Math.random() * 900;
  setTimeout(() => {
    _botPending.delete(key);
    const now = tables.get(roomId);
    const bot = now?.players.find(p => p.socketId === target.socketId && p.isBot);
    if (!now || !bot || now.handCount !== t.handCount || now.phase !== t.phase) return;

    if (now.phase === 'betting' && !bot.betReady) {
      placeBet(roomId, bot.socketId, _decideBotBet(bot));
      if (now.phase === 'betting') _notify(now);
      return;
    }

    if (now.phase === 'action' && bot.action === null) {
      playerAction(roomId, bot.socketId, _decideBotAction(bot));
      if (now.phase === 'action') _notify(now);
    }
  }, delay);
}

// ===== フェーズ管理 =====

/**
 * betting フェーズ開始
 * 既存プレイヤーのベットをリセット
 */
function _startBetting(t) {
  _clearAllTimers(t);
  t.phase = 'betting';
  t.handCount++;

  for (const p of t.players) {
    p.bets        = { ante: 0, pp: 0, sixCard: 0 };
    p.hand        = [];
    p.action      = null;
    p.result      = null;
    p.betReady    = false;
    p.startPoints = p.points;  // ハンド開始時の残高（真の損益計算用）
  }
  t.dealerHand = null;

  log(`${t.id} hand=${t.handCount} betting フェーズ開始 (${t.players.length}人)`);

  // タイムアウト: 未ベットプレイヤーを自動フォールド扱いで進行
  t._betTimer = setTimeout(() => {
    _onBetTimeout(t);
  }, BET_TIMEOUT * 1000);

  _notify(t);
}

/**
 * プレイヤーがベットを確定する
 * ante: 1-100 必須, pp / sixCard: 0-100 任意
 */
function placeBet(roomId, socketId, { ante, pp = 0, sixCard = 0 }) {
  const t = tables.get(roomId);
  if (!t || t.phase !== 'betting') return { ok: false, reason: 'notBetting' };

  const p = t.players.find(pl => pl.socketId === socketId);
  if (!p) return { ok: false, reason: 'notInRoom' };
  if (p.betReady) return { ok: false, reason: 'alreadyBet' };

  // バリデーション
  if (typeof ante !== 'number' || ante < BET_MIN || ante > BET_MAX || !Number.isInteger(ante)) {
    return { ok: false, reason: 'invalidAnte' };
  }
  if (typeof pp !== 'number' || pp < 0 || pp > BET_MAX || !Number.isInteger(pp)) {
    return { ok: false, reason: 'invalidPP' };
  }
  if (typeof sixCard !== 'number' || sixCard < 0 || sixCard > BET_MAX || !Number.isInteger(sixCard)) {
    return { ok: false, reason: 'invalidSixCard' };
  }
  const total = ante + pp + sixCard;
  if (p.points < total) return { ok: false, reason: 'insufficientPoints' };

  p.bets     = { ante, pp, sixCard };
  p.betReady = true;
  p.points   -= total; // ゲーム内残高から差し引き（DB は reveal 後に更新）

  log(`${p.name} ベット確定: ante=${ante} pp=${pp} 6c=${sixCard}`);

  // 全員ベット確定 → deal へ
  if (t.players.every(pl => pl.betReady)) {
    _deal(t);
  }

  return { ok: true };
}

function _onBetTimeout(t) {
  if (t.phase !== 'betting') return;
  log(`${t.id} ベットタイムアウト`);

  // 未ベットプレイヤーを最小ベット(1)で自動確定（ポイント不足なら退場）
  for (const p of t.players) {
    if (!p.betReady) {
      if (p.points >= 1) {
        p.bets     = { ante: 1, pp: 0, sixCard: 0 };
        p.betReady = true;
        p.points   -= 1;
      } else {
        // ポイント不足 → このハンドはフォールド扱い（betReady のまま false → _deal でスキップ）
        p.bets     = { ante: 0, pp: 0, sixCard: 0 };
        p.betReady = true; // 進行のためtrue にする
        p.action   = 'fold_no_bet'; // ベットなしフォールド
      }
    }
  }
  _deal(t);
}

/**
 * カード配布フェーズ
 */
function _deal(t) {
  _clearAllTimers(t);
  t.phase = 'dealt';
  const deck = createShuffledDeck();

  // プレイヤーに3枚ずつ
  for (const p of t.players) {
    if (p.action === 'fold_no_bet') {
      p.hand = [];
      continue;
    }
    p.hand = deck.splice(0, 3);
  }
  // ディーラーに3枚（サーバーのみ保持）
  t.deck       = deck;
  t.dealerHand = deck.splice(0, 3);

  log(`${t.id} dealt: dealer=[${t.dealerHand.join(',')}]`);

  // すぐに action フェーズへ
  _startAction(t);
}

/**
 * action フェーズ: プレイ/フォールドを受け付ける
 */
function _startAction(t) {
  t.phase = 'action';
  log(`${t.id} action フェーズ開始`);

  t._actionTimer = setTimeout(() => {
    _onActionTimeout(t);
  }, ACTION_TIMEOUT * 1000);

  _notify(t);
}

/**
 * プレイヤーがプレイ/フォールドを選択
 */
function playerAction(roomId, socketId, action) {
  const t = tables.get(roomId);
  if (!t || t.phase !== 'action') return { ok: false, reason: 'notAction' };

  const p = t.players.find(pl => pl.socketId === socketId);
  if (!p || p.action !== null || p.action === 'fold_no_bet') {
    return { ok: false, reason: 'invalid' };
  }
  if (action !== 'play' && action !== 'fold') {
    return { ok: false, reason: 'invalidAction' };
  }

  if (action === 'play') {
    // プレイベット: アンテと同額を追加消費
    if (p.points < p.bets.ante) {
      // ポイント不足時は自動フォールド
      p.action = 'fold';
    } else {
      p.points -= p.bets.ante;
      p.action  = 'play';
    }
  } else {
    p.action = 'fold';
  }

  log(`${p.name} → ${p.action}`);

  // 全員確定 → reveal
  const active = t.players.filter(pl => pl.action !== 'fold_no_bet');
  if (active.every(pl => pl.action !== null)) {
    _reveal(t);
  }
  return { ok: true };
}

function _onActionTimeout(t) {
  if (t.phase !== 'action') return;
  log(`${t.id} アクションタイムアウト → 未アクションはフォールド`);

  for (const p of t.players) {
    if (p.action === null && p.action !== 'fold_no_bet') {
      p.action = 'fold';
    }
  }
  _reveal(t);
}

/**
 * reveal フェーズ: ディーラー公開・結果計算
 */
function _reveal(t) {
  _clearAllTimers(t);
  t.phase = 'reveal';

  const dHand      = t.dealerHand;
  const dQualifies = dealerQualifies(dHand);
  const dEval      = evaluateThreeCardHand(dHand);

  log(`${t.id} reveal: dealer=[${dHand.join(',')}] ${dEval.label} qualifies=${dQualifies}`);

  for (const p of t.players) {
    if (p.action === 'fold_no_bet') {
      p.result = {
        net:             0,
        dealerQualified: dQualifies,
        won:             false,
        folded:          true,
        dealerHand:      dHand,
        dealerEval:      dEval.label,
      };
      continue;
    }

    let net = 0;

    if (p.action === 'fold') {
      // フォールド: アンテ・プレイは没収（bets は既に差し引き済み）
      // アンテボーナス・ペアプラス・6カードはフォールドでも有効
      net -= 0; // アンテは既に差し引き済み

      // アンテボーナス（ストレート以上、勝敗・フォールド無関係）
      const anteBonusMult = getAnteBonus(p.hand);
      if (anteBonusMult > 0) {
        net += p.bets.ante * anteBonusMult; // 配当のみ
      }

      // ペアプラス
      const ppPay = p.bets.pp > 0 ? getPairPlusPayout(p.hand) : 0;
      if (ppPay > 0) {
        net += p.bets.pp * (ppPay + 1); // 掛け金返却 + 配当
      }
      // 6カードボーナス（ディーラー手と合わせて判定）
      const sixPay = p.bets.sixCard > 0 ? getSixCardBonusPayout(p.hand, dHand) : 0;
      if (sixPay > 0) {
        net += p.bets.sixCard * (sixPay + 1);
      }

      p.points += net;
      p.result  = {
        net,
        dealerQualified: dQualifies,
        won:             false,
        folded:          true,
        anteBonusMult,
        ppPayout:        ppPay,
        sixCardPayout:   sixPay,
        playerEval:      evaluateThreeCardHand(p.hand).label,
        dealerHand:      dHand,
        dealerEval:      dEval.label,
      };
    } else {
      // プレイ: アンテ + プレイベット
      const cmp = compareThreeCardHands(p.hand, dHand);

      // ディーラー不参加: アンテ 1:1 勝ち、プレイベット push（返却のみ）
      if (!dQualifies) {
        net += p.bets.ante * 2; // アンテ 1:1 配当 + 返却
        net += p.bets.ante;     // プレイベット push → 返却のみ
      } else if (cmp > 0) {
        // プレイヤー勝ち
        net += p.bets.ante * 2;   // アンテ 1:1 配当 + 返却
        net += p.bets.ante * 2;   // プレイ 1:1 配当 + 返却
      } else if (cmp === 0) {
        // 引き分け: push（アンテ + プレイ返却）
        net += p.bets.ante;
        net += p.bets.ante;
      } else {
        // 負け: アンテ・プレイとも没収（既に差し引き済みなので追加なし）
      }

      // アンテボーナス（勝敗無関係）
      const anteBonusMult = getAnteBonus(p.hand);
      if (anteBonusMult > 0) {
        net += p.bets.ante * anteBonusMult; // 配当のみ（元金はアンテ/プレイで処理済み）
      }

      // ペアプラス
      const ppPay = p.bets.pp > 0 ? getPairPlusPayout(p.hand) : 0;
      if (ppPay > 0) {
        net += p.bets.pp * (ppPay + 1);
      }

      // 6カードボーナス
      const sixPay = p.bets.sixCard > 0 ? getSixCardBonusPayout(p.hand, dHand) : 0;
      if (sixPay > 0) {
        net += p.bets.sixCard * (sixPay + 1);
      }

      p.points += net;
      p.result  = {
        net,
        dealerQualified: dQualifies,
        won:             dQualifies ? cmp > 0 : true,
        push:            dQualifies && cmp === 0,
        anteBonusMult,
        ppPayout:        ppPay,
        sixCardPayout:   sixPay,
        playerEval:      evaluateThreeCardHand(p.hand).label,
        dealerHand:      dHand,
        dealerEval:      dEval.label,
      };
    }
  }

  t.phase = 'result';

  // 各プレイヤーの result.net を「真の損益（最終残高 - 開始残高）」に統一する。
  // それまでの net は「配当として戻る額」だったが、ベットで引いた分が含まれず
  // DB反映・表示の両方で不整合になるため、ここで真の損益へ上書きする。
  for (const p of t.players) {
    if (!p.result) continue;
    const trueNet = p.points - (p.startPoints ?? p.points);
    p.result.net = trueNet;
  }

  log(`${t.id} result フェーズ`);

  _notify(t);  // result フェーズ通知 → server側で DB更新 + ブロードキャスト

  // 5秒後に次ハンド
  t._resultTimer = setTimeout(() => {
    _nextHand(t);
  }, RESULT_DELAY);
}

function _nextHand(t) {
  if (t.players.length === 0) {
    _maybeDeleteTable(t.id);
    return;
  }
  _startBetting(t);
}

// ===== ゲーム状態のビルド（クライアント送信用） =====

/**
 * 特定プレイヤー視点のゲーム状態を返す
 * 自分の手のみ見える。ディーラーの手は reveal フェーズのみ。
 */
function buildTableState(roomId, requestSocketId) {
  const t = tables.get(roomId);
  if (!t) return null;

  const isReveal = t.phase === 'reveal' || t.phase === 'result';
  const isAction = t.phase === 'action';

  const players = t.players.map(p => {
    const isSelf = p.socketId === requestSocketId;
    // 自分の手役ラベル: action フェーズ以降は表示（ポップアップ・常時表示用）
    let handLabel = null;
    if (isSelf && (isAction || isReveal) && p.hand.length === 3) {
      try {
        const { evaluateThreeCardHand } = require('./threeCardEvaluator');
        handLabel = evaluateThreeCardHand(p.hand).label;
      } catch { /* silent */ }
    }
    return {
      name:      p.name,
      isSelf,
      points:    p.points,
      bets:      p.bets,
      hand:      isSelf || isReveal ? p.hand : p.hand.map(() => '??'),
      action:    p.action,
      betReady:  p.betReady,
      handLabel, // action フェーズから提供（reveal前でも自分の役がわかる）
      result:    isReveal ? p.result : null,
    };
  });

  return {
    roomId:     t.id,
    phase:      t.phase,
    handCount:  t.handCount,
    players,
    dealerHand: isReveal ? t.dealerHand : t.dealerHand?.map(() => '??'),
    maxPlayers: MAX_PLAYERS,
  };
}

/**
 * 全員にブロードキャストするための状態
 * （socketId ごとに buildTableState を呼ぶことも可）
 */
function buildBroadcastState(roomId) {
  const t = tables.get(roomId);
  if (!t) return null;
  const isReveal = t.phase === 'reveal' || t.phase === 'result';

  const players = t.players.map(p => ({
    name:     p.name,
    points:   p.points,
    bets:     p.bets,
    hand:     isReveal ? p.hand : p.hand.map(() => '??'),
    action:   p.action,
    betReady: p.betReady,
    result:   isReveal ? p.result : null,
  }));

  return {
    roomId:     t.id,
    phase:      t.phase,
    handCount:  t.handCount,
    players,
    dealerHand: isReveal ? t.dealerHand : t.dealerHand?.map(() => '??'),
    maxPlayers: MAX_PLAYERS,
  };
}

// 初期テーブル作成（room-1 は常設）
_createTable();

module.exports = {
  isThreeCardRoom,
  listRooms,
  getOrCreateAvailableRoom,
  getTable,
  joinTable,
  leaveTable,
  addBot,
  addBots,
  removeBot,
  removeBots,
  listBots,
  triggerBotActions,
  placeBet,
  playerAction,
  setPhaseChangeCallback,
  buildTableState,
  buildBroadcastState,
  MAX_PLAYERS,
  BET_MIN,
  BET_MAX,
  TC_PREFIX,
};
