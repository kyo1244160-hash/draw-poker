/**
 * server/index.js — Poker Room Pastis メインサーバー
 *
 * Socket.IO イベント（クライアント → サーバー）:
 *   getRoomList      {}                         ロビー一覧を要求
 *   getRoomPlayers   { roomId }                 部屋のプレイヤー一覧
 *   createRoom       { label, mode, password }  部屋作成
 *   joinRoom         { roomId, name, password } 入室（6人制限・パスワード）
 *   leaveRoom        { roomId }                 退室
 *   updateSelected   { roomId, indices }        ドロー中の選択インデックスを送信
 *   drawCards        { roomId, indices }        カードを交換
 *   betAction        { roomId, action }         ベットアクション
 *
 * Socket.IO イベント（サーバー → クライアント）:
 *   roomList         RoomInfo[]                 ロビー一覧
 *   lobbyUpdate      string[]                   部屋の参加者一覧
 *   roomCreated      { roomId }                 部屋作成成功
 *   joinError        { message }                入室失敗
 *   gameState        { players, meta }          ゲーム状態
 *   gameStarted      {}                         ゲーム開始
 *   showdown         {}                         ショーダウン
 *   kicked           {}                         退室通知
 *   timerUpdate      { remaining, limit }       タイマー残り秒数
 *   error            { message }                エラー
 */

const express    = require('express');
const next       = require('next');
const http       = require('http');
const { Server } = require('socket.io');
const { parse }  = require('url');
const cfg        = require('./config');

const { checkText } = require('./profanityFilter');
const {
  getOrCreateRoom, joinRoom: joinPokerRoom,
  leaveRoom, startGame, drawCards, betAction, updateSelectedIndices,
  buildGameState, removePlayer, canAutoStart, getAllRooms,
  incrementTimeout, resetTimeout,
} = require('./poker/gameManager');

// ===== Next.js =====
const dev    = process.env.NODE_ENV !== 'production';
const app    = next({ dev });
const handle = app.getRequestHandler();

// ==========================================================
// ■ 固定ロビー部屋の初期化
// ==========================================================

function _initFixedRooms() {
  const fixed = [];
  for (let i = 1; i <= cfg.ROOM_COUNT; i++) {
    const mode   = i % 2 === 0 ? 'badugi' : '27';
    const label  = mode === 'badugi' ? `Badugi Room ${i}` : `2-7 Room ${i}`;
    const roomId = mode === 'badugi' ? `badugi-room-${i}` : `27-room-${i}`;
    getOrCreateRoom(roomId, { label });
    fixed.push({ id: roomId, label, mode, isFixed: true });
  }
  // Mix部屋
  const mixId = 'mix-room-1';
  getOrCreateRoom(mixId, { label: 'Mix Room 1 (2-7↔Badugi)' });
  fixed.push({ id: mixId, label: 'Mix Room 1', mode: 'mix', isFixed: true });
  return fixed;
}

const fixedRooms = _initFixedRooms();

function getLobbyList() {
  const list = [];
  for (const fr of fixedRooms) {
    const room = getOrCreateRoom(fr.id);
    list.push({
      id: fr.id, label: fr.label, mode: fr.mode,
      count: room.players.length + room.pendingPlayers.length,
      hasPassword: false, isUserRoom: false,
    });
  }
  for (const [, room] of getAllRooms()) {
    if (!room.isUserCreated) continue;
    list.push({
      id: room.id, label: room.label, mode: room.mode,
      count: room.players.length + room.pendingPlayers.length,
      hasPassword: !!room.password, isUserRoom: true,
    });
  }
  return list;
}

