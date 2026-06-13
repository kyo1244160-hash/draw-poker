/**
 * Temporary Socket.IO load-test runner for admin use.
 *
 * Modes:
 * - connect:          open Socket.IO connections only.
 * - spectate:         subscribe as spectators and receive gameState.
 * - tournament-player: register temporary bot accounts, join the tournament,
 *                      and play simple automatic actions through Socket.IO.
 */

const { io: createClient } = require('socket.io-client');
const sql = require('../db/client');
const { registerEntry } = require('../db/tournament');

const MAX_LOGS = 2000;
const DEFAULT_RAMP_MS = 200;
const DEFAULT_DURATION_SEC = 300;
const BET_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);

const runs = new Map();

function _now() {
  return new Date().toISOString();
}

function _clipLogs(logs) {
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

function _safeNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function _makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `load-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function _log(run, type, data = {}) {
  const event = {
    ts: _now(),
    runId: run.id,
    type,
    ...data,
  };
  run.logs.push(event);
  _clipLogs(run.logs);
  return event;
}

function _snapshotRun(run) {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    config: run.config,
    metrics: {
      ...run.metrics,
      active: [...run.bots.values()].filter((b) => b.connected).length,
      sockets: run.bots.size,
      uptimeMs: run.startedAt ? Date.now() - run.startedAtMs : 0,
    },
    recentLogs: run.logs.slice(-80),
  };
}

function _summaryMarkdown(run) {
  const snap = _snapshotRun(run);
  const errors = run.logs.filter((l) => l.type.includes('error') || l.type === 'disconnect').slice(-20);
  const states = run.logs.filter((l) => l.type === 'game_state').slice(-10);
  const actions = run.logs.filter((l) => l.type === 'action_emit').slice(-20);
  return [
    '# Load Test Report',
    '',
    `runId: ${run.id}`,
    `status: ${snap.status}`,
    `targetUrl: ${run.config.targetUrl}`,
    `mode: ${run.config.mode}`,
    `count: ${run.config.count}`,
    `tableId: ${run.config.tableId || '-'}`,
    `tournamentId: ${run.config.tournamentId || '-'}`,
    `durationSec: ${run.config.durationSec}`,
    '',
    '## Summary',
    `- connected: ${snap.metrics.connected}`,
    `- connectFailed: ${snap.metrics.connectFailed}`,
    `- disconnected: ${snap.metrics.disconnected}`,
    `- active: ${snap.metrics.active}`,
    `- gameStateReceived: ${snap.metrics.gameStateReceived}`,
    `- tournamentRegistered: ${snap.metrics.tournamentRegistered ?? 0}`,
    `- tableJoins: ${snap.metrics.tableJoins ?? 0}`,
    `- actionsSent: ${snap.metrics.actionsSent ?? 0}`,
    `- actionErrors: ${snap.metrics.actionErrors ?? 0}`,
    `- avgLatencyMs: ${snap.metrics.avgLatencyMs ?? '-'}`,
    `- maxLatencyMs: ${snap.metrics.maxLatencyMs ?? '-'}`,
    `- errors: ${snap.metrics.errors}`,
    '',
    '## Recent State Samples',
    '```jsonl',
    ...states.map((e) => JSON.stringify(e)),
    '```',
    '',
    '## Recent Action Samples',
    '```jsonl',
    ...actions.map((e) => JSON.stringify(e)),
    '```',
    '',
    '## Recent Error Samples',
    '```jsonl',
    ...errors.map((e) => JSON.stringify(e)),
    '```',
  ].join('\n');
}

function _updateLatency(run, latencyMs) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  run.metrics.latencySamples += 1;
  run.metrics.latencyTotalMs += latencyMs;
  run.metrics.avgLatencyMs = Math.round(run.metrics.latencyTotalMs / run.metrics.latencySamples);
  run.metrics.maxLatencyMs = Math.max(run.metrics.maxLatencyMs ?? 0, latencyMs);
}

function _isBetPhase(phase) {
  return typeof phase === 'string' && (phase.startsWith('bet') || BET_PHASES.has(phase));
}

