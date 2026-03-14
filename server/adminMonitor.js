'use strict';
/**
 * adminMonitor.js — トーナメントリアルタイム監視 API
 *
 * Express ルーターとして mount する。
 * すべてのエンドポイントは管理者認証が必要。
 *
 * エンドポイント:
 *   GET  /api/admin/monitor/tournaments
 *     現在 running 中の全トーナメント一覧と概要
 *
 *   GET  /api/admin/monitor/tournaments/:tournamentId
 *     トーナメント詳細（テーブル・プレイヤー・ブラインド状況）
 *
 *   GET  /api/admin/monitor/tournaments/:tournamentId/tables/:tableId
 *     特定テーブルのリアルタイム状態（手札なし）
 *
 *   POST /api/admin/monitor/tournaments/:tournamentId/forceFinish
 *     管理者によるトーナメント強制終了
 *
 *   POST /api/admin/monitor/tables/:tableId/kickPlayer
 *     body: { playerId }
 *     管理者による特定プレイヤーの強制退場
 */

const express = require('express');
const { decode } = require('next-auth/jwt');
const { isAdmin } = require('./db/admin');
const {
  getTournament,
  getTournamentByTable,
  isTournamentTable,
  handleForcedLeave,
  _broadcastTournamentStatus,
  startTournament,
  broadcastTableState,
} = require('./tournament/tournamentManager');
const { getOrCreateRoom, getAllRooms, leaveRoom } = require('./poker/gameManager');
const { getTournament: getTournamentDB, getEntries } = require('./db/tournament');
const { updateTournamentStatus } = require('./db/admin');

const router = express.Router();

// io インスタンス（index.js から setIo() で注入）
let _io = null;
function setIo(io) { _io = io; }

// ===== 管理者認証ミドルウェア =====
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });

    const decoded = await decode({ token, secret: process.env.NEXTAUTH_SECRET });
    if (!decoded?.accountId) return res.status(401).json({ error: 'INVALID_TOKEN' });

    const admin = await isAdmin(decoded.accountId);
    if (!admin) return res.status(403).json({ error: 'FORBIDDEN' });

    req.adminId = decoded.accountId;
    next();
  } catch (err) {
    console.error('[adminMonitor] auth error:', err.message);
    res.status(500).json({ error: 'AUTH_ERROR' });
  }
}

router.use(requireAdmin);

// ===== ヘルパー =====
function _tableSnapshot(tableId) {
  const room = getOrCreateRoom(tableId);
  if (!room) return null;
  return {
    tableId,
    phase:   room.phase,
    pot:     room.pot,
    handCount: room.handCount,
    blinds: {
      sb: room.smallBlind,
      bb: room.bigBlind,
    },
    players: room.players.map(p => ({
      id:           p.id,
      name:         p.name,
      chips:        p.chips,
      bet:          p.bet,
      folded:       p.folded,
      sittingOut:   p.sittingOut,
      disconnected: p.disconnected ?? false,
      timeoutCount: p.timeoutCount ?? 0,
      isDealer:     room.players.indexOf(p) === room.fixedDealerIdx,
    })),
  };
}

// ===== GET /api/admin/monitor/tournaments =====
router.get('/tournaments', (req, res) => {
  const running = [];
  // getAllRooms でトーナメントテーブルを逆引き
  const seen = new Set();
  for (const [roomId] of getAllRooms()) {
    if (!isTournamentTable(roomId)) continue;
    const t = getTournamentByTable(roomId);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);

    const lv = t.levels[t.currentLevelIdx];
    const elapsed = Date.now() - t.levelStartedAt;
    const secondsToNextLevel = lv.durationMinutes > 0
      ? Math.max(0, Math.floor((lv.durationMinutes * 60 * 1000 - elapsed) / 1000))
      : 0;

    running.push({
      id:               t.id,
      name:             t.name,
      mode:             t.mode,
      status:           t.status,
      totalPlayers:     t.totalPlayers,
      remainingPlayers: t.tableIds.reduce((sum, tid) => {
        const r = getOrCreateRoom(tid);
        return sum + (r ? r.players.length : 0);
      }, 0),
      tableCount:       t.tableIds.length,
      blindLevel:       lv.level,
      currentSb:        lv.sb,
      currentBb:        lv.bb,
      secondsToNextLevel,
    });
  }
  res.json({ tournaments: running });
});

