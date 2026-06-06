const { log, logDev } = require('./logger');

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
const { createHmac, timingSafeEqual } = require('crypto');
const { isAdmin } = require('./db/admin');
const {
  getTournament,
  getTournamentByTable,
  isTournamentTable,
  handleForcedLeave,
  _broadcastTournamentStatus,
  startTournament,
  broadcastTableState,
  addTableToTournament,
  incrementTotalPlayers,
} = require('./tournament/tournamentManager');
const { getOrCreateRoom, getAllRooms, leaveRoom, canAutoStart, startGame, ensurePotsAwarded } = require('./poker/gameManager');
const { getTournament: getTournamentDB, getEntries } = require('./db/tournament');
const { updateTournamentStatus } = require('./db/admin');

const router = express.Router();

// io インスタンス（index.js から setIo() で注入）
let _io = null;
function setIo(io) { _io = io; }

// 事前BOT予約マップ: tournamentId → count
// DBのFOREIGN KEY制約を避けてメモリで管理
const _preBotReservations = new Map();

/**
 * BOT追加後にwaitingまたはshowdown状態のテーブルをゲーム開始させる。
 * index.js の _tryAutoStart / _scheduleAutoStart を外部から注入して使う。
 */
let _tryAutoStartFn = null;
let _scheduleAutoStartFn = null;

function injectAutoStartHandlers(tryFn, scheduleFn) {
  _tryAutoStartFn = tryFn;
  _scheduleAutoStartFn = scheduleFn;
}

function _kickstartBotOnlyTables(tableIds) {
  if (!_io || !_tryAutoStartFn) return;
  for (const tid of tableIds) {
    if (canAutoStart(tid)) {
      log(`[adminMonitor] kickstart table ${tid.slice(-8)}`);
      _tryAutoStartFn(_io, tid);
    }
  }
}