function _isDrawPhase(phase) {
  return typeof phase === 'string' && phase.startsWith('draw');
}

function _safeActionAmount(action, self, meta) {
  if (action !== 'bet' && action !== 'raise') return undefined;
  if (self?.isNL) {
    const amount = (meta?.currentBet ?? 0) <= 0 ? self.minBet : self.minRaiseTotal;
    return Number.isFinite(amount) && amount > 0 ? amount : undefined;
  }
  const options = Array.isArray(self?.betSizeOptions) ? self.betSizeOptions.filter((n) => Number.isFinite(n) && n > 0) : [];
  if (options.length > 1) return options[0];
  return undefined;
}

function _decideBetAction(self, meta) {
  if (!self || self.isAllIn) return { action: self?.canCheck ? 'check' : 'call' };
  if (self.mustBringIn) return { action: 'bringIn' };

  const toCall = Math.max(0, Number(self.toCall ?? 0));
  const canCheck = !!self.canCheck || toCall <= 0;
  const canRaise = !!self.canRaise;
  let action;

  if (toCall > 0) {
    if (canRaise && Math.random() < 0.08) action = 'raise';
    else action = Math.random() < 0.88 ? 'call' : 'fold';
  } else if (canCheck) {
    action = canRaise && Math.random() < 0.18 ? 'bet' : 'check';
  } else {
    action = 'call';
  }

  return { action, amount: _safeActionAmount(action, self, meta) };
}

function _decideDrawIndices(self, meta) {
  const hand = Array.isArray(self?.hand) ? self.hand : [];
  const visible = hand.map((code, i) => ({ code, i })).filter((c) => c.code && c.code !== '??');
  if (visible.length === 0) return [];
  const mode = meta?.currentMode ?? '';
  const maxDiscard = mode === 'badugi' ? 1 : 2;
  const discardCount = Math.random() < 0.25 ? 0 : Math.min(maxDiscard, Math.floor(Math.random() * (maxDiscard + 1)));
  return visible
    .sort(() => Math.random() - 0.5)
    .slice(0, discardCount)
    .map((c) => c.i)
    .sort((a, b) => a - b);
}

function _scheduleTournamentAction(run, bot, payload) {
  const meta = payload?.meta ?? null;
  const players = Array.isArray(payload?.players) ? payload.players : [];
  const self = players.find((p) => p?.isSelf);
  if (!meta || !self || !self.isMyTurn || self.isPendingPlayer || self.folded || self.sittingOut) return;
  const tableId = meta.roomId || bot.tableId || run.config.tableId;
  if (!tableId) return;

  const actionKey = `${tableId}::${meta.handCount ?? 0}::${meta.phase}::${self.bet ?? 0}::${self.toCall ?? 0}`;
  if (bot.pendingActionKey === actionKey) return;
  bot.pendingActionKey = actionKey;

  const delay = 180 + Math.floor(Math.random() * 620);
  setTimeout(() => {
    if (run.status !== 'running' || !bot.socket?.connected) return;
    if (_isDrawPhase(meta.phase)) {
      const indices = _decideDrawIndices(self, meta);
      bot.socket.emit('drawCards', { roomId: tableId, indices });
      run.metrics.actionsSent += 1;
      run.metrics.drawActionsSent += 1;
      _log(run, 'action_emit', { botId: bot.id, tableId, phase: meta.phase, action: 'draw', indices });
      return;
    }
    if (_isBetPhase(meta.phase)) {
      const decision = _decideBetAction(self, meta);
      bot.socket.emit('betAction', { roomId: tableId, action: decision.action, amount: decision.amount });
      run.metrics.actionsSent += 1;
      run.metrics.betActionsSent += 1;
      _log(run, 'action_emit', { botId: bot.id, tableId, phase: meta.phase, action: decision.action, amount: decision.amount ?? null, toCall: self.toCall ?? 0 });
    }
  }, delay);
}