// ===== GET /api/admin/monitor/tournaments/:tournamentId =====
router.get('/tournaments/:tournamentId', (req, res) => {
  const t = getTournament(req.params.tournamentId);
  if (!t) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });

  const lv = t.levels[t.currentLevelIdx];
  const nextLv = t.levels[t.currentLevelIdx + 1] ?? null;
  const elapsed = Date.now() - t.levelStartedAt;
  const secondsToNextLevel = lv.durationMinutes > 0
    ? Math.max(0, Math.floor((lv.durationMinutes * 60 * 1000 - elapsed) / 1000))
    : 0;

  const tables = t.tableIds.map(tid => _tableSnapshot(tid)).filter(Boolean);

  res.json({
    id:               t.id,
    name:             t.name,
    mode:             t.mode,
    status:           t.status,
    totalPlayers:     t.totalPlayers,
    remainingPlayers: tables.reduce((s, tbl) => s + tbl.players.length, 0),
    startingChips:    t.startingChips,
    blind: {
      level:              lv.level,
      sb:                 lv.sb,
      bb:                 lv.bb,
      smallBet:           lv.smallBet,
      bigBet:             lv.bigBet,
      isLastLevel:        lv.durationMinutes === 0,
      secondsToNextLevel,
      nextSb:             nextLv?.sb  ?? null,
      nextBb:             nextLv?.bb  ?? null,
    },
    eliminationOrder: t.eliminationOrder,
    tables,
  });
});

// ===== GET /api/admin/monitor/tournaments/:tournamentId/tables/:tableId =====
router.get('/tournaments/:tournamentId/tables/:tableId', (req, res) => {
  const t = getTournament(req.params.tournamentId);
  if (!t) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });
  const snap = _tableSnapshot(req.params.tableId);
  if (!snap) return res.status(404).json({ error: 'TABLE_NOT_FOUND' });
  res.json(snap);
});

// ===== POST /api/admin/monitor/tournaments/:tournamentId/forceFinish =====
router.post('/tournaments/:tournamentId/forceFinish', (req, res) => {
  const t = getTournament(req.params.tournamentId);
  if (!t) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });
  if (t.status !== 'running') return res.status(400).json({ error: 'NOT_RUNNING' });

  console.log(`[adminMonitor] forceFinish tournament ${t.id} by admin ${req.adminId}`);
  // ステータスを finished に強制変更（_finishTournament は tournamentManager 内部関数のため
  // ここでは status を直接変えるのではなく、全プレイヤーを脱落させて自然終了させる）
  // 簡易実装: running の全テーブルからプレイヤーを強制退場
  for (const tableId of [...t.tableIds]) {
    const room = getOrCreateRoom(tableId);
    if (!room) continue;
    for (const p of [...room.players]) {
      handleForcedLeave(tableId, p.id, 'admin-force-finish');
    }
  }
  res.json({ ok: true, message: 'Force finish initiated' });
});

// ===== POST /api/admin/monitor/tables/:tableId/kickPlayer =====
router.post('/tables/:tableId/kickPlayer', (req, res) => {
  const { tableId } = req.params;
  const { playerId } = req.body ?? {};
  if (!playerId) return res.status(400).json({ error: 'PLAYER_ID_REQUIRED' });

  if (!isTournamentTable(tableId)) {
    // 通常テーブルの場合は単純退室
    leaveRoom(tableId, playerId);
    return res.json({ ok: true, message: 'Player removed from normal table' });
  }

  console.log(`[adminMonitor] kickPlayer ${playerId} from ${tableId} by admin ${req.adminId}`);
  handleForcedLeave(tableId, playerId, 'admin-kick');
  res.json({ ok: true, message: 'Player force-eliminated from tournament' });
});

