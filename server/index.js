/**
 * server/index.js — Poker Room Pastis メインサーバー
 *
 * Socket.IO イベント（クライアント → サーバー）:
 *   getRoomList   {}                          ロビー一覧を要求
 *   getRoomPlayers { roomId }                 部屋のプレイヤー一覧を要求
 *   createRoom    { label, mode, password }   ユーザーが部屋を作成
 *   joinRoom      { roomId, name, password }  部屋に参加（パスワードあり部屋は照合）
 *   leaveRoom     { roomId }                  ゲームから退室
 *   drawCards     { roomId, indices }         カードを交換
 *   betAction     { roomId, action }          ベットアクション
 *
 * Socket.IO イベント（サーバー → クライアント）:
 *   roomList      RoomInfo[]                  ロビー一覧
 *   lobbyUpdate   string[]                    部屋の参加者一覧
 *   roomCreated   { roomId }                  部屋作成成功
 *   joinError     { message }                 入室失敗（パスワード不一致など）
 *   gameState     { players, meta }           ゲーム状態（個別送信）
 *   gameStarted   {}                          ゲーム開始通知
 *   showdown      {}                          ショーダウン通知
 *   kicked        {}                          退室通知
 *   timerUpdate   { remaining, limit }        タイマー残り秒数
 *   error         { message }                 エラー
 */

const express    = require('express');
const next       = require('next');
const http       = require('http');
const { Server } = require('socket.io');
const { parse }  = require('url');
const cfg        = require('./config');

const {
  getOrCreateRoom, createUserRoom, joinRoom: joinPokerRoom,
  leaveRoom, startGame, drawCards, betAction,
  buildGameState, removePlayer, canAutoStart, getAllRooms,
} = require('./poker/gameManager');

// ===== Next.js =====
const dev    = process.env.NODE_ENV !== 'production';
const app    = next({ dev });
const handle = app.getRequestHandler();

// ==========================================================
// ■ 固定ロビー部屋（サーバー起動時に生成）
// ==========================================================

/**
 * 固定部屋を初期化する。
 * 奇数番号 = 2-7, 偶数番号 = Badugi
 * MIX部屋を別途追加（BTNが一周するたびに 2-7 ↔ Badugi 切替）
 */
function _initFixedRooms() {
  const fixed = [];

  // 2-7 と Badugi の固定部屋
  for (let i = 1; i <= cfg.ROOM_COUNT; i++) {
    const mode   = i % 2 === 0 ? 'badugi' : '27';
    const label  = mode === 'badugi' ? `Badugi Room ${i}` : `2-7 Room ${i}`;
    const roomId = mode === 'badugi' ? `badugi-room-${i}` : `27-room-${i}`;
    getOrCreateRoom(roomId, { label }); // gameManager に登録
    fixed.push({ id: roomId, label, mode, isFixed: true });
  }

  // MIX 部屋（BTN一周ごとに 2-7 ↔ Badugi 切替）
  const mixId = 'mix-room-1';
  getOrCreateRoom(mixId, { label: 'Mix Room 1 (2-7 ↔ Badugi)' });
  fixed.push({ id: mixId, label: 'Mix Room 1', mode: 'mix', isFixed: true });

  return fixed;
}

const fixedRooms = _initFixedRooms();

/**
 * ロビー一覧を生成する。
 * 固定部屋 + ユーザー作成部屋を合わせて返す。
 */