async function _ensureLoadTestAccount(accountId, nickname) {
  const email = `${accountId.replace(/[^a-zA-Z0-9_-]/g, '_')}@loadtest.local`;
  await sql`
    INSERT INTO accounts (id, email, google_name)
    VALUES (${accountId}, ${email}, ${nickname})
    ON CONFLICT (id) DO UPDATE
      SET google_name = EXCLUDED.google_name
  `;
  await sql`
    INSERT INTO profiles (account_id, nickname, change_count)
    VALUES (${accountId}, ${nickname}, 0)
    ON CONFLICT (account_id) DO UPDATE
      SET nickname = EXCLUDED.nickname
  `;
}

async function _prepareTournamentPlayers(run) {
  if (!run.config.tournamentId) {
    const err = new Error('TOURNAMENT_TARGET_REQUIRED');
    err.statusCode = 400;
    throw err;
  }
  const stampPart = run.id.replace(/^load-/, '').slice(10, 14);
  const suffix = run.id.slice(-4);
  for (let i = 0; i < run.config.count; i++) {
    const num = String(i + 1).padStart(3, '0');
    const accountId = `bot_load_${run.id}_${num}`;
    const nickname = `L${stampPart}${suffix}${num}`;
    await _ensureLoadTestAccount(accountId, nickname);
    await registerEntry(run.config.tournamentId, accountId);
    run.players[i] = { accountId, nickname };
    run.metrics.tournamentRegistered += 1;
    _log(run, 'tournament_register', { botId: accountId, nickname, tournamentId: run.config.tournamentId });
  }
  const tm = require('../tournament/tournamentManager');
  if (tm.triggerSitAndGoCheck) {
    tm.triggerSitAndGoCheck(run.config.tournamentId);
    _log(run, 'sng_check_triggered', { tournamentId: run.config.tournamentId, registered: run.metrics.tournamentRegistered });
  }
}

