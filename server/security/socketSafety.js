'use strict';

const OBJECT_EVENTS = new Set([
  't:getMyTable', 'joinRoom', 'leaveRoom', 'leaveSocketRoom', 'joinSocketRoom',
  'getGameState', 't:returnToSeat', 'updateSelected', 'drawCards', 'betAction',
  'reserveLeave', 'spectate', 't:leaveSpectate', '3c:join', '3c:bet', '3c:action',
  '3c:leave', 'z:join', 'z:fastFold', 'z:requestGameState', 'z:foldStay', 'z:leave',
]);

function validPacket(event, value) {
  if (event === 'getRoomPlayers') return typeof value === 'string' && value.length > 0 && value.length <= 64;
  if (!OBJECT_EVENTS.has(event)) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const key of ['roomId', 'tableId', 'tournamentId', 'poolId']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key] || value[key].length > 64)) return false;
  }
  if (event === 't:getMyTable' && !value.tournamentId) return false;
  if (event === 'spectate' && !value.tableId && !value.tournamentId) return false;
  if (event === 'z:requestGameState' && !value.roomId) return false;
  if (value.action !== undefined && (typeof value.action !== 'string' || value.action.length > 32)) return false;
  if (value.password !== undefined && (typeof value.password !== 'string' || value.password.length > 256)) return false;
  if (value.indices !== undefined && (!Array.isArray(value.indices) || value.indices.length > 5 ||
    new Set(value.indices).size !== value.indices.length || value.indices.some(i => !Number.isInteger(i) || i < 0 || i > 4))) return false;
  for (const key of ['amount', 'ante', 'pp', 'sixCard']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) return false;
  }
  return true;
}

function safeSocketOn(socket) {
  return (event, handler) => socket.on(event, (...args) => {
    if (!validPacket(event, args[0])) {
      socket.emit('error', { code: 'INVALID_PAYLOAD', message: '送信内容が不正です' });
      return;
    }
    const failed = () => {
      // Do not log payloads, tokens, or raw exception messages.
      console.error(`[socket-handler] failed event=${event}`);
      if (socket.connected) socket.emit('error', { code: 'ACTION_FAILED', message: '処理に失敗しました。再度お試しください' });
    };
    try {
      const result = handler(...args);
      if (result && typeof result.catch === 'function') result.catch(failed);
    } catch {
      failed();
    }
  });
}

function createRateLimiter(max, windowMs, maxKeys = 10000) {
  const counts = new Map();
  let lastSweep = 0;
  return (key, now = Date.now()) => {
    if (now - lastSweep >= windowMs) {
      for (const [k, record] of counts) if (record.until <= now) counts.delete(k);
      lastSweep = now;
    }
    let record = counts.get(key);
    if (!record || record.until <= now) {
      if (counts.size >= maxKeys && !record) return false;
      record = { count: 0, until: now + windowMs };
      counts.set(key, record);
    }
    return ++record.count <= max;
  };
}

module.exports = { safeSocketOn, validPacket, createRateLimiter };