// ==========================================================
// ■ サーバー起動
// ==========================================================
app.prepare().then(() => {
  const expressApp = express();
  const server     = http.createServer(expressApp);
  const io         = new Server(server, { path: '/socket.io', cors: { origin: '*' } });

  // タイマーブロードキャスト（1秒ごと）
  setInterval(() => {
    for (const [roomId, room] of getAllRooms()) {
      if (!room._timerStart || !room._timerLimit) continue;
      const remaining = Math.max(0, room._timerLimit - (Date.now() - room._timerStart) / 1000);
      io.to(roomId).emit('timerUpdate', { remaining: Math.round(remaining), limit: room._timerLimit });
    }
  }, 1000);

  io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);
    socket.emit('roomList', getLobbyList());
    let currentRoom = { name: '', roomId: '' };

    socket.on('getRoomList',    () => socket.emit('roomList', getLobbyList()));

    socket.on('getRoomPlayers', (roomId) => {
      const room  = getOrCreateRoom(roomId);
      const names = [
        ...room.players.map((p) => p.sittingOut ? `${p.name} (待機中)` : p.name),
        ...room.pendingPlayers.map((p) => `${p.name} (次ゲームから)`),
      ];
      socket.emit('lobbyUpdate', names);
    });

    // ----- 部屋作成 -----
    socket.on('createRoom', ({ label, mode, password }) => {
      return;
    });

    // ----- 入室 -----
    socket.on('joinRoom', ({ roomId, name, password }) => {
      if (!roomId || !name) return;
      const room = getOrCreateRoom(roomId);

      // パスワードチェック
      if (room.password && room.password !== password) {
        socket.emit('joinError', { message: 'パスワードが違います' });
        return;
      }

      // プレイヤー名の公序良俗チェック
      const nameCheck = checkText(name);
      if (!nameCheck.ok) {
        socket.emit('joinError', { message: `名前エラー: ${nameCheck.reason}` });
        return;
      }

      const result = joinPokerRoom(roomId, socket.id, name);

      // 6人制限
      if (result === 'full') {
        socket.emit('joinError', {
          message: `この部屋は満員です（最大${room.maxPlayers ?? 6}人）。他の部屋をお試しください。`,
        });
        return;
      }

      socket.join(roomId);
      currentRoom = { name, roomId };
      console.log(`[join] "${name}" → ${roomId} (${result})`);

      io.emit('roomList', getLobbyList());
      _broadcastLobbyUpdate(io, roomId);
      _broadcast(io, roomId);

      // 自動スタート（waiting + 2人以上）
      const activeCount = room.players.filter((p) => !p.sittingOut).length;
      if (room.phase === 'waiting' && activeCount >= 2) {
        _tryAutoStart(io, roomId);
      }
    });

    // ----- 退室 -----
    socket.on('leaveRoom', ({ roomId }) => {
      _handleLeave(io, socket, roomId);
      currentRoom = { name: '', roomId: '' };
      socket.emit('kicked');
    });

    // ----- ドロー中の選択インデックス更新 -----
    // クライアントがカードを選択するたびに送信 → タイムアウト時に自動交換で使用
    socket.on('updateSelected', ({ roomId, indices }) => {
      if (!roomId || !Array.isArray(indices)) return;
      updateSelectedIndices(roomId, socket.id, indices);
    });

    // ----- カードを交換 -----
    socket.on('drawCards', ({ roomId, indices }) => {
      if (!roomId || !Array.isArray(indices)) return;
      const room = drawCards(roomId, socket.id, indices);
      if (!room) { socket.emit('error', { message: 'ドローできません（あなたのターンではありません）' }); return; }
      resetTimeout(roomId, socket.id);  // アクション成功 → タイムアウトカウントリセット
      _broadcast(io, roomId);
      if (room.phase === 'showdown') { io.to(roomId).emit('showdown'); _scheduleAutoStart(io, roomId); }
    });

    // ----- ベットアクション -----
    socket.on('betAction', ({ roomId, action }) => {
      if (!roomId || !action) return;
      const room = betAction(roomId, socket.id, action);
      if (!room) { socket.emit('error', { message: 'そのアクションはできません' }); return; }
      resetTimeout(roomId, socket.id);  // アクション成功 → タイムアウトカウントリセット
      _broadcast(io, roomId);
      if (room.phase === 'showdown') { io.to(roomId).emit('showdown'); _scheduleAutoStart(io, roomId); }
    });

    // ----- 切断 -----
    socket.on('disconnect', () => {
      console.log(`[disconnect] ${socket.id}`);
      if (currentRoom.roomId) _handleLeave(io, socket, currentRoom.roomId);
    });
  });

  expressApp.use((req, res, nxt) => {
    if (req.path.startsWith('/socket.io')) return nxt();
    handle(req, res, parse(req.url, true));
  });

  const PORT = process.env.PORT ?? 3000;
  server.listen(PORT, () => console.log(`🃏 ${cfg.SITE_NAME} → http://localhost:${PORT}`));
});

