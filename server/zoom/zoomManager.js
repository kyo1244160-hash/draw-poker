/**
 * zoomManager.js — FastFold（Zoom）プール管理
 */

const {
  getOrCreateRoom, joinRoom, leaveRoom, fastFoldPlayer,
  startGame, buildGameState, canAutoStart,
} = require('../poker/gameManager');

const zoomPools   = new Map();  // poolId → pool
const socketToPool = new Map(); // socketId → poolId
const socketNames  = new Map(); // socketId → name（名前の永続保持）
const spectators   = new Map(); // socketId → 観戦中roomId

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
      id:             def.id,
      label:          def.label,
      mode:           def.mode,
      waitingPlayers: [],
      activeTables:   new Map(), // roomId → Set<socketId>
    });
  }
}
initPools();

function getAllPools()          { return [...zoomPools.values()]; }
function getWaitingCount(pid)  { return zoomPools.get(pid)?.waitingPlayers.length ?? 0; }

function getTotalCount(pid) {
  const pool = zoomPools.get(pid);
  if (!pool) return 0;
  const activeCount = [...pool.activeTables.values()].reduce((sum, s) => sum + s.size, 0);
  return pool.waitingPlayers.length + activeCount;
}

// ==========================================================
// ■ 待機列への追加（重複防止付き）
// ==========================================================

function _addToWaiting(pool, socketId) {
  // 既に待機列にいる場合はスキップ
  if (pool.waitingPlayers.some((p) => p.id === socketId)) return;
  const name = socketNames.get(socketId) ?? 'Player';
  pool.waitingPlayers.push({ id: socketId, name });
}

// ==========================================================
// ■ テーブル生成・開始
// ==========================================================

function _tryAssignTable(io, poolId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;

  while (pool.waitingPlayers.length >= 6) {
    const six    = pool.waitingPlayers.splice(0, 6);
    const roomId = `zoom-table-${poolId}-${Date.now()}`;

    getOrCreateRoom(roomId, { label: pool.label, isZoomTable: true });

    for (const p of six) {
      joinRoom(roomId, p.id, p.name);
      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        // 観戦中のルームから退出
        const prev = spectators.get(p.id);
        if (prev) { sock.leave(prev); spectators.delete(p.id); }
        sock.join(roomId);
      }
      // activeTables に登録
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
// ■ FastFold 共通処理（テーブルからプールへ戻す）
// ==========================================================

function _doFastFold(io, socket, poolId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;

  // activeTableから自分を探す
  let currentRoomId = null;
  for (const [roomId, players] of pool.activeTables.entries()) {
    if (players.has(socket.id)) { currentRoomId = roomId; break; }
  }

  if (currentRoomId) {
    const result = fastFoldPlayer(socket.id);

    if (result) {
      // fastFoldPlayer が roomId を返した = フォールド処理完了（即フォールドまたはpending登録済み）
      // 即フォールドした場合のみブロードキャスト（pendingはターンが来たときに自動ブロードキャストされる）
      const gm = require('../poker/gameManager');
      const room = gm.getOrCreateRoom(currentRoomId);
      const player = room?.players.find((p) => p.id === socket.id);
      const isFoldedNow = player?.folded;

      if (isFoldedNow) {
        // 即フォールドされた（自分のターン中だった）→ ブロードキャストして退室
        _broadcast(io, currentRoomId);
        if (room?.phase === 'showdown') {
          io.to(currentRoomId).emit('showdown');
          _scheduleAutoStart(io, currentRoomId, poolId);
        }
        leaveRoom(socket.id);
        socket.leave(currentRoomId);
        pool.activeTables.get(currentRoomId)?.delete(socket.id);
        spectators.set(socket.id, currentRoomId);
      } else {
        // pending登録済み（ターン外）→ activeTables から即削除してカウントを正確に
        // プレイヤーはルームには残ったまま（他プレイヤーには通常表示）、showdown後に leaveRoom する
        pool.activeTables.get(currentRoomId)?.delete(socket.id);
        const gm2 = require('../poker/gameManager');
        const r = gm2.getOrCreateRoom(currentRoomId);
        if (r) {
          const p = r.players.find((pp) => pp.id === socket.id);
          if (p) p.pendingFastFoldLeave = true;
        }
      }
    } else {
      // ベットフェーズ外（showdown中など）→ そのまま退室
      leaveRoom(socket.id);
      socket.leave(currentRoomId);
      pool.activeTables.get(currentRoomId)?.delete(socket.id);
      spectators.set(socket.id, currentRoomId);
    }
  }

  // 待機列に戻す（重複防止付き）
  _addToWaiting(pool, socket.id);
  const _wc = pool.waitingPlayers.length;
  socket.emit('z:waiting', { poolId, waitingCount: _wc, totalCount: getTotalCount(poolId) });
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
      gm.leaveRoom(playerId);
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
      _scheduleAutoStart(io, rid, poolId);
    }
  };
}

