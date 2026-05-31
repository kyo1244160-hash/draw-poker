/**
 * studBotManager.js — スタッド系トーナメントBOT（ルールベース）
 *
 * gameManager 系の tournamentBotManager とは別。studManager のルーム
 * （studRooms）を読み、相手のアップカードと自分の手を見て判断する。
 *
 * 判断方針（ルールベース）:
 *   - 自分の手の「現在の強さ」と「相手に見えているアップカードの脅威度」を評価
 *   - スコアに応じて fold / call / raise を確率的に選ぶ
 *   - モード別:
 *       stud_s: ハイハンドの完成度・ドロー（ペア/3カード/フラッシュ/ストレート見込み）
 *       stud_e: ロー方向（8以下を多く集める）＋ハイの兼ね合い
 *       razz:   ロー（低いカードを多く集める、ペアは悪い）
 */

const { log, logDev } = require('../logger');
const { RANK_HI, RANK_LO } = require('./studEvaluator');

/** studManager の studRooms を遅延取得（循環参照回避） */
function _getStudRoom(tableId) {
  const sm = require('./studManager');
  return sm.studRooms.get(tableId) ?? null;
}

// ==========================================================
// ■ 手の強さ評価（0〜1 のスコア。1=最強）
// ==========================================================

/**
 * 自分の全カード（裏含む）から、現ストリートでの手の強さスコアを返す
 * @param {string[]} cards 自分の全カード
 * @param {string} mode
 * @param {number} street 現在のストリート（3〜7）
 */
function handStrength(cards, mode, street) {
  if (!cards || cards.length === 0) return 0;
  if (mode === 'razz') return razzStrength(cards, street);
  if (mode === 'stud_e') return studELowStrength(cards, street);
  return studHiStrength(cards, street);
}

/** ハイ方向の強さ（stud_s） */
function studHiStrength(cards, street) {
  const nums = cards.map((c) => RANK_HI[c[0]]);
  const suits = cards.map((c) => c.slice(-1));

  // ペア・3カード・4カード
  const cnt = {};
  for (const n of nums) cnt[n] = (cnt[n] ?? 0) + 1;
  const counts = Object.values(cnt).sort((a, b) => b - a);
  const maxRank = Math.max(...nums);

  let score = 0;
  if (counts[0] >= 4) score = 0.97;
  else if (counts[0] === 3 && counts[1] >= 2) score = 0.92; // フルハウス
  else if (counts[0] === 3) score = 0.78;                    // 3カード
  else if (counts[0] === 2 && counts[1] === 2) score = 0.62; // 2ペア
  else if (counts[0] === 2) {
    // ペア: 高いペアほど強い
    const pairRank = Number(Object.entries(cnt).find(([, c]) => c === 2)[0]);
    score = 0.40 + (pairRank / 14) * 0.18;
  } else {
    // ハイカード: 最大カードと大きさで
    score = 0.15 + (maxRank / 14) * 0.15;
  }

  // フラッシュドロー / ストレートドロー加点（5th以前）
  const suitCnt = {};
  for (const s of suits) suitCnt[s] = (suitCnt[s] ?? 0) + 1;
  const maxSuit = Math.max(...Object.values(suitCnt));
  if (maxSuit >= 5) score = Math.max(score, 0.85);          // フラッシュ完成
  else if (maxSuit === 4 && street <= 5) score += 0.10;     // フラッシュドロー

  return Math.min(0.99, score);
}

/** ロー方向の強さ（stud_e）: 8以下を多く集めるほど良い */
function studELowStrength(cards, street) {
  const lowCards = cards.filter((c) => RANK_LO[c[0]] <= 8);
  const uniqLow = new Set(lowCards.map((c) => RANK_LO[c[0]]));
  const lowCount = uniqLow.size;

  // ロー完成度
  let loScore = 0;
  if (lowCount >= 5) loScore = 0.85;
  else if (lowCount === 4) loScore = 0.60;
  else if (lowCount === 3) loScore = 0.40;
  else loScore = 0.15;

  // ハイ側のスコアも見て高い方を採用（スクープ狙い）
  const hiScore = studHiStrength(cards, street) * 0.8;

  return Math.min(0.99, Math.max(loScore, hiScore));
}

/** Razz の強さ: 低いカードを多く・ペアは悪い */
function razzStrength(cards, street) {
  const nums = cards.map((c) => RANK_LO[c[0]]);
  const uniq = [...new Set(nums)].sort((a, b) => a - b);

  // ペアはRazzで致命的
  const cnt = {};
  for (const n of nums) cnt[n] = (cnt[n] ?? 0) + 1;
  const pairs = Object.values(cnt).filter((c) => c >= 2).length;

  // 低いユニークカードの枚数で評価
  const lowUniq = uniq.filter((n) => n <= 8);
  let score = 0;
  if (lowUniq.length >= 5) {
    // ロー完成。最高カードが低いほど強い
    const high = lowUniq[4];
    score = 0.95 - (high - 5) * 0.05;
  } else if (lowUniq.length === 4) score = 0.60;
  else if (lowUniq.length === 3) score = 0.42;
  else score = 0.18;

  // ペアペナルティ
  score -= pairs * 0.18;

  return Math.max(0.05, Math.min(0.99, score));
}

