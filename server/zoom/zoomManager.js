/**
 * zoomManager.js — FastFold（Zoom）プール管理
 *
 * PokerStars Zoom と同等の動作:
 *   1. z:join でプールへ参加 → 6人集まると新テーブルにアサイン・ゲーム開始
 *   2. FastFold: 即フォールド処理してプールへ戻る（folded状態でテーブルに残る）
 *   3. showdown後: 全員まとめてプールへ戻す → 新テーブル編成
 */

const { log } = require('../logger');

// タイムスタンプ付きログ（FastFold問題の解析用）
const _ts = () => {
  const n = new Date();
  return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}.${String(n.getMilliseconds()).padStart(3,'0')}`;
};
const ffLog = (_msg) => {};  // デバッグログ（削除済み）
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
      poolHandCount:  0,         // MIXモード用：テーブルをまたいだハンド数カウンタ
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
  if (!pool) { ffLog(`_tryAssignTable: poolId=${poolId} pool NOT FOUND`); return; }

  ffLog(`_tryAssignTable called: poolId=${poolId} waiting=${pool.waitingPlayers.length} players=[${pool.waitingPlayers.map(p=>p.name).join(',')}]`);
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

    // MIX モードの場合、pool レベルのハンドカウンタを room に注入してモード交互切替を維持
    if (pool.mode === 'mix') {
      const rm = getOrCreateRoom(roomId);
      if (rm) rm.handCount = pool.poolHandCount;
    }

    const onTimeout = _makeTimeoutHandler(io, roomId, poolId);
    ffLog(`startGame call: room=${roomId.slice(-12)} players=[${six.map(p=>p.name).join(',')}]`);
    const room = startGame(roomId, onTimeout);
    // MIX モード: このテーブルのハンド完了後のカウンタを pool に保存
    if (pool.mode === 'mix' && room) {
      pool.poolHandCount = room.handCount; // startGame内でhandCount+1済み
      ffLog(`MIX mode: poolHandCount=${pool.poolHandCount} currentMode=${room.currentMode}`);
    }
    ffLog(`startGame result: room=${roomId.slice(-12)} phase=${room?.phase ?? 'NULL'}`);
    if (room) {
      ffLog(` _tryAssignTable: 新テーブル ${roomId.slice(-12)} 生成 players=[${six.map(p=>p.name).join(',')}]`);
      // ① まず z:assigned を送る（クライアントがPokerTableをマウントし始める）
      for (const p of six) {
        io.sockets.sockets.get(p.id)?.emit('z:assigned', { roomId, poolId });
        ffLog(` z:assigned → ${p.name}(${p.id.slice(-6)}) roomId=${roomId.slice(-12)}`);
      }
      // ② 1200ms 待ってからgameStateをブロードキャスト
      //    （PokerTableマウント完了を待つ + Fujitaが画面確認する時間を確保）
      setTimeout(() => {
        try {
          const rm = getOrCreateRoom(roomId);
          if (!rm) { ffLog(`_tryAssignTable BROADCAST: room=${roomId.slice(-12)} MISSING (already closed)`); return; }
          const allSt = (rm.players?.map(p => p.name+'(f='+(p.folded?1:0)+')') ?? []).join(',');
          ffLog('_tryAssignTable BROADCAST: room=' + roomId.slice(-12) + ' phase=' + rm.phase + ' actIdx=' + rm.actionIndex + ' active=' + rm.players?.[rm.actionIndex]?.name + ' states=[' + allSt + ']');
          _broadcast(io, roomId);
          io.to(roomId).emit('gameStarted');
          // 個別にも送信（PokerTableのリスナー登録完了を待って確実に届けるため）
          for (const p of six) {
            const rawGs = buildGameState(rm, p.id);
            const sock = io.sockets.sockets.get(p.id);
            if (rawGs && sock) {
              const meta    = rawGs.find(x => x._meta);
              const players = rawGs.filter(x => !x._meta);
              const me      = players.find(pl => pl.isSelf);
              ffLog('  -> gameState:' + p.name + ' phase=' + meta?.phase + ' myTurn=' + (me?.isMyTurn??'?') + ' folded=' + (me?.folded??'?') + ' acted=' + (me?.acted??'?'));
              sock.emit('gameState', { players, meta });
            }
          }
        } catch (e) {
          ffLog(`_tryAssignTable BROADCAST ERROR: ${e.message}`);
          // エラーが起きてもbroadcastだけは試みる
          try { _broadcast(io, roomId); } catch(_) {}
        }
      }, 1200);
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
  const roomState = getOrCreateRoom(roomId);
  const allP = roomState?.players?.map(p=>`${p.name}(f=${p.folded?1:0},ff=${p.fastFoldPending?1:0})`).join(',')??'?';
  ffLog(`_returnAllToPool START: room=${roomId.slice(-12)} phase=${roomState?.phase} poolPlayers=[${playerIds.map(id=>socketNames.get(id)??id.slice(-6)).join(',')}] gamePlayers=[${allP}]`);

  // --- 1. 全員退室・socketToRoom削除・待機列追加（_tryAssignTable は呼ばない）---
  for (const sid of playerIds) {
    // FastFold 後に新テーブルへ移動済みのプレイヤーは socketToRoom が別 roomId を
    // 指しているため、leaveRoom を呼ぶと新テーブルで誤ってフォールド扱いになる。
    // socketToRoom が現テーブルを指しているプレイヤーだけ leaveRoom する。
    if (socketToRoom.get(sid) === roomId) {
      ffLog(`   leaveRoom: ${socketNames.get(sid)??sid.slice(-6)} (socketToRoom一致)`);
      leaveRoom(sid);
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.leave(roomId);
      socketToRoom.delete(sid);
      // socketToRoomを削除した後(=どのテーブルにも属さない)場合のみ待機列追加
      if (socketToPool.get(sid) === poolId) {
        _addToWaiting(pool, sid);
      }
    } else {
      // 既に別テーブルに移動済み → 待機列に追加しない（二重割り当て防止）
      ffLog(`   skip leaveRoom+addToWaiting: ${socketNames.get(sid)??sid.slice(-6)} (socketToRoom=${socketToRoom.get(sid)?.slice(-12)??'none'}, 別テーブル移動済み)`);
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
  ffLog(` _doFastFold: ${socketNames.get(socket.id)??socket.id.slice(-6)} poolId=${poolId} currentRoom=${currentRoomId?.slice(-12)??'none'}`);

  // ガード: すでに別テーブル移動済み or 待機中（socketToRoomがない）はスキップ
  if (!currentRoomId) {
    ffLog(` _doFastFold: skip (currentRoom=none, 既に移動済みまたは待機中)`);
    return;
  }

  // bet0（プリドロー）以外はFastFold不可
  const gm   = require('../poker/gameManager');
  const room = gm.getOrCreateRoom(currentRoomId);
  if (room && room.phase !== 'bet0' && room.phase !== 'showdown') {
    ffLog(` _doFastFold: skip (phase=${room.phase}, FastFoldはbet0のみ有効)`);
    return;
  }

  // activeTables と socketToRoom を即クリア（showdown中でも同じ）
  // これにより2重呼び出しをガードできる
  pool.activeTables.get(currentRoomId)?.delete(socket.id);
  socketToRoom.delete(socket.id);

  // 旧テーブルのSocket.IOルームから退出（旧テーブルのbroadcastを受信しないようにする）
  socket.leave(currentRoomId);

  // ゲームのフォールド処理とブロードキャスト
  // targetRoomId を渡して旧テーブルの folded=true 誤検知を防ぐ
  const ffResult = fastFoldPlayer(socket.id, currentRoomId);
  ffLog(`_doFastFold: fastFoldPlayer result=${ffResult} player=${socketNames.get(socket.id)??'?'} room=${currentRoomId.slice(-12)}`);

  // FastFoldしたプレイヤーがactionIndexだった場合、サーバーのタイマーが残存するのを防ぐ
  // （プレイヤーがsocket.leaveで退出済みのため、ゲームがタイムアウトまで待ち続けてしまう）
  const roomForTimer = getOrCreateRoom(currentRoomId);
  if (roomForTimer && roomForTimer._timer) {
    const curPlayer = roomForTimer.players?.[roomForTimer.actionIndex];
    if (curPlayer?.id === socket.id) {
      // 自分がactionIndexなら内部タイマーをクリアして次のプレイヤーへ
      // （gameManagerの_clearTimerは外部アクセス不可のためnullクリアのみ）
      clearTimeout(roomForTimer._timer);
      roomForTimer._timer = null;
      roomForTimer._timerStart = null;
      roomForTimer._timerLimit = 0;
    }
  }

  // _broadcast の代わりに「FastFoldした本人を除外」して送信
  // （socket.leaveしても s.emit は直接届くため、旧テーブルの folded=true を誤受信しないよう除外）
  {
    const rmBc = getOrCreateRoom(currentRoomId);
    if (rmBc) {
      for (const p of [...rmBc.players, ...(rmBc.pendingPlayers ?? [])]) {
        if (p.id === socket.id) {
          ffLog(`  _broadcast skip: ${p.name} (FastFold済み、旧テーブルgameState送信しない)`);
          continue;
        }
        const s = io.sockets.sockets.get(p.id);
        if (!s) continue;
        const rawGs = buildGameState(rmBc, p.id);
        if (rawGs) {
          const meta    = rawGs.find(x => x._meta);
          const players = rawGs.filter(x => !x._meta);
          s.emit('gameState', { players, meta });
        }
      }
    }
  }

  // 新しい activePlayer に追加で gameState を送信（"あなたのターン"通知を確実に届ける）
  {
    const rmActv = getOrCreateRoom(currentRoomId);
    if (rmActv && rmActv.phase !== 'showdown') {
      const actPl = rmActv.players?.[rmActv.actionIndex];
      if (actPl && actPl.id !== socket.id && !actPl.folded) {
        const sActv = io.sockets.sockets.get(actPl.id);
        if (sActv) {
          const rawGs2 = buildGameState(rmActv, actPl.id);
          if (rawGs2) {
            const m2 = rawGs2.find(x => x._meta);
            const pl2 = rawGs2.filter(x => !x._meta);
            sActv.emit('gameState', { players: pl2, meta: m2 });
            ffLog('  -> activePlayer notify: ' + actPl.name + ' phase=' + rmActv.phase + ' myTurn=true actIdx=' + rmActv.actionIndex);
          }
        }
      }
    }
  }

  // fastFoldPlayerの結果、ゲームがshowdownに遷移した場合は handleZoomShowdown を呼ぶ
  // index.js の betAction/drawCards ハンドラは通らないため、ここで明示的に呼ぶ必要がある
  const roomAfterFF = getOrCreateRoom(currentRoomId);
  if (roomAfterFF?.phase === 'showdown') {
    io.to(currentRoomId).emit('showdown');
    ffLog(` _doFastFold: showdown遷移検知 → handleZoomShowdown(${currentRoomId.slice(-12)})`);
    handleZoomShowdown(io, currentRoomId);
    // showdown中パスに進む（待機列追加のみ）
  }

  if (room?.phase === 'showdown') {
    // showdown中: handleZoomShowdown で _returnAllToPool は既にスケジュール済み
    // 重複呼び出しを防ぐため、自分だけ待機列に追加して次のテーブルを探す
    ffLog(` _doFastFold: showdown中 → 待機列追加のみ（_returnAllToPool は呼ばない）`);
    if (socketToPool.get(socket.id) === poolId) {
      _addToWaiting(pool, socket.id);
      socket.emit('z:waiting', {
        poolId,
        waitingCount: pool.waitingPlayers.length,
        totalCount:   getTotalCount(poolId),
      });
      _broadcastPoolState(io, poolId);
      _tryAssignTable(io, poolId);
    }
    return;
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
    const pname = socketNames.get(playerId) ?? playerId.slice(-6);
    ffLog(` timeout: ${pname} rid=${rid.slice(-12)} phase=${phase}`);
    if (phase.startsWith('draw')) {
      const room    = gm.getOrCreateRoom(rid);
      const indices = room?._selectedIndices[playerId] ?? [];
      gm.drawCards(rid, playerId, indices);
    } else if (phase.startsWith('bet')) {
      const resultRoom = gm.betAction(rid, playerId, 'fold');
      if (resultRoom?.phase === 'showdown' && resultRoom?.isZoomTable) {
        io.to(rid).emit('showdown');
        ffLog(` timeout→fold: showdown遷移 → handleZoomShowdown(${rid.slice(-12)})`);
        handleZoomShowdown(io, rid);
      }
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

  socket.on('z:join', ({ poolId }) => {
    const pool = zoomPools.get(poolId);
    if (!pool) { ffLog(`z:join: poolId=${poolId} pool NOT FOUND`); return; }
    const user = socket.data?.user;
    const name = user?.nickname;
    if (!name) {
      socket.emit('z:error', { message: 'FastFoldに参加するにはログインとニックネーム設定が必要です' });
      socket.emit('joinError', { message: 'FastFoldに参加するにはログインとニックネーム設定が必要です' });
      return;
    }

    socketNames.set(socket.id, name);
    socketToPool.set(socket.id, poolId);

    _addToWaiting(pool, socket.id);
    const wc = pool.waitingPlayers.length;
    ffLog(`z:join: ${name} poolId=${poolId} waiting=${wc} total=${getTotalCount(poolId)}`);
    socket.emit('z:waiting', {
      poolId,
      waitingCount: wc,
      totalCount:   getTotalCount(poolId),
    });
    _broadcastPoolState(io, poolId);
    _tryAssignTable(io, poolId);
  });

  socket.on('z:fastFold', ({ poolId, roomId: requestedRoomId }) => {
    // roomId が指定されている場合、現在のroomIdと一致するか確認
    // 不一致 = テーブル移動後に旧テーブル向けのイベントが届いた（レースコンディション）
    const pname5 = socketNames.get(socket.id)??socket.id.slice(-6);
    if (requestedRoomId) {
      const currentRoom = socketToRoom.get(socket.id);
      if (currentRoom !== requestedRoomId) {
        ffLog(`z:fastFold STALE: ${pname5} requested=${requestedRoomId.slice(-12)} current=${currentRoom?.slice(-12)??'none'} → skip`);
        return;
      }
      // 受信時の状態をログ
      const rm5 = getOrCreateRoom(requestedRoomId);
      const me5 = rm5?.players?.find(p => p.id === socket.id);
      const myIdx5 = rm5?.players?.indexOf(me5) ?? -1;
      const isMyTurn5 = rm5?.actionIndex === myIdx5;
      ffLog(`z:fastFold RECV: ${pname5} room=${requestedRoomId.slice(-12)} phase=${rm5?.phase} isMyTurn=${isMyTurn5} actIdx=${rm5?.actionIndex} playerIdx=${myIdx5}`);
    }
    _doFastFold(io, socket, poolId);
  });

  // z:assigned受信後にPokerTableがマウントされてからgameStateを要求するためのハンドラ
  socket.on('z:requestGameState', ({ roomId: rid }) => {
    const pname = socketNames.get(socket.id)??socket.id.slice(-6);
    const currentRoom = socketToRoom.get(socket.id);
    if (currentRoom !== rid) {
      ffLog(`z:requestGameState SKIP: ${pname} req=${rid.slice(-12)} cur=${currentRoom?.slice(-12)??'none'}`);
      return;
    }
    const room = getOrCreateRoom(rid);
    const rawGs = room ? buildGameState(room, socket.id) : null;
    if (rawGs) {
      const meta    = rawGs.find(x => x._meta);
      const players = rawGs.filter(x => !x._meta);
      const me      = players.find(p => p.isSelf);
      socket.emit('gameState', { players, meta });  // ← 正しい形式
      ffLog(`z:requestGameState SENT: ${pname} room=${rid.slice(-12)} phase=${meta?.phase} myTurn=${me?.isMyTurn??'?'} folded=${me?.folded??'?'} actIdx=${room?.actionIndex}`);
    } else {
      ffLog(`z:requestGameState FAIL: ${pname} room=${rid.slice(-12)} room=${!!room} gs=null`);
    }
  });

  // フォールドして観戦: ゲーム内でフォールドするが現テーブルに留まる
  socket.on('z:foldStay', ({ poolId: pid }) => {
    const gm = require('../poker/gameManager');
    const rid = socketToRoom.get(socket.id);
    if (!rid) return;
    const pname = socketNames.get(socket.id)??socket.id.slice(-6);
    const rm = gm.getOrCreateRoom(rid);
    if (!rm || !rm.phase.startsWith('bet')) {
      ffLog(`z:foldStay SKIP: ${pname} phase=${rm?.phase??'none'} (betフェーズ外)`);
      return;
    }
    const me = rm.players.find(p => p.id === socket.id);
    if (!me || me.folded) {
      ffLog(`z:foldStay SKIP: ${pname} me=${!!me} folded=${me?.folded} (対象なし)`);
      return;
    }
    const myIdx  = rm.players.indexOf(me);
    const isMyTurn = rm.actionIndex === myIdx;
    const toCall   = rm.currentBet - me.bet;
    ffLog(`z:foldStay RECV: ${pname} room=${rid.slice(-12)} phase=${rm.phase} isMyTurn=${isMyTurn} toCall=${toCall} folded=${me.folded}`);

    if (isMyTurn) {
      // 自分のターン: betAction で正規にアドバンス
      // toCall=0 の場合はフォールド不可→チェックで代用
      const action = toCall > 0 ? 'fold' : 'check';
      const resultRoom = gm.betAction(rid, socket.id, action);
      ffLog(`z:foldStay (isMyTurn) action=${action} RESULT: phase=${resultRoom?.phase??'null'} folded=${resultRoom?.players?.find(p=>p.id===socket.id)?.folded??'?'}`);
    } else {
      // 自分のターン外: folded=true を直接セット（プール戻しなし・観戦継続）
      me.folded = true;
      ffLog(`z:foldStay (notMyTurn) IMMEDIATE fold: ${pname} folded=true`);
    }
    _broadcast(io, rid);
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

// showdownのdouble-call防止: 同じroomIdで2回スケジュールしない
const _showdownScheduled = new Set();

function handleZoomShowdown(io, roomId) {
  // すでにスケジュール済みの場合はスキップ
  if (_showdownScheduled.has(roomId)) {
    ffLog(` handleZoomShowdown: skip(already scheduled) roomId=${roomId.slice(-12)}`);
    return;
  }
  // roomIdがどのpoolIdに属するか探す
  for (const [poolId, pool] of zoomPools.entries()) {
    if (pool.activeTables.has(roomId)) {
      ffLog(` handleZoomShowdown: roomId=${roomId.slice(-12)} poolId=${poolId} → 3秒後に_returnAllToPool`);
      _showdownScheduled.add(roomId);
      setTimeout(() => {
        _showdownScheduled.delete(roomId);
        _returnAllToPool(io, roomId, poolId);
      }, 3000);
      return;
    }
  }
}

module.exports = { registerZoomHandlers, getAllPools, getWaitingCount, getTotalCount, handleZoomShowdown };