// ===== 管理者認証ミドルウェア =====
function verifySocketToken(token) {
  if (typeof token !== 'string' || !token.startsWith('socket:')) return null;
  const body = token.slice('socket:'.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  const expected = createHmac('sha256', process.env.NEXTAUTH_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded?.accountId || typeof decoded.accountId !== 'string') return null;
    if (!Number.isFinite(decoded.exp) || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });

    const decoded = verifySocketToken(token);
    if (!decoded?.accountId) return res.status(401).json({ error: 'INVALID_TOKEN' });

    const admin = await isAdmin(decoded.accountId);
    if (!admin) return res.status(403).json({ error: 'FORBIDDEN' });

    req.adminId = decoded.accountId;
    next();
  } catch (err) {
    log('[adminMonitor] auth error:', err.message);
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

  log(`[adminMonitor] forceFinish tournament ${t.id} by admin ${req.adminId}`);
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
    leaveRoom(playerId);
    return res.json({ ok: true, message: 'Player removed from normal table' });
  }

  log(`[adminMonitor] kickPlayer ${playerId} from ${tableId} by admin ${req.adminId}`);
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

    // BOT名プール
    const BOT_NAME_POOL = [
      'Dealer-Dan', 'Poker-Pete', 'Lucky-Lou', 'Bluff-Bill',
      'Ace-Anna', 'Check-Chris', 'Raise-Ray', 'Call-Carl',
      'Fold-Frank', 'Bet-Betty', 'Slow-Sam', 'Tight-Tom',
    ];
    let botNameIdx = 0;

    // プレイヤー一覧（全エントリーが人間）
    const players = entries.map(e => ({
      accountId: e.account_id,
      nickname:  e.nickname ?? e.google_name ?? e.account_id.slice(0, 8),
    }));

    // ブラインドスケジュール（DB の levels カラムを使う）
    // postgres.js は JSONB を自動パースするが、二重エンコードで文字列になる場合があるため
    // safeParseArray で確実に配列に変換する
    const safeParseArray = (raw) => {
      if (!raw) return null;
      if (Array.isArray(raw)) return raw;
      try {
        let parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        return Array.isArray(parsed) ? parsed : null;
      } catch { return null; }
    };
    const scheduleData = safeParseArray(dbTournament.blind_levels);

    // tournamentManager でトーナメント開始
    log(`[adminMonitor] manual start: calling startTournament for ${tournamentId.slice(-8)} (${players.length} players)`);
    const tournament = startTournament({
      id:               tournamentId,
      name:             dbTournament.name,
      mode:             dbTournament.mode,
      startingChips:    dbTournament.starting_chips,
      scheduleId:       dbTournament.blind_schedule_id ?? 'default',
      players,
      scheduleData,
      lateLevelCutoff:  dbTournament.blind_late_level_cutoff ?? 0,
      lateRegMinutes:   dbTournament.late_reg_minutes ?? 0,
    });

    if (!tournament) {
      return res.status(500).json({ error: 'START_FAILED' });
    }

    log(`[adminMonitor] tournament ${tournamentId} started by admin ${req.adminId} (${players.length} players)`);

    // 事前予約BOT（_preBotReservationsマップから取得）をspawnBotで配置
    const preBotCount = _preBotReservations.get(tournamentId) ?? 0;
    if (preBotCount > 0 && tournament) {
      const { getOrCreateRoom } = require('./poker/gameManager');
      const usedNames = new Set(players.map(p => p.nickname));
      let spawned = 0;
      for (let i = 0; i < preBotCount; i++) {
        const baseName = BOT_NAME_POOL[botNameIdx % BOT_NAME_POOL.length];
        botNameIdx++;
        // 同名が既にいる場合は番号を付けてユニーク化（例: Dealer-Dan-2）
        let botName = baseName;
        let suffix = 2;
        while (usedNames.has(botName)) {
          botName = `${baseName}-${suffix++}`;
        }
        // 空きがある最小テーブルを探す
        let targetTid = tournament.tableIds
          .map(tid => ({ tid, cnt: (getOrCreateRoom(tid)?.players.length ?? 0) + (getOrCreateRoom(tid)?.pendingPlayers.length ?? 0) }))
          .filter(x => x.cnt < 6)
          .sort((a, b) => a.cnt - b.cnt)[0]?.tid;
        // 全テーブルが満席なら新テーブルを追加
        if (!targetTid) {
          targetTid = addTableToTournament(tournamentId);
          if (targetTid) logDev(`[adminMonitor] pre-bot: added new table ${targetTid.slice(-8)}`);
        }
        if (targetTid) {
          tbm.spawnBot(targetTid, botName, dbTournament.starting_chips);
          usedNames.add(botName);
          spawned++;
        }
      }
      incrementTotalPlayers(tournamentId, spawned);
      _preBotReservations.delete(tournamentId);
      log(`[adminMonitor] spawned ${spawned}/${preBotCount} pre-reserved BOTs`);
    }

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
    log('[adminMonitor] start error:', err.message);
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
  const n = Math.min(Math.max(1, parseInt(count) || 1), 20);
  const added = ringBotManager.addFastFoldBots(poolId, n);
  log(`[adminMonitor] FastFoldボット ${n}体 追加 → ${poolId} by ${req.adminId}`);
  res.json({ ok: true, added });
});

/** DELETE /api/admin/monitor/fastfold-bots — FastFoldボット全削除 */
router.delete('/fastfold-bots', (req, res) => {
  const { poolId } = req.body;
  if (!poolId) return res.status(400).json({ error: 'poolId は必須です' });
  const count = ringBotManager.removeFastFoldBots(poolId);
  log(`[adminMonitor] FastFoldボット ${count}体 全削除 → ${poolId} by ${req.adminId}`);
  res.json({ ok: true, removed: count });
});

/** POST /api/admin/monitor/bots — ボット追加 */
router.post('/bots', (req, res) => {
  const { roomId, count = 1 } = req.body;
  if (!roomId || typeof roomId !== 'string') {
    return res.status(400).json({ error: 'roomId は必須です' });
  }
  const n = Math.min(Math.max(1, parseInt(count) || 1), 20);
  const added = ringBotManager.addBots(roomId, n);
  log(`[adminMonitor] ボット ${n}体 追加 → ${roomId} by ${req.adminId}`);
  res.json({ ok: true, added });
});

