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
  getRoomMode, getRoom,
} = require('./poker/gameManager');

const { registerZoomHandlers, getAllPools, getWaitingCount, getTotalCount, handleZoomShowdown } = require('./zoom/zoomManager');

// ===== Next.js =====
const dev    = process.env.NODE_ENV !== 'production';
const app    = next({ dev });
const handle = app.getRequestHandler();

// ==========================================================
// ■ 固定ロビー部屋の初期化
// ==========================================================

function _initFixedRooms() {
  const fixed = [];

  // 通常部屋: 各モード×3
  const normalDefs = [
    { id: '27-room-1',     label: '2-7 Room 1',    mode: '27'     },
    { id: 'badugi-room-1', label: 'Badugi Room 1', mode: 'badugi' },
    { id: 'mix-room-1',    label: 'Mix Room 1',    mode: 'mix'    },
    { id: '27-room-2',     label: '2-7 Room 2',    mode: '27'     },
    { id: 'badugi-room-2', label: 'Badugi Room 2', mode: 'badugi' },
    { id: 'mix-room-2',    label: 'Mix Room 2',    mode: 'mix'    },
    { id: '27-room-3',     label: '2-7 Room 3',    mode: '27'     },
    { id: 'badugi-room-3', label: 'Badugi Room 3', mode: 'badugi' },
    { id: 'mix-room-3',    label: 'Mix Room 3',    mode: 'mix'    },
  ];
  for (const r of normalDefs) {
    getOrCreateRoom(r.id, { label: r.label });
    fixed.push({ id: r.id, label: r.label, mode: r.mode, isFixed: true, isZoom: false });
  }

  // FastFold（Zoom）部屋: 各モード1つ（一番下）
  const zoomDefs = [
    { id: 'zoom-27',     label: '2-7 Room (FastFold)',    mode: '27'     },
    { id: 'zoom-badugi', label: 'Badugi Room (FastFold)', mode: 'badugi' },
    { id: 'zoom-mix',    label: 'Mix Room (FastFold)',    mode: 'mix'    },
  ];
  for (const z of zoomDefs) {
    getOrCreateRoom(z.id, { label: z.label });
    fixed.push({ id: z.id, label: z.label, mode: z.mode, isFixed: true, isZoom: true });
  }

  return fixed;
}

const fixedRooms = _initFixedRooms();

