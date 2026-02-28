/**
 * server/index.js — Poker Room Pastis メインサーバー
 *
 * Express + Next.js + Socket.IO を統合したサーバーです。
 * ロビー管理（人数表示）とポーカーゲームを1つのサーバーで処理します。
 *
 * Socket.IO イベント一覧:
 *   クライアント → サーバー:
 *     joinRoom      { roomId, name }          部屋に参加
 *     getRoomPlayers { roomId }               ロビーのプレイヤー一覧を要求
 *     startGame     { roomId }                ゲーム開始
 *     drawCards     { roomId, indices }       カードを交換
 *     betAction     { roomId, action }        ベットアクション
 *
 *   サーバー → クライアント:
 *     roomList      Room[]                    ロビーの部屋一覧
 *     lobbyUpdate   string[]                  特定部屋の参加者名一覧
 *     gameState     { players, meta }         ゲーム状態（個別送信）
 *     gameStarted   {}                        ゲーム開始通知
 *     showdown      {}                        ショーダウン通知
 *     timerUpdate   { remaining, limit }      タイマー残り秒数（定期送信）
 *     error         { message }               エラーメッセージ
 */

const express    = require('express');
const next       = require('next');
const http       = require('http');
const { Server } = require('socket.io');
const { parse }  = require('url');
const cfg        = require('./config');

const {
  getOrCreateRoom,
  joinRoom: joinPokerRoom,
  startGame,
  drawCards,
  betAction,
  buildGameState,
  removePlayer,
  getRoomMode,
} = require('./poker/gameManager');

// ===== Next.js セットアップ =====
const dev    = process.env.NODE_ENV !== 'production';
const app    = next({ dev });
const handle = app.getRequestHandler();

// ===== ロビー管理（人数表示のみ）=====
/**
 * 部屋一覧を生成する（奇数 = 2-7, 偶数 = Badugi）
 * 部屋名: "2-7 Room 1", "2-7 Room 3", ... / "Badugi Room 2", "Badugi Room 4", ...
 */
const lobbyRooms = Array.from({ length: cfg.ROOM_COUNT }, (_, i) => {
  const num     = i + 1;
  const mode    = num % 2 === 0 ? 'badugi' : '27';
  const label   = mode === 'badugi' ? 'Badugi' : '2-7';
  const roomId  = `${label.toLowerCase().replace('-','')}-room-${num}`; // "27-room-1" / "badugi-room-2"
  return { id: roomId, label: `${label} Room ${num}`, mode, players: [] };
});