/** DELETE /api/admin/monitor/bots/:botId — ボット個別削除 */
router.delete('/bots/:botId', (req, res) => {
  const botId = parseInt(req.params.botId);
  const ok = ringBotManager.removeBot(botId);
  if (!ok) return res.status(404).json({ error: 'ボットが見つかりません' });
  log(`[adminMonitor] ボット ${botId} 削除 by ${req.adminId}`);
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
  log(`[adminMonitor] リングボット #${botId} → "${newName}" by ${req.adminId}`);
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
  log(`[adminMonitor] トーナメントBOT ${botId} → "${newName}" by ${req.adminId}`);
  res.json({ ok: true, name: newName });
});
router.delete('/bots', (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ error: 'roomId は必須です' });
  const count = ringBotManager.removeAllBots(roomId);
  log(`[adminMonitor] ${roomId} のボット ${count}体 全削除 by ${req.adminId}`);
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
 * tableId 指定時: そのテーブルのみにcount体追加
 * tableId 省略時: 全テーブルに均等にcount体ずつ追加（各テーブルの空き枠を考慮）
 */
router.post('/tournament-bots/:tournamentId/add', (req, res) => {
  const { tableId, count = 1 } = req.body;
  const tournament = getTournament(req.params.tournamentId);
  if (!tournament) return res.status(404).json({ error: 'トーナメントが見つかりません' });

  // tableId指定時: そのテーブルのみにcount体追加
  // tableId省略時: count体を全テーブルに均等配分（ラウンドロビン）
  const totalN = Math.min(Math.max(1, parseInt(count) || 1), 500);
  const targets = tableId ? [tableId] : tournament.tableIds;
  const added = [];

  const { getOrCreateRoom } = require('./poker/gameManager');
  
  if (tableId) {
    // 特定テーブルに追加
    const room = getOrCreateRoom(tableId);
    if (room && tournament.tableIds.includes(tableId)) {
      const existingNames = room.players.map(p => p.name);
      for (let i = 0; i < totalN; i++) {
        const totalSeated = room.players.length + (room.pendingPlayers?.length ?? 0);
        if (totalSeated >= (room.maxPlayers ?? 6)) break;
        try {
          const botId = tbm.spawnBot(tableId, _pickBotName(existingNames), tournament.startingChips);
          const spawned = room.players.find(p => p.id === botId) ?? room.pendingPlayers?.find(p => p.id === botId);
          if (spawned) { existingNames.push(spawned.name); added.push({ tableId, name: spawned.name }); }
        } catch (e) { log('[adminMonitor] spawnBot error:', e.message); }
      }
    }
  } else {
    // 全テーブルにラウンドロビンで均等配分
    // テーブルが足りない場合は自動で新テーブルを作成
    const MAX_TABLES = 100; // 安全上限
    const tableStates = tournament.tableIds
      .map(tid => {
        const room = getOrCreateRoom(tid);
        return { tid, room, existingNames: room ? room.players.map(p => p.name) : [] };
      })
      .filter(t => t.room);

    for (let i = 0; i < totalN; i++) {
      const maxPerTable = 6;
      // 空きがあるテーブルを探す
      let target = tableStates
        .filter(t => t.room.players.length + (t.room.pendingPlayers?.length ?? 0) < maxPerTable)
        .sort((a, b) => (a.room.players.length + (a.room.pendingPlayers?.length ?? 0)) - (b.room.players.length + (b.room.pendingPlayers?.length ?? 0)))[0];

      // 全テーブルが満席かつ上限未満なら新テーブルを作成
      if (!target && tournament.tableIds.length < MAX_TABLES) {
        const newTid = addTableToTournament(req.params.tournamentId);
        if (newTid) {
          const newRoom = getOrCreateRoom(newTid);
          if (newRoom) {
            const newState = { tid: newTid, room: newRoom, existingNames: [] };
            tableStates.push(newState);
            target = newState;
            // 新テーブルへのjoin通知をbroadcast
            broadcastTableState(newTid);
          }
        }
      }

      if (!target) break; // これ以上追加不可
      try {
        const botId = tbm.spawnBot(target.tid, _pickBotName(target.existingNames), tournament.startingChips);
        const spawned = target.room.players.find(p => p.id === botId) ?? target.room.pendingPlayers?.find(p => p.id === botId);
        if (spawned) { target.existingNames.push(spawned.name); added.push({ tableId: target.tid, name: spawned.name }); }
      } catch (e) { log('[adminMonitor] spawnBot error:', e.message); }
    }
  }

  // BOT追加分をtotalPlayersに反映（開始後に追加したBOTはtotalPlayersに含まれていないため）
  if (added.length > 0) incrementTotalPlayers(req.params.tournamentId, added.length);
  log(`[adminMonitor] トーナメント ${req.params.tournamentId} にBOT ${added.length}体 追加 by ${req.adminId}`);

  // 追加後にゲーム状態をブロードキャスト
  for (const tid of (tableId ? [tableId] : tournament.tableIds)) {
    broadcastTableState(tid);
  }

  // waiting 状態のテーブルにBOTが揃った場合はゲームを開始させる
  // （adminMonitorはindex.jsの_tryAutoStartを呼べないためここで代替処理）
  const tablesToKickstart = (tableId ? [tableId] : tournament.tableIds)
    .filter(tid => canAutoStart(tid));
  if (tablesToKickstart.length > 0) {
    setTimeout(() => _kickstartBotOnlyTables(tablesToKickstart), 500);
  }

  res.json({ ok: true, added });
});

