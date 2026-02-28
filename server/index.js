/**
 * server/index.js - 2-7 トリプルドロー統合サーバー
 */
const express = require('express');
const next = require('next');
const http = require('http');
const { Server } = require('socket.io');
const { parse } = require('url');

const {
  getOrCreateRoom, joinRoom: joinPokerRoom,
  startGame, drawCards, betAction,
  buildGameState, removePlayer,
} = require('./poker/gameManager');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const lobbyRooms = Array.from({ length: 10 }, (_, i) => ({
  id: `room${i + 1}`, players: [],
}));
const getLobbyList = () => lobbyRooms.map((r) => ({ id: r.id, count: r.players.length }));

app.prepare().then(() => {
  const expressApp = express();
  const server = http.createServer(expressApp);
  const io = new Server(server, { path: '/socket.io', cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);
    socket.emit('roomList', getLobbyList());
    let lobbyPlayer = { name: '', roomId: '' };

    // ロビー
    socket.on('getRoomPlayers', (roomId) => {
      const r = lobbyRooms.find((r) => r.id === roomId);
      if (r) socket.emit('lobbyUpdate', r.players);
    });

    // 入室
    socket.on('joinRoom', ({ roomId, name }) => {
      if (!roomId || !name) return;
      const lr = lobbyRooms.find((r) => r.id === roomId);
      if (lr && !lr.players.includes(name)) { lr.players.push(name); lobbyPlayer = { name, roomId }; }
      joinPokerRoom(roomId, socket.id, name);
      socket.join(roomId);
      console.log(`[join] "${name}" → ${roomId}`);
      io.emit('roomList', getLobbyList());
      if (lr) io.emit('lobbyUpdate', lr.players);
      broadcast(io, roomId);
    });

    // ゲーム開始（カードを配る）
    socket.on('startGame', ({ roomId }) => {
      const room = startGame(roomId);
      if (!room) { socket.emit('error', { message: 'プレイヤーが2人以上必要です' }); return; }
      console.log(`[start] room:${roomId}`);
      broadcast(io, roomId);
      io.to(roomId).emit('gameStarted');
    });

    // ドロー
    socket.on('drawCards', ({ roomId, indices }) => {
      if (!roomId || !Array.isArray(indices)) return;
      const room = drawCards(roomId, socket.id, indices);
      if (!room) { socket.emit('error', { message: 'ドローできません（あなたのターンではありません）' }); return; }
      console.log(`[draw] ${socket.id} ${indices.length}枚 phase:${room.phase}`);
      broadcast(io, roomId);
      if (room.phase === 'showdown') io.to(roomId).emit('showdown');
    });

    // ベットアクション
    socket.on('betAction', ({ roomId, action, raiseAmount }) => {
      if (!roomId || !action) return;
      const room = betAction(roomId, socket.id, action, raiseAmount);
      if (!room) { socket.emit('error', { message: 'そのアクションはできません（あなたのターンではありません）' }); return; }
      console.log(`[bet] ${socket.id} ${action} phase:${room.phase}`);
      broadcast(io, roomId);
      if (room.phase === 'showdown') io.to(roomId).emit('showdown');
    });

    // 切断
    socket.on('disconnect', () => {
      const { name, roomId } = lobbyPlayer;
      const lr = lobbyRooms.find((r) => r.id === roomId);
      if (lr) { lr.players = lr.players.filter((p) => p !== name); io.emit('roomList', getLobbyList()); io.emit('lobbyUpdate', lr.players); }
      const rid = removePlayer(socket.id);
      if (rid) broadcast(io, rid);
    });
  });

  expressApp.use((req, res, nxt) => {
    if (req.path.startsWith('/socket.io')) return nxt();
    handle(req, res, parse(req.url, true));
  });

  const PORT = process.env.PORT ?? 3000;
  server.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
});

function broadcast(io, roomId) {
  const room = getOrCreateRoom(roomId);
  // _meta を除いたプレイヤー一覧を各自に送信
  for (const player of room.players) {
    const s = io.sockets.sockets.get(player.id);
    if (s) {
      const state = buildGameState(room, player.id);
      const meta = state.find((x) => x._meta);
      const players = state.filter((x) => !x._meta);
      s.emit('gameState', { players, meta });
    }
  }
}
