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

const { log, logDev } = require('./logger');

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
  getRoomMode, getRoom, ensurePotsAwarded,
  isStudMode, isMixMode, getMixCurrentMode, advanceModeRotation, peekNextMode,
  advanceDealerButton, advanceBbAnchor,
} = require('./poker/gameManager');

const studManager = require('./poker/studManager');
const studBotManager = require('./poker/studBotManager');

const ringDb = require('./db/ring');
const tcManager = require('./poker/threeCardManager');

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
  // スリーカードポーカーテーブル
  for (const t of tcManager.listRooms()) {
    list.push({
      id:          t.id,
      label:       `Three Card Poker ${t.id.replace('3card-room-', '')}`,
      mode:        '3card',
      count:       t.players.length,
      maxPlayers:  tcManager.MAX_PLAYERS,
      phase:       t.phase,
      isThreeCard: true,
    });
  }
  return list;
}

// ==========================================================
// ■ サーバー起動
// ==========================================================
log('🔧 サーバー起動中...');

// ===== 必須環境変数チェック =====
const REQUIRED_ENV = ['NEXTAUTH_SECRET', 'DATABASE_URL', 'BOT_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup] ❌ 必須環境変数 ${key} が未設定です。サーバーを終了します。`);
    process.exit(1);
  }
}