function _createBot(run, index) {
  const prepared = run.players[index] ?? null;
  const botId = prepared?.accountId ?? `loadbot::${run.id}::${String(index + 1).padStart(3, '0')}`;
  const botName = prepared?.nickname ?? `LoadBot-${String(index + 1).padStart(3, '0')}`;
  const startedAt = Date.now();
  const socket = createClient(run.config.targetUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    timeout: 10000,
    auth: {
      loadTest: true,
      botName,
      botId,
      accountId: prepared?.accountId,
      mode: run.config.mode,
    },
  });
  const bot = {
    id: botId,
    name: botName,
    socket,
    connected: false,
    lastEventAt: null,
    gameStateCount: 0,
    tableId: null,
    pendingActionKey: null,
    tableLookupRequestedAt: null,
  };
  run.bots.set(botId, bot);
  _log(run, 'connect_start', { botId, botName });

  socket.on('connect', () => {
    bot.connected = true;
    bot.lastEventAt = Date.now();
    run.metrics.connected += 1;
    _updateLatency(run, Date.now() - startedAt);
    _log(run, 'connect_ok', { botId, socketId: socket.id, latencyMs: Date.now() - startedAt });
    if (run.config.mode === 'spectate') {
      socket.emit('spectate', {
        tableId: run.config.tableId || undefined,
        tournamentId: run.config.tournamentId || undefined,
        loadTest: true,
      });
      _log(run, 'spectate_emit', { botId, tableId: run.config.tableId || null, tournamentId: run.config.tournamentId || null });
    } else if (run.config.mode === 'tournament-player') {
      socket.emit('t:getMyTable', { tournamentId: run.config.tournamentId });
      bot.tableLookupRequestedAt = Date.now();
      _log(run, 'tournament_get_table_emit', { botId, tournamentId: run.config.tournamentId });
    }
  });

  socket.on('connect_error', (err) => {
    run.metrics.connectFailed += 1;
    run.metrics.errors += 1;
    _log(run, 'connect_error', { botId, message: err?.message ?? String(err) });
  });

  socket.on('disconnect', (reason) => {
    if (bot.connected) run.metrics.disconnected += 1;
    bot.connected = false;
    bot.lastEventAt = Date.now();
    _log(run, 'disconnect', { botId, reason });
  });

  socket.on('t:tournamentStarting', ({ tableId, tournamentId, direct }) => {
    if (run.config.mode === 'tournament-player' && !direct) {
      if (tournamentId === run.config.tournamentId) {
        bot.tableLookupRequestedAt = Date.now();
        socket.emit('t:getMyTable', { tournamentId: run.config.tournamentId });
        _log(run, 'tournament_start_notice', { botId, tournamentId, announcedTableId: tableId });
      }
      return;
    }
    bot.tableId = tableId;
    run.metrics.tableJoins += 1;
    bot.tableLookupRequestedAt = null;
    _log(run, 'table_join', { botId, tableId, tournamentId, direct: !!direct });
    socket.emit('getGameState', { roomId: tableId });
  });

  socket.on('t:tableTransfer', ({ toTableId }) => {
    bot.tableId = toTableId;
    run.metrics.tableTransfers += 1;
    _log(run, 'table_transfer', { botId, tableId: toTableId });
    socket.emit('getGameState', { roomId: toTableId });
  });

  socket.on('t:pendingTableTransfer', ({ tableId }) => {
    bot.tableId = tableId;
    run.metrics.tableTransfers += 1;
    _log(run, 'pending_table_transfer', { botId, tableId });
    socket.emit('getGameState', { roomId: tableId });
  });

  socket.on('gameStarted', () => {
    bot.pendingActionKey = null;
    if (bot.tableId) socket.emit('getGameState', { roomId: bot.tableId });
  });

  socket.on('gameState', (payload) => {
    bot.gameStateCount += 1;
    bot.lastEventAt = Date.now();
    run.metrics.gameStateReceived += 1;
    const meta = payload?.meta ?? null;
    if (meta) {
      if (meta.roomId) bot.tableId = meta.roomId;
      _log(run, 'game_state', {
        botId,
        tableId: meta.roomId ?? run.config.tableId ?? null,
        phase: meta.phase ?? null,
        mode: meta.currentMode ?? null,
        currentBet: meta.currentBet ?? null,
        pot: meta.pot ?? null,
        handCount: meta.handCount ?? null,
      });
    }
    if (run.config.mode === 'tournament-player') _scheduleTournamentAction(run, bot, payload);
  });

  socket.on('error', (err) => {
    run.metrics.errors += 1;
    run.metrics.actionErrors += 1;
    bot.pendingActionKey = null;
    _log(run, 'socket_error', { botId, message: err?.message ?? String(err) });
  });
}