// ==========================================================
// ■ ショーダウン後の自動スタート
// ==========================================================

function _scheduleAutoStart(io, roomId, poolId) {
  // pendingFastFoldLeave のプレイヤーを退室させてからスタート
  const room = getOrCreateRoom(roomId);
  if (room) {
    for (const player of [...room.players]) {
      if (!player.pendingFastFoldLeave) continue;
      const sock = io.sockets.sockets.get(player.id);
      leaveRoom(player.id);
      if (sock) {
        sock.leave(roomId);
        spectators.set(player.id, roomId);
      }
      // activeTables から削除
      const pool = zoomPools.get(poolId);
      pool?.activeTables.get(roomId)?.delete(player.id);
    }
  }

  // FastFoldは3秒待たずに即スタート
  if (canAutoStart(roomId)) {
    const onTimeout = _makeTimeoutHandler(io, roomId, poolId);
    const startedRoom = startGame(roomId, onTimeout);
    if (startedRoom) {
      _broadcast(io, roomId);
      io.to(roomId).emit('gameStarted');
    }
  }
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

  // 観戦者（FastFold後に待機中）へも送信
  for (const [specId, specRoomId] of spectators.entries()) {
    if (specRoomId !== roomId) continue;
    const s = io.sockets.sockets.get(specId);
    if (!s) continue;
    const state   = buildGameState(room, null);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    s.emit('gameState', { players, meta });
  }
}

function _broadcastPoolState(io, poolId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;
  const waitingCount = pool.waitingPlayers.length;
  const totalCount   = getTotalCount(poolId);
  io.emit('z:poolState', { poolId, waitingCount, totalCount });
}

// ==========================================================
// ■ プールからの削除
// ==========================================================

function _removeFromPool(poolId, socketId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;
  pool.waitingPlayers = pool.waitingPlayers.filter((p) => p.id !== socketId);
  for (const [roomId, players] of pool.activeTables.entries()) {
    players.delete(socketId);
    if (players.size === 0) pool.activeTables.delete(roomId);
  }
  socketToPool.delete(socketId);
  socketNames.delete(socketId);
  spectators.delete(socketId);
}

// ==========================================================
// ■ Socket.IO ハンドラ登録
// ==========================================================

function registerZoomHandlers(io, socket) {

  // ----- z:join -----
  socket.on('z:join', ({ poolId, name }) => {
    const pool = zoomPools.get(poolId);
    if (!pool) return;

    // 名前を保持（FastFold後の再参加でも使えるよう）
    socketNames.set(socket.id, name);
    socketToPool.set(socket.id, poolId);

    _addToWaiting(pool, socket.id);
    const _wc = pool.waitingPlayers.length; socket.emit('z:waiting', { poolId, waitingCount: _wc, totalCount: getTotalCount(poolId) });
    _broadcastPoolState(io, poolId);
    _tryAssignTable(io, poolId);
  });

  // ----- z:fastFold -----
  socket.on('z:fastFold', ({ poolId }) => {
    _doFastFold(io, socket, poolId);
  });

  // ----- z:leave -----
  socket.on('z:leave', ({ poolId }) => {
    _handleZoomLeave(io, socket, poolId);
  });

  // ----- disconnect -----
  socket.on('disconnect', () => {
    const poolId = socketToPool.get(socket.id);
    if (poolId) _handleZoomLeave(io, socket, poolId);
  });
}

function _handleZoomLeave(io, socket, poolId) {
  const pool = zoomPools.get(poolId);
  if (!pool) return;

  // アクティブテーブルにいれば退室
  for (const [roomId, players] of pool.activeTables.entries()) {
    if (players.has(socket.id)) {
      fastFoldPlayer(socket.id) || leaveRoom(socket.id);
      _broadcast(io, roomId);
      socket.leave(roomId);
      break;
    }
  }

  _removeFromPool(poolId, socket.id);
  _broadcastPoolState(io, poolId);
  socket.emit('kicked');
}

module.exports = { registerZoomHandlers, getAllPools, getWaitingCount, getTotalCount };