function getLobbyList() {
  const list = [];

  // 固定部屋
  for (const fr of fixedRooms) {
    const room = getOrCreateRoom(fr.id);
    list.push({
      id:          fr.id,
      label:       fr.label,
      mode:        fr.mode,
      count:       room.players.length + room.pendingPlayers.length,
      hasPassword: false,
      isUserRoom:  false,
    });
  }

  // ユーザー作成部屋（gameManager の rooms から抽出）
  for (const [, room] of getAllRooms()) {
    if (!room.isUserCreated) continue;
    list.push({
      id:          room.id,
      label:       room.label,
      mode:        room.mode,
      count:       room.players.length + room.pendingPlayers.length,
      hasPassword: !!room.password,
      isUserRoom:  true,
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
  const io         = new Server(server, {
    path:  '/socket.io',
    cors: { origin: '*' },
  });

  // タイマーブロードキャスト（1秒ごと）
  setInterval(() => {
    for (const [roomId, room] of getAllRooms()) {
      if (!room._timerStart || !room._timerLimit) continue;
      const remaining = Math.max(0, room._timerLimit - (Date.now() - room._timerStart) / 1000);
      io.to(roomId).emit('timerUpdate', { remaining: Math.round(remaining), limit: room._timerLimit });
    }
  }, 1000);

  // ===== Socket.IO 接続処理 =====
  io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);
    socket.emit('roomList', getLobbyList());

    // この接続で入室した部屋情報（退室・切断時の削除用）
    let currentRoom = { name: '', roomId: '' };

    // ----- ロビー一覧を要求 -----
    socket.on('getRoomList', () => {
      socket.emit('roomList', getLobbyList());
    });

    // ----- 部屋内プレイヤー一覧を要求 -----
    socket.on('getRoomPlayers', (roomId) => {
      const room = getOrCreateRoom(roomId);
      const names = [
        ...room.players.map((p) => p.name),
        ...room.pendingPlayers.map((p) => `${p.name} (次ゲームから参加)`),
      ];
      socket.emit('lobbyUpdate', names);
    });

    // ----- ユーザーが部屋を作成 -----
    socket.on('createRoom', ({ label, mode, password }) => {
      if (!label || !mode) { socket.emit('error', { message: '部屋名とゲームタイプを入力してください' }); return; }
      const validModes = ['27', 'badugi', 'mix'];
      if (!validModes.includes(mode)) { socket.emit('error', { message: '無効なゲームタイプです' }); return; }

      // ユニークなルームIDを生成（タイムスタンプ使用）
      const roomId = `${mode}-user-${Date.now()}`;
      const room   = getOrCreateRoom(roomId, {
        label:         label.slice(0, 30), // 30文字制限
        password:      password || null,
        isUserCreated: true,
      });
      console.log(`[createRoom] "${label}" mode:${mode} id:${roomId}`);

      // 全クライアントにロビーを更新
      io.emit('roomList', getLobbyList());
      socket.emit('roomCreated', { roomId, label: room.label });
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

      // ゲーム進行中かつ pending でもない新規プレイヤー → 参加待ち通知
      const result = joinPokerRoom(roomId, socket.id, name);
      socket.join(roomId);
      currentRoom = { name, roomId };
      console.log(`[join] "${name}" → ${roomId} (${result})`);

      io.emit('roomList', getLobbyList());
      _broadcastLobbyUpdate(io, roomId);
      _broadcast(io, roomId);

      // 自動ゲーム開始: waiting かつ 2人以上
      const activeCount = room.players.filter((p) => !p.sittingOut).length;
      if (room.phase === 'waiting' && activeCount >= 2) {
        _tryAutoStart(io, roomId);
      }
    });

    // ----- 退室ボタン -----
    socket.on('leaveRoom', ({ roomId }) => {
      _handleLeave(io, socket, roomId, currentRoom.name);
      currentRoom = { name: '', roomId: '' };
      socket.emit('kicked'); // クライアントをロビーに戻す
    });

    // ----- カードを交換 -----
    socket.on('drawCards', ({ roomId, indices }) => {
      if (!roomId || !Array.isArray(indices)) return;
      const room = drawCards(roomId, socket.id, indices);
      if (!room) { socket.emit('error', { message: 'ドローできません（あなたのターンではありません）' }); return; }
      console.log(`[draw] ${socket.id} ${indices.length}枚 → ${room.phase}`);
      _broadcast(io, roomId);
      if (room.phase === 'showdown') {
        io.to(roomId).emit('showdown');
        _scheduleAutoStart(io, roomId);
      }
    });

    // ----- ベットアクション -----
    socket.on('betAction', ({ roomId, action }) => {
      if (!roomId || !action) return;
      const room = betAction(roomId, socket.id, action);
      if (!room) { socket.emit('error', { message: 'そのアクションはできません' }); return; }
      console.log(`[bet] ${socket.id} ${action} → ${room.phase}`);
      _broadcast(io, roomId);
      if (room.phase === 'showdown') {
        io.to(roomId).emit('showdown');
        _scheduleAutoStart(io, roomId);
      }
    });

    // ----- 切断 -----
    socket.on('disconnect', () => {
      console.log(`[disconnect] ${socket.id}`);
      if (currentRoom.roomId) {
        _handleLeave(io, socket, currentRoom.roomId, currentRoom.name);
      }
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
// ■ ヘルパー関数
// ==========================================================

/** 退室処理（leaveRoom イベント & disconnect 共通）*/
function _handleLeave(io, socket, roomId, name) {
  leaveRoom(socket.id);
  socket.leave(roomId);
  io.emit('roomList', getLobbyList());
  _broadcastLobbyUpdate(io, roomId);
  _broadcast(io, roomId);

  // ゲームが showdown になっていたら自動スタートを試みる
  const room = getOrCreateRoom(roomId);
  if (room.phase === 'showdown') _scheduleAutoStart(io, roomId);
}

/** タイムアウト時の自動アクションハンドラを生成 */
function _makeTimeoutHandler(io, roomId) {
  return (rid, phase, playerId) => {
    console.log(`[timeout] ${playerId} in ${rid} at ${phase}`);
    if (phase.startsWith('draw')) drawCards(rid, playerId, []);
    else if (phase.startsWith('bet')) betAction(rid, playerId, cfg.BET_TIMEOUT_ACTION);
    _broadcast(io, rid);
    const room = getOrCreateRoom(rid);
    if (room.phase === 'showdown') {
      io.to(rid).emit('showdown');
      _scheduleAutoStart(io, rid);
    }
  };
}

/** 即時自動開始を試みる */
function _tryAutoStart(io, roomId) {
  const onTimeout = _makeTimeoutHandler(io, roomId);
  const room = startGame(roomId, onTimeout);
  if (room) {
    console.log(`[auto-start] ${roomId}`);
    _broadcast(io, roomId);
    io.to(roomId).emit('gameStarted');
  }
}

/**
 * ショーダウン後に少し待ってから自動スタート
 * （プレイヤーが結果を確認する時間を確保するため 3 秒待つ）
 */
function _scheduleAutoStart(io, roomId) {
  setTimeout(() => {
    if (canAutoStart(roomId)) {
      _tryAutoStart(io, roomId);
    }
  }, 3000);
}

/** ロビー部屋のプレイヤー一覧をブロードキャスト */
function _broadcastLobbyUpdate(io, roomId) {
  const room  = getOrCreateRoom(roomId);
  const names = [
    ...room.players.map((p) => p.sittingOut ? `${p.name} (待機中)` : p.name),
    ...room.pendingPlayers.map((p) => `${p.name} (次ゲームから)`),
  ];
  io.to(roomId).emit('lobbyUpdate', names);
}

/** 各プレイヤーに個別のゲーム状態を送信 */
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