async function startRun(configInput = {}) {
  if (process.env.LOAD_TEST_ENABLED !== 'true') {
    const err = new Error('LOAD_TEST_DISABLED');
    err.statusCode = 403;
    throw err;
  }

  const count = _safeNumber(configInput.count, 5, 1, _safeNumber(process.env.LOAD_TEST_MAX_BOTS, 50, 1, 300));
  const mode = ['connect', 'spectate', 'tournament-player'].includes(configInput.mode)
    ? configInput.mode
    : 'connect';
  const targetUrl = String(configInput.targetUrl || '').trim();
  if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
    const err = new Error('INVALID_TARGET_URL');
    err.statusCode = 400;
    throw err;
  }
  if (mode === 'spectate' && !configInput.tableId && !configInput.tournamentId) {
    const err = new Error('SPECTATE_TARGET_REQUIRED');
    err.statusCode = 400;
    throw err;
  }
  if (mode === 'tournament-player' && !configInput.tournamentId) {
    const err = new Error('TOURNAMENT_TARGET_REQUIRED');
    err.statusCode = 400;
    throw err;
  }

  const run = {
    id: _makeRunId(),
    status: 'running',
    startedAt: _now(),
    startedAtMs: Date.now(),
    endedAt: null,
    config: {
      targetUrl,
      mode,
      count,
      tableId: String(configInput.tableId || '').trim(),
      tournamentId: String(configInput.tournamentId || '').trim(),
      rampMs: _safeNumber(configInput.rampMs, DEFAULT_RAMP_MS, 0, 10000),
      durationSec: _safeNumber(configInput.durationSec, DEFAULT_DURATION_SEC, 5, 1800),
    },
    players: [],
    bots: new Map(),
    timers: [],
    logs: [],
    metrics: {
      connected: 0,
      connectFailed: 0,
      disconnected: 0,
      gameStateReceived: 0,
      tournamentRegistered: 0,
      tableJoins: 0,
      tableTransfers: 0,
      actionsSent: 0,
      drawActionsSent: 0,
      betActionsSent: 0,
      actionErrors: 0,
      errors: 0,
      latencySamples: 0,
      latencyTotalMs: 0,
      avgLatencyMs: null,
      maxLatencyMs: null,
    },
  };
  runs.set(run.id, run);
  _log(run, 'run_start', { config: run.config });

  if (mode === 'tournament-player') {
    try {
      await _prepareTournamentPlayers(run);
    } catch (err) {
      run.status = 'failed';
      run.endedAt = _now();
      run.metrics.errors += 1;
      _log(run, 'run_failed', { message: err?.message ?? String(err) });
      throw err;
    }
  }

  for (let i = 0; i < count; i++) {
    const timer = setTimeout(() => {
      if (run.status !== 'running') return;
      _createBot(run, i);
    }, i * run.config.rampMs);
    run.timers.push(timer);
  }

  if (mode === 'tournament-player') {
    const lookupTimer = setInterval(() => {
      if (run.status !== 'running') return;
      for (const bot of run.bots.values()) {
        if (!bot.socket?.connected || bot.tableId) continue;
        const last = bot.tableLookupRequestedAt ?? 0;
        if (Date.now() - last < 3000) continue;
        bot.tableLookupRequestedAt = Date.now();
        bot.socket.emit('t:getMyTable', { tournamentId: run.config.tournamentId });
        _log(run, 'tournament_get_table_retry', { botId: bot.id, tournamentId: run.config.tournamentId });
      }
    }, 3000);
    run.timers.push(lookupTimer);
  }

  const stopTimer = setTimeout(() => stopRun(run.id, 'duration_elapsed'), run.config.durationSec * 1000);
  run.timers.push(stopTimer);
  return _snapshotRun(run);
}

function stopRun(runId, reason = 'admin_stop') {
  const run = runs.get(runId);
  if (!run) return null;
  if (run.status !== 'running') return _snapshotRun(run);
  run.status = 'stopping';
  for (const timer of run.timers) clearTimeout(timer);
  run.timers = [];
  for (const bot of run.bots.values()) {
    try {
      if (bot.socket?.connected) bot.socket.disconnect();
      else bot.socket?.close?.();
    } catch (err) {
      _log(run, 'disconnect_error', { botId: bot.id, message: err?.message ?? String(err) });
    }
  }
  run.status = 'stopped';
  run.endedAt = _now();
  _log(run, 'run_stop', { reason });
  return _snapshotRun(run);
}

function stopAll(reason = 'admin_stop_all') {
  const stopped = [];
  for (const id of runs.keys()) {
    const snap = stopRun(id, reason);
    if (snap) stopped.push(snap.id);
  }
  return stopped;
}

function getStatus() {
  return {
    enabled: process.env.LOAD_TEST_ENABLED === 'true',
    maxBots: _safeNumber(process.env.LOAD_TEST_MAX_BOTS, 50, 1, 300),
    runs: [...runs.values()].map(_snapshotRun).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))),
  };
}

function getRun(runId) {
  const run = runs.get(runId);
  return run ? _snapshotRun(run) : null;
}

function getLogs(runId, limit = 500) {
  const run = runs.get(runId);
  if (!run) return null;
  const n = _safeNumber(limit, 500, 1, MAX_LOGS);
  return run.logs.slice(-n);
}

function exportRun(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  return {
    jsonl: run.logs.map((e) => JSON.stringify(e)).join('\n'),
    markdown: _summaryMarkdown(run),
  };
}

module.exports = {
  startRun,
  stopRun,
  stopAll,
  getStatus,
  getRun,
  getLogs,
  exportRun,
};