// ===== POST /api/admin/monitor/tournaments/:tournamentId/start =====
// DB の entries を読んで tournamentManager.startTournament を呼ぶ
router.post('/tournaments/:tournamentId/start', async (req, res) => {
  const { tournamentId } = req.params;

  // メモリ上ですでに running なら拒否
  const inMem = getTournament(tournamentId);
  if (inMem) {
    return res.status(400).json({ error: 'ALREADY_RUNNING' });
  }

  try {
    // DB からトーナメント情報と参加者を取得
    const dbTournament = await getTournamentDB(tournamentId);
    if (!dbTournament) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });

    // registering または running（DBだけrunningでメモリにない）なら開始可
    if (!['registering', 'running'].includes(dbTournament.status)) {
      return res.status(400).json({ error: 'INVALID_STATUS', status: dbTournament.status });
    }

    const entries = await getEntries(tournamentId);
    // 管理者による手動開始は1人でも許可（BOT追加でテスト可能）
    // 自動スケジューラは2人以上を要求するが、手動開始は1人から許可する
    if (entries.length < 1) {
      return res.status(400).json({ error: 'NOT_ENOUGH_PLAYERS', count: entries.length });
    }

    // DB ステータスを running に更新
    await updateTournamentStatus(tournamentId, 'running');

    // プレイヤー一覧を構築
    const players = entries.map(e => ({
      accountId: e.account_id,
      nickname:  e.nickname ?? e.google_name ?? e.account_id.slice(0, 8),
    }));

    // ブラインドスケジュール（DB の levels カラムを使う）
    const scheduleData = dbTournament.blind_levels ?? null;

    // tournamentManager でトーナメント開始
    const tournament = startTournament({
      id:            tournamentId,
      name:          dbTournament.name,
      mode:          dbTournament.mode,
      startingChips: dbTournament.starting_chips,
      scheduleId:    dbTournament.blind_schedule_id ?? 'default',
      players,
      scheduleData,
    });

    if (!tournament) {
      return res.status(500).json({ error: 'START_FAILED' });
    }

    console.log(`[adminMonitor] tournament ${tournamentId} started by admin ${req.adminId} (${players.length} players)`);

    // 全クライアントに開始通知（グローバルブロードキャスト）
    // クライアントは t:tournamentStarting を受け取り joinRoom を送る
    if (_io) {
      for (const tableId of tournament.tableIds) {
        _io.emit('t:tournamentStarting', { tournamentId, tableId });
      }
    }

    res.json({
      ok:         true,
      tournamentId,
      tableCount: tournament.tableIds.length,
      playerCount: players.length,
    });
  } catch (err) {
    console.error('[adminMonitor] start error:', err.message);
    res.status(500).json({ error: 'SERVER_ERROR', detail: err.message });
  }
});

// ==========================================================
// ■ リングボット管理 API
// ==========================================================
const ringBotManager = require('./ringBotManager');

/** GET /api/admin/monitor/bots — ボット一覧（リング + FastFold） */
router.get('/bots', (req, res) => {
  res.json({
    bots:         ringBotManager.listBots(),
    fastFoldBots: ringBotManager.listFastFoldBots(),
  });
});

/** POST /api/admin/monitor/fastfold-bots — FastFoldボット追加 */
router.post('/fastfold-bots', (req, res) => {
  const { poolId, count = 1 } = req.body;
  const VALID_POOLS = ['zoom-27', 'zoom-badugi', 'zoom-mix'];
  if (!poolId || !VALID_POOLS.includes(poolId)) {
    return res.status(400).json({ error: `poolId は ${VALID_POOLS.join(' / ')} のいずれかです` });
  }
  const n = Math.min(Math.max(1, parseInt(count) || 1), 6);
  const added = ringBotManager.addFastFoldBots(poolId, n);
  console.log(`[adminMonitor] FastFoldボット ${n}体 追加 → ${poolId} by ${req.adminId}`);
  res.json({ ok: true, added });
});

/** DELETE /api/admin/monitor/fastfold-bots — FastFoldボット全削除 */
router.delete('/fastfold-bots', (req, res) => {
  const { poolId } = req.body;
  if (!poolId) return res.status(400).json({ error: 'poolId は必須です' });
  const count = ringBotManager.removeFastFoldBots(poolId);
  console.log(`[adminMonitor] FastFoldボット ${count}体 全削除 → ${poolId} by ${req.adminId}`);
  res.json({ ok: true, removed: count });
});