app.prepare().then(async () => {
  log('✓ Next.js 準備完了');

  // ===== 自動マイグレーション =====
  try {
    const sql = require('./db/client');
    await sql`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS late_reg_minutes INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS late_reg_closed_at TIMESTAMPTZ`;
    await sql`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournament_mode_check`;
    await sql`
      ALTER TABLE tournaments
      ADD CONSTRAINT tournament_mode_check
      CHECK (mode IN ('27','badugi','mix','a5','27sd','mix3','beast+','stud_mix','stud_s','stud_e','razz'))
    `;
    log('✓ DB migration: tournament base schema OK');
  } catch (e) {
    console.warn('⚠ DB migration warning:', e.message);
  }
  try {
    await ringDb.ensureRingTable();
    log('✓ DB migration: ring_hand_results OK');
  } catch (e) {
    console.warn('⚠ DB migration warning (ring):', e.message);
  }

  const expressApp = express();
  const server     = http.createServer(expressApp);
  const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000', credentials: true },
  });

  // ===== Socket.IO 認証ミドルウェア =====
  const BOT_SECRET = process.env.BOT_SECRET;
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
        log(`[duplicate-kick] ${user.nickname} の旧接続 ${existing} を切断`);
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
  tournamentManager.init(io, (roomId) => _makeTimeoutHandler(io, roomId), null, (accountId) => _connectedUsers.get(accountId) ?? null);

  // BOT モデルのプリロード（起動時に全 ONNX セッションをメモリに展開）
  const { preloadAll: preloadBotModels } = require('./poker/botModel');
  preloadBotModels().catch(err => log(`[BotModel] preload error: ${err.message}`));

  io.on('connection', (socket) => {
    logDev(`[connect] ${socket.id}`);
    socket.emit('roomList', getLobbyList());
    let currentRoom = { name: '', roomId: '' };

    socket.on('getRoomList',    () => socket.emit('roomList', getLobbyList()));

    // ----- トーナメント：自分のテーブルを問い合わせ -----
    // drawページを直接開いた場合（t:tournamentStartingを受け取れなかった場合）に使う
    socket.on('t:getMyTable', ({ tournamentId }) => {
      const user = socket.data.user;
      if (!user?.accountId) return;
      let tableId = tournamentManager.getTableForPlayer(tournamentId, user.accountId);
      // getTableForPlayer が null の場合、nickname でも検索する（accountId が未設定の場合の補完）
      if (!tableId && user.nickname) {
        const { getOrCreateRoom: _scanRoom } = require('./poker/gameManager');
        const t0 = tournamentManager.getTournament(tournamentId);
        if (t0) {
          for (const tid of t0.tableIds) {
            const r0 = _scanRoom(tid);
            if (!r0) continue;
            const found0 = [...r0.players, ...r0.pendingPlayers].find(p => p.name === user.nickname);
            if (found0) {
              // accountId を補完: 再接続時にサーバー再起動でaccountIdが消えた場合の復元。
              // found0 はゲームState内プレイヤーへの参照だが、accountIdの補完のみを行い
              // ゲームロジックに影響する他フィールドは変更しないため副作用は限定的。
              if (!found0.accountId && user.accountId) found0.accountId = user.accountId;
              tableId = tid;
              logDev(`[t:getMyTable] ${user.nickname}: found by nickname on ${tid.slice(-8)} (accountId補完)`);
              break;
            }
          }
        }
      }
      if (tableId) {
        // pendingPlayersにいるかどうか確認
        const { getOrCreateRoom } = require('./poker/gameManager');
        const room = getOrCreateRoom(tableId);
        const pendingPlayer = room?.pendingPlayers?.find(p =>
          p.accountId === user.accountId || p.name === user.nickname
        );
        if (pendingPlayer) {
          // pending中に再接続: socket IDを更新してpending通知を送信
          const oldSocketId = pendingPlayer.id;
          if (oldSocketId && oldSocketId !== socket.id) {
            _cancelTournamentDisconnectGrace(oldSocketId);
          }
          pendingPlayer.id = socket.id;
          pendingPlayer.disconnected = false;
          socket.join(tableId);
          _removeSpectatorSocket(socket.id, tableId);
          currentRoom = { name: user.nickname ?? '', roomId: tableId };
          socket.emit('t:pendingTableTransfer', { tableId, message: '次のハンドから参加します' });
          // 【重要】pending プレイヤーにも現在の gameState を送信する。
          // クライアント側は isPendingPlayer フラグで「次のハンドから参加します」表示に切り替わる。
          {
            _emitStateToSocket(socket, tableId);
            const statusPayload = tournamentManager.getTournamentStatusPayload(tournamentId);
            if (statusPayload) socket.emit('t:tournamentStatus', statusPayload);
            const blindPayload = tournamentManager.getCurrentBlindPayload(tournamentId);
            if (blindPayload) socket.emit('t:blindUpdate', blindPayload);
          }
          log(`[t:getMyTable] ${user.nickname} → ${tableId.slice(-8)} (pending reconnect, chips=${pendingPlayer.chips}, oldSocket=${String(oldSocketId).slice(-8)}, newSocket=${socket.id.slice(-8)})`);
        } else {
          // 再接続: room.players の socket.id を即座に更新する。
          // t:tournamentStarting → フロントの joinRoom 到達までの非同期の隙間に
          // betAction が送られると "そのアクションはできません" エラーになるバグを防ぐ。
          const activePlayer = room?.players.find(p =>
            p.accountId === user.accountId || p.name === user.nickname
          );
          if (activePlayer && activePlayer.id !== socket.id) {
            _cancelTournamentDisconnectGrace(activePlayer.id);
            activePlayer.id = socket.id;
            activePlayer.disconnected = false;
            // スタッド進行中の場合、studManager 側の id も同期する。
            // これを怠ると手番照合・チップ書き戻しが id 不一致で失敗する。
            studManager.updateStudPlayerSocketId(tableId, user.accountId, user.nickname, socket.id);
            logDev(`[t:getMyTable] ${user.nickname}: player.id updated → ${socket.id}`);
          }
          // _disconnectedChips に退避されたチップを復元（leaveRoom済みプレイヤーは activePlayer=null になるため別途処理）
          socket.join(tableId);
          _removeSpectatorSocket(socket.id, tableId);
          currentRoom = { name: user.nickname ?? '', roomId: tableId };
          socket.emit('t:tournamentStarting', { tournamentId, tableId });
          logDev(`[t:getMyTable] ${user.nickname} → ${tableId}`);
          // 【重要】player.id 更新後、本人に gameState を直接送信する。
          //
          // 理由: startGame 時の _broadcast は player.id がまだ accountId のままで
          //       io.sockets.sockets.get(accountId) が undefined を返し本人に送信スキップされる。
          //       その後 t:getMyTable で player.id を socket.id に更新しても、
          //       次の _broadcast が起きるまで（誰かのアクションまで）本人画面に gameState が届かない。
          //       結果として「もう1人参加を待っています」画面で固まる致命的バグ。
          //
          // 解決: player.id 更新後に必ず本人へ buildGameState を emit する。
          {
            _emitStateToSocket(socket, tableId);
          }
          // 接続直後に現在のステータスを本人のソケットに直接送信（残り人数・ブラインドを即表示）
          {
            const statusPayload = tournamentManager.getTournamentStatusPayload(tournamentId);
            if (statusPayload) socket.emit('t:tournamentStatus', statusPayload);
            const blindPayload = tournamentManager.getCurrentBlindPayload(tournamentId);
            if (blindPayload) socket.emit('t:blindUpdate', blindPayload);
          }
        }
      } else {
        // テーブルが見つからない場合はトーナメント自体を確認
        // _launchTournament（DBロード・BOTスポーン）がまだ完了していない場合と
        // scheduled in Xs でまだ起動前の場合の両方に対応するため
        // DBでステータスを確認してからリトライ判断する
        const _retryGetTable = async (retriesLeft) => {
          // まずメモリを確認
          const t = tournamentManager.getTournament(tournamentId);
          if (!t) {
            // メモリになければDBを確認（registering/runningなら待機続行）
            if (retriesLeft > 0) {
              try {
                const dbT = await require('./db/tournament').getTournament(tournamentId);
                if (dbT && (dbT.status === 'registering' || dbT.status === 'running')) {
                  // 最初の1回と10回ごとにのみログ出力（スパム防止）
                  if (retriesLeft === 120 || retriesLeft % 10 === 0) {
                    log(`[t:getMyTable] ${user.nickname}: waiting for tournament (status=${dbT.status}), ${retriesLeft} retries left`);
                  }
                  setTimeout(() => _retryGetTable(retriesLeft - 1), 500);
                  return;
                }
                if (!dbT) {
                  log(`[t:getMyTable] ${user.nickname}: tournament ${tournamentId.slice(-8)} not found in DB → notFound`);
                }
              } catch (_) {}
            }
            socket.emit('t:tournamentNotFound', { tournamentId });
            return;
          }
          // メモリにある → テーブルを再検索
          const retryTableId = tournamentManager.getTableForPlayer(tournamentId, user.accountId);
          if (retryTableId) {
            const { getOrCreateRoom: _gor } = require('./poker/gameManager');
            const _room = _gor(retryTableId);
            const _pending = _room?.pendingPlayers?.find(p =>
              p.accountId === user.accountId || p.name === user.nickname
            );
            if (_pending) {
              const _oldSocketId = _pending.id;
              if (_oldSocketId && _oldSocketId !== socket.id) {
                _cancelTournamentDisconnectGrace(_oldSocketId);
              }
              _pending.id = socket.id;
              _pending.disconnected = false;
              socket.join(retryTableId);
              _removeSpectatorSocket(socket.id, retryTableId);
              currentRoom = { name: user.nickname ?? '', roomId: retryTableId };
              socket.emit('t:pendingTableTransfer', { tableId: retryTableId, message: '次のハンドから参加します' });
              // pending プレイヤーにも gameState を送信（即時画面更新のため）
              _emitStateToSocket(socket, retryTableId);
              const _sp = tournamentManager.getTournamentStatusPayload(tournamentId);
              if (_sp) socket.emit('t:tournamentStatus', _sp);
              const _bp = tournamentManager.getCurrentBlindPayload(tournamentId);
              if (_bp) socket.emit('t:blindUpdate', _bp);
              log(`[t:getMyTable-retry] ${user.nickname} → ${retryTableId.slice(-8)} (pending reconnect, chips=${_pending.chips}, oldSocket=${String(_oldSocketId).slice(-8)}, newSocket=${socket.id.slice(-8)})`);
            } else {
              // 【重要】retry成功時にも player.id を即更新する。
              // 更新しないと _broadcast が socket を見つけられず gameState が届かない。
              const _ap = _room?.players.find(p =>
                p.accountId === user.accountId || p.name === user.nickname
              );
              if (_ap && _ap.id !== socket.id) {
                _cancelTournamentDisconnectGrace(_ap.id);
                _ap.id = socket.id;
                _ap.disconnected = false;
                studManager.updateStudPlayerSocketId(retryTableId, user.accountId, user.nickname, socket.id);
                log(`[t:getMyTable-retry] ${user.nickname}: player.id updated → ${socket.id}`);
              }
              socket.join(retryTableId);
              _removeSpectatorSocket(socket.id, retryTableId);
              currentRoom = { name: user.nickname ?? '', roomId: retryTableId };
              socket.emit('t:tournamentStarting', { tournamentId, tableId: retryTableId });
              // gameState を本人に直接送信（_broadcast 待ちにしない）
              _emitStateToSocket(socket, retryTableId);
              // 接続直後に現在のステータスを本人のソケットに直接送信
              {
                const statusPayload = tournamentManager.getTournamentStatusPayload(tournamentId);
                if (statusPayload) socket.emit('t:tournamentStatus', statusPayload);
                const blindPayload = tournamentManager.getCurrentBlindPayload(tournamentId);
                if (blindPayload) socket.emit('t:blindUpdate', blindPayload);
              }
            }
            log(`[t:getMyTable] ${user.nickname} → ${retryTableId} (after retry)`);
            return;
          }
          // テーブルはまだ未割当だがメモリにはある
          // 脱落済みプレイヤーは早期チェックしてリトライを打ち切る
          // （最初のリトライ時と10回ごとにチェック）
          if (retriesLeft === 120 || retriesLeft % 10 === 0) {
            if (t.eliminationOrder?.includes(user.accountId)) {
              log(`[t:getMyTable] ${user.nickname}: eliminated (early detect) → redirect to spectate`);
              socket.emit('t:eliminatedSpectate', { tournamentId });
              return;
            }
          }
          // レイトレジスト中（lateRegOpen=true）なら即座に配置する（60秒待ちをスキップ）
          if (t.status === 'running' && t.lateRegOpen) {
            // 脱落済みプレイヤーは配置しない
            if (t.eliminationOrder?.includes(user.accountId)) {
              log(`[t:getMyTable] ${user.nickname}: already eliminated → redirect to spectate`);
              // 脱落済みプレイヤーは観戦モードへ誘導
              socket.emit('t:eliminatedSpectate', { tournamentId });
              return;
            }
            log(`[t:getMyTable] ${user.nickname}: lateReg immediate placement (status=${t.status})`);
          } else if (retriesLeft > 0) {
            if (retriesLeft === 120 || retriesLeft % 10 === 0) {
              log(`[t:getMyTable] ${user.nickname}: in memory but table not assigned, ${retriesLeft} retries left (status=${t.status})`);
            }
            setTimeout(() => _retryGetTable(retriesLeft - 1), 500);
            return;
          }
          log(`[t:getMyTable] ${user.nickname}: retry exhausted, status=${t.status} lateRegOpen=${t.lateRegOpen}`);

          // _disconnectedChips に退避済みの場合: チップを復元して再配置
          const _dcMap = tournamentManager.getDisconnectedChips();
          const _dcEntry = _dcMap.get(user.accountId);
          if (_dcEntry) {
            const { getOrCreateRoom: _gcr2, canAutoStart: _cas2 } = require('./poker/gameManager');
            _dcMap.delete(user.accountId);
            log(`[t:getMyTable] ${user.nickname}: restoring from disconnectedChips chips=${_dcEntry.chips}`);
            // 退避時のテーブルが生きているか確認
            const _restoreRoom = _gcr2(_dcEntry.tableId);
            const _stillValid  = t.tableIds.includes(_dcEntry.tableId) && _restoreRoom;
            const _destTid2    = _stillValid
              ? _dcEntry.tableId
              : (t.tableIds.find(tid => { const r = _gcr2(tid); return r && r.players.length < 6; }) ?? null);
            if (_destTid2) {
              const { joinRoom: _jr2 } = require('./poker/gameManager');
              const _nick2 = user.nickname ?? user.accountId.slice(0, 8);
              _jr2(_destTid2, socket.id, _nick2, { accountId: user.accountId, existingChips: _dcEntry.chips });
              socket.join(_destTid2);
              _removeSpectatorSocket(socket.id, _destTid2);
              socket.emit('t:tournamentStarting', { tournamentId, tableId: _destTid2 });
              const _sp2 = tournamentManager.getTournamentStatusPayload(tournamentId);
              if (_sp2) socket.emit('t:tournamentStatus', _sp2);
              const _bp2 = tournamentManager.getCurrentBlindPayload(tournamentId);
              if (_bp2) socket.emit('t:blindUpdate', _bp2);
              const { _broadcast: _bc2 } = require('./poker/gameManager');
              // _broadcast は index.js スコープ関数なので直接呼ぶ
              _broadcast(io, _destTid2);
              if (_cas2(_destTid2)) _tryAutoStart(io, _destTid2);
              log(`[lateReg] ${_nick2} restored to ${_destTid2.slice(-8)} (chips=${_dcEntry.chips})`);
              return;
            }
          }

          if (t.lateRegOpen) {
          // レイトレジスト期間中: 最も人数が少ないテーブルに配置する
          const { getOrCreateRoom, canAutoStart } = require('./poker/gameManager');

          // 配置直前に既存テーブルを再確認する（accountId + nickname 両方で検索）
          const getOrCreateRoomLocal = getOrCreateRoom;
          let existingTidFinal = tournamentManager.getTableForPlayer(tournamentId, user.accountId);
          // accountId で見つからない場合は nickname でフォールバック検索
          if (!existingTidFinal && user.nickname) {
            const _t2 = tournamentManager.getTournament(tournamentId);
            if (_t2) {
              for (const _tid2 of _t2.tableIds) {
                const _r2 = getOrCreateRoomLocal(_tid2);
                if (!_r2) continue;
                const _fp2 = [..._r2.players, ..._r2.pendingPlayers].find(p => p.name === user.nickname);
                if (_fp2) {
                  if (!_fp2.accountId && user.accountId) _fp2.accountId = user.accountId;
                  existingTidFinal = _tid2;
                  log(`[lateReg] ${user.nickname}: found by nickname on ${_tid2.slice(-8)} (accountId補完)`);
                  break;
                }
              }
            }
          }
          if (existingTidFinal) {
            const _nickname = user.nickname ?? user.accountId.slice(0, 8);
            log(`[lateReg] ${_nickname} already on ${existingTidFinal.slice(-8)} → reconnect (skip fresh placement)`);
            const existingRoom = getOrCreateRoom(existingTidFinal);
            const existingPlayer = existingRoom?.players.find(p => p.accountId === user.accountId || p.name === user.nickname)
                                ?? existingRoom?.pendingPlayers?.find(p => p.accountId === user.accountId || p.name === user.nickname);
            if (existingPlayer) {
              const oldSocketId = existingPlayer.id;
              if (oldSocketId && oldSocketId !== socket.id) {
                _cancelTournamentDisconnectGrace(oldSocketId);
              }
              existingPlayer.id = socket.id;
              existingPlayer.disconnected = false;
              studManager.updateStudPlayerSocketId(existingTidFinal, user.accountId, user.nickname, socket.id);
              log(`[lateReg] ${_nickname}: existing reconnect on ${existingTidFinal.slice(-8)} chips=${existingPlayer.chips} oldSocket=${String(oldSocketId).slice(-8)} newSocket=${socket.id.slice(-8)}`);
            }
            socket.join(existingTidFinal);
            _removeSpectatorSocket(socket.id, existingTidFinal);
            const statusPayloadF = tournamentManager.getTournamentStatusPayload(tournamentId);
            if (statusPayloadF) socket.emit('t:tournamentStatus', statusPayloadF);
            const blindPayloadF = tournamentManager.getCurrentBlindPayload(tournamentId);
            if (blindPayloadF) socket.emit('t:blindUpdate', blindPayloadF);
            socket.emit('t:tournamentStarting', { tournamentId, tableId: existingTidFinal });
            _emitStateToSocket(socket, existingTidFinal);
            _broadcast(io, existingTidFinal);
          } else {
            // 本当に新規: まず DB のエントリー登録を確認する。
            // 【重要・セキュリティ】レイトレジ受付中(lateRegOpen)でも、実際に
            // エントリー登録していないユーザーを着席させてはならない。
            // この確認が無いと、未登録ユーザーが t:getMyTable を送るだけで
            // 進行中トーナメントに勝手に座れてしまう（既知バグ）。
            let _isRegistered = false;
            try {
              _isRegistered = await require('./db/tournament').isRegistered(tournamentId, user.accountId);
            } catch (e) {
              log(`[lateReg] ${user.nickname}: isRegistered check failed: ${e?.message ?? e}`);
              _isRegistered = false; // 確認失敗時は安全側（着席させない）
            }
            if (!_isRegistered) {
              log(`[lateReg] ${user.nickname}: NOT registered → reject placement (notFound)`);
              socket.emit('t:tournamentNotFound', { tournamentId });
              return;
            }
            // 空きテーブルを探して配置
            let destTid = t.tableIds
              .map(tid => {
                const r = getOrCreateRoom(tid);
                return { tid, cnt: (r?.players.length ?? 0) + (r?.pendingPlayers.length ?? 0) };
              })
              .filter(x => x.cnt < 6)
              .sort((a, b) => a.cnt - b.cnt)[0]?.tid;
            // 全テーブルが満席なら新テーブルを作成
            if (!destTid) {
              destTid = tournamentManager.addTableToTournament(tournamentId);
              if (destTid) log(`[lateReg] added new table ${destTid.slice(-8)}`);
            }
            if (destTid) {
              const nickname = user.nickname ?? user.accountId.slice(0, 8);
              const joinResult = joinPokerRoom(destTid, socket.id, nickname, { accountId: user.accountId, existingChips: t.startingChips });
              log(`[lateReg] ${nickname}: fresh placement result=${joinResult} table=${destTid.slice(-8)} startingChips=${t.startingChips}`);
              if (joinResult === 'full') {
                log(`[lateReg] ${nickname}: placement failed, table full ${destTid.slice(-8)}`);
                socket.emit('t:tournamentNotFound', { tournamentId });
                return;
              }
              socket.join(destTid);
              _removeSpectatorSocket(socket.id, destTid);
              if (joinResult === 'active' || joinResult === 'pending') {
                tournamentManager.incrementTotalPlayers(tournamentId, 1);
              }
              socket.emit('t:tournamentStarting', { tournamentId, tableId: destTid });
              _emitStateToSocket(socket, destTid);
              io.to(destTid).emit('t:playerArrived', { playerName: nickname });
              // 【lateReg broadcast修正】スタッドハンド進行中は _broadcast を遅延させる。
              // 進行中に _broadcast(→_broadcastStud→triggerStudBotActions) を呼ぶと
              // BOTアクションチェーンが干渉してフリーズする場合があるため。
              if (_isStudHandInProgress(destTid)) {
                setTimeout(() => _broadcast(io, destTid), 3100);
              } else {
                _broadcast(io, destTid);
              }
              if (canAutoStart(destTid)) _tryAutoStart(io, destTid);
              log(`[lateReg] ${nickname} placed at ${destTid.slice(-8)}`);
              // レイトレジスト参加直後に残り人数を送信（SNG等でも即座に表示されるよう）
              tournamentManager.broadcastStatus(tournamentId);
              tournamentManager.broadcastBlind(tournamentId);

              // 配置後にテーブルバランスを確認（1人テーブルが生まれた場合に対処）
              const _lateRegBalanceRetry = (retriesLeft) => {
                setTimeout(() => {
                  const tNow = tournamentManager.getTournament(tournamentId);
                  if (!tNow || tNow.status !== 'running') return;
                  if (tNow.tableIds.length <= 1) return;
                  const newTableRoom = getOrCreateRoom(destTid);
                  const newTableCount = (newTableRoom?.players.length ?? 0) + (newTableRoom?.pendingPlayers?.length ?? 0);
                  if (newTableCount >= 2) {
                    if (canAutoStart(destTid)) _tryAutoStart(io, destTid);
                    return;
                  }
                  log(`[lateReg] retry balance (${retriesLeft} left) for ${destTid.slice(-8)}`);
                  tournamentManager.balanceTables(tournamentId);
                  for (const tid of tNow.tableIds) {
                    if (canAutoStart(tid)) _tryAutoStart(io, tid);
                  }
                  if (retriesLeft > 1) _lateRegBalanceRetry(retriesLeft - 1);
                }, 3000);
              };
              setTimeout(() => {
                const tNow = tournamentManager.getTournament(tournamentId);
                if (!tNow || tNow.status !== 'running') return;
                if (tNow.tableIds.length <= 1) return;
                log(`[lateReg] triggering balance after join`);
                tournamentManager.balanceTables(tournamentId);
                for (const tid of tNow.tableIds) {
                  if (canAutoStart(tid)) _tryAutoStart(io, tid);
                }
                const newRoom = getOrCreateRoom(destTid);
                const cnt = (newRoom?.players.length ?? 0) + (newRoom?.pendingPlayers?.length ?? 0);
                if (cnt < 2) _lateRegBalanceRetry(10);
              }, 500);
            } else {
              socket.emit('error', { message: 'テーブルに空きがありません' });
            }
          } // else: 新規 lateReg 配置
          } else {
            // lateRegOpen でなく自分のテーブルも見つからない
            // → 脱落済みかどうかを確認して適切なイベントを送信
            const _tNow = tournamentManager.getTournament(tournamentId);
            const _isEliminated = _tNow?.eliminationOrder?.includes(user.accountId);
            if (_isEliminated) {
              // 脱落済みプレイヤー → 観戦ページへ誘導（t:tournamentNotFoundではなく専用イベント）
              log(`[t:getMyTable] ${user.nickname}: eliminated → redirect to spectate`);
              socket.emit('t:eliminatedSpectate', { tournamentId });
            } else {
              // 未脱落だがテーブルが見つからない（稀な状態）→ ロビーへ
              log(`[t:getMyTable] ${user.nickname}: no table found (not eliminated) → tournamentNotFound`);
              socket.emit('t:tournamentNotFound', { tournamentId });
            }
          }
        }; // _retryGetTable end
        _retryGetTable(120); // 500ms × 120回 = 最大60秒リトライ
      }
    });

    socket.on('getRoomPlayers', (roomId) => {
      if (!roomId || typeof roomId !== 'string' || roomId.length > 64) {
        socket.emit('lobbyUpdate', []);
        return;
      }
      const room  = getRoom(roomId);
      if (!room) {
        socket.emit('lobbyUpdate', []);
        return;
      }
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
      const room = getRoom(roomId);
      if (!room) {
        socket.emit('joinError', { message: '部屋が見つかりません' });
        return;
      }
      if (tournamentManager.isTournamentTable(roomId)) {
        socket.emit('joinError', { message: 'トーナメント卓へはトーナメント画面から参加してください' });
        return;
      }

      // パスワードチェック
      if (room.password && room.password !== password) {
        socket.emit('joinError', { message: 'パスワードが違います' });
        return;
      }

      const result = joinPokerRoom(roomId, socket.id, name, {
        accountId: socket.data.user?.accountId ?? null,
      });

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
      logDev(`[join] "${name}" → ${roomId} (${result})`);

      io.emit('roomList', getLobbyList());
      _broadcastLobbyUpdate(io, roomId);
      _broadcast(io, roomId);

      // トーナメントテーブルへの参加時: 現在のブラインド情報を即座に送信
      if (tournamentManager.isTournamentTable(roomId)) {
        const t = tournamentManager.getTournamentByTable(roomId);
        if (t) {
          const blindPayload = tournamentManager.getCurrentBlindPayload(t.id);
          if (blindPayload) socket.emit('t:blindUpdate', blindPayload);
          tournamentManager._broadcastTournamentStatus(t);
        }
      }

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

    // ----- テーブル移動専用: Socket.IOルームのみ切り替え（gameManagerのjoinRoomは呼ばない） -----
    socket.on('leaveSocketRoom', ({ roomId }) => {
      if (roomId) socket.leave(roomId);
    });
    socket.on('joinSocketRoom', ({ roomId }) => {
      if (roomId && _socketBelongsToTable(socket, roomId)) {
        socket.join(roomId);
        _removeSpectatorSocket(socket.id, roomId);
        currentRoom = { name: socket.data.user?.nickname ?? '', roomId };
      }
    });

    // ----- テーブル移動後のゲーム状態取得 -----
    socket.on('getGameState', ({ roomId }) => {
      if (!roomId || typeof roomId !== 'string' || roomId.length > 64) return;
      if (!getRoom(roomId) && !studManager.getStudRoom(roomId)) return;
      _broadcast(io, roomId);
      if (tournamentManager.isTournamentTable(roomId)) {
        const t = tournamentManager.getTournamentByTable(roomId);
        if (t) {
          const blindPayload = tournamentManager.getCurrentBlindPayload(t.id);
          if (blindPayload) socket.emit('t:blindUpdate', blindPayload);
          tournamentManager._broadcastTournamentStatus(t);
        }
      }
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
      if (!getRoom(roomId)) return;  // 存在しないroomIdは無視（空ルーム生成防止）
      const room = drawCards(roomId, socket.id, indices);
      if (!room) { socket.emit('error', { message: 'ドローできません（あなたのターンではありません）' }); return; }
      resetTimeout(roomId, socket.id);  // アクション成功 → タイムアウトカウントリセット
      _broadcast(io, roomId);
      // ZoomテーブルはzoomManagerが管理するためindex.jsからはautoStartしない
      if (room.phase === 'showdown') {
        if (tournamentManager.isTournamentTable(roomId)) {
          ensurePotsAwarded(roomId);  // ポット確定後に脱落チェック
          tournamentManager.checkEliminations(roomId);
          // ※ ここで _broadcast を再送しない:
          //   checkEliminations が leaveRoom でプレイヤーを即削除するため
          //   再送すると手札表示前にプレイヤーが消えた gameState が上書きされ
          //   最終ハンドの showdown 手札が確認できなくなるバグの原因になる。
          //   次の gameState 更新は _scheduleAutoStart の 3 秒後タイマーに委譲する。
        }
        _recordRingHandResults(roomId);  // リングゲーム損益記録
        io.to(roomId).emit('showdown');
        if (room.isZoomTable) handleZoomShowdown(io, roomId);
        else _scheduleAutoStart(io, roomId);
      }
    });

    // ----- ベットアクション -----
    const VALID_ACTIONS = new Set(['fold','check','call','bet','raise']);
    // 【ブリングイン選択制】スタッド3rd street の義務者専用アクション
    const VALID_STUD_ACTIONS = new Set(['fold','check','call','bet','raise','bringIn','complete']);
    socket.on('betAction', ({ roomId, action, amount }) => {
      if (!roomId || typeof roomId !== 'string' || roomId.length > 64) return;
      // スタッドアクティブなら bringIn/complete も許可、それ以外は従来通り
      const _validSet = _isStudActive(roomId) ? VALID_STUD_ACTIONS : VALID_ACTIONS;
      if (!action || !_validSet.has(action)) return;

      // ===== スタッド系ルーティング =====
      if (_isStudActive(roomId)) {
        const sr = studManager.getStudRoom(roomId);
        const actingP = sr?.players.find((p) => p.id === socket.id);
        const updated = studManager.studBetAction(roomId, socket.id, action, 0);
        if (!updated) {
          socket.emit('error', { message: 'そのアクションはできません' });
          return;
        }
        io.to(roomId).emit('playerAction', {
          playerName: actingP ? actingP.name : '',
          action,
        });
        _broadcast(io, roomId);
        if (updated.phase === 'showdown') {
          _onStudShowdown(io, roomId);
        }
        return;
      }

      if (!getRoom(roomId)) return;  // 存在しないroomIdは無視（空ルーム生成防止）
      // amount は NL（27sd）のbet/raise時のみ有効。
      // 防御層: 厳密に number 型のみ受け入れ、文字列・boolean・object などは無視する。
      // NaN/Infinity/-Infinity も Number.isFinite で除外。betAction 内で範囲チェック実施。
      const _amt = (action === 'bet' || action === 'raise')
        && typeof amount === 'number' && Number.isFinite(amount)
        ? amount : undefined;
      // アクション前のプレイヤー名を記録
      const roomBefore = getRoom(roomId);
      const actingPlayer = roomBefore
        ? roomBefore.players.find((p) => p.id === socket.id)
        : null;
      const room = betAction(roomId, socket.id, action, _amt);
      if (!room) {
        // 原因をログ（開発環境のみ）
        const { getOrCreateRoom: _gorBet } = require('./poker/gameManager');
        const _r = _gorBet(roomId);
        // socket.id と currentPlayer.id の不一致が最も多い原因（テーブル移動後）
        const _curPlayer = _r?.players[_r?.actionIndex];
        const _idMatch = _curPlayer?.id === socket.id;
        logDev(`[betAction-debug] REJECTED user=${user?.nickname} action=${action}`);
        logDev(`[betAction-debug]   roomId=${roomId?.slice(-8)} socketId=${socket.id.slice(-8)}`);
        logDev(`[betAction-debug]   phase=${_r?.phase ?? 'no-room'} actionIdx=${_r?.actionIndex}`);
        logDev(`[betAction-debug]   currentPlayer=${_curPlayer?.name}(id=${_curPlayer?.id?.slice(-8)}) idMatch=${_idMatch}`);
        logDev(`[betAction-debug]   allPlayers=[${_r?.players?.map(p => `${p.name}:${p.id.slice(-8)}`).join(',')}]`);
        socket.emit('error', { message: 'そのアクションはできません' }); return;
      }
      resetTimeout(roomId, socket.id);
      // アクション名を全員に通知（socket.id は含めない）
      io.to(roomId).emit('playerAction', {
        playerName: actingPlayer ? actingPlayer.name : '',
        action,
      });
      _broadcast(io, roomId);
      if (room.phase === 'showdown') {
        if (tournamentManager.isTournamentTable(roomId)) {
          ensurePotsAwarded(roomId);  // ポット確定後に脱落チェック
          tournamentManager.checkEliminations(roomId);
          // ※ 2回目の _broadcast は送らない（drawCards と同様の理由）
        }
        _recordRingHandResults(roomId);  // リングゲーム損益記録
        io.to(roomId).emit('showdown');
        if (room.isZoomTable) handleZoomShowdown(io, roomId);
        else _scheduleAutoStart(io, roomId);
      }
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
    socket.on('spectate', ({ tableId: rawTableId, tournamentId }) => {
      // tableId 未指定の場合は tournamentId からアクティブなテーブルを自動解決
      let tableId = rawTableId;
      const _specTid = tournamentId; // tournamentId を後続処理でも参照
      if (!tableId && _specTid) {
        const t = tournamentManager.getTournament(_specTid);
        if (!t) {
          // トーナメントがメモリにない（終了済み等）
          socket.emit('t:tournamentNotFound', { tournamentId: _specTid });
          return;
        }
        if (t.status === 'finished') {
          // 終了済み → 結果ページへ誘導
          socket.emit('t:tournamentFinished', { rankings: [] });
          return;
        }
        tableId = t?.tableIds?.[0] ?? null;
      }
      if (!tableId || typeof tableId !== 'string' || tableId.length > 64) {
        // tableId が解決できない場合（トーナメントが起動前等）は静かに待機
        logDev(`[spectate] tableId unresolved for tournamentId=${tournamentId}`);
        return;
      }
      if (!tournamentManager.isTournamentTable(tableId)) {
        // roomToTournament に登録されていない（tableIds と不整合）
        // エラーは出さず静かに戻す（クライアントは t:tournamentStarting を待つ）
        logDev(`[spectate] ${tableId} not in roomToTournament`);
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
      logDev(`[spectate] ${socket.id} → ${tableId}`);

      // 現在の状態を即配信（手札は伏せる）
      // 【001/008 修正】スタッドがアクティブなテーブルを観戦する場合、
      // ドロー版 buildGameState を呼ぶと isStud=false の meta が届き
      // 観戦者にドローUIが誤表示される。_isStudActive で振り分ける。
      if (_isStudActive(tableId)) {
        const sr = studManager.getStudRoom(tableId);
        if (sr) {
          const sState   = studManager.buildStudGameState(sr, null);
          const sMeta    = sState.find((x) => x._meta);
          const sPlayers = sState.filter((x) => !x._meta);
          logDev(`[spectate] ${tableId.slice(-8)} STUD観戦 mode=${sMeta?.currentMode} isStud=${sMeta?.isStud}`);
          socket.emit('gameState', { players: sPlayers, meta: sMeta, isSpectator: true });
          return;
        }
      }
      const room = getOrCreateRoom(tableId);
      const state   = buildGameState(room, null);  // null = 自分なし = 全部 '??'
      const meta    = state.find((x) => x._meta);
      const players = state.filter((x) => !x._meta);
      logDev(`[spectate] ${tableId.slice(-8)} DRAW観戦 mode=${meta?.currentMode} isStud=${meta?.isStud}`);
      socket.emit('gameState', { players, meta, isSpectator: true });
    });

    // ================================================================
    // ■ スリーカードポーカー イベント
    // ================================================================

    // --- io スコープ内ヘルパー（io を直接参照できる） ---
    const tc_broadcast = (roomId) => {
      const t = tcManager.getTable(roomId);
      if (!t) return;
      for (const p of t.players) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('3c:state', tcManager.buildTableState(roomId, p.socketId));
      }
      io.emit('roomList', getLobbyList());
    };

    const tc_leave = (roomId, socketId) => {
      tcManager.leaveTable(roomId, socketId);
      const s = io.sockets.sockets.get(socketId);
      if (s) s.leave(roomId);
      io.emit('roomList', getLobbyList());
      const t = tcManager.getTable(roomId);
      if (t) tc_broadcast(roomId);
    };

    socket.on('3c:getRoomList', () => {
      const rooms = tcManager.listRooms().map(t => ({
        id:         t.id,
        label:      `Three Card Poker ${t.id.replace('3card-room-', '')}`,
        count:      t.players.length,
        maxPlayers: tcManager.MAX_PLAYERS,
        phase:      t.phase,
      }));
      socket.emit('3c:roomList', rooms);
    });

    socket.on('3c:join', async ({ roomId }) => {
      const user = socket.data.user;
      if (!user?.nickname) { socket.emit('3c:error', { message: 'ログインが必要です' }); return; }

      // ポイントチェック
      let points = 0;
      if (user.accountId) {
        try {
          const pointsDb = require('./db/points');
          points = await pointsDb.getUserPoints(user.accountId);
        } catch { points = 0; }
      }
      if (points < 1) {
        socket.emit('3c:error', { message: 'ポイントが不足しています' });
        return;
      }

      let targetRoomId = roomId;
      if (!targetRoomId) {
        // roomId 未指定 → 空きのあるテーブルに自動配置
        targetRoomId = tcManager.getOrCreateAvailableRoom().id;
      }

      // socket.join を joinTable より前に実行する。
      // joinTable 内で waiting→betting 遷移が起きると _notify→_tc_broadcast が
      // 走るため、その時点で socket がルームに参加済みである必要がある。
      socket.join(targetRoomId);

      const result = tcManager.joinTable(targetRoomId, socket.id, user.nickname, user.accountId, points);
      if (result === 'full') {
        socket.leave(targetRoomId);
        socket.emit('3c:error', { message: 'このテーブルは満員です' });
        return;
      }
      if (result !== 'ok' && result !== 'alreadyJoined') {
        socket.leave(targetRoomId);
        socket.emit('3c:error', { message: '入室できませんでした' });
        return;
      }

      // 本人に最新状態を送信（betting 遷移済みでも確実に届く）
      socket.emit('3c:state', tcManager.buildTableState(targetRoomId, socket.id));
      // 他プレイヤーにも通知
      socket.to(targetRoomId).emit('3c:state', tcManager.buildBroadcastState(targetRoomId));
      // ロビー更新
      io.emit('roomList', getLobbyList());
    });

    socket.on('3c:bet', ({ roomId, ante, pp, sixCard }) => {
      const result = tcManager.placeBet(roomId, socket.id, {
        ante:    Number(ante),
        pp:      Number(pp    ?? 0),
        sixCard: Number(sixCard ?? 0),
      });
      if (!result.ok) {
      const BET_ERROR_MSG = {
        notBetting:         'ベットフェーズではありません',
        notInRoom:          'テーブルに参加していません',
        alreadyBet:         'すでにベット確定済みです',
        invalidAnte:        `アンテは ${tcManager.BET_MIN}〜${tcManager.BET_MAX}pt で入力してください`,
        invalidPP:          `ペアプラスは 0〜${tcManager.BET_MAX}pt で入力してください`,
        invalidSixCard:     `6カードボーナスは 0〜${tcManager.BET_MAX}pt で入力してください`,
        insufficientPoints: 'ポイントが不足しています',
      };
      socket.emit('3c:error', { message: BET_ERROR_MSG[result.reason] ?? `ベットエラー: ${result.reason}` });
        return;
      }
      // 全員ベット完了で deal→action へ遷移した場合は phaseChange コールバックが
      // ブロードキャストする。まだ betting 中なら個別にブロードキャスト。
      const t = tcManager.getTable(roomId);
      if (t && t.phase === 'betting') {
        tc_broadcast(roomId);
      }
    });

    socket.on('3c:action', ({ roomId, action }) => {
      const result = tcManager.playerAction(roomId, socket.id, action);
      if (!result.ok) {
      const ACTION_ERROR_MSG = {
        notAction:     'アクションフェーズではありません',
        invalid:       '無効なアクションです',
        invalidAction: 'PLAY か FOLD を選択してください',
      };
      socket.emit('3c:error', { message: ACTION_ERROR_MSG[result.reason] ?? `アクションエラー: ${result.reason}` });
        return;
      }
      const t = tcManager.getTable(roomId);
      if (t && t.phase === 'action') {
        tc_broadcast(roomId);
      }
    });

    socket.on('3c:leave', ({ roomId }) => {
      tc_leave(roomId, socket.id);
    });

    // ================================================================
    // ■ 切断
    // ================================================================

    socket.on('disconnect', () => {
      logDev(`[disconnect] ${socket.id}`);
      leaveReservations.delete(socket.id);
      _rateCounts.delete(socket.id);
      const user = socket.data.user;
      if (user?.accountId && _connectedUsers.get(user.accountId) === socket.id) {
        _connectedUsers.delete(user.accountId);
      }
      // スリーカードポーカーテーブルから退室
      for (const t of tcManager.listRooms()) {
        if (t.players.some(p => p.socketId === socket.id)) {
          tc_leave(t.id, socket.id);
          break;
        }
      }
      // 観戦者リストからも除去
      if (currentRoom.roomId) _spectators.get(currentRoom.roomId)?.delete(socket.id);
      if (!currentRoom.roomId) return;
      const roomId = currentRoom.roomId;

      if (tournamentManager.isTournamentTable(roomId)) {
        // トーナメントテーブル: active / pending どちらも即退室させず猶予を開始する。
        // pending を除外すると、更新時に pendingPlayers から消えて lateReg の新規配置に落ち、
        // 初期スタックで入り直せてしまう。
        const { getOrCreateRoom: _gor } = require('./poker/gameManager');
        const _room = _gor(roomId);
        const isPlayer = _room?.players.some(p => p.id === socket.id)
                      || _room?.pendingPlayers?.some(p => p.id === socket.id);
        if (isPlayer) {
          _startTournamentDisconnectGrace(io, socket.id, roomId);
        }
        // 観戦者の場合は何もしない（すでに _spectators から削除済み）
      } else {
        _handleLeave(io, socket, roomId);
      }
    });
  });

  // adminMonitor は express.json() が必要なので、そのルートだけに適用
  const adminMonitor = require('./adminMonitor');
  adminMonitor.setIo(io);
  adminMonitor.injectAutoStartHandlers(_tryAutoStart, _scheduleAutoStart);
  // tournamentManager にも注入（balanceTables後のkickstart用）
  tournamentManager.injectAutoStartHandlers(_tryAutoStart, _scheduleAutoStart);
  // balance後のBOTアクショントリガーを _broadcast チェーンに一本化するため注入
  tournamentManager.injectBroadcast((roomId) => _broadcast(io, roomId));
  expressApp.use('/api/admin/monitor', express.json(), adminMonitor.router);

  // スリーカードポーカー: フェーズ変化時のコールバックを登録
  // io スコープ内で定義し、io を直接クロージャでキャプチャする。
  // （_tc_broadcast は io スコープ外のため io にアクセスできない問題を回避）
  tcManager.setPhaseChangeCallback(async (roomId, phase) => {
    const t = tcManager.getTable(roomId);
    if (!t) return;
    if (phase === 'result') {
      // DB ポイント反映
      const pointsDb = require('./db/points');
      for (const p of t.players) {
        if (!p.accountId || !p.result) continue;
        try {
          await pointsDb.applyThreeCardResult(p.accountId, p.result.net ?? 0);
        } catch (e) { log(`[3CP] DB error ${p.name}: ${e.message}`); }
      }
    }
    // 全プレイヤーに状態送信（io を直接使用）
    for (const p of t.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('3c:state', tcManager.buildTableState(roomId, p.socketId));
    }
    io.emit('roomList', getLobbyList());
  });

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
    log(`🃏 ${cfg.SITE_NAME} → http://localhost:${PORT}`);
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
  // スタッドハンド進行中の離脱: studManager 側でもフォールド/退室処理を行う。
  // これを怠ると actionIndex が抜けたプレイヤーを指し続けハンドがハングする（High-3）。
  if (_isStudActive(roomId)) {
    const sr = studManager.studLeaveRoom(roomId, socket.id);
    leaveRoom(socket.id);
    socket.leave(roomId);
    io.emit('roomList', getLobbyList());
    _broadcastLobbyUpdate(io, roomId);
    _broadcast(io, roomId);
    // 離脱の結果ショーダウンに到達したら後処理
    if (sr && sr.phase === 'showdown') {
      _onStudShowdown(io, roomId);
    }
    return;
  }

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

// ================================================================
// ■ スリーカードポーカー ヘルパー関数
// ================================================================

/** 全プレイヤーにテーブル状態をブロードキャスト（自分の手は自分のみ） */
function _tc_broadcast(roomId) {
  const t = tcManager.getTable(roomId);
  if (!t) return;
  for (const p of t.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('3c:state', tcManager.buildTableState(roomId, p.socketId));
  }
  io.emit('roomList', getLobbyList());
}

/** reveal 後にポイントをDBへ反映 */
async function _tc_applyResults(t) {
  const pointsDb = require('./db/points');
  for (const p of t.players) {
    if (!p.accountId || !p.result) continue;
    try {
      await pointsDb.applyThreeCardResult(p.accountId, p.result.net);
    } catch (e) {
      log(`[3c] applyThreeCardResult error: ${e.message}`);
    }
  }
}

/** プレイヤーをテーブルから退室させる */
function _tc_leavePlayer(roomId, socketId) {
  tcManager.leaveTable(roomId, socketId);  // 内部で空テーブル削除も実施
  const s = io.sockets.sockets.get(socketId);
  if (s) s.leave(roomId);
  io.emit('roomList', getLobbyList());
  // 残ったプレイヤーに状態を送信（テーブルがまだ存在する場合のみ）
  const t = tcManager.getTable(roomId);
  if (t) _tc_broadcast(roomId);
}

/**
 * タイムアウト時の自動アクションハンドラ
 * ドロー: _selectedIndices に保存済みの選択カードを交換
 * ベット: フォールド
 */
function _makeStudTimeoutHandler(io, roomId) {
  return (rid, phase, playerId) => {
    log(`[stud-timeout] ${playerId.slice(-12)} in ${rid.slice(-8)} at ${phase}`);
    const acted = !!studManager.handleStudTimeout(rid, playerId);
    if (!acted) {
      // handleStudTimeout が null を返すケース:
      //   1. 既に他の経路でターンが進んでいる（正常）
      //   2. プレイヤーが studRoom.players に見つからない（socket未確立の遅延参加者等）
      //      → このまま return するとテーブルが永久フリーズする
      // ケース2 の救済: studRoom の現在の actionIndex のプレイヤーを強制 fold させる。
      const _sr = studManager.getStudRoom(rid);
      const _cur = _sr?.players[_sr?.actionIndex ?? -1];
      if (_sr && _cur && _sr.phase !== 'showdown' && _sr.phase !== 'waiting') {
        log(`[stud-timeout-force] ${playerId.slice(-12)} not found → force fold for actionIndex[${_sr.actionIndex}]=${_cur.name}`);
        const _forced = !!studManager.handleStudTimeout(rid, _cur.id);
        if (!_forced) {
          // それでも失敗（全員 acted など）→ フェーズを強制進行させる
          log(`[stud-timeout-force] force also failed, phase=${_sr.phase} → advancing`);
          studManager.forceAdvancePhase(rid);
        }
      } else {
        log(`[stud-timeout-skip] ${playerId}: already resolved`);
        return;
      }
    }
    _broadcast(io, rid);
    const room = studManager.getStudRoom(rid);
    if (room?.phase === 'showdown') {
      _onStudShowdown(io, rid);
    }
  };
}

function _makeTimeoutHandler(io, roomId) {
  return (rid, phase, playerId) => {
    // 観測性強化: playerId が accountId のままになっている = t:getMyTable 未成功
    //             プレイヤーが画面を見えていない可能性があるため、name/connected 状態もログに残す
    const _r = getOrCreateRoom(rid);
    const _p = _r?.players.find(p => p.id === playerId);
    const _sock = io.sockets.sockets.get(playerId);
    const _isAccountIdStyle = playerId && playerId.length > 30 && /^\d+$/.test(playerId);
    log(`[timeout] ${playerId.slice(-12)} (name=${_p?.name ?? '?'} sock=${_sock ? 'OK' : 'NONE'}${_isAccountIdStyle ? ' AS_ACCOUNT_ID' : ''}) in ${rid.slice(-8)} at ${phase}`);

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
      // fold を試み、チェック可能な場面（toCall=0）では check にフォールバック
      acted = !!betAction(rid, playerId, 'fold');
      if (!acted) {
        acted = !!betAction(rid, playerId, 'check');
        if (acted) log(`[timeout] ${playerId}: fold rejected (checkable) → check`);
      }
    }

    if (!acted) {
      log(`[timeout-skip] ${playerId}: action already resolved, skip count`);
      return;
    }

    _broadcast(io, rid);
    const room = getOrCreateRoom(rid);
    if (room?.phase === 'showdown') {
      if (tournamentManager.isTournamentTable(rid)) {
        tournamentManager.checkEliminations(rid);
        // ※ 2回目の _broadcast は送らない（betAction と同様の理由）
      }
      _recordRingHandResults(rid);  // リングゲーム損益記録
      io.to(rid).emit('showdown');
      if (room.isZoomTable) handleZoomShowdown(io, rid);
      else _scheduleAutoStart(io, rid);
    }

    // 連続タイムアウトカウント → 3回で退室
    // タイマー切れ直前のアクションが I/O フェーズで到達して resetTimeout を
    // 呼ぶ可能性があるため、200ms の猶予を設けてから kick を確定する。
    const shouldKick = incrementTimeout(rid, playerId);
    if (shouldKick) {
      setTimeout(() => {
        const room2   = getOrCreateRoom(rid);
        const player2 = room2?.players.find((p) => p.id === playerId);
        if (!player2 || (player2.timeoutCount ?? 0) < 3) {
          log(`[kick-timeout-cancel] ${playerId}: action arrived within grace period`);
          return;
        }
        log(`[kick-timeout] ${playerId} in ${rid} (3 consecutive timeouts)`);

        // スタッドハンド進行中なら studManager 側でも離脱処理（ハング防止）
        let _studSr = null;
        if (_isStudActive(rid)) {
          _studSr = studManager.studLeaveRoom(rid, playerId);
        }

        if (tournamentManager.isTournamentTable(rid)) {
          // 【仕様】3回連続タイムアウト = ゲームに参加していないとみなし、
          // チップが残っていても脱落させる。
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
        // スタッドで離脱の結果ショーダウンに到達したら後処理
        if (_studSr && _studSr.phase === 'showdown') {
          _onStudShowdown(io, rid);
        }
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

function _removeSpectatorSocket(socketId, tableId = null) {
  if (tableId) _spectators.get(tableId)?.delete(socketId);
  for (const spectators of _spectators.values()) {
    spectators.delete(socketId);
  }
}

function _socketBelongsToTable(socket, roomId) {
  if (!roomId || typeof roomId !== 'string' || roomId.length > 64) return false;
  const user = socket.data?.user;
  const room = getRoom(roomId);
  const inDrawRoom = !!room && [...room.players, ...room.pendingPlayers].some((p) =>
    p.id === socket.id ||
    (user?.accountId && p.accountId === user.accountId) ||
    (user?.nickname && p.name === user.nickname)
  );
  if (inDrawRoom) return true;

  const studRoom = studManager.getStudRoom(roomId);
  return !!studRoom && studRoom.players.some((p) =>
    p.id === socket.id ||
    (user?.accountId && p.accountId === user.accountId) ||
    (user?.nickname && p.name === user.nickname)
  );
}

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
  const pendingPlayer = room?.pendingPlayers?.find((p) => p.id === socketId);
  const reconnectTarget = player ?? pendingPlayer;
  const reconnectState = player ? 'active' : pendingPlayer ? 'pending' : 'not-found';
  if (reconnectTarget) reconnectTarget.disconnected = true;
  _broadcast(io, roomId);

  log(`[t:grace-start] ${socketId.slice(-8)} in ${roomId.slice(-8)} state=${reconnectState} name=${reconnectTarget?.name ?? '-'} chips=${reconnectTarget?.chips ?? '-'} – 3min grace`);

  const timer = setTimeout(() => {
    _tournamentGraceTimers.delete(socketId);
    log(`[t:grace-expire] ${socketId} in ${roomId} – forced leave`);
    // スタッドハンド進行中なら studManager 側からも離脱（残留・ハング防止）
    let _studSr = null;
    if (_isStudActive(roomId)) {
      _studSr = studManager.studLeaveRoom(roomId, socketId);
    }
    tournamentManager.handleForcedLeave(roomId, socketId, 'disconnect-timeout');
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) targetSocket.leave(roomId);
    io.emit('roomList', getLobbyList());
    _broadcastLobbyUpdate(io, roomId);
    _broadcast(io, roomId);
    if (_studSr && _studSr.phase === 'showdown') {
      _onStudShowdown(io, roomId);
    }
  }, TOURNAMENT_DISCONNECT_GRACE_MS);

  _tournamentGraceTimers.set(socketId, { roomId, timer });
}

function _cancelTournamentDisconnectGrace(socketId, reason = 'reconnected') {
  const entry = _tournamentGraceTimers.get(socketId);
  if (!entry) return;
  clearTimeout(entry.timer);
  _tournamentGraceTimers.delete(socketId);
  log(`[t:grace-cancel] ${socketId} reason=${reason}`);
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
  // ===== High-1 対策: 前ハンドがスタッドだった場合の残留リセット =====
  // スタッドハンドは showdown 後も studRooms に phase='showdown' で残るため、
  // 次ハンドの開始前に必ず waiting へ戻す。これを怠ると _isStudActive が
  // true を返し続け、次がドロー系でも _broadcastStud に誤ルーティングされる。
  //
  // 【重要・二重ハンド進行バグ修正】
  // phase が showdown のときのみ finishStudHand を呼ぶ。bet系・deal系（進行中）の
  // ときに finishStudHand を呼ぶと、進行中のハンドを強制終了して次ハンドを始めて
  // しまい、BOTのアクションチェーンが切れてフリーズする（lateReg参加時に多発）。
  // 進行中の場合はそのまま return し、ハンド完了後の _onStudShowdown→
  // _scheduleAutoStart に開始を委ねる。
  {
    const _sr = studManager.getStudRoom(roomId);
    if (_sr && _sr.phase !== 'waiting' && _sr.phase !== 'showdown') {
      // 進行中ハンドがある → 開始処理をスキップ（ハンド破壊を防ぐ）
      log(`[auto-start] ${roomId.slice(-8)} スタッドハンド進行中(phase=${_sr.phase}) → 開始スキップ`);
      return;
    }
    if (_sr && _sr.phase === 'showdown') {
      studManager.finishStudHand(roomId);
    }
  }

  // ブレイク中はゲーム開始を待機
  if (tournamentManager.isTournamentTable(roomId)) {
    const t = tournamentManager.getTournamentByTable(roomId);
    if (t?.isOnBreak) {
      // ブレイク終了まで再試行
      setTimeout(() => {
        if (canAutoStart(roomId)) _tryAutoStart(io, roomId);
      }, 5000);
      return;
    }
    // pendingLevelUp があれば次ハンド開始前に適用
    // 複数レベルが期限切れになっている場合はループして一括適用する。
    // 1レベルずつ適用すると毎ハンド「次のハンドでブラインドアップ」が表示され続ける。
    log(`[blind-debug] _tryAutoStart roomId=${roomId.slice(-8)} pendingLevelUp=${t?.pendingLevelUp} currentLevelIdx=${t?.currentLevelIdx}`);
    if (t?.pendingLevelUp) {
      let _loopT = t;
      let _maxLevels = 20; // 安全制限
      while (_loopT?.pendingLevelUp && !_loopT?.isOnBreak && _maxLevels-- > 0) {
        const applied = tournamentManager.applyPendingLevelUp(_loopT.id);
        _loopT = tournamentManager.getTournamentByTable(roomId);
        log(`[blind-debug] applyPendingLevelUp applied=${applied} pendingLevelUp_after=${_loopT?.pendingLevelUp} currentLevelIdx=${_loopT?.currentLevelIdx}`);
        if (!applied || !_loopT) break;
      }
      log(`[blind-debug] applyPendingLevelUp loop done: pendingLevelUp=${_loopT?.pendingLevelUp} currentLevelIdx=${_loopT?.currentLevelIdx}`);
    }
    // applyPendingLevelUp でブレイクに入った場合はゲームを開始しない
    const tAfter = tournamentManager.getTournamentByTable(roomId);
    if (tAfter?.isOnBreak) {
      setTimeout(() => {
        if (canAutoStart(roomId)) _tryAutoStart(io, roomId);
      }, 5000);
      return;
    }
  }
  const onTimeout = _makeTimeoutHandler(io, roomId);

  // ===== 【007 修正】1人取り残されたテーブルのデッドロック解消 =====
  // balanceTables は showdown 後にしか呼ばれないが、active<2 のテーブルは
  // ハンドが始まらず showdown に到達しないため、「もう1人参加を待っています」
  // 画面で永遠に固まる。リトライも canAutoStart=false のため発火しない。
  // ここで「開始不能（active<2）かつ複数テーブル存在」を検出したら
  // balanceTables を能動的に呼び、他テーブルからプレイヤーを集約させる。
  if (tournamentManager.isTournamentTable(roomId)) {
    const _rStart = getOrCreateRoom(roomId);
    const _activeCount = (_rStart?.players?.filter(p => !p.sittingOut).length ?? 0)
                       + (_rStart?.pendingPlayers?.length ?? 0);
    const _tBal = tournamentManager.getTournamentByTable(roomId);
    if (_activeCount < 2 && _tBal && _tBal.tableIds.length > 1 && _tBal.status === 'running') {
      log(`[007-fix] ${roomId.slice(-8)} active=${_activeCount}<2 かつ複数テーブル → balanceTables 発火`);
      tournamentManager.balanceTables(_tBal.id);
      // バランス後に再度開始を試みる（複数遅延でテーブル集約の完了を待つ）
      for (const delay of [500, 1500, 3500]) {
        setTimeout(() => {
          const r = getOrCreateRoom(roomId);
          if (r && r.phase === 'waiting' && canAutoStart(roomId)) {
            log(`[007-fix] ${roomId.slice(-8)} balance後リトライ delay=${delay}`);
            _tryAutoStart(io, roomId);
          }
        }, delay);
      }
      // このテーブルが解体された（tableIds から消えた）場合は開始処理を中断
      const _tAfterBal = tournamentManager.getTournamentByTable(roomId);
      if (!_tAfterBal || !_tAfterBal.tableIds.includes(roomId)) {
        log(`[007-fix] ${roomId.slice(-8)} はバランスで解体された → 開始中断`);
        return;
      }
      // まだ active<2 のままなら今回は開始せず、上のリトライに委ねる
      const _rRecheck = getOrCreateRoom(roomId);
      const _activeRecheck = (_rRecheck?.players?.filter(p => !p.sittingOut).length ?? 0)
                           + (_rRecheck?.pendingPlayers?.length ?? 0);
      if (_activeRecheck < 2) {
        log(`[007-fix] ${roomId.slice(-8)} balance直後もまだactive=${_activeRecheck}<2 → リトライ待ち`);
        return;
      }
    }
  }

  // ===== スタッド系の先読みルーティング =====
  // 【002/008 修正】人数非依存ローテーションに対応。
  // peekNextMode で「次ハンドのモード」を副作用なしで先読みし、
  // スタッド系なら studManager 経由で開始する。
  // モードの正式確定は advanceModeRotation（startGame と同じ前進処理）で行い、
  // このハンドを _modeHandsDone に計上する。これにより人数変動で
  // モードがズレる問題（razz→stud_s 誤判定=002, ハンド途中切替=008）を防ぐ。
  const _gmRoom = getRoom(roomId);
  if (_gmRoom && isMixMode(_gmRoom.mode) && isStudMode(peekNextMode(_gmRoom))) {
    // sittingOut リセット（startGame 相当の最小処理・gameManager L411-419 と同一）
    // _waitZoneSkip=true のプレイヤー（pendingPlayersから来た参加待ち）は
    // このハンドも sittingOut=true のままにして、フラグをクリアする。
    // フラグがクリアされるため次のハンドからは sittingOut=false になり正式参加。
    for (const p of _gmRoom.players) {
      if (p._waitZoneSkip) {
        p.sittingOut    = true;   // このハンドも待機
        p._waitZoneSkip = false;  // 次ハンドからは参加（gameManager startGame と同じ）
      } else {
        p.sittingOut = false;
      }
    }
    // モードを正式に前進・確定（startGame と同一処理）
    const nextMode = advanceModeRotation(_gmRoom);
    _gmRoom.currentMode = nextMode;
    _gmRoom._modeHandsDone = (_gmRoom._modeHandsDone ?? 0) + 1;  // このハンドを消化
    _gmRoom.handCount += 1;  // 表示・ログ用の総ハンド数も加算
    // 【ディーラーボタン移動】スタッド経路は startGame を通らないため、
    // ここで明示的にボタンを前進させる。これを怠るとスタッド連続区間で
    // ボタンが固定されてしまう（startGame と同じ advanceDealerButton を使用）。
    advanceDealerButton(_gmRoom);
    log(`[stud] dealer button → idx=${_gmRoom.dealerIndex} (${_gmRoom.players[_gmRoom.dealerIndex]?.name ?? '?'})`);
    log(`[stud] mode確定 roomId=${roomId.slice(-8)} mode=${nextMode} done=${_gmRoom._modeHandsDone}/${_gmRoom._modeHandsTotal} seqIdx=${_gmRoom._modeSeqIndex}`);
    const studRoom = studManager.syncFromGameManager(_gmRoom, nextMode);
    studRoom.handCount = _gmRoom.handCount;
    const started = studManager.startStudHand(studRoom, _makeStudTimeoutHandler(io, roomId), { skipHandCountIncrement: true });
    if (started) {
      // 【デッドボタン一貫性】スタッドハンド成立時にBBアンカーも前進させる。
      // ミックスでドロー系に戻ったとき、スタッドを挟んだ分ブラインド順が進み、
      // 同じプレイヤーが連続BBになるのを防ぐ（ボタンと同様に毎ハンド前進）。
      advanceBbAnchor(_gmRoom);
      const _dbgPlayers = studRoom.players.map(p => `${p.name}(so=${p.sittingOut},fd=${p.folded},act=${p.acted})`).join(',');
      log(`[stud] startStudHand SUCCESS roomId=${roomId.slice(-8)} mode=${nextMode} players=${studRoom.players.length} handCount=${studRoom.handCount}`);
      log(`[stud-players] ${roomId.slice(-8)}: ${_dbgPlayers}`);
      _broadcast(io, roomId);
      io.to(roomId).emit('gameStarted');
      if (tournamentManager.isTournamentTable(roomId)) {
        const _tSync = tournamentManager.getTournamentByTable(roomId);
        if (_tSync) tournamentManager.broadcastBlind(_tSync.id);
      }
    } else {
      // 開始失敗（active<2）: モード前進とハンドカウントを巻き戻す
      _gmRoom.handCount -= 1;
      _gmRoom._modeHandsDone = Math.max(0, (_gmRoom._modeHandsDone ?? 1) - 1);
      log(`[stud] startStudHand NULL roomId=${roomId.slice(-8)} (active<2) mode/handCount rolled back`);
      // 【007対策】ドロー経路と同様にリトライをスケジュールする。
      // テーブルバランスでプレイヤー移動中などに一時的に active<2 となった場合、
      // リトライが無いと「もう1人待っています」画面で固まり続ける。
      if (tournamentManager.isTournamentTable(roomId)) {
        setTimeout(() => {
          // 進行中のハンドを破壊しないよう共通ガードで確認してからリトライ
          if (_canSafelyRetryAutoStart(roomId)) {
            log(`[stud] startStudHand retry for ${roomId.slice(-8)}`);
            _tryAutoStart(io, roomId);
          }
        }, 1500);
      }
    }
    return;
  }

  const room = startGame(roomId, onTimeout);
  if (room) {
    const _room = getOrCreateRoom(roomId);
    const _allBots = _room?.players.every(p => p.id.startsWith('tbot::')) ?? false;
    log(`[stuck-debug] startGame SUCCESS roomId=${roomId.slice(-8)} players=${_room?.players.length} pendingPlayers=${_room?.pendingPlayers?.length} allBots=${_allBots} phase=${_room?.phase}`);
    _broadcast(io, roomId);
    io.to(roomId).emit('gameStarted');
    // ハンド開始時に毎回ブラインド情報を再送してクライアントの表示を同期する。
    // applyPendingLevelUp の有無に関わらず常に送信することで
    // 「次のハンドでブラインドアップ」が消えない／レベルが更新されないバグを防ぐ。
    if (tournamentManager.isTournamentTable(roomId)) {
      const _tSync = tournamentManager.getTournamentByTable(roomId);
      if (_tSync) {
        log(`[blind-debug] broadcastBlind after startGame: pendingLevelUp=${_tSync.pendingLevelUp} level=${_tSync.currentLevelIdx}`);
        tournamentManager.broadcastBlind(_tSync.id);
      }
    }
  } else if (tournamentManager.isTournamentTable(roomId)) {
    // startGame が null を返した場合（_waitZoneSkip プレイヤーが多く active < 2）:
    // startGame 内で _waitZoneSkip がクリアされたため、1秒後に再試行すると全員 sittingOut=false になり成功する
    const _rNull = getOrCreateRoom(roomId);
    log(`[stuck-debug] startGame NULL roomId=${roomId.slice(-8)} players=${_rNull?.players.map(p => `${p.name}(sittingOut=${p.sittingOut},waitZone=${p._waitZoneSkip})`).join(',')}`);
    setTimeout(() => {
      if (_canSafelyRetryAutoStart(roomId)) {
        log(`[stuck-debug] startGame retry for ${roomId.slice(-8)}`);
        _tryAutoStart(io, roomId);
      }
    }, 1000);
  }
}

// 二重スケジュール防止セット
const _pendingAutoStart = new Set();
const DEFAULT_AUTOSTART_DELAY_MS = 3000;
const STUD_SHOWDOWN_AUTOSTART_DELAY_MS = 3000;
const STUD_SHOWDOWN_RETRY_DELAY_MS = 9500;

/** ショーダウン後の自動スタート。FastFoldは即時、通常部屋は表示猶予を置いて開始する */
/**
 * リングゲーム: ハンド終了時の損益をDBに記録する
 * - トーナメントテーブルは除外
 * - accountId を持たないプレイヤー（ゲスト・BOT）は除外
 * - chips_before = room.startingChips（リング部屋は毎ハンド startingChips にリセットされる仕様）
 *   ※ gameManager.js startGame L333 の `if (!room._isTournament) p.chips = room.startingChips`
 *      に依存。この仕様変更時は本関数も修正が必要。
 *
 * 二重記録は DB の UNIQUE(room_id, account_id, hand_num) + ON CONFLICT DO NOTHING で防止。
 */
async function _recordRingHandResults(roomId) {
  try {
    if (tournamentManager.isTournamentTable(roomId)) return;
    const room = getRoom(roomId);   // 読み取り専用（新規作成しない）
    if (!room) return;
    if (room.handCount <= 0) return;  // ハンド未開始の防衛チェック

    const chipsBefore = room.startingChips;
    const records = [];
    for (const p of room.players) {
      if (!p.accountId) continue;                       // ゲストはスキップ
      if (p.accountId.startsWith('bot::')) continue;    // リングBOTはスキップ（bot.js が起動した場合）
      if (p.id && p.id.startsWith('tbot::')) continue;  // トーナメントBOT IDプレフィックス防衛
      const net = p.chips - chipsBefore;
      records.push({
        accountId:  p.accountId,
        roomId,
        mode:       room.currentMode ?? room.mode,
        handNum:    room.handCount,
        net,
        chipsAfter: p.chips,
      });
    }
    if (records.length === 0) return;
    await ringDb.recordHandResults(records);
  } catch (e) {
    // DB書き込みエラーはゲームに影響させない
    log(`[ring] recordHandResults error: ${e.message}`);
  }
}

// ================================================================
// ================================================================
// ■ スリーカードポーカー ヘルパー関数（定義は上部に集約済み）
// ================================================================

function _scheduleAutoStart(io, roomId) {
  const room = getOrCreateRoom(roomId);
  // 退室予約者は即退室
  _processLeaveReservations(io, roomId);
  if (room?.isZoomTable) {
    if (canAutoStart(roomId)) _tryAutoStart(io, roomId);
  } else {
    if (_pendingAutoStart.has(roomId)) {
      log(`[auto-start] ${roomId.slice(-8)} _scheduleAutoStart skip (already pending)`);
      return;
    }
    _pendingAutoStart.add(roomId);
    const studRoom = studManager.getStudRoom(roomId);
    const delayMs = studRoom?.phase === 'showdown'
      ? STUD_SHOWDOWN_AUTOSTART_DELAY_MS
      : DEFAULT_AUTOSTART_DELAY_MS;
    log(`[auto-start] ${roomId.slice(-8)} scheduled delayMs=${delayMs} studPhase=${studRoom?.phase ?? 'none'} canAutoStart=${canAutoStart(roomId)}`);
    setTimeout(() => {
      _pendingAutoStart.delete(roomId);
      log(`[auto-start] ${roomId.slice(-8)} timer fired delayMs=${delayMs} canAutoStart=${canAutoStart(roomId)}`);
      // トーナメント: 脱落チェック → テーブルバランシング → 自動スタート
      if (tournamentManager.isTournamentTable(roomId)) {
        // balanceTables でチップを移動する前に、全テーブルのポットを確実に精算する。
        // BOTのみのテーブルでは _broadcast が buildGameState を呼ばないため
        // _awardPots が未実行のままになり、移動プレイヤーのチップが旧値になるバグがある。
        const tForEnsure = tournamentManager.getTournamentByTable(roomId);
        if (tForEnsure) {
          for (const tid of tForEnsure.tableIds) ensurePotsAwarded(tid);
          // 【指摘2対策】balanceTables の前に、showdown 状態で残っている
          // スタッドルームを finishStudHand で waiting に戻す。
          // これを怠ると balanceTables 時点で studRooms.phase=showdown のままとなり、
          // 移動処理が studManager 状態を中途半端に扱う原因になる。
          for (const tid of tForEnsure.tableIds) {
            const _sr = studManager.getStudRoom(tid);
            if (!_sr) continue;
            if (_sr.phase === 'showdown') {
              log(`[stud-recover] ${tid.slice(-8)} finish lingering showdown before balance`);
              studManager.finishStudHand(tid);
            } else if (_sr.phase !== 'waiting') {
              log(`[stud-recover] ${tid.slice(-8)} keep active stud hand phase=${_sr.phase} before balance`);
            }
          }
        }
        tournamentManager.checkEliminations(roomId);
        const t = tournamentManager.getTournamentByTable(roomId);
        if (t) tournamentManager.balanceTables(t.id);
      }
      if (canAutoStart(roomId)) _tryAutoStart(io, roomId);
    }, delayMs);
  }
}

// ==========================================================
// ■ スタッド系ルーティング（BEAST+ / stud_mix）
// ==========================================================

/** 指定テーブルが現在スタッドハンドを実行中かどうか */
function _isStudActive(roomId) {
  const sr = studManager.studRooms.get(roomId);
  return !!sr && sr.phase !== 'waiting';
}

/**
 * スタッドハンドが「ベット/配布の進行中」か判定する。
 * waiting（ハンド未開始）でも showdown（精算済み・次ハンド開始可能）でもない、
 * 途中状態（ante・bet系・deal系）のときのみ true。
 *
 * 自動開始リトライ（_tryAutoStart の再呼び出し）の前にこれを確認することで、
 * 進行中のハンドを finishStudHand で破壊してしまう二重起動バグを防ぐ。
 */
function _isStudHandInProgress(roomId) {
  const sr = studManager.studRooms.get(roomId);
  if (!sr) return false;
  return sr.phase !== 'waiting' && sr.phase !== 'showdown';
}

/**
 * 自動開始リトライを安全に発火してよいか判定する共通ガード。
 * - スタッドハンドが進行中なら false（破壊防止）
 * - gameManager 側が waiting/showdown かつ canAutoStart なら true
 */
function _canSafelyRetryAutoStart(roomId) {
  if (_isStudHandInProgress(roomId)) return false;
  // getRoom（生成しない版）を使う。リトライ判定のためにルームを新規生成する
  // 副作用を避ける。ルームが存在しないなら開始すべきものは無い。
  const r = getRoom(roomId);
  const phaseOk = !!r && (r.phase === 'waiting' || r.phase === 'showdown');
  return phaseOk && canAutoStart(roomId);
}

/** 単一ソケットへ現在のゲーム状態を送る（スタッド/ドロー自動判定） */
function _emitStateToSocket(socket, tableId) {
  if (_isStudActive(tableId)) {
    const room = studManager.getStudRoom(tableId);
    if (!room) return;
    const gmRoom = getRoom(tableId);
    const user = socket.data?.user;
    const pendingPlayer = gmRoom?.pendingPlayers?.find((p) =>
      p.id === socket.id ||
      (user?.accountId && p.accountId === user.accountId) ||
      (user?.nickname && p.name === user.nickname)
    );
    const isAlreadyStudPlayer = room.players.some((p) => p.id === socket.id);
    if (pendingPlayer && !isAlreadyStudPlayer) {
      const baseState = studManager.buildStudGameState(room, null);
      const meta = baseState.find((x) => x._meta);
      const players = baseState.filter((x) => !x._meta);
      const selfEntry = {
        id: pendingPlayer.id, name: pendingPlayer.name, chips: pendingPlayer.chips ?? 0,
        isSelf: true, isPendingPlayer: true,
        folded: false, sittingOut: true, isMyTurn: false,
        cards: [], faceUp: [], bet: 0, totalContribution: 0,
        isBringIn: false, isDealer: false,
      };
      socket.emit('gameState', { players: [...players, selfEntry], meta });
      return;
    }
    const state = studManager.buildStudGameState(room, socket.id);
    const meta = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    socket.emit('gameState', { players, meta });
    return;
  }
  const room = getOrCreateRoom(tableId);
  if (!room) return;
  const state = buildGameState(room, socket.id);
  const meta = state.find((x) => x._meta);
  const players = state.filter((x) => !x._meta);
  socket.emit('gameState', { players, meta });
}

function _studLogSnapshot(room) {
  if (!room) return 'room=null';
  const cur = room.players?.[room.actionIndex];
  const players = (room.players ?? []).map((p, i) =>
    `${i}:${p.name}${p.isBot ? '[B]' : ''}${p.folded ? '/F' : ''}${p.sittingOut ? '/S' : ''}${p.acted ? '/A' : '/-'}:bet${p.bet}:chips${p.chips}`
  ).join('|');
  return `phase=${room.phase} mode=${room.currentMode} actionIndex=${room.actionIndex} cur=${cur ? `${cur.name}${cur.isBot ? '[B]' : ''}` : 'none'} currentBet=${room.currentBet} pot=${room.pot} players=[${players}]`;
}

/** スタッド版のゲーム状態配信（_broadcast のスタッド版） */
function _broadcastStud(io, roomId) {
  const room = studManager.getStudRoom(roomId);
  if (!room) return;
  log(`[stud-broadcast] start table=${roomId.slice(-8)} ${_studLogSnapshot(room)}`);
  // デバッグ: 現在のactionIndexが人間プレイヤーの場合に警告
  if (room.phase && room.phase.startsWith('bet')) {
    const _cur = room.players[room.actionIndex];
    if (_cur && !_cur.isBot && !_cur.sittingOut && !_cur.folded) {
      const _gmR = getRoom(roomId);
      const _isPending = _gmR?.pendingPlayers?.some(pp => pp.id === _cur.id || pp.name === _cur.name);
      log(`[stud-action] ${roomId.slice(-8)} phase=${room.phase} actionIdx=${room.actionIndex} cur=${_cur.name} isBot=${_cur.isBot} sittingOut=${_cur.sittingOut} folded=${_cur.folded} isPending=${_isPending ?? false} isMyTurn=${_cur.isMyTurn ?? false}`);
    }
  }

  let anySocketSent = false;
  for (const player of room.players) {
    const s = io.sockets.sockets.get(player.id);
    if (!s) continue;
    anySocketSent = true;
    const state   = studManager.buildStudGameState(room, player.id);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    s.emit('gameState', { players, meta });
  }

  // 【pendingPlayers観戦中バグ修正】gmRoom.pendingPlayers にいるプレイヤーは
  // studRoom.players にまだ含まれていないため、上のループで gameState が送られず
  // クライアントが isSpectator:true の状態を受け取って観戦中表示になる。
  // pendingPlayers の socket には studRoom の状態を requesterId 付きで送信することで
  // isSelf=true のプレイヤーが含まれ、クライアントの観戦中フラグが解除される。
  const _gmRoomForPending = getRoom(roomId);
  if (_gmRoomForPending?.pendingPlayers?.length > 0) {
    const _studPlayerIds = new Set(room.players.map((p) => p.id));
    log(`[pending-broadcast] ${roomId.slice(-8)} pendingPlayers=${_gmRoomForPending.pendingPlayers.map(p=>p.name).join(',')}`);
    for (const pp of _gmRoomForPending.pendingPlayers) {
      // 既に studRoom.players に含まれているなら上のループで送信済み → スキップ（二重送信防止）
      if (_studPlayerIds.has(pp.id)) continue;
      const s = io.sockets.sockets.get(pp.id);
      log(`[pending-broadcast] ${roomId.slice(-8)} ${pp.name} id=${pp.id.slice(-8)} socket=${s ? 'found' : 'NOT_FOUND'}`);
      if (!s) continue;
      // buildStudGameState に null を渡してベース状態（全員 isSelf=false）を作り、
      // pendingPlayer 自身のエントリ（isSelf=true, isPendingPlayer=true）を追加する。
      const _baseState = studManager.buildStudGameState(room, null);
      const _baseMeta  = _baseState.find((x) => x._meta);
      const _basePlayers = _baseState.filter((x) => !x._meta);
      const _selfEntry = {
        id: pp.id, name: pp.name, chips: pp.chips ?? 0,
        isSelf: true, isPendingPlayer: true,
        folded: false, sittingOut: true, isMyTurn: false,
        cards: [], faceUp: [], bet: 0, totalContribution: 0,
        isBringIn: false, isDealer: false,
      };
      s.emit('gameState', { players: [..._basePlayers, _selfEntry], meta: _baseMeta });
      anySocketSent = true;
    }
  }
  // BOT-only: showdown で精算を確実に実行
  if (!anySocketSent && room.phase === 'showdown' && !room._potAwarded) {
    studManager.buildStudGameState(room, null);
  }

  // 観戦者へ配信（手札伏せ）
  const spectators = _spectators.get(roomId);
  if (spectators && spectators.size > 0) {
    // playerSocketIds: studRoom.players + gmRoom.pendingPlayers の両方を含める。
    // pendingPlayers のソケットにも既に gameState を送信済みのため、
    // 観戦者配信で isSpectator:true で上書きされないようスキップ対象にする。
    const _gmRoomSpec = getRoom(roomId);
    const playerSocketIds = new Set([
      ...room.players.map((p) => p.id),
      ...(_gmRoomSpec?.pendingPlayers?.map((p) => p.id) ?? []),
    ]);
    const state   = studManager.buildStudGameState(room, null);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    for (const sid of spectators) {
      if (playerSocketIds.has(sid)) { spectators.delete(sid); continue; }
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('gameState', { players, meta, isSpectator: true });
    }
  }

  // トーナメントBOT: スタッド版トリガー
  if (tournamentManager.isTournamentTable(roomId)) {
    const botIds = tournamentBotManager.getBotIds
      ? tournamentBotManager.getBotIds(roomId)
      : null;
    if (botIds && botIds.size > 0 && room.phase && room.phase.startsWith('bet')) {
      log(`[stud-broadcast] trigger-bots table=${roomId.slice(-8)} botCount=${botIds.size} ${_studLogSnapshot(room)}`);
      studBotManager.triggerStudBotActions(roomId, botIds, (tblId, botName, botAction) => {
        const beforeCallbackRoom = studManager.getStudRoom(tblId);
        log(`[stud-broadcast] bot-callback table=${tblId.slice(-8)} bot=${botName ?? 'unknown'} action=${botAction ?? 'unknown'} ${_studLogSnapshot(beforeCallbackRoom)}`);
        if (botName && botAction) {
          io.to(tblId).emit('playerAction', { playerName: botName, action: botAction });
          log(`[stud-broadcast] emitted-playerAction table=${tblId.slice(-8)} bot=${botName} action=${botAction}`);
        }
        _broadcast(io, tblId);
        const r = studManager.getStudRoom(tblId);
        log(`[stud-broadcast] after-recursive-broadcast table=${tblId.slice(-8)} ${_studLogSnapshot(r)}`);
        if (r?.phase === 'showdown') {
          log(`[stud-broadcast] showdown-detected table=${tblId.slice(-8)} ${_studLogSnapshot(r)}`);
          _onStudShowdown(io, tblId);
        }
      });
    } else if (botIds && botIds.size > 0) {
      log(`[stud-broadcast] skip-bots table=${roomId.slice(-8)} reason=phase-not-betting ${_studLogSnapshot(room)}`);
    } else {
      log(`[stud-broadcast] no-bots table=${roomId.slice(-8)} ${_studLogSnapshot(room)}`);
    }
  }
}

/** スタッドハンドのショーダウン後処理（精算・脱落・自動開始） */
function _onStudShowdown(io, roomId) {
  const sr = studManager.getStudRoom(roomId);
  if (!sr) return;
  // 二重呼び出し防止: 既に精算済みなら再実行しない
  if (sr._onStudShowdownCalled) {
    log(`[stud-showdown] ${roomId.slice(-8)} already called, skip`);
    return;
  }
  sr._onStudShowdownCalled = true;
  log(`[stud-showdown] ${roomId.slice(-8)} _onStudShowdown called`);
  // 精算確実化
  studManager.buildStudGameState(sr, null);
  // チップを gameManager のルームへ書き戻す（チップ連続性）
  const gmRoom = getRoom(roomId);
  if (gmRoom) {
    studManager.syncToGameManager(gmRoom);
    // gameManager のルームを showdown 相当にして次の自動開始フローに乗せる
    gmRoom.phase = 'showdown';
    gmRoom._potAwarded = true;
  }
  if (tournamentManager.isTournamentTable(roomId)) {
    tournamentManager.checkEliminations(roomId);
  }
  io.to(roomId).emit('showdown');
  log(`[stud-showdown] ${roomId.slice(-8)} calling _scheduleAutoStart, pending=${_pendingAutoStart.has(roomId)}`);
  // この showdown のハンド番号を記録。バックアップタイマー発火時に
  // 「まだ同じハンドのまま（=次ハンドが始まっていない）」かを判定するために使う。
  const _showdownHandCount = sr.handCount;
  _scheduleAutoStart(io, roomId);
  // 【フリーズ防止バックアップ】_scheduleAutoStart が何らかの理由で次ハンドを
  // 開始できなかった場合のための保険。ただし以下を厳密に確認してから発火する:
  //   1. studRoom が依然 showdown/waiting（進行中のハンドを破壊しない）
  //   2. handCount が showdown 時点から変わっていない（次ハンドが始まっていない）
  // これを怠ると、既に始まった次ハンドを finishStudHand で強制終了してしまう
  // （bet3rd 進行中に _tryAutoStart が呼ばれてハンドが飛ぶ二重起動バグ）。
  setTimeout(() => {
    const _sr2 = studManager.getStudRoom(roomId);
    if (!_sr2) return;
    // 判定ロジック:
    // 1. srPhase が進行中（bet系・deal系）→ 絶対に介入しない（進行中ハンドを破壊しない）
    // 2. handCount が増加 かつ srPhase が waiting/showdown →
    //    次ハンドが始まったが完了して次が必要な状態 → _canSafelyRetryAutoStart で再チェック
    // 3. handCount が同じ → showdown のまま固まっている → 介入が必要
    //
    // 【修正】handChanged=true だけではスキップしない。srPhase が進行中かどうかで判断する。
    // 旧実装: handChanged=true ならスキップ → hand=N が完了して waiting になっても
    //         スキップしてしまい次ハンドが始まらないフリーズが発生していた。
    const _inProgress = _isStudHandInProgress(roomId);
    log(`[stud-showdown-retry] ${roomId.slice(-8)} backup check: srPhase=${_sr2.phase} handCount=${_sr2.handCount}(was ${_showdownHandCount}) inProgress=${_inProgress} canRetry=${_canSafelyRetryAutoStart(roomId)}`);
    if (_inProgress) {
      log(`[stud-showdown-retry] ${roomId.slice(-8)} ハンド進行中 → スキップ`);
      return;
    }
    // 共通ガード: 進行中ハンドの破壊を防ぎつつ、開始可能なら発火
    if (_canSafelyRetryAutoStart(roomId)) {
      log(`[stud-showdown-retry] ${roomId.slice(-8)} 次ハンド開始可能 → _tryAutoStart 発火`);
      _tryAutoStart(io, roomId);
    }
  }, STUD_SHOWDOWN_RETRY_DELAY_MS);
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
  // スタッド系がアクティブなテーブルは studManager 経由で配信する
  if (_isStudActive(roomId)) { _broadcastStud(io, roomId); return; }
  const room = getOrCreateRoom(roomId);

  if (
    room?.phase === 'waiting' &&
    tournamentManager.isTournamentTable(roomId) &&
    canAutoStart(roomId) &&
    !_pendingAutoStart.has(roomId)
  ) {
    _pendingAutoStart.add(roomId);
    log(`[stud-recover] ${roomId.slice(-8)} waiting broadcast canAutoStart=true -> retry auto-start`);
    setTimeout(() => {
      _pendingAutoStart.delete(roomId);
      if (_canSafelyRetryAutoStart(roomId)) {
        log(`[stud-recover] ${roomId.slice(-8)} retry auto-start fired`);
        _tryAutoStart(io, roomId);
      } else {
        const r = getRoom(roomId);
        log(`[stud-recover] ${roomId.slice(-8)} retry skipped phase=${r?.phase} canAutoStart=${canAutoStart(roomId)} studInProgress=${_isStudHandInProgress(roomId)}`);
      }
    }, 250);
  }

  // プレイヤーへ配信（手札あり）
  // BOT-only テーブルでは全員ソケット未接続のため buildGameState が呼ばれず
  // _awardPots が実行されない問題を防ぐため、事前に ensure する
  let anySocketSent = false;
  for (const player of [...room.players, ...room.pendingPlayers]) {
    const s = io.sockets.sockets.get(player.id);
    if (!s) continue;
    anySocketSent = true;
    const state   = buildGameState(room, player.id);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    s.emit('gameState', { players, meta });
  }
  // BOT-only テーブル: ソケット配信がなかった場合も buildGameState を呼んで
  // _awardPots（ポット配布）を確実に実行する
  if (!anySocketSent && room.phase === 'showdown' && !room._potAwarded) {
    logDev(`[broadcast] ${roomId.slice(-8)} BOT-only showdown → ensurePots`);
    buildGameState(room, null);  // 内部で _awardPots が実行される
  }
  if (!anySocketSent) {
    logDev(`[broadcast] ${roomId.slice(-8)} BOT-only phase=${room.phase} players=${room.players.length}`);
  }

  // 観戦者へ配信（手札は伏せる）
  const spectators = _spectators.get(roomId);
  if (spectators && spectators.size > 0) {
    // spectate→lateReg参加後にソケットがplayerとspectatorsの両方に残るケースを修正:
    // プレイヤーとして参加済みのソケットは観戦者リストから除外する
    const playerSocketIds = new Set([...room.players, ...room.pendingPlayers].map(p => p.id));
    const state   = buildGameState(room, null);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    for (const sid of spectators) {
      if (playerSocketIds.has(sid)) {
        // このソケットはプレイヤーとして参加済み → 観戦者リストから自動除外
        spectators.delete(sid);
        logDev(`[broadcast] ${roomId.slice(-8)} spectator ${sid.slice(-8)} promoted to player → removed from spectators`);
        continue;
      }
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('gameState', { players, meta, isSpectator: true });
    }
  }

  // トーナメント BOT: ターンが来ていれば自動アクション
  // triggerBotActions は内部で二重スケジュール防止しているため安全に呼べる
  if (tournamentManager.isTournamentTable(roomId)) {
    tournamentBotManager.triggerBotActions(roomId, (tblId, botName, botAction) => {
      // betアクション（call/check/fold/bet/raise）のみplayerActionをemit
      // drawはdrawFlashで表示するためbotAction=nullで来る
      if (botName && botAction) {
        io.to(tblId).emit('playerAction', { playerName: botName, action: botAction });
      }
      // _broadcast で次のBOTアクションをトリガーするが、
      // showdown判定は _broadcast 後の roomフェーズで行う（コールバック内では行わない）
      // ← コールバック内でshowdown処理+_broadcastをすると二重処理になりバグの原因になる
      _broadcast(io, tblId);
      const r = getOrCreateRoom(tblId);
      if (r?.phase === 'showdown') {
        ensurePotsAwarded(tblId);
        if (tournamentManager.isTournamentTable(tblId)) {
          tournamentManager.checkEliminations(tblId);
        }
        _recordRingHandResults(tblId);  // リングゲーム損益記録
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
    const tid = tournamentId.slice(-8);
    log(`[scheduler] ${tid}: _launchTournament called`);

    if (_scheduled.has(tournamentId)) {
      log(`[scheduler] ${tid}: already in _scheduled set → skip (duplicate call guard)`);
      return;
    }
    _scheduled.add(tournamentId);

    if (tournamentManager.getTournament(tournamentId)) {
      log(`[scheduler] ${tid}: already running in memory`);
      return;
    }

    try {
      log(`[scheduler] ${tid}: fetching from DB...`);
      const dbTournament = await getTournamentDB(tournamentId);
      if (!dbTournament) {
        log(`[scheduler] ${tid}: not found in DB → abort`);
        return;
      }
      if (dbTournament.status === 'cancelled' || dbTournament.status === 'finished') {
        log(`[scheduler] ${tid}: DB status=${dbTournament.status} → abort`);
        return;
      }
      // status=running かつメモリ未登録 = DB更新後にstartTournamentが失敗した中途半端な状態
      // → registering と同様に startTournament を実行してリカバリする
      if (dbTournament.status === 'running') {
        log(`[scheduler] ${tid}: DB status=running but not in memory → recovering`);
      }

      const entries = await getEntries(tournamentId);
      const lateRegMinutes = dbTournament.late_reg_minutes ?? 0;
      const { getPreBotCount } = require('./adminMonitor');
      const preBotCount = getPreBotCount(tournamentId);
      const totalExpected = entries.length + preBotCount;
      log(`[scheduler] ${tid}: entries=${entries.length} preBots=${preBotCount} lateReg=${lateRegMinutes}min`);
      // キャンセル競合調査用: _launchTournament 時点のエントリー一覧（開発環境のみ）
      logDev(`[scheduler-debug] ${tid}: entries at launch = [${entries.map(e => e.nickname ?? e.account_id?.slice(-8)).join(', ')}]`);

      if (totalExpected < 1 && lateRegMinutes <= 0) {
        log(`[scheduler] ${tid}: only ${entries.length} player(s), skip`);
        await updateTournamentStatus(tournamentId, 'cancelled');
        return;
      }

      log(`[scheduler] ${tid}: updating status to running...`);
      await updateTournamentStatus(tournamentId, 'running');

      const players = entries.map(e => ({
        accountId: e.account_id,
        nickname:  e.nickname ?? e.google_name ?? e.account_id.slice(0, 8),
      }));

      // JSONB の二重エンコード対策（adminMonitor.js と同じ safeParseArray を使用）
      const safeParseArray = (raw) => {
        if (!raw) return null;
        if (Array.isArray(raw)) return raw;
        try {
          let parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (typeof parsed === 'string') parsed = JSON.parse(parsed);
          return Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
      };

      log(`[scheduler] ${tid}: calling startTournament...`);
      const tournament = startTournament({
        id:               tournamentId,
        name:             dbTournament.name,
        mode:             dbTournament.mode,
        startingChips:    dbTournament.starting_chips,
        scheduleId:       dbTournament.blind_schedule_id ?? 'default',
        players,
        scheduleData:     safeParseArray(dbTournament.blind_levels),
        lateLevelCutoff:  dbTournament.blind_late_level_cutoff ?? 0,
        lateRegMinutes:   dbTournament.late_reg_minutes ?? 0,
        isSitAndGo:       dbTournament.is_sit_and_go ?? false,
        minPlayers:       dbTournament.min_players ?? 3,
      });

      if (!tournament) {
        log(`[scheduler] ${tid}: startTournament returned null → abort`);
        return;
      }

      log(`[scheduler] ${tid}: auto-started (${players.length} players, ${tournament.tableIds.length} tables)`);

      // 事前予約BOTをspawn
      if (preBotCount > 0) {
        log(`[scheduler] ${tid}: spawning ${preBotCount} pre-reserved BOTs...`);
        const adminMonitor = require('./adminMonitor');
        try {
          await adminMonitor.spawnPreReservedBots(io, tournamentId, dbTournament);
          log(`[scheduler] ${tid}: BOT spawn complete`);
        } catch (e) {
          log(`[scheduler] ${tid}: BOT spawn error: ${e.message}`);
        }
      }

      log(`[scheduler] ${tid}: emitting t:tournamentStarting to ${tournament.tableIds.length} table(s)`);
      for (const tableId of tournament.tableIds) {
        io.emit('t:tournamentStarting', { tournamentId, tableId });
      }
      log(`[scheduler] ${tid}: launch complete`);
    } catch (err) {
      log(`[scheduler] ${tid}: UNCAUGHT ERROR: ${err.message}`);
      log(`[scheduler] ${tid}: stack: ${err.stack?.split('\n')[1]?.trim() ?? 'n/a'}`);
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
          log(`[scheduler] ${row.id.slice(-8)}: start time passed (${Math.abs(Math.round(diff/1000))}s ago) → launching now`);
          _launchTournament(row.id);
        } else if (!_scheduled.has(row.id)) {
          log(`[scheduler] ${row.id}: scheduled in ${Math.round(diff / 1000)}s`);
          _scheduled.add(row.id);
          const MAX_TIMEOUT = 24 * 60 * 60 * 1000; // 24時間上限（32bit符号付き整数対策）
          if (diff > MAX_TIMEOUT) {
            // 遠い未来のトーナメントは次回の_scanで再スケジュール
            _scheduled.delete(row.id);
          } else {
            setTimeout(() => {
              log(`[scheduler] ${row.id.slice(-8)}: setTimeout fired → launching`);
              _scheduled.delete(row.id);
              _launchTournament(row.id);
            }, diff);
          }
        } else {
          logDev(`[scheduler] ${row.id.slice(-8)}: already in _scheduled set, skip re-register`);
        }
      }
    } catch (err) {
      console.error('[scheduler] scan error:', err.message);
    }
  }

  // Sit & Go: 参加登録時に起動チェックできるよう _launchTournament を注入
  tournamentManager.init(undefined, undefined, _launchTournament);

  _scan();
  setInterval(_scan, 60 * 1000);
  log('[scheduler] tournament auto-start scheduler running');
}