function getLobbyList() {
  const list = [];
  for (const fr of fixedRooms) {
    const room = getOrCreateRoom(fr.id);
    list.push({
      id: fr.id, label: fr.label, mode: fr.mode,
      count: fr.isZoom
        ? getTotalCount(fr.id)
        : room.players.length + room.pendingPlayers.length,
      hasPassword: false, isUserRoom: false, isZoom: fr.isZoom ?? false,
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
    // createRoom は現在無効化中
    // socket.on('createRoom', ...)

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
      // ZoomテーブルはzoomManagerが管理するためindex.jsからはautoStartしない
      if (room.phase === 'showdown') { io.to(roomId).emit('showdown'); if (room.isZoomTable) handleZoomShowdown(io, roomId); else _scheduleAutoStart(io, roomId); }
    });

    // ----- ベットアクション -----
    socket.on('betAction', ({ roomId, action }) => {
      if (!roomId || !action) return;
      // アクション前のプレイヤー名を記録
      const roomBefore = getRoom(roomId);
      const actingPlayer = roomBefore
        ? roomBefore.players.find((p) => p.id === socket.id)
        : null;
      const room = betAction(roomId, socket.id, action);
      if (!room) { socket.emit('error', { message: 'そのアクションはできません' }); return; }
      resetTimeout(roomId, socket.id);
      // アクション名を全員に通知（socket.id は含めない）
      io.to(roomId).emit('playerAction', {
        playerName: actingPlayer ? actingPlayer.name : '',
        action,
      });
      _broadcast(io, roomId);
      if (room.phase === 'showdown') { io.to(roomId).emit('showdown'); if (room.isZoomTable) handleZoomShowdown(io, roomId); else _scheduleAutoStart(io, roomId); }
    });

    // ----- 切断 -----
    // ----- 退室予約 -----
    socket.on('reserveLeave', ({ roomId, type }) => {
      if (!roomId || !['afterHand', 'nextBB', 'cancel'].includes(type)) return;
      if (type === 'cancel') {
        leaveReservations.delete(socket.id);
      } else {
        leaveReservations.set(socket.id, type);
      }
      // 予約状態をそのプレイヤーに返す
      socket.emit('leaveReservation', { type: type === 'cancel' ? null : type });
    });

    // ----- Zoom（FastFold）ハンドラ -----
    registerZoomHandlers(io, socket);

    socket.on('disconnect', () => {
      console.log(`[disconnect] ${socket.id}`);
      leaveReservations.delete(socket.id);
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
  // showdownのままなら次ゲームを試みる（waitingにリセットされていたら不要）
  if (room && room.phase === 'showdown') _scheduleAutoStart(io, roomId);
  // waitingになった（人数不足でリセット）なら参加者到着を待つだけ
}

/**
 * タイムアウト時の自動アクションハンドラ
 * ドロー: _selectedIndices に保存済みの選択カードを交換
 * ベット: フォールド
 */
function _makeTimeoutHandler(io, roomId) {
  return (rid, phase, playerId) => {
    console.log(`[timeout] ${playerId} in ${rid} at ${phase}`);

    // アクション実行 ─ 成否を必ず確認する。
    //
    // 【競合の背景】
    // Node.js のイベントループでは タイマーフェーズ（setTimeout）は
    // I/O フェーズ（socket.io イベント）より先に処理される。
    // そのため「タイマー残り ~0秒の瞬間にクライアントがアクションを送信」すると
    //   1. タイマーフェーズ: このコールバックが先に実行される
    //   2. I/O フェーズ: クライアントのアクションが処理されるが、
    //      ターンは既に進んでいるため betAction/drawCards が null を返す
    //      → resetTimeout が呼ばれない
    // これが 3 回蓄積すると不当な kick が発生していた。
    //
    // 修正: アクションが null（＝既に別経路でターンが進んでいる）の場合は
    // incrementTimeout を呼ばずに早期リターンする。
    let acted = false;
    if (phase.startsWith('draw')) {
      const room    = getOrCreateRoom(rid);
      const indices = room._selectedIndices[playerId] ?? [];
      acted = !!drawCards(rid, playerId, indices);
    } else if (phase.startsWith('bet')) {
      acted = !!betAction(rid, playerId, 'fold');
    }

    if (!acted) {
      console.log(`[timeout-skip] ${playerId}: action already resolved, skip count`);
      return;
    }

    _broadcast(io, rid);
    const room = getOrCreateRoom(rid);
    if (room?.phase === 'showdown') { io.to(rid).emit('showdown'); if (room.isZoomTable) handleZoomShowdown(io, rid); else _scheduleAutoStart(io, rid); }

    // 連続タイムアウトカウント → 3回で退室
    // タイマー切れ直前のアクションが I/O フェーズで到達して resetTimeout を
    // 呼ぶ可能性があるため、200ms の猶予を設けてから kick を確定する。
    const shouldKick = incrementTimeout(rid, playerId);
    if (shouldKick) {
      setTimeout(() => {
        const room2   = getOrCreateRoom(rid);
        const player2 = room2?.players.find((p) => p.id === playerId);
        if (!player2 || (player2.timeoutCount ?? 0) < 3) {
          console.log(`[kick-timeout-cancel] ${playerId}: action arrived within grace period`);
          return;
        }
        console.log(`[kick-timeout] ${playerId} in ${rid} (3 consecutive timeouts)`);
        leaveRoom(playerId);
        const targetSocket = io.sockets.sockets.get(playerId);
        if (targetSocket) {
          targetSocket.emit('kicked', { reason: '連続タイムアウトにより退室されました' });
          targetSocket.leave(rid);
        }
        io.emit('roomList', getLobbyList());
        _broadcastLobbyUpdate(io, rid);
        _broadcast(io, rid);
      }, 200);
    }
  };
}

// ==========================================================
// ■ 退室予約管理
// ==========================================================
// socketId → 'afterHand' | 'nextBB'
const leaveReservations = new Map();

function _doReservedLeave(io, socketId, roomId) {
  leaveReservations.delete(socketId);
  leaveRoom(socketId);
  const sock = io.sockets.sockets.get(socketId);
  if (sock) {
    sock.leave(roomId);
    sock.emit('kicked', { reason: 'reserved' });
  }
  io.emit('roomList', getLobbyList());
  _broadcastLobbyUpdate(io, roomId);
  _broadcast(io, roomId);
}

function _processLeaveReservations(io, roomId) {
  const room = getOrCreateRoom(roomId);
  if (!room) return;

  // 次ゲームのBBになるプレイヤーのsocketId
  // _processLeaveReservations は startGame() の前に呼ばれるため
  // 「現在のfixedBbIdx」の次の位置が次のBBになる（通常: BBの左隣がDealer翌ハンドのSB、さらにその左がBB）
  // 簡易計算: 現dealerIdxから順に次のBBを特定
  const players = room.players;
  let nextBbSocketId = null;
  if (players.length >= 2 && room.dealerIndex >= 0) {
    // 次のハンドのdealer = 現dealerの左隣の非sittingOut
    let nextDealer = (room.dealerIndex + 1) % players.length;
    for (let t = 0; t < players.length; t++) {
      if (!players[nextDealer]?.sittingOut) break;
      nextDealer = (nextDealer + 1) % players.length;
    }
    if (players.length === 2) {
      // ヘッズアップ: nextDealer = SB、相手がBB
      const nextBbIdx = (nextDealer + 1) % players.length;
      nextBbSocketId = players[nextBbIdx]?.id;
    } else {
      // 通常: nextDealer→SB→BB
      let sb = (nextDealer + 1) % players.length;
      for (let t = 0; t < players.length; t++) {
        if (!players[sb]?.sittingOut) break;
        sb = (sb + 1) % players.length;
      }
      let bb = (sb + 1) % players.length;
      for (let t = 0; t < players.length; t++) {
        if (!players[bb]?.sittingOut) break;
        bb = (bb + 1) % players.length;
      }
      nextBbSocketId = players[bb]?.id;
    }
  }

  for (const player of [...players]) {
    const reservation = leaveReservations.get(player.id);
    if (!reservation) continue;

    if (reservation === 'afterHand') {
      _doReservedLeave(io, player.id, roomId);
    } else if (reservation === 'nextBB' && player.id === nextBbSocketId) {
      _doReservedLeave(io, player.id, roomId);
    }
  }
}

function _hasAnyReservation(roomId) {
  const room = getOrCreateRoom(roomId);
  if (!room) return false;
  return room.players.some((p) => leaveReservations.has(p.id));
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

// 二重スケジュール防止セット
const _pendingAutoStart = new Set();

/** ショーダウン後の自動スタート。FastFoldテーブルは即スタート、通常部屋は3秒待つ */
function _scheduleAutoStart(io, roomId) {
  const room = getOrCreateRoom(roomId);
  // 退室予約者は即退室
  _processLeaveReservations(io, roomId);
  if (room?.isZoomTable) {
    // FastFoldテーブルは即スタート
    if (canAutoStart(roomId)) _tryAutoStart(io, roomId);
  } else {
    // 通常部屋は3秒待つ（二重スケジュール防止）
    if (_pendingAutoStart.has(roomId)) return;
    _pendingAutoStart.add(roomId);
    setTimeout(() => {
      _pendingAutoStart.delete(roomId);
      if (canAutoStart(roomId)) _tryAutoStart(io, roomId);
    }, 3000);
  }
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