/** POST /api/admin/monitor/bots — ボット追加 */
router.post('/bots', (req, res) => {
  const { roomId, count = 1 } = req.body;
  if (!roomId || typeof roomId !== 'string') {
    return res.status(400).json({ error: 'roomId は必須です' });
  }
  const n = Math.min(Math.max(1, parseInt(count) || 1), 6);
  const added = ringBotManager.addBots(roomId, n);
  console.log(`[adminMonitor] ボット ${n}体 追加 → ${roomId} by ${req.adminId}`);
  res.json({ ok: true, added });
});

/** DELETE /api/admin/monitor/bots/:botId — ボット個別削除 */
router.delete('/bots/:botId', (req, res) => {
  const botId = parseInt(req.params.botId);
  const ok = ringBotManager.removeBot(botId);
  if (!ok) return res.status(404).json({ error: 'ボットが見つかりません' });
  console.log(`[adminMonitor] ボット ${botId} 削除 by ${req.adminId}`);
  res.json({ ok: true });
});

/** PATCH /api/admin/monitor/bots/:botId — リングボット名変更 */
router.patch('/bots/:botId', (req, res) => {
  const botId = parseInt(req.params.botId);
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '名前は必須です' });
  }
  const newName = name.trim().slice(0, 20);
  const ok = ringBotManager.renameBot(botId, newName);
  if (!ok) return res.status(404).json({ error: 'ボットが見つかりません' });
  console.log(`[adminMonitor] リングボット #${botId} → "${newName}" by ${req.adminId}`);
  res.json({ ok: true, name: newName });
});

/** PATCH /api/admin/monitor/tournament-bots/:tournamentId/rename — トーナメントBOT名変更 */
router.patch('/tournament-bots/:tournamentId/rename', (req, res) => {
  const { tableId, botId, name } = req.body;
  if (!tableId || !botId || !name?.trim()) {
    return res.status(400).json({ error: 'tableId / botId / name は必須です' });
  }
  const newName = name.trim().slice(0, 20);
  const { renamePlayer } = require('./poker/gameManager');
  const ok = renamePlayer(tableId, botId, newName);
  if (!ok) return res.status(404).json({ error: 'BOTが見つかりません' });
  console.log(`[adminMonitor] トーナメントBOT ${botId} → "${newName}" by ${req.adminId}`);
  res.json({ ok: true, name: newName });
});
router.delete('/bots', (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ error: 'roomId は必須です' });
  const count = ringBotManager.removeAllBots(roomId);
  console.log(`[adminMonitor] ${roomId} のボット ${count}体 全削除 by ${req.adminId}`);
  res.json({ ok: true, removed: count });
});

// ==========================================================
// ■ トーナメントBOT管理 API
// ==========================================================
const tbm = require('./tournament/tournamentBotManager');

/**
 * GET /api/admin/monitor/tournament-bots/:tournamentId
 * トーナメントの全テーブルのBOT一覧を返す
 */
router.get('/tournament-bots/:tournamentId', (req, res) => {
  const t = getTournament(req.params.tournamentId);
  if (!t) return res.status(404).json({ error: 'トーナメントが見つかりません（未開始または終了済み）' });

  const { getOrCreateRoom } = require('./poker/gameManager');
  const tables = t.tableIds.map(tableId => {
    const room = getOrCreateRoom(tableId);
    const bots = (room?.players ?? [])
      .filter(p => p.id.startsWith('tbot::'))
      .map(p => ({ id: p.id, name: p.name, chips: p.chips, tableId }));
    return { tableId, playerCount: room?.players?.length ?? 0, bots };
  });

  res.json({ tournamentId: t.id, name: t.name, tables });
});

/**
 * POST /api/admin/monitor/tournament-bots/:tournamentId/add
 * body: { tableId?, count? }
 * tableId 省略時は全テーブルに追加
 */
