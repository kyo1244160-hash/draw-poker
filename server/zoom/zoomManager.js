/**
 * zoomManager.js — FastFold（Zoom）プール管理
 *
 * PokerStars Zoom と同等の動作:
 *   1. z:join でプールへ参加 → 6人集まると新テーブルにアサイン・ゲーム開始
 *   2. FastFold: 即フォールド処理してプールへ戻る（folded状態でテーブルに残る）
 *   3. showdown後: 全員まとめてプールへ戻す → 新テーブル編成
 */

const {
  getOrCreateRoom, joinRoom, leaveRoom, fastFoldPlayer,
  startGame, buildGameState,
} = require('../poker/gameManager');

const zoomPools    = new Map();  // poolId → pool
const socketToPool = new Map();  // socketId → poolId
const socketNames  = new Map();  // socketId → name
const socketToRoom = new Map();  // socketId → roomId (現在参加中テーブル)

// ==========================================================
// ■ プール定義
// ==========================================================

const POOL_DEFS = [
  { id: 'zoom-27',     label: '2-7 Room (FastFold)',    mode: '27'     },
  { id: 'zoom-badugi', label: 'Badugi Room (FastFold)', mode: 'badugi' },
  { id: 'zoom-mix',    label: 'Mix Room (FastFold)',    mode: 'mix'    },
];

function initPools() {
  for (const def of POOL_DEFS) {
    zoomPools.set(def.id, {
      id:           def.id,
      label:        def.label,
      mode:         def.mode,
      waitingPlayers: [],
      activeTables:   new Map(), // roomId → Set<socketId>
    });
  }
}
initPools();

function getAllPools()         { return [...zoomPools.values()]; }
function getWaitingCount(pid) { return zoomPools.get(pid)?.waitingPlayers.length ?? 0; }

function getTotalCount(pid) {
  const pool = zoomPools.get(pid);
  if (!pool) return 0;
  const activeIds = new Set();
  for (const s of pool.activeTables.values()) for (const id of s) activeIds.add(id);
  const waitingOnly = pool.waitingPlayers.filter(p => !activeIds.has(p.id)).length;
  return activeIds.size + waitingOnly;
}

// ==========================================================
// ■ 待機列への追加（重複防止）
// ==========================================================

function _addToWaiting(pool, socketId) {
  if (pool.waitingPlayers.some((p) => p.id === socketId)) return;
  const name = socketNames.get(socketId) ?? 'Player';
  pool.waitingPlayers.push({ id: socketId, name });
}

// ==========================================================
// ■ テーブル生成・ゲーム開始
// ==========================================================