/**
 * POST /api/admin/monitor/tournament-bots/:tournamentId/pre-add
 * registering 状態のトーナメントにBOTを事前登録する（メモリ管理）
 * body: { count }
 * DBのFOREIGN KEY制約を避けるため、メモリ上のMapで予約数を管理する
 * 開始時に startTournament の直後に spawnBot で配置される
 */
router.post('/tournament-bots/:tournamentId/pre-add', async (req, res) => {
  const { count = 1 } = req.body;
  const tournamentId = req.params.tournamentId;
  const totalN = Math.min(Math.max(1, parseInt(count) || 1), 500);

  try {
    // ファイルトップのgetEntries等と同じ getTournamentDB を使用
    const dbTournament = await getTournamentDB(tournamentId);
    if (!dbTournament) return res.status(404).json({ error: 'TOURNAMENT_NOT_FOUND' });
    log(`[pre-add] tournament ${tournamentId} status=${dbTournament.status}`);
    // 既にメモリ上でrunning（startTournament済み）なら /add を使う
    const alreadyRunning = !!getTournament(tournamentId);
    if (alreadyRunning) {
      return res.status(400).json({ error: 'ALREADY_RUNNING', hint: 'use /add for running tournaments' });
    }
    // DB status が registering か running（まだメモリにロードされていない）なら予約可能
    if (!['registering', 'running'].includes(dbTournament.status)) {
      return res.status(400).json({ error: 'INVALID_STATUS', currentStatus: dbTournament.status });
    }

    // メモリ上の予約マップに追加
    const current = _preBotReservations.get(tournamentId) ?? 0;
    const newTotal = current + totalN;
    _preBotReservations.set(tournamentId, newTotal);

    log(`[adminMonitor] pre-reserved ${totalN} BOTs for ${tournamentId} (total: ${newTotal})`);
    res.json({ ok: true, added: Array.from({ length: totalN }, (_, i) => ({ name: `BOT-${current + i + 1}` })), totalBots: newTotal, humanPlayers: 0 });

    // Sit & Go: BOT 追加後に参加人数チェックを再実行
    // （人間が先に登録済みでも BOT 追加で min_players を満たす場合がある）
    if (dbTournament.is_sit_and_go) {
      const { triggerSitAndGoCheck } = require('./tournament/tournamentManager');
      triggerSitAndGoCheck(tournamentId).catch(() => {});
    }
  } catch (err) {
    log(`[adminMonitor] pre-add-bots error: ${err.message}`);
    res.status(500).json({ error: 'SERVER_ERROR', detail: err.message });
  }
});