// ==========================================================
// ■ 相手の脅威度（見えているアップカードから）
// ==========================================================

/** 相手のアップカードから脅威度を評価（0〜1） */
function boardThreat(room, selfId) {
  let threat = 0;
  for (const p of room.players) {
    if (p.id === selfId || p.folded || p.sittingOut) continue;
    const ups = (p.cards || []).filter((c, i) => p.faceUp[i]);
    if (ups.length === 0) continue;
    if (room.currentMode === 'razz') {
      // 低いアップカードが多いほど脅威
      const low = ups.filter((c) => RANK_LO[c[0]] <= 8).length;
      threat = Math.max(threat, low / Math.max(1, ups.length) * 0.6);
    } else {
      // ペア・高カードが脅威
      const nums = ups.map((c) => RANK_HI[c[0]]);
      const cnt = {};
      for (const n of nums) cnt[n] = (cnt[n] ?? 0) + 1;
      const hasPair = Object.values(cnt).some((c) => c >= 2);
      const high = Math.max(...nums);
      threat = Math.max(threat, (hasPair ? 0.5 : 0) + (high / 14) * 0.3);
    }
  }
  return Math.min(1, threat);
}

// ==========================================================
// ■ アクション決定
// ==========================================================

/**
 * BOTのベットアクションを決定
 * @returns {'fold'|'check'|'call'|'raise'}
 */
function decideStudBetAction(room, player) {
  const street = (room.cards) ? 7 : (player.cards ? player.cards.length : 3);
  const strength = handStrength(player.cards, room.currentMode, street);
  const threat = boardThreat(room, player.id);
  const toCall = room.currentBet - player.bet;

  // 【ブリングイン選択制】義務者の手番: bringIn か complete を選ぶ。
  // 通常は最小ブリングイン。強い見せ札のときだけたまにコンプリート。
  if (player.mustBringIn) {
    if (strength > 0.7 && Math.random() < 0.35) return 'complete';
    return 'bringIn';
  }

  // 正味スコア = 自分の強さ - 相手脅威*0.5
  const net = strength - threat * 0.4;

  // チェック可能な場面
  if (toCall <= 0) {
    // 強ければベット、普通ならチェック
    if (net > 0.65 && Math.random() < 0.7) return 'bet';
    if (net > 0.5 && Math.random() < 0.35) return 'bet';
    return 'check';
  }

  // コールが必要な場面
  // ブリングイン強制ポスト直後（3rd）は緩めに参加
  if (room.phase === 'bet3rd') {
    if (net > 0.7 && Math.random() < 0.5) return 'raise';
    if (net > 0.3) return 'call';
    if (net > 0.18 && Math.random() < 0.4) return 'call'; // たまに参加
    return 'fold';
  }

  // 4th以降
  if (net > 0.72 && room.raiseCount < 5 && Math.random() < 0.55) return 'raise';
  if (net > 0.45) return 'call';
  if (net > 0.32 && Math.random() < 0.45) return 'call';
  return 'fold';
}

// ==========================================================
// ■ トリガー（tournamentBotManager.triggerBotActions のスタッド版）
// ==========================================================

const _pendingStudBot = new Map();

/**
 * スタッドテーブルでBOTのターンなら自動アクションを実行する。
 * tournamentBotManager の _tableBots を流用して BOT 判定する。
 *
 * @param {string} tableId
 * @param {Set<string>} botIds このテーブルのBOT id集合
 * @param {function} onActionDone (tableId, botName, action) コールバック
 */
function triggerStudBotActions(tableId, botIds, onActionDone) {
  const room = _getStudRoom(tableId);
  if (!room || room.phase === 'waiting' || room.phase === 'showdown') return;
  if (!botIds || botIds.size === 0) return;

  const cur = room.players[room.actionIndex];
  if (!cur || !botIds.has(cur.id)) {
    logDev(`[StudBot] ${tableId.slice(-8)} turn not bot → skip`);
    return;
  }

  const key = `${tableId}::${cur.id}`;
  if (_pendingStudBot.has(key)) return;
  _pendingStudBot.set(key, true);

  const delay = 500 + Math.random() * 1000;
  setTimeout(() => {
    _pendingStudBot.delete(key);
    const room2 = _getStudRoom(tableId);
    if (!room2 || room2.phase === 'waiting' || room2.phase === 'showdown') return;
    const cur2 = room2.players[room2.actionIndex];
    if (!cur2 || cur2.id !== cur.id) return;

    const sm = require('./studManager');
    const action = decideStudBetAction(room2, cur2);
    const acted = !!sm.studBetAction(tableId, cur2.id, action, 0);
    log(`[StudBot] ${tableId.slice(-8)} ${cur2.name}(${room2.currentMode}) ${action} acted=${acted} chips=${cur2.chips}`);
    if (acted && onActionDone) {
      onActionDone(tableId, cur2.name, action);
    }
  }, delay);
}

module.exports = {
  triggerStudBotActions,
  decideStudBetAction,
  handStrength,
  boardThreat,
};