function _tryAssignTable(io, poolId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;

  while (pool.waitingPlayers.length >= 6) {
    const six    = pool.waitingPlayers.splice(0, 6);
    const roomId = `zoom-table-${poolId}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

    getOrCreateRoom(roomId, { label: pool.label, isZoomTable: true });

    for (const p of six) {
      joinRoom(roomId, p.id, p.name);
      socketToRoom.set(p.id, roomId);
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.join(roomId);
      if (!pool.activeTables.has(roomId)) pool.activeTables.set(roomId, new Set());
      pool.activeTables.get(roomId).add(p.id);
    }

    const onTimeout = _makeTimeoutHandler(io, roomId, poolId);
    const room = startGame(roomId, onTimeout);
    if (room) {
      _broadcast(io, roomId);
      io.to(roomId).emit('gameStarted');
      for (const p of six) {
        io.sockets.sockets.get(p.id)?.emit('z:assigned', { roomId, poolId });
      }
    }

    _broadcastPoolState(io, poolId);
  }
}

// ==========================================================
// ■ showdown後: 全員まとめてプールへ戻す → 新テーブル編成
// 全員を待機列に追加し終えてから _tryAssignTable を呼ぶ（途中割り込み防止）
// ==========================================================

function _returnAllToPool(io, roomId, poolId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;

  const tableSet = pool.activeTables.get(roomId);
  if (!tableSet) return;

  const playerIds = [...tableSet];

  // --- 1. 全員退室・socketToRoom削除・待機列追加（_tryAssignTable は呼ばない）---
  for (const sid of playerIds) {
    leaveRoom(sid);
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.leave(roomId);
    socketToRoom.delete(sid);

    if (socketToPool.get(sid) === poolId) {
      _addToWaiting(pool, sid);
    }
  }

  pool.activeTables.delete(roomId);

  // --- 2. 全員追加後に z:waiting を一括送信 ---
  const wc = pool.waitingPlayers.length;
  const tc = getTotalCount(poolId);
  for (const sid of playerIds) {
    if (socketToPool.get(sid) === poolId) {
      io.sockets.sockets.get(sid)?.emit('z:waiting', {
        poolId,
        waitingCount: wc,
        totalCount:   tc,
      });
    }
  }

  // --- 3. 全員追加後に一度だけテーブル編成 ---
  _broadcastPoolState(io, poolId);
  _tryAssignTable(io, poolId);
}

// ==========================================================
// ■ FastFold: 即フォールド → 待機列へ（テーブルには folded 状態で残る）
// ==========================================================

function _doFastFold(io, socket, poolId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;

  const currentRoomId = socketToRoom.get(socket.id);

  if (currentRoomId) {
    fastFoldPlayer(socket.id);
    _broadcast(io, currentRoomId);

    const gm   = require('../poker/gameManager');
    const room = gm.getOrCreateRoom(currentRoomId);
    if (room?.phase === 'showdown') {
      io.to(currentRoomId).emit('showdown');
      setTimeout(() => _returnAllToPool(io, currentRoomId, poolId), 3000);
      return;
    }
  }

  _addToWaiting(pool, socket.id);
  socket.emit('z:waiting', {
    poolId,
    waitingCount: pool.waitingPlayers.length,
    totalCount:   getTotalCount(poolId),
  });
  _broadcastPoolState(io, poolId);
  _tryAssignTable(io, poolId);
}

// ==========================================================
// ■ タイムアウトハンドラ
// ==========================================================

function _makeTimeoutHandler(io, roomId, poolId) {
  const gm = require('../poker/gameManager');
  return (rid, phase, playerId) => {
    if (phase.startsWith('draw')) {
      const room    = gm.getOrCreateRoom(rid);
      const indices = room?._selectedIndices[playerId] ?? [];
      gm.drawCards(rid, playerId, indices);
    } else if (phase.startsWith('bet')) {
      gm.betAction(rid, playerId, 'fold');
    }

    const shouldKick = gm.incrementTimeout(rid, playerId);
    if (shouldKick) {
      const sock = io.sockets.sockets.get(playerId);
      if (sock) {
        sock.emit('kicked', { reason: '連続タイムアウトにより退室されました' });
        sock.leave(rid);
      }
      _removeFromPool(poolId, playerId);
    }

    _broadcast(io, rid);
    const room = gm.getOrCreateRoom(rid);
    if (room?.phase === 'showdown') {
      io.to(rid).emit('showdown');
      setTimeout(() => _returnAllToPool(io, rid, poolId), 3000);
    }
  };
}

// ==========================================================
// ■ ブロードキャスト
// ==========================================================

function _broadcast(io, roomId) {
  const room = getOrCreateRoom(roomId);
  if (!room) return;
  for (const player of [...room.players, ...room.pendingPlayers]) {
    const s = io.sockets.sockets.get(player.id);
    if (!s) continue;
    const state   = buildGameState(room, player.id);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    s.emit('gameState', { players, meta });
  }
}

function _broadcastPoolState(io, poolId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;
  io.emit('z:poolState', {
    poolId,
    waitingCount: pool.waitingPlayers.length,
    totalCount:   getTotalCount(poolId),
  });
}

// ==========================================================
// ■ プールからの完全削除
// ==========================================================

function _removeFromPool(poolId, socketId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;
  pool.waitingPlayers = pool.waitingPlayers.filter((p) => p.id !== socketId);
  for (const [, players] of pool.activeTables.entries()) {
    players.delete(socketId);
  }
  socketToPool.delete(socketId);
  socketNames.delete(socketId);
  socketToRoom.delete(socketId);
}

// ==========================================================
// ■ Socket.IO ハンドラ登録
// ==========================================================

function registerZoomHandlers(io, socket) {

  socket.on('z:join', ({ poolId, name }) => {
    const pool = zoomPools.get(poolId);
    if (!pool) return;

    socketNames.set(socket.id, name);
    socketToPool.set(socket.id, poolId);

    _addToWaiting(pool, socket.id);
    socket.emit('z:waiting', {
      poolId,
      waitingCount: pool.waitingPlayers.length,
      totalCount:   getTotalCount(poolId),
    });
    _broadcastPoolState(io, poolId);
    _tryAssignTable(io, poolId);
  });

  socket.on('z:fastFold', ({ poolId }) => {
    _doFastFold(io, socket, poolId);
  });

  socket.on('z:leave', ({ poolId }) => {
    _handleZoomLeave(io, socket, poolId);
  });

  socket.on('disconnect', () => {
    const poolId = socketToPool.get(socket.id);
    if (poolId) _handleZoomLeave(io, socket, poolId);
  });
}

function _handleZoomLeave(io, socket, poolId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;

  const currentRoomId = socketToRoom.get(socket.id);
  if (currentRoomId) {
    fastFoldPlayer(socket.id) || leaveRoom(socket.id);
    _broadcast(io, currentRoomId);
    socket.leave(currentRoomId);
    pool.activeTables.get(currentRoomId)?.delete(socket.id);
    socketToRoom.delete(socket.id);
  }

  _removeFromPool(poolId, socket.id);
  _broadcastPoolState(io, poolId);
  socket.emit('kicked');
}


// ==========================================================
// ■ 外部呼び出し: showdown発生時にzoomManagerへ通知
// index.js の drawCards / betAction から呼ばれる
// ==========================================================

function handleZoomShowdown(io, roomId) {
  // roomIdがどのpoolIdに属するか探す
  for (const [poolId, pool] of zoomPools.entries()) {
    if (pool.activeTables.has(roomId)) {
      setTimeout(() => _returnAllToPool(io, roomId, poolId), 3000);
      return;
    }
  }
}

module.exports = { registerZoomHandlers, getAllPools, getWaitingCount, getTotalCount, handleZoomShowdown };