// ==========================================================
// ■ ヘルパー
// ==========================================================

function _handleLeave(io, socket, roomId) {
  leaveRoom(socket.id);
  socket.leave(roomId);
  io.emit('roomList', getLobbyList());
  _broadcastLobbyUpdate(io, roomId);
  _broadcast(io, roomId);
  const room = getOrCreateRoom(roomId);
  if (room.phase === 'showdown') _scheduleAutoStart(io, roomId);
}

/**
 * タイムアウト時の自動アクションハンドラ
 * ドロー: _selectedIndices に保存済みの選択カードを交換
 * ベット: フォールド
 */
function _makeTimeoutHandler(io, roomId) {
  return (rid, phase, playerId) => {
    console.log(`[timeout] ${playerId} in ${rid} at ${phase}`);

    if (phase.startsWith('draw')) {
      const room    = getOrCreateRoom(rid);
      const indices = room._selectedIndices[playerId] ?? [];
      drawCards(rid, playerId, indices);
    } else if (phase.startsWith('bet')) {
      betAction(rid, playerId, 'fold');
    }

    // 連続タイムアウトカウント → 3回で退室
    const shouldKick = incrementTimeout(rid, playerId);
    if (shouldKick) {
      console.log(`[kick-timeout] ${playerId} in ${rid} (3 consecutive timeouts)`);
      leaveRoom(playerId);
      // 対象ソケットに kicked を通知
      const targetSocket = io.sockets.sockets.get(playerId);
      if (targetSocket) {
        targetSocket.emit('kicked', { reason: '連続タイムアウトにより退室されました' });
        targetSocket.leave(rid);
      }
      io.emit('roomList', getLobbyList());
      _broadcastLobbyUpdate(io, rid);
    }

    _broadcast(io, rid);
    const room = getOrCreateRoom(rid);
    if (room.phase === 'showdown') { io.to(rid).emit('showdown'); _scheduleAutoStart(io, rid); }
  };
}

function _tryAutoStart(io, roomId) {
  const onTimeout = _makeTimeoutHandler(io, roomId);
  const room = startGame(roomId, onTimeout);
  if (room) {
    console.log(`[auto-start] ${roomId}`);
    _broadcast(io, roomId);
    io.to(roomId).emit('gameStarted');
  }
}

/** ショーダウン後3秒待ってから次ゲームを自動スタート */
function _scheduleAutoStart(io, roomId) {
  setTimeout(() => { if (canAutoStart(roomId)) _tryAutoStart(io, roomId); }, 3000);
}

function _broadcastLobbyUpdate(io, roomId) {
  const room  = getOrCreateRoom(roomId);
  const names = [
    ...room.players.map((p) => p.sittingOut ? `${p.name} (待機中)` : p.name),
    ...room.pendingPlayers.map((p) => `${p.name} (次ゲームから)`),
  ];
  io.to(roomId).emit('lobbyUpdate', names);
}

function _broadcast(io, roomId) {
  const room = getOrCreateRoom(roomId);
  for (const player of [...room.players, ...room.pendingPlayers]) {
    const s = io.sockets.sockets.get(player.id);
    if (!s) continue;
    const state   = buildGameState(room, player.id);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    s.emit('gameState', { players, meta });
  }
}