/** ロビー一覧をクライアント向け形式に変換 */
function getLobbyList() {
  return lobbyRooms.map((r) => ({
    id:    r.id,
    label: r.label,
    mode:  r.mode,
    count: r.players.length,
  }));
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

  // ===== タイマーのブロードキャスト（1秒ごと）=====
  // 全アクティブルームに残り時間を送信
  setInterval(() => {
    for (const lobbyRoom of lobbyRooms) {
      const room = getOrCreateRoom(lobbyRoom.id);
      if (!room._timerStart || !room._timerLimit) continue;
      const remaining = Math.max(
        0,
        room._timerLimit - (Date.now() - room._timerStart) / 1000
      );
      io.to(lobbyRoom.id).emit('timerUpdate', {
        remaining: Math.round(remaining),
        limit:     room._timerLimit,
      });
    }
  }, 1000);

  // ===== Socket.IO 接続処理 =====
  io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);

    // 接続時にロビー一覧を送信
    socket.emit('roomList', getLobbyList());

    // この接続で入室したプレイヤー情報（切断時の削除用）
    let lobbyPlayer = { name: '', roomId: '' };

    // ----- ロビー: 特定部屋のプレイヤー一覧を要求 -----
    socket.on('getRoomPlayers', (roomId) => {
      const lr = lobbyRooms.find((r) => r.id === roomId);
      if (lr) socket.emit('lobbyUpdate', lr.players);
    });

    // ----- 入室 -----
    socket.on('joinRoom', ({ roomId, name }) => {
      if (!roomId || !name) return;

      // ロビーに追加（重複防止）
      const lr = lobbyRooms.find((r) => r.id === roomId);
      if (lr && !lr.players.includes(name)) {
        lr.players.push(name);
        lobbyPlayer = { name, roomId };
      }

      // ポーカーゲームに参加
      joinPokerRoom(roomId, socket.id, name);
      socket.join(roomId);
      console.log(`[join] "${name}" → ${roomId}`);

      // 全クライアントにロビー情報を更新
      io.emit('roomList', getLobbyList());
      if (lr) io.to(roomId).emit('lobbyUpdate', lr.players);

      // ゲーム状態を配信
      _broadcast(io, roomId);

      // ===== 自動ゲーム開始: 2人以上いれば即スタート =====
      const room = getOrCreateRoom(roomId);
      if (room.phase === 'waiting' && room.players.length >= 2) {
        const onTimeout = _makeTimeoutHandler(io, roomId);
        const started = startGame(roomId, onTimeout);
        if (started) {
          console.log(`[auto-start] ${roomId} players:${room.players.length}`);
          _broadcast(io, roomId);
          io.to(roomId).emit('gameStarted');
        }
      }
    });

    // ----- ゲーム開始（手動起動、通常は自動起動が使われる）-----
    socket.on('startGame', ({ roomId }) => {
      const onTimeout = _makeTimeoutHandler(io, roomId);
      const room = startGame(roomId, onTimeout);
      if (!room) {
        socket.emit('error', { message: 'プレイヤーが2人以上必要です' });
        return;
      }
      console.log(`[start] ${roomId} mode:${room.mode}`);
      _broadcast(io, roomId);
      io.to(roomId).emit('gameStarted');
    });

    // ----- カードを交換（ドロー）-----
    socket.on('drawCards', ({ roomId, indices }) => {
      if (!roomId || !Array.isArray(indices)) return;
      const room = drawCards(roomId, socket.id, indices);
      if (!room) {
        socket.emit('error', { message: 'ドローできません（あなたのターンではありません）' });
        return;
      }
      console.log(`[draw] ${socket.id} ${indices.length}枚 → ${room.phase}`);
      _broadcast(io, roomId);
      if (room.phase === 'showdown') io.to(roomId).emit('showdown');
    });

    // ----- ベットアクション -----
    socket.on('betAction', ({ roomId, action }) => {
      if (!roomId || !action) return;
      const room = betAction(roomId, socket.id, action);
      if (!room) {
        socket.emit('error', { message: 'そのアクションはできません' });
        return;
      }
      console.log(`[bet] ${socket.id} ${action} → ${room.phase}`);
      _broadcast(io, roomId);
      if (room.phase === 'showdown') io.to(roomId).emit('showdown');
    });

    // ----- 切断 -----
    socket.on('disconnect', () => {
      console.log(`[disconnect] ${socket.id}`);
      const { name, roomId } = lobbyPlayer;
      const lr = lobbyRooms.find((r) => r.id === roomId);
      if (lr) {
        lr.players = lr.players.filter((p) => p !== name);
        io.emit('roomList', getLobbyList());
        io.to(roomId).emit('lobbyUpdate', lr.players);
      }
      const removedId = removePlayer(socket.id);
      if (removedId) _broadcast(io, removedId);
    });
  });

  // Next.js へのフォールスルー
  expressApp.use((req, res, nxt) => {
    if (req.path.startsWith('/socket.io')) return nxt();
    handle(req, res, parse(req.url, true));
  });

  const PORT = process.env.PORT ?? 3000;
  server.listen(PORT, () => {
    console.log(`🃏 ${cfg.SITE_NAME} → http://localhost:${PORT}`);
  });
});

// ===== ヘルパー: タイムアウトコールバックを生成 =====
/**
 * 制限時間切れ時の自動アクションハンドラを返す。
 * ドロー: スタンドパット（0枚交換）
 * ベット: config の BET_TIMEOUT_ACTION（check / fold）
 */
function _makeTimeoutHandler(io, roomId) {
  return (rid, phase, playerId) => {
    console.log(`[timeout] ${playerId} in ${rid} at ${phase}`);
    if (phase.startsWith('draw')) {
      drawCards(rid, playerId, []); // スタンドパット
    } else if (phase.startsWith('bet')) {
      betAction(rid, playerId, cfg.BET_TIMEOUT_ACTION);
    }
    _broadcast(io, rid);
    const room = getOrCreateRoom(rid);
    if (room.phase === 'showdown') io.to(rid).emit('showdown');
  };
}

// ===== ヘルパー: 各プレイヤーに個別のゲーム状態を送信 =====
function _broadcast(io, roomId) {
  const room = getOrCreateRoom(roomId);
  for (const player of room.players) {
    const s = io.sockets.sockets.get(player.id);
    if (!s) continue;
    const state   = buildGameState(room, player.id);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    s.emit('gameState', { players, meta });
  }
}
