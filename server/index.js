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

// .env.local を明示的に読み込む（node server/index.js 起動時は Next.js が読まないため）
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });

// NODE_ENV が未設定の場合は production にフォールバック
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';

const express    = require('express');
const next       = require('next');
const http       = require('http');
const { Server } = require('socket.io');
const { parse }  = require('url');
const cfg        = require('./config');

const { checkText } = require('./profanityFilter');
const { decode }    = require('next-auth/jwt');
const { getNickname } = require('./db/accounts');
const {
  getOrCreateRoom, joinRoom: joinPokerRoom,
  leaveRoom, startGame, drawCards, betAction, updateSelectedIndices,
  buildGameState, removePlayer, canAutoStart, getAllRooms,
  incrementTimeout, resetTimeout,
  getRoomMode, getRoom,
} = require('./poker/gameManager');

const { registerZoomHandlers, getAllPools, getWaitingCount, getTotalCount, handleZoomShowdown } = require('./zoom/zoomManager');
const tournamentManager    = require('./tournament/tournamentManager');
const tournamentBotManager = require('./tournament/tournamentBotManager');

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
console.log('🔧 サーバー起動中...');
app.prepare().then(() => {
  console.log('✓ Next.js 準備完了');
  const expressApp = express();
  const server     = http.createServer(expressApp);
  const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000', credentials: true },
  });

  // ===== Socket.IO 認証ミドルウェア =====
  const BOT_SECRET = process.env.BOT_SECRET ?? 'pastis-internal-bot';
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;

    // ボット（サーバー内部）はBOT_SECRETで認証をバイパス
    if (token === `bot:${BOT_SECRET}`) {
      const botName = socket.handshake.auth?.botName ?? 'Bot';
      socket.data.user = { accountId: `bot::${botName}`, nickname: botName, isBot: true };
      return next();
    }

    // トークンなし → ゲストとして接続を許可（ルーム一覧表示のみ）
    if (!token) {
      socket.data.user = null;
      return next();
    }
    try {
      const decoded = await decode({ token, secret: process.env.NEXTAUTH_SECRET });
      if (!decoded?.accountId) return next(new Error('AUTH_INVALID'));
      const nickname = await getNickname(decoded.accountId);
      if (!nickname) return next(new Error('NICKNAME_REQUIRED'));
      // 管理者かどうかをここで確認してキャッシュ
      const { isAdmin } = require('./db/admin');
      const admin = await isAdmin(decoded.accountId).catch(() => false);
      socket.data.user = { accountId: decoded.accountId, nickname, isAdmin: !!admin };
      next();
    } catch (err) {
      console.error('[socket-auth]', err.message);
      // 認証エラーもゲストとして接続継続
      socket.data.user = null;
      next();
    }
  });

  // ===== 二重接続防止ミドルウェア（管理者は複数接続OK）=====
  // accountId → socketId のMap
  const _connectedUsers = new Map();
  io.use((socket, next) => {
    const user = socket.data.user;
    // ゲスト・BOTはスキップ
    if (!user || user.isBot) return next();
    // 管理者は複数接続OK
    if (user.isAdmin) return next();

    const existing = _connectedUsers.get(user.accountId);
    if (existing && existing !== socket.id) {
      // 既存の接続を切断してから新しい接続を許可
      const existingSocket = io.sockets.sockets.get(existing);
      if (existingSocket) {
        existingSocket.emit('kicked', { reason: '別の端末からログインされました' });
        existingSocket.disconnect(true);
        console.log(`[duplicate-kick] ${user.nickname} の旧接続 ${existing} を切断`);
      }
    }
    _connectedUsers.set(user.accountId, socket.id);
    next();
  });

  // ===== レートリミット（20イベント/秒） =====
  const _rateCounts = new Map();
  io.use((socket, next) => {
    socket.onAny(() => {
      const now = Date.now();
      const rec = _rateCounts.get(socket.id) ?? { count: 0, resetAt: now + 1000 };
      if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 1000; }
      rec.count++;
      _rateCounts.set(socket.id, rec);
      if (rec.count > 20) { socket.disconnect(true); }
    });
    next();
  });

  // タイマーブロードキャスト（1秒ごと）
  setInterval(() => {
    for (const [roomId, room] of getAllRooms()) {
      if (!room._timerStart || !room._timerLimit) continue;
      const remaining = Math.max(0, room._timerLimit - (Date.now() - room._timerStart) / 1000);
      io.to(roomId).emit('timerUpdate', { remaining: Math.round(remaining), limit: room._timerLimit });
    }
  }, 1000);

  // トーナメントマネージャー初期化（タイムアウトハンドラを注入）
  // _makeTimeoutHandler(io, roomId) をtournamentManager用にラップ
  tournamentManager.init(io, (roomId) => _makeTimeoutHandler(io, roomId));

  io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);
    socket.emit('roomList', getLobbyList());
    let currentRoom = { name: '', roomId: '' };

    socket.on('getRoomList',    () => socket.emit('roomList', getLobbyList()));

    // ----- トーナメント：自分のテーブルを問い合わせ -----
    // drawページを直接開いた場合（t:tournamentStartingを受け取れなかった場合）に使う
    socket.on('t:getMyTable', ({ tournamentId }) => {
      const user = socket.data.user;
      if (!user?.accountId) return;
      const tableId = tournamentManager.getTableForPlayer(tournamentId, user.accountId);
      if (tableId) {
        socket.emit('t:tournamentStarting', { tournamentId, tableId });
        console.log(`[t:getMyTable] ${user.nickname} → ${tableId}`);
      } else {
        // テーブルが見つからない場合はトーナメント自体を確認
        const t = tournamentManager.getTournament(tournamentId);
        if (!t) {
          socket.emit('t:tournamentNotFound', { tournamentId });
        }
      }
    });

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
    socket.on('joinRoom', ({ roomId, password }) => {
      // 認証ミドルウェアで検証済みのニックネームを使用（クライアント送信値は無視）
      const name = socket.data.user?.nickname;
      if (!roomId || typeof roomId !== 'string' || roomId.length > 64) return;
      if (!name) return;
      const room = getOrCreateRoom(roomId);

      // パスワードチェック
      if (room.password && room.password !== password) {
        socket.emit('joinError', { message: 'パスワードが違います' });
        return;
      }

      const result = joinPokerRoom(roomId, socket.id, name);

      // 6人制限
      if (result === 'full') {
        // 同じモードで空きのある部屋を案内する
        const sameMode = getLobbyList()
          .filter(r => r.mode === room.mode && r.id !== roomId && !r.isZoom)
          .sort((a, b) => b.count - a.count);

        const MAX = room.maxPlayers ?? 6;
        const available = sameMode.filter(r => r.count < MAX);

        let message = `この部屋は満員です（最大${MAX}人）。`;
        if (available.length > 0) {
          const names = available.slice(0, 3).map(r => `${r.label}（${r.count}/${MAX}人）`).join('、');
          message += ` 空きのある部屋: ${names}`;
        } else if (sameMode.length > 0) {
          message += ' 同じモードの他の部屋も現在満員です。';
        } else {
          message += ' 別の部屋をお試しください。';
        }

        socket.emit('joinError', { message, fullRoomId: roomId });
        return;
      }

      // ゲーム進行中に pending で入室した場合：
      //   トーナメントテーブル、ボット → pending のまま待機（既存動作）
      //   通常リングゲームの人間プレイヤー → pending のまま待機し「次のハンドから参加」を通知
      if (result === 'pending' && !tournamentManager.isTournamentTable(roomId)) {
        // pending 待機中であることを本人に通知（入室はできているが次ゲーム待ち）
        socket.emit('pendingJoin', { message: 'ゲーム進行中です。次のハンドから自動的に参加します。' });
      }

      socket.join(roomId);
      currentRoom = { name, roomId };
      console.log(`[join] "${name}" → ${roomId} (${result})`);

      io.emit('roomList', getLobbyList());
      _broadcastLobbyUpdate(io, roomId);
      _broadcast(io, roomId);

      // 自動スタート（waiting + 2人以上、canAutoStart で pendingPlayers も含めてチェック）
      if (canAutoStart(roomId)) {
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
      if (!roomId || typeof roomId !== 'string' || roomId.length > 64) return;
      if (!Array.isArray(indices) || indices.length > 5) return;
      updateSelectedIndices(roomId, socket.id, indices);
    });

    // ----- カードを交換 -----
    socket.on('drawCards', ({ roomId, indices }) => {
      if (!roomId || typeof roomId !== 'string' || roomId.length > 64) return;
      if (!Array.isArray(indices) || indices.length > 5) return;
      const room = drawCards(roomId, socket.id, indices);
      if (!room) { socket.emit('error', { message: 'ドローできません（あなたのターンではありません）' }); return; }
      resetTimeout(roomId, socket.id);  // アクション成功 → タイムアウトカウントリセット
      _broadcast(io, roomId);
      // ZoomテーブルはzoomManagerが管理するためindex.jsからはautoStartしない
      if (room.phase === 'showdown') { io.to(roomId).emit('showdown'); if (room.isZoomTable) handleZoomShowdown(io, roomId); else _scheduleAutoStart(io, roomId); }
    });

    // ----- ベットアクション -----
    const VALID_ACTIONS = new Set(['fold','check','call','bet','raise']);
    socket.on('betAction', ({ roomId, action }) => {
      if (!roomId || typeof roomId !== 'string' || roomId.length > 64) return;
      if (!action || !VALID_ACTIONS.has(action)) return;
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
      // トーナメントテーブルでは退室予約を受け付けない
      if (tournamentManager.isTournamentTable(roomId)) {
        socket.emit('error', { message: 'トーナメント中は退室予約できません' });
        return;
      }
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

    // ----- 観戦（トーナメントテーブル専用）-----
    socket.on('spectate', ({ tableId }) => {
      if (!tableId || typeof tableId !== 'string' || tableId.length > 64) return;
      if (!tournamentManager.isTournamentTable(tableId)) {
        socket.emit('error', { message: 'この部屋は観戦できません' });
        return;
      }
      // 既存の観戦を解除
      if (currentRoom.roomId && currentRoom.roomId !== tableId) {
        socket.leave(currentRoom.roomId);
        _spectators.get(currentRoom.roomId)?.delete(socket.id);
      }
      socket.join(tableId);
      currentRoom = { name: socket.data.user?.nickname ?? '', roomId: tableId };
      if (!_spectators.has(tableId)) _spectators.set(tableId, new Set());
      _spectators.get(tableId).add(socket.id);
      console.log(`[spectate] ${socket.id} → ${tableId}`);

      // 現在の状態を即配信（手札は伏せる）
      const room = getOrCreateRoom(tableId);
      const state   = buildGameState(room, null);  // null = 自分なし = 全部 '??'
      const meta    = state.find((x) => x._meta);
      const players = state.filter((x) => !x._meta);
      socket.emit('gameState', { players, meta, isSpectator: true });
    });

    socket.on('disconnect', () => {
      console.log(`[disconnect] ${socket.id}`);
      leaveReservations.delete(socket.id);
      _rateCounts.delete(socket.id);
      // 二重接続管理マップから削除（自分が最新の接続の場合のみ）
      const user = socket.data.user;
      if (user?.accountId && _connectedUsers.get(user.accountId) === socket.id) {
        _connectedUsers.delete(user.accountId);
      }
      // 観戦者リストからも除去
      if (currentRoom.roomId) _spectators.get(currentRoom.roomId)?.delete(socket.id);
      if (!currentRoom.roomId) return;
      const roomId = currentRoom.roomId;

      if (tournamentManager.isTournamentTable(roomId)) {
        // トーナメントテーブル: 即退室せず3分猶予
        _startTournamentDisconnectGrace(io, socket.id, roomId);
      } else {
        _handleLeave(io, socket, roomId);
      }
    });
  });

  // adminMonitor は express.json() が必要なので、そのルートだけに適用
  const adminMonitor = require('./adminMonitor');
  adminMonitor.setIo(io);
  expressApp.use('/api/admin/monitor', express.json(), adminMonitor.router);

  // ヘルスチェック（render.yaml の healthCheckPath）
  expressApp.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), ts: Date.now() });
  });

  expressApp.use((req, res, nxt) => {
    if (req.path.startsWith('/socket.io')) return nxt();
    handle(req, res, parse(req.url, true));
  });

  const PORT = process.env.PORT ?? 3000;
  server.listen(PORT, () => {
    console.log(`🃏 ${cfg.SITE_NAME} → http://localhost:${PORT}`);
    // サーバー起動後にトーナメント自動開始スケジューラを起動
    _startTournamentScheduler(io);
  });
}).catch((err) => {
  console.error('❌ サーバー起動エラー:', err);
  process.exit(1);
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

        if (tournamentManager.isTournamentTable(rid)) {
          // トーナメント: 脱落扱いで強制退場
          tournamentManager.handleForcedLeave(rid, playerId, 'timeout-kick');
        } else {
          leaveRoom(playerId);
        }

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

// ==========================================================
// ■ 観戦者管理（トーナメントテーブル専用）
// ==========================================================
// tableId → Set<socketId>
const _spectators = new Map();

// ==========================================================
// ■ トーナメント切断猶予管理（3分）
// ==========================================================
// socketId → { roomId: string, timer: NodeJS.Timeout }
const _tournamentGraceTimers = new Map();
const TOURNAMENT_DISCONNECT_GRACE_MS = 3 * 60 * 1000; // 3分

function _startTournamentDisconnectGrace(io, socketId, roomId) {
  // 既存タイマーがあればキャンセル（再接続→再切断時）
  _cancelTournamentDisconnectGrace(socketId);

  // プレイヤーを disconnected としてマーク（UI表示用）
  const room = getOrCreateRoom(roomId);
  const player = room?.players.find((p) => p.id === socketId);
  if (player) player.disconnected = true;
  _broadcast(io, roomId);

  console.log(`[t:grace-start] ${socketId} in ${roomId} – 3min grace`);

  const timer = setTimeout(() => {
    _tournamentGraceTimers.delete(socketId);
    console.log(`[t:grace-expire] ${socketId} in ${roomId} – forced leave`);
    tournamentManager.handleForcedLeave(roomId, socketId, 'disconnect-timeout');
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) targetSocket.leave(roomId);
    io.emit('roomList', getLobbyList());
    _broadcastLobbyUpdate(io, roomId);
    _broadcast(io, roomId);
  }, TOURNAMENT_DISCONNECT_GRACE_MS);

  _tournamentGraceTimers.set(socketId, { roomId, timer });
}

function _cancelTournamentDisconnectGrace(socketId) {
  const entry = _tournamentGraceTimers.get(socketId);
  if (!entry) return;
  clearTimeout(entry.timer);
  _tournamentGraceTimers.delete(socketId);
  console.log(`[t:grace-cancel] ${socketId} reconnected`);
}

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

  // プレイヤーへ配信（手札あり）
  for (const player of [...room.players, ...room.pendingPlayers]) {
    const s = io.sockets.sockets.get(player.id);
    if (!s) continue;
    const state   = buildGameState(room, player.id);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    s.emit('gameState', { players, meta });
  }

  // 観戦者へ配信（手札は伏せる）
  const spectators = _spectators.get(roomId);
  if (spectators && spectators.size > 0) {
    const state   = buildGameState(room, null);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    for (const sid of spectators) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('gameState', { players, meta, isSpectator: true });
    }
  }

  // トーナメント BOT: ターンが来ていれば自動アクション
  if (tournamentManager.isTournamentTable(roomId)) {
    tournamentBotManager.triggerBotActions(roomId, (tblId) => {
      _broadcast(io, tblId);
      const r = getOrCreateRoom(tblId);
      if (r?.phase === 'showdown') {
        io.to(tblId).emit('showdown');
        _scheduleAutoStart(io, tblId);
      }
    });
  }
}