/**
 * GET /api/admin/monitor/tournament-bots/:tournamentId/pre-count
 * 事前登録BOT数を返す
 */
router.get('/tournament-bots/:tournamentId/pre-count', (req, res) => {
  const count = _preBotReservations.get(req.params.tournamentId) ?? 0;
  res.json({ count });
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

  log(`[adminMonitor] トーナメント ${req.params.tournamentId} BOT削除 (${removed}) by ${req.adminId}`);
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

module.exports = {
  router,
  setIo,
  injectAutoStartHandlers,
  getPreBotCount: (tournamentId) => _preBotReservations.get(tournamentId) ?? 0,
  /**
   * 事前予約BOTをspawnする共通関数（手動開始・自動開始どちらからも呼べる）
   */
  async spawnPreReservedBots(io, tournamentId, dbTournament) {
    const tid = tournamentId.slice(-8);
    const preBotCount = _preBotReservations.get(tournamentId) ?? 0;
    log(`[adminMonitor] spawnPreReservedBots called: preBotCount=${preBotCount}`);
    if (preBotCount <= 0) {
      log(`[adminMonitor] ${tid}: no pre-reserved BOTs → skip spawn`);
      return;
    }

    const { getTournament, addTableToTournament, incrementTotalPlayers } = require('./tournament/tournamentManager');
    const tournament = getTournament(tournamentId);
    if (!tournament) {
      log(`[adminMonitor] ${tid}: tournament not in memory → skip spawn`);
      return;
    }

    const { getOrCreateRoom } = require('./poker/gameManager');
    const entries = tournament.players ? tournament.players.map(p => p.nickname) : [];
    const usedNames = new Set(entries);
    const BOT_NAME_POOL = [
      'Dealer-Dan', 'Poker-Pete', 'Lucky-Lou', 'Bluff-Bill',
      'Ace-Anna', 'Check-Chris', 'Raise-Ray', 'Call-Carl',
      'Fold-Frank', 'Bet-Betty', 'Slow-Sam', 'Tight-Tom',
    ];
    let botNameIdx = 0;
    let spawned = 0;

    for (let i = 0; i < preBotCount; i++) {
      const baseName = BOT_NAME_POOL[botNameIdx % BOT_NAME_POOL.length];
      botNameIdx++;
      let botName = baseName;
      let suffix = 2;
      while (usedNames.has(botName)) { botName = `${baseName}-${suffix++}`; }

      let targetTid = tournament.tableIds
        .map(tid => ({ tid, cnt: (getOrCreateRoom(tid)?.players.length ?? 0) + (getOrCreateRoom(tid)?.pendingPlayers.length ?? 0) }))
        .filter(x => x.cnt < 6)
        .sort((a, b) => a.cnt - b.cnt)[0]?.tid;
      if (!targetTid) {
        targetTid = addTableToTournament(tournamentId);
        if (targetTid) logDev(`[adminMonitor] pre-bot: added new table ${targetTid.slice(-8)}`);
      }
      if (targetTid) {
        tbm.spawnBot(targetTid, botName, dbTournament.starting_chips);
        usedNames.add(botName);
        spawned++;
      }
    }

    incrementTotalPlayers(tournamentId, spawned);
    _preBotReservations.delete(tournamentId);
    log(`[adminMonitor] spawned ${spawned}/${preBotCount} pre-reserved BOTs`);

    // kickstart
    if (io) {
      const { canAutoStart } = require('./poker/gameManager');
      for (const tableId of tournament.tableIds) {
        if (canAutoStart(tableId)) {
          log(`[adminMonitor] kickstart table ${tableId.slice(-8)}`);
          if (_tryAutoStartFn) _tryAutoStartFn(io, tableId);
        }
      }
    }
  },
};