router.post('/tournament-bots/:tournamentId/add', (req, res) => {
  const { tableId, count = 1 } = req.body;
  const tournament = getTournament(req.params.tournamentId);
  if (!tournament) return res.status(404).json({ error: 'トーナメントが見つかりません' });

  // テーブル数 × 最大6人 = 複数テーブル分を一度に追加できるよう上限を30に拡大
  const n = Math.min(Math.max(1, parseInt(count) || 1), 30);
  const targets = tableId ? [tableId] : tournament.tableIds;
  const added = [];

  const { getOrCreateRoom } = require('./poker/gameManager');
  for (const tid of targets) {
    if (!tournament.tableIds.includes(tid)) continue;
    const room = getOrCreateRoom(tid);
    if (!room) continue;
    const existingNames = room.players.map(p => p.name);
    for (let i = 0; i < n; i++) {
      if (room.players.length >= (room.maxPlayers ?? 6)) break;
      try {
        const botId = tbm.spawnBot(tid, _pickBotName(existingNames), tournament.startingChips);
        const spawned = room.players.find(p => p.id === botId);
        if (spawned) { existingNames.push(spawned.name); added.push({ tableId: tid, name: spawned.name }); }
      } catch (e) {
        console.error('[adminMonitor] spawnBot error:', e.message);
      }
    }
  }

  console.log(`[adminMonitor] トーナメント ${req.params.tournamentId} にBOT ${added.length}体 追加 by ${req.adminId}`);

  // 追加後にゲーム状態をブロードキャスト
  for (const tid of (tableId ? [tableId] : tournament.tableIds)) {
    broadcastTableState(tid);
  }

  res.json({ ok: true, added });
});

/**
 * DELETE /api/admin/monitor/tournament-bots/:tournamentId/remove
 * body: { tableId?, botId? }
 * botId 指定時は個別削除、tableId のみ指定時は該当テーブルの全BOT削除、両方省略時は全テーブルの全BOT削除
 */
router.delete('/tournament-bots/:tournamentId/remove', (req, res) => {
  const { tableId, botId } = req.body ?? {};
  const tournament = getTournament(req.params.tournamentId);
  if (!tournament) return res.status(404).json({ error: 'トーナメントが見つかりません' });

  const { leaveRoom, getOrCreateRoom } = require('./poker/gameManager');
  let removed = 0;

  if (botId) {
    // 個別削除
    const room = tableId ? getOrCreateRoom(tableId) : null;
    const targetTable = tableId ?? tournament.tableIds.find(tid => {
      const r = getOrCreateRoom(tid);
      return r?.players.some(p => p.id === botId);
    });
    if (targetTable) {
      leaveRoom(botId);
      removed = 1;
    }
  } else {
    // テーブルまたは全体の全BOT削除
    const targets = tableId ? [tableId] : tournament.tableIds;
    for (const tid of targets) {
      tbm.removeBots(tid);
      removed++;
    }
  }

  console.log(`[adminMonitor] トーナメント ${req.params.tournamentId} BOT削除 (${removed}) by ${req.adminId}`);
  res.json({ ok: true, removed });
});

// BOT名ピッカー（tournamentBotManager の内部ロジックを再利用）
const _tBotNames = [
  'Dealer-Dan', 'Poker-Pete', 'Lucky-Lou', 'Bluff-Bill',
  'Ace-Anna', 'Check-Chris', 'Raise-Ray', 'Call-Carl',
  'Fold-Frank', 'Bet-Betty', 'River-Rita', 'Flop-Fred',
  'All-In-Al', 'Slow-Play-Sam', 'Tight-Tom', 'Loose-Liz',
  'Squeeze-Sue', 'Cold-Call-Cole', 'Triple-Tim', 'Badugi-Bob',
  'Draw-Dave', 'Showdown-Shawn', 'Pot-Pam', 'Chip-Chuck',
  'Stack-Steve', 'Blind-Bud', 'Turn-Terry', 'River-Rex',
  'Nuts-Nancy', 'Flush-Fiona',
];
function _pickBotName(existingNames) {
  const used = new Set(existingNames);
  for (const name of _tBotNames) {
    if (!used.has(name)) return name;
  }
  return `TBot-${Date.now()}`;
}

module.exports = { router, setIo };
