/**
 * Temporary Socket.IO load-test runner for admin use.
 *
 * The runner only supports "connect" and "spectate" modes. It never joins a
 * game as a player and never sends game actions, so it should not mutate live
 * game state beyond normal spectator socket membership.
 */

const { io: createClient } = require('socket.io-client');

const MAX_LOGS = 2000;
const DEFAULT_RAMP_MS = 200;
const DEFAULT_DURATION_SEC = 300;

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
    `- avgLatencyMs: ${snap.metrics.avgLatencyMs ?? '-'}`,
    `- maxLatencyMs: ${snap.metrics.maxLatencyMs ?? '-'}`,
    `- errors: ${snap.metrics.errors}`,
    '',
    '## Recent State Samples',
    '```jsonl',
    ...states.map((e) => JSON.stringify(e)),
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

function _createBot(run, index) {
  const botId = `loadbot::${run.id}::${String(index + 1).padStart(3, '0')}`;
  const botName = `LoadBot-${String(index + 1).padStart(3, '0')}`;
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
    },
  });
  const bot = {
    id: botId,
    name: botName,
    socket,
    connected: false,
    lastEventAt: null,
    gameStateCount: 0,
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

  socket.on('gameState', (payload) => {
    bot.gameStateCount += 1;
    bot.lastEventAt = Date.now();
    run.metrics.gameStateReceived += 1;
    const meta = payload?.meta ?? null;
    if (meta) {
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
  });

  socket.on('error', (err) => {
    run.metrics.errors += 1;
    _log(run, 'socket_error', { botId, message: err?.message ?? String(err) });
  });
}

function startRun(configInput = {}) {
  if (process.env.LOAD_TEST_ENABLED !== 'true') {
    const err = new Error('LOAD_TEST_DISABLED');
    err.statusCode = 403;
    throw err;
  }

  const count = _safeNumber(configInput.count, 5, 1, _safeNumber(process.env.LOAD_TEST_MAX_BOTS, 50, 1, 300));
  const mode = configInput.mode === 'spectate' ? 'spectate' : 'connect';
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
    bots: new Map(),
    timers: [],
    logs: [],
    metrics: {
      connected: 0,
      connectFailed: 0,
      disconnected: 0,
      gameStateReceived: 0,
      errors: 0,
      latencySamples: 0,
      latencyTotalMs: 0,
      avgLatencyMs: null,
      maxLatencyMs: null,
    },
  };
  runs.set(run.id, run);
  _log(run, 'run_start', { config: run.config });

  for (let i = 0; i < count; i++) {
    const timer = setTimeout(() => {
      if (run.status !== 'running') return;
      _createBot(run, i);
    }, i * run.config.rampMs);
    run.timers.push(timer);
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