// ==========================================================
// ■ トーナメント自動開始スケジューラ
// ==========================================================
function _startTournamentScheduler(io) {
  const sql            = require('./db/client');
  const { getTournament: getTournamentDB, getEntries } = require('./db/tournament');
  const { updateTournamentStatus } = require('./db/admin');
  const { startTournament }        = require('./tournament/tournamentManager');

  const _scheduled = new Set();

  async function _launchTournament(tournamentId) {
    if (_scheduled.has(tournamentId)) return;
    _scheduled.add(tournamentId);

    if (tournamentManager.getTournament(tournamentId)) {
      console.log(`[scheduler] ${tournamentId}: already running in memory`);
      return;
    }

    try {
      const dbTournament = await getTournamentDB(tournamentId);
      if (!dbTournament || dbTournament.status !== 'registering') return;

      const entries = await getEntries(tournamentId);
      if (entries.length < 2) {
        console.log(`[scheduler] ${tournamentId}: only ${entries.length} player(s), skip`);
        await updateTournamentStatus(tournamentId, 'cancelled');
        return;
      }

      await updateTournamentStatus(tournamentId, 'running');

      const players = entries.map(e => ({
        accountId: e.account_id,
        nickname:  e.nickname ?? e.google_name ?? e.account_id.slice(0, 8),
      }));

      const tournament = startTournament({
        id:            tournamentId,
        name:          dbTournament.name,
        mode:          dbTournament.mode,
        startingChips: dbTournament.starting_chips,
        scheduleId:    dbTournament.blind_schedule_id ?? 'default',
        players,
        scheduleData:  dbTournament.blind_levels ?? null,
      });

      if (tournament) {
        console.log(`[scheduler] ${tournamentId}: auto-started (${players.length} players, ${tournament.tableIds.length} tables)`);
        for (const tableId of tournament.tableIds) {
          io.emit('t:tournamentStarting', { tournamentId, tableId });
        }
      }
    } catch (err) {
      console.error(`[scheduler] ${tournamentId}: error`, err.message);
      _scheduled.delete(tournamentId);
    }
  }

  async function _scan() {
    try {
      const rows = await sql`
        SELECT id, scheduled_start_at
        FROM tournaments
        WHERE status = 'registering'
        ORDER BY scheduled_start_at ASC
        LIMIT 50
      `;

      const now = Date.now();
      for (const row of rows) {
        const startAt = new Date(row.scheduled_start_at).getTime();
        const diff    = startAt - now;

        if (diff <= 0) {
          _launchTournament(row.id);
        } else if (!_scheduled.has(row.id)) {
          console.log(`[scheduler] ${row.id}: scheduled in ${Math.round(diff / 1000)}s`);
          _scheduled.add(row.id);
          setTimeout(() => {
            _scheduled.delete(row.id);
            _launchTournament(row.id);
          }, diff);
        }
      }
    } catch (err) {
      console.error('[scheduler] scan error:', err.message);
    }
  }

  _scan();
  setInterval(_scan, 60 * 1000);
  console.log('[scheduler] tournament auto-start scheduler running');
}
