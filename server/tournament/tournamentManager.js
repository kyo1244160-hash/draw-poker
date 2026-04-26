const { log, logDev } = require('../logger');

'use strict';
/**
 * tournamentManager.js
 * トーナメント全体の管理・スケジュール・テーブル生成・脱落検出・ブラインドレベルアップ
 *
 * 依存: gameManager.js（room プロパティ化済み）
 */

const {
  getOrCreateRoom,
  canAutoStart,
  joinRoom: joinPokerRoom,
  leaveRoom,
  startGame,
  getAllRooms,
} = require('../poker/gameManager');

const { getSchedule } = require('./blindSchedule');

// ===== 内部ステート =====
// tournamentId → Tournament オブジェクト
const tournaments = new Map();

// global を使ってレイトレジスト終了状態を Next.js API Route と共有
// (webpack バンドル境界をまたぐため require は別インスタンスになるため global を使う)
if (!global.__pastisLateRegClosed) global.__pastisLateRegClosed = new Set();
function _markLateRegClosed(tournamentId) {
  global.__pastisLateRegClosed.add(tournamentId);
}
function _clearLateRegState(tournamentId) {
  global.__pastisLateRegClosed.delete(tournamentId);
}

// roomId → tournamentId （どのトーナメントのテーブルかを逆引き）
const roomToTournament = new Map();

// 切断中プレイヤーのチップ保持 Map: accountId → { chips, tableId }
// handleForcedLeave で chips>0 の場合に保存し、再接続時に復元する
const _disconnectedChips = new Map();

// Socket.IO の io インスタンス（init で設定）
let _io = null;
// タイムアウトハンドラファクトリ（index.js から注入）
let _makeTimeoutHandler = null;
// Sit & Go 起動コールバック（index.js の _launchTournament を注入）
let _launchCallback = null;
// accountId → 最新 socket.id のルックアップ関数（index.js から注入）
// t:eliminated が旧 socket.id に届かない場合のフォールバック用
let _getSocketByAccountId = null;

function init(io, makeTimeoutHandler, launchTournamentCallback, getSocketByAccountId) {
  // undefined を渡した引数は既存値を保持する（部分更新に対応）
  // 例: tournamentManager.init(undefined, undefined, _launchTournament) で
  //     _io が null に上書きされ kickstart が発火しないバグを防ぐ。
  if (io !== undefined)                     _io                    = io;
  if (makeTimeoutHandler !== undefined)     _makeTimeoutHandler    = makeTimeoutHandler ?? null;
  if (launchTournamentCallback !== undefined) _launchCallback      = launchTournamentCallback ?? null;
  if (getSocketByAccountId !== undefined)   _getSocketByAccountId = getSocketByAccountId ?? null;
}

// ===== Tournament オブジェクト構造 =====
// {
//   id:              string,
//   name:            string,
//   mode:            '27' | 'badugi' | 'mix',
//   startingChips:   number,
//   scheduleId:      string,
//   levels:          BlindLevel[],        // メモリにコピー済み
//   currentLevelIdx: number,              // 現在のレベルインデックス
//   levelStartedAt:  number,             // Date.now() ms
//   pendingLevelUp:  boolean,
//   tableIds:        string[],           // 現在のテーブル roomId 一覧
//   eliminationOrder: AccountId[],       // 脱落順（早い順）
//   totalPlayers:    number,
//   status:          'running' | 'finished',
//   _levelTimer:     NodeJS.Timeout | null,
// }

// ===== テーブル名生成 =====
let _tableSeq = 0;
function _makeTableId(tournamentId) {
  _tableSeq += 1;
  return `t-${tournamentId}-${_tableSeq}`;
}

// ===== テーブル作成 =====
function _createTable(tournament, playerInfos) {
  const tableId = _makeTableId(tournament.id);
  const lv = tournament.levels[tournament.currentLevelIdx];

  // gameManager にトーナメント用パラメータを渡して部屋を作成
  // mode を明示的に渡さないと getRoomMode がroomId文字列から推測するため
  // badugi/mix トーナメントのテーブルが必ず '27' になるバグがある
  const room = getOrCreateRoom(tableId, {
    isUserCreated:  false,
    isZoomTable:    false,
    label:          `${tournament.name} Table`,
    smallBlind:     lv.sb,
    bigBlind:       lv.bb,
    smallBet:       lv.smallBet,
    bigBet:         lv.bigBet,
    startingChips:  tournament.startingChips,
    mode:           tournament.mode,  // badugi/mix/27 を正しく設定
    // トーナメントフラグ
    _tournamentId:  tournament.id,
    _isTournament:  true,
  });

  // 各プレイヤーをテーブルに参加させる
  for (const { accountId, nickname, chips } of playerInfos) {
    joinPokerRoom(tableId, accountId, nickname, { existingChips: chips, accountId });
  }

  tournament.tableIds.push(tableId);
  roomToTournament.set(tableId, tournament.id);
  return tableId;
}

// ===== プレイヤーを均等にテーブルへ割り振り =====
const MAX_PER_TABLE = 6;

function _assignTables(tournament, players) {
  // 必要テーブル数
  const tableCount = Math.ceil(players.length / MAX_PER_TABLE);
  const shuffled = [...players].sort(() => Math.random() - 0.5);

  const tables = [];
  for (let i = 0; i < tableCount; i++) tables.push([]);
  shuffled.forEach((p, idx) => tables[idx % tableCount].push(p));

  const tableIds = [];
  for (const group of tables) {
    tableIds.push(_createTable(tournament, group));
  }
  return tableIds;
}

// ===== トーナメント開始 =====
/**
 * @param {object} opts
 * @param {string}   opts.id             - tournament DB id
 * @param {string}   opts.name
 * @param {string}   opts.mode           - '27'|'badugi'|'mix'
 * @param {number}   opts.startingChips
 * @param {string}   opts.scheduleId     - blind schedule id
 * @param {object[]} opts.players        - [{ accountId, nickname }]
 * @param {object}   opts.scheduleData   - levels array from DB (optional, overrides scheduleId lookup)
 */
function startTournament(opts) {
  const { id, name, mode, startingChips, scheduleId, players, scheduleData, lateLevelCutoff, lateRegMinutes, isSitAndGo, minPlayers } = opts;
  log(`[TM] startTournament called: id=${id.slice(-8)} players=${players.length} mode=${mode} chips=${startingChips}`);

  if (tournaments.has(id)) {
    log(`[TM] Tournament ${id.slice(-8)} already running → return null`);
    return null;
  }

  // ブラインドスケジュールをメモリにコピー
  let levels;
  let schedule = null;
  if (scheduleData && Array.isArray(scheduleData)) {
    levels = scheduleData;
  } else {
    schedule = getSchedule(scheduleId);
    levels = schedule.levels;
  }

  const tournament = {
    id,
    name,
    mode,
    startingChips,
    scheduleId,
    levels,
    currentLevelIdx: 0,
    levelStartedAt:  Date.now(),
    pendingLevelUp:   false,
    tableIds:         [],
    eliminationOrder: [],
    totalPlayers:     players.length,
    status:           'running',
    _levelTimer:      null,
    // レイトレジスト
    // scheduleDataを使う場合はscheduleがnullになるので、scheduleIdからも取得を試みる
    // DB スケジュール使用時は opts.lateLevelCutoff を優先、フォールバックは JS 定義値
    lateLevelCutoff:  lateLevelCutoff ?? schedule?.lateLevelCutoff ?? getSchedule(scheduleId)?.lateLevelCutoff ?? 0,
    lateRegOpen:      true,   // 開始時はtrue、cutoffレベルを過ぎたらfalse
    lateRegMinutes:   lateRegMinutes ?? 0,  // 0=レベルベース管理, >0=時間ベース管理
    lateRegEndAt:     lateRegMinutes > 0 ? Date.now() + lateRegMinutes * 60 * 1000 : null,
    // ファイナルテーブル
    finalTableReached: false,
    // ブレイク中フラグ
    isOnBreak:        false,
    // Sit & Go
    isSitAndGo:       isSitAndGo ?? false,
    minPlayers:       minPlayers ?? 3,
  };

  tournaments.set(id, tournament);

  // テーブル割り当て
  const playerInfos = players.map(p => ({
    accountId: p.accountId,
    nickname:  p.nickname,
    chips:     startingChips,
  }));
  _assignTables(tournament, playerInfos);

  // 全テーブルでゲーム開始（onTimeoutを渡してタイムアウト処理を有効化）
  for (const tableId of tournament.tableIds) {
    const onTimeout = _makeTimeoutHandler ? _makeTimeoutHandler(tableId) : null;
    startGame(tableId, onTimeout);
  }

  // ブラインドレベルアップタイマー開始
  _startLevelTimer(tournament);

  // 時間ベースのレイトレジスト終了タイマー（lateRegMinutes > 0 の場合）
  if (tournament.lateRegMinutes > 0) {
    setTimeout(() => {
      const t = tournaments.get(id);
      if (!t || !t.lateRegOpen) return;
      t.lateRegOpen = false;
      _markLateRegClosed(id);
      log(`[TM] ${id}: late registration CLOSED (time-based, ${tournament.lateRegMinutes}min)`);
      if (_io) {
        for (const tableId of t.tableIds) {
          _io.to(tableId).emit('t:lateRegClosed', { tournamentId: id });
        }
      }
      _broadcastBlindUpdate(t);

      // SNG: レイトレジスト終了と同時に次のトーナメントを作成する。
      // _finishTournament でも作成するが、BOT のみの場合はトーナメントが
      // 長時間続くため、レイトレジスト終了時点で次を用意して参加を受け付ける。
      if (t.isSitAndGo) {
        (async () => {
          try {
            const { createTournament } = require('../db/admin');
            const { getTournament: getTournamentDB } = require('../db/tournament');
            const dbT = await getTournamentDB(id);
            if (dbT) {
              const newId = require('crypto').randomUUID();
              await createTournament({
                id:               newId,
                name:             dbT.name,
                mode:             dbT.mode,
                scheduledStartAt: new Date('2099-01-01').toISOString(),
                startingChips:    dbT.starting_chips,
                maxPlayers:       dbT.max_players ?? null,
                blindScheduleId:  dbT.blind_schedule_id,
                isTest:           dbT.is_test ?? false,
                lateRegMinutes:   dbT.late_reg_minutes ?? 0,
                createdBy:        dbT.created_by,
                isSitAndGo:       true,
                minPlayers:       dbT.min_players ?? 3,
              });
              t._sngRecreated = true;  // _finishTournament での二重作成を防ぐ
              log(`[SNG] auto-recreated on lateReg close: ${newId.slice(-8)} (copy of ${id.slice(-8)})`);
            }
          } catch (e) {
            console.error('[SNG] auto-recreate error:', e.message);
          }
        })();
      }
    }, tournament.lateRegMinutes * 60 * 1000);
  }

  log(`[TM] Tournament ${id} started: ${players.length} players, ${tournament.tableIds.length} tables`);

  // クライアントへ開始通知
  _broadcastTournamentStatus(tournament);

  return tournament;
}

// ===== ブラインドレベルアップタイマー =====
function _startLevelTimer(tournament) {
  if (tournament._levelTimer) clearTimeout(tournament._levelTimer);
  tournament._levelTimer = null;

  const lv = tournament.levels[tournament.currentLevelIdx];
  if (!lv || lv.durationMinutes === 0) return; // 最終レベル

  const ms = lv.durationMinutes * 60 * 1000;

  // pendingLevelUp中に経過した時間分だけ遡ってlevelStartedAtをセット
  // （例: 30秒pendingだったら、新レベルは既に30秒消費済みとして開始）
  const pendingElapsed = tournament.pendingLevelUpAt
    ? Math.max(0, Date.now() - tournament.pendingLevelUpAt)
    : 0;
  tournament.levelStartedAt = Date.now() - pendingElapsed;
  tournament.pendingLevelUpAt = null; // リセット

  const remaining = Math.max(0, ms - pendingElapsed);
  if (remaining <= 0) {
    // すでに次レベルの時間を超過している場合:
    // setTimeout(..., 0) で即 _pendingLevelUp を呼ぶと、
    // applyPendingLevelUp の _broadcastBlindUpdate(pendingLevelUp=false) より後に
    // pendingLevelUp=true が上書きされ「次のハンドでブラインドアップ」が消えないバグになる。
    // → pendingLevelUp フラグだけ立てて次の手でまた applyPendingLevelUp を呼ばせる。
    if (lv.isBreak) tournament.isOnBreak = false;
    tournament.pendingLevelUp    = true;
    tournament.pendingLevelUpAt  = Date.now();
    log(`[blind-debug] _startLevelTimer: remaining=0, set pendingLevelUp=true directly (no broadcast) tournamentId=${tournament.id.slice(-8)}`);
    return;
  }

  tournament._levelTimer = setTimeout(() => {
    const t = tournaments.get(tournament.id);
    if (!t || t.status !== 'running') return;
    // ブレイク終了時: isOnBreak を解除してクライアントに通知
    if (lv.isBreak) {
      t.isOnBreak = false;
      log(`[TM] ${tournament.id}: break ended`);
      // ブレイク終了後のブラインド情報をbroadcast（次レベル予告を表示）
      _broadcastBlindUpdate(t);
    }
    _pendingLevelUp(tournament.id);
  }, remaining);
}

/**
 * レベルアップを「次のハンド開始まで保留」にセット
 * ハンド開始時に gameManager のコールバックからチェックする
 */
function _pendingLevelUp(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (!t || t.status !== 'running') return;

  t.pendingLevelUp = true;
  t.pendingLevelUpAt = Date.now(); // ← pending開始時刻を記録
  log(`[blind-debug] _pendingLevelUp set: tournamentId=${tournamentId.slice(-8)} pendingLevelUp=true`);
  // タイマー0をクライアントに即通知（表示が止まって見えるのを防ぐ）
  _broadcastBlindUpdate(t);

  // waiting 状態で詰まっているテーブルを kickstart する。
  // balanceTables の繰り返しで BOT が出入りし startGame が null のまま
  // 放置されるケースに対するフォールセーフ。
  if (_io && _tryAutoStartFn) {
    const { canAutoStart } = require('../poker/gameManager');
    log(`[stuck-debug] _pendingLevelUp kickstart check: tables=[${t.tableIds.map(id => id.slice(-8)).join(',')}]`);
    for (const tableId of t.tableIds) {
      const room = getOrCreateRoom(tableId);
      const canStart = canAutoStart(tableId);
      log(`[stuck-debug] table=${tableId.slice(-8)} phase=${room?.phase} players=${room?.players.length} pending=${room?.pendingPlayers?.length} canAutoStart=${canStart}`);
      if (room && room.phase === 'waiting' && canStart) {
        log(`[TM] _pendingLevelUp kickstart stuck table ${tableId.slice(-8)}`);
        _tryAutoStartFn(_io, tableId);
      }
    }
    // 3秒後に再チェック: 全テーブルが進行中で kickstart できなかったケースの取りこぼし防止
    const _tid = t.id;
    setTimeout(() => {
      const _t2 = tournaments.get(_tid);
      if (!_t2 || !_t2.pendingLevelUp) return; // 既に解消済み
      log(`[stuck-debug] _pendingLevelUp retry kickstart after 3s: tournamentId=${_tid.slice(-8)}`);
      for (const tableId of _t2.tableIds) {
        const room = getOrCreateRoom(tableId);
        if (room && room.phase === 'waiting' && canAutoStart(tableId)) {
          log(`[TM] _pendingLevelUp retry kickstart table ${tableId.slice(-8)}`);
          _tryAutoStartFn(_io, tableId);
        }
      }
    }, 3000);
  } else {
    log(`[stuck-debug] _pendingLevelUp: _io=${!!_io} _tryAutoStartFn=${!!_tryAutoStartFn} (injection missing?)`);
  }
}

/**
 * ハンド開始直前に呼ばれる（server/index.js の startGame コールバック等から）
 * pendingLevelUp があれば全テーブルのブラインドを更新する
 */
function applyPendingLevelUp(tournamentId) {
  const t = tournaments.get(tournamentId);
  log(`[blind-debug] applyPendingLevelUp called: tournamentId=${tournamentId.slice(-8)} pendingLevelUp=${t?.pendingLevelUp} status=${t?.status}`);
  if (!t || !t.pendingLevelUp || t.status !== 'running') return false;

  t.pendingLevelUp  = false;
  t.currentLevelIdx = Math.min(t.currentLevelIdx + 1, t.levels.length - 1);

  const lv = t.levels[t.currentLevelIdx];

  if (lv.isBreak) {
    // ブレイクレベル: ブラインドは変更せず休憩フラグをセットしてタイマー起動
    log(`[TM] ${tournamentId}: entering break: ${lv.breakLabel}`);
    t.isOnBreak = true;
    t._notifyBlindUpdate = 'break';  // ブレイク突入通知
    _startLevelTimer(t); // ブレイクタイマー開始（終了時にisOnBreak=falseとbroadcast）
    _broadcastBlindUpdate(t); // クライアントにブレイク状態を通知
    return true;
  }

  log(`[TM] ${tournamentId}: blind level up → Lv${lv.level} sb=${lv.sb} bb=${lv.bb}`);
  t._notifyBlindUpdate = 'blindUp';  // ブラインドアップ通知

  // レイトレジスト終了チェック（時間ベース管理の場合はタイマーに任せるのでスキップ）
  if (t.lateRegOpen && t.lateRegMinutes === 0 && lv.level !== null && lv.level > t.lateLevelCutoff) {
    t.lateRegOpen = false;
    _markLateRegClosed(tournamentId);
    log(`[TM] ${tournamentId}: late registration CLOSED at Lv${lv.level}`);
    if (_io) {
      for (const tableId of t.tableIds) {
        _io.to(tableId).emit('t:lateRegClosed', { tournamentId: t.id });
      }
    }
    // SNG: レベルベースのlateReg終了時に次のトーナメントを作成する
    // （時間ベースはタイマー内で作成済み。レベルベースはここで初めて作成）
    if (t.isSitAndGo) {
      (async () => {
        try {
          const { createTournament } = require('../db/admin');
          const { getTournament: getTournamentDB } = require('../db/tournament');
          const dbT = await getTournamentDB(tournamentId);
          if (dbT) {
            const newId = require('crypto').randomUUID();
            await createTournament({
              id:               newId,
              name:             dbT.name,
              mode:             dbT.mode,
              scheduledStartAt: new Date('2099-01-01').toISOString(),
              startingChips:    dbT.starting_chips,
              maxPlayers:       dbT.max_players ?? null,
              blindScheduleId:  dbT.blind_schedule_id,
              isTest:           dbT.is_test ?? false,
              lateRegMinutes:   dbT.late_reg_minutes ?? 0,
              createdBy:        dbT.created_by,
              isSitAndGo:       true,
              minPlayers:       dbT.min_players ?? 3,
            });
            t._sngRecreated = true;  // _finishTournament での二重作成を防ぐ
            log(`[SNG] auto-recreated on lateReg close (level-based): ${newId.slice(-8)} (copy of ${tournamentId.slice(-8)})`);
          }
        } catch (e) {
          console.error('[SNG] auto-recreate error (level-based):', e.message);
        }
      })();
    }
  }

  // 全テーブルのブラインドを更新
  // ゲーム進行中（bet0〜bet3 / draw1〜draw3）のテーブルは即時書き換えしない。
  // 書き換えると同一ハンド内でフェーズによってベット額が変わるバグが発生するため、
  // 進行中テーブルには _pendingBlind に新値を保持し、次の startGame で適用する。
  for (const tableId of t.tableIds) {
    const room = getOrCreateRoom(tableId);
    const inProgress = room.phase !== 'waiting' && room.phase !== 'showdown';
    if (inProgress) {
      // 進行中: 次ハンド開始時に適用するため pending に保持
      room._pendingBlind = { sb: lv.sb, bb: lv.bb, smallBet: lv.smallBet, bigBet: lv.bigBet };
      logDev(`[TM] blind-pending (in-progress phase=${room.phase}) ${tableId.slice(-8)}`);
    } else {
      // 待機中/showdown: 即時適用
      room.smallBlind    = lv.sb;
      room.bigBlind      = lv.bb;
      room.smallBet      = lv.smallBet;
      room.bigBet        = lv.bigBet;
    }
  }

  // 次レベルのタイマー開始
  _startLevelTimer(t);

  // 全クライアントへブラインド更新通知（pendingLevelUp=false を確実に届ける）
  _broadcastBlindUpdate(t);

  return true;
}

// ===== 脱落検出 =====
/**
 * ハンド終了後（showdown 後）に各テーブルで呼ぶ
 * チップが 0 以下のプレイヤーを脱落扱いにする
 */
function checkEliminations(tableId) {
  const tournamentId = roomToTournament.get(tableId);
  if (!tournamentId) return;
  const t = tournaments.get(tournamentId);
  if (!t || t.status !== 'running') return;

  const { getOrCreateRoom: getRoom } = require('../poker/gameManager');
  const room = getRoom(tableId);
  if (!room) return;

  const alreadyEliminated = new Set(t.eliminationOrder);
  const eliminated = room.players.filter(p =>
    p.chips <= 0 && !alreadyEliminated.has(p.accountId ?? p.id)
  );
  for (const p of eliminated) {
    _eliminatePlayer(t, tableId, p);
  }

  // ステータス通知（ファイナルテーブル検出含む）
  _broadcastTournamentStatus(t);

  // 全体で1人になったらトーナメント終了
  const remaining = _countRemaining(t);
  if (remaining <= 1) {
    _finishTournament(t);
  }
}

function _eliminatePlayer(tournament, tableId, player) {
  // rankは「現在の生存者数 + 脱落済み数 + 1（今脱落するプレイヤー自身）」
  // totalPlayersはBOT追加で増減するため使わず、実際の残人数から計算
  const currentRemaining = (() => {
    const { getOrCreateRoom: gr } = require('../poker/gameManager');
    let cnt = 0;
    for (const tid of tournament.tableIds) {
      const r = gr(tid);
      if (r) cnt += r.players.length;
    }
    return cnt;
  })();
  const rank = currentRemaining;  // 今いる人数 = この人の順位
  tournament.eliminationOrder.push(player.accountId ?? player.id);

  log(`[TM] ${tournament.id}: ${player.name} eliminated, rank=${rank}`);

  // テーブルから退場（leaveRoomはsocketId単一引数）
  leaveRoom(player.id);

  // ソケットをSocket.IOルームからも退出させる。
  // これをしないと脱落後もソケットがトーナメントテーブルの room に残り、
  // 次ハンドの t:tournamentStarting が脱落者に届いて
  // _app.tsx の TournamentStartWatcher が draw ページへ誤遷移させるバグの原因になる。
  if (_io) {
    const sock = _io.sockets.sockets.get(player.id);
    if (sock) sock.leave(tableId);
  }

  // 同テーブルの全員にバスト通知（showdown表示が先に届くよう1秒遅延）
  if (_io) {
    const tid = tableId;
    const payload = { playerName: player.name, rank, totalPlayers: tournament.totalPlayers };
    setTimeout(() => {
      if (_io) _io.to(tid).emit('t:playerEliminated', payload);
    }, 1000);
  }

  // 本人に脱落通知
  // player.id（socket.id）が古い場合のフォールバックとして accountId でも検索する
  if (_io) {
    let sock = _io.sockets.sockets.get(player.id);
    if (!sock && _getSocketByAccountId && player.accountId) {
      const freshSocketId = _getSocketByAccountId(player.accountId);
      if (freshSocketId) sock = _io.sockets.sockets.get(freshSocketId);
      if (sock) log(`[TM] _eliminatePlayer: fallback socket found for ${player.name} via accountId`);
    }
    if (sock) {
      sock.emit('t:eliminated', {
        rank,
        totalPlayers: tournament.totalPlayers,
      });
    } else {
      log(`[TM] _eliminatePlayer: socket not found for ${player.name} (${player.id.slice(-8)})`);
    }
  }
}

function _countRemaining(tournament) {
  // pendingPlayers（ゲーム中テーブルに移動してきたプレイヤー）も含めてカウント。
  // これを漏らすと「1人しかいない」と誤判定して _finishTournament が呼ばれてしまう。
  let count = 0;
  for (const tableId of tournament.tableIds) {
    const room = getOrCreateRoom(tableId);
    if (room) count += room.players.length + room.pendingPlayers.length;
  }
  return count;
}

// ===== トーナメント終了 =====
function _finishTournament(tournament) {
  tournament.status = 'finished';
  if (tournament._levelTimer) clearTimeout(tournament._levelTimer);
  tournament._levelTimer = null;

  // 最終順位確定（残っているプレイヤーが1位）
  const rankings = [];
  for (const tableId of tournament.tableIds) {
    const room = getOrCreateRoom(tableId);
    if (room) {
      for (const p of room.players) {
        rankings.push({ accountId: p.accountId ?? p.id, nickname: p.name, rank: 1, chips: p.chips });
      }
    }
  }
  // 脱落順から下位を追加（重複 accountId がある場合は最初のエントリのみ使用）
  const seenIds = new Set(rankings.map(r => r.accountId));
  for (let i = tournament.eliminationOrder.length - 1; i >= 0; i--) {
    const accountId = tournament.eliminationOrder[i];
    if (seenIds.has(accountId)) continue;  // 重複をスキップ
    seenIds.add(accountId);
    const rank = tournament.totalPlayers - i;
    rankings.push({ accountId, rank });
  }

  log(`[TM] ${tournament.id}: finished`);
  _clearLateRegState(tournament.id);

  // DBのステータスをfinishedに更新 + 結果を保存 + SNG自動再作成
  (async () => {
    try {
      const { updateTournamentStatus, createTournament } = require('../db/admin');
      await updateTournamentStatus(tournament.id, 'finished');
      const { recordTournamentResults } = require('../db/points');
      const { isTournamentBotId } = require('./tournamentBotManager');
      // BOT（tbot::プレフィックス）はDBのFK制約に引っかかるため除外
      const dbResults = rankings
        .filter(r => r.accountId && !isTournamentBotId(r.accountId))
        .map(r => ({
          accountId: r.accountId,
          finalRank: r.rank,
          finalChips: r.chips ?? 0,
        }));
      if (dbResults.length > 0) {
        await recordTournamentResults(tournament.id, dbResults);
      }

      // Sit & Go: lateReg終了時に再作成済み（_sngRecreated=true）の場合はスキップ。
      // レベルベース（lateRegMinutes=0）の再作成は applyPendingLevelUp で実施済み。
      // 時間ベース（lateRegMinutes>0）の再作成はレイトレジスト終了タイマーで実施済み。
      if (tournament.isSitAndGo && !tournament._sngRecreated) {
        const { getTournament: getTournamentDB } = require('../db/tournament');
        const dbT = await getTournamentDB(tournament.id);
        if (dbT) {
          const newId = require('crypto').randomUUID();
          await createTournament({
            id:              newId,
            name:            dbT.name,
            mode:            dbT.mode,
            scheduledStartAt: new Date('2099-01-01').toISOString(),
            startingChips:   dbT.starting_chips,
            maxPlayers:      dbT.max_players ?? null,
            blindScheduleId: dbT.blind_schedule_id,
            isTest:          dbT.is_test ?? false,
            lateRegMinutes:  dbT.late_reg_minutes ?? 0,
            createdBy:       dbT.created_by,
            isSitAndGo:      true,
            minPlayers:      dbT.min_players ?? 3,
          });
          log(`[SNG] auto-recreated on finish: ${newId.slice(-8)} (copy of ${tournament.id.slice(-8)})`);
        }
      }
    } catch (e) {
      console.error('[TM] finish DB error:', e.message);
    }
  })();

  // 全テーブルに終了通知（5秒遅延: 最終ハンドのshowdown表示時間を確保）
  if (_io) {
    const tableIds = [...tournament.tableIds];
    setTimeout(() => {
      if (!_io) return;
      for (const tableId of tableIds) {
        _io.to(tableId).emit('t:tournamentFinished', { rankings });
      }
      // 通知送信後にテーブルをメモリから削除（通知前に削除するとgameStateが届かなくなる）
      _cleanupTables(tournament);
    }, 7000);
  } else {
    // IOなし（テスト等）は即削除
    _cleanupTables(tournament);
  }
}

function _cleanupTables(tournament) {
  const { deleteRoom } = require('../poker/gameManager');
  const { removeBots }  = require('./tournamentBotManager');
  for (const tableId of tournament.tableIds) {
    roomToTournament.delete(tableId);
    deleteRoom(tableId);   // 公開関数経由で削除（内部 Map への直接参照を避ける）
    removeBots(tableId);   // _bots / _tableBots Map もクリーンアップ
  }
  tournament.tableIds = [];
  // tournaments Map 自体も遅延削除（通知送信後に呼ばれるため即削除で問題なし）
  setTimeout(() => {
    tournaments.delete(tournament.id);
    // 当該トーナメントに紐づく disconnectedChips もクリーンアップ
    for (const [accountId, v] of _disconnectedChips.entries()) {
      if (v.tournamentId === tournament.id) _disconnectedChips.delete(accountId);
    }
  }, 5000);
}

// ===== ステータス通知 =====
function _broadcastTournamentStatus(tournament) {
  if (!_io) return;
  const remaining = _countRemaining(tournament);
  const total = remaining + tournament.eliminationOrder.length;
  if (total > tournament.totalPlayers) tournament.totalPlayers = total;
  const totalChips = tournament.totalPlayers * tournament.startingChips;
  const averageStack = remaining > 0 ? Math.floor(totalChips / remaining) : 0;

  // ファイナルテーブル突入検出: テーブルが1つになった瞬間
  const isFinalTable = tournament.tableIds.length === 1 && remaining > 1 && !tournament.lateRegOpen;
  if (isFinalTable && !tournament.finalTableReached) {
    tournament.finalTableReached = true;
    log(`[TM] ${tournament.id}: FINAL TABLE! ${remaining} players remain`);
    if (_io) {
      for (const tableId of tournament.tableIds) {
        _io.to(tableId).emit('t:finalTable', {
          tournamentId: tournament.id,
          remainingPlayers: remaining,
        });
      }
    }
  }

  const payload = {
    tournamentId:     tournament.id,
    totalPlayers:     tournament.totalPlayers,
    remainingPlayers: remaining,
    averageStack,
    isFinalTable,
  };

  for (const tableId of tournament.tableIds) {
    _io.to(tableId).emit('t:tournamentStatus', payload);
  }
}

function _broadcastBlindUpdate(tournament) {
  if (!_io) return;
  const lv      = tournament.levels[tournament.currentLevelIdx];
  const elapsed = Date.now() - tournament.levelStartedAt;
  const remaining = lv.durationMinutes > 0
    ? Math.max(0, Math.floor((lv.durationMinutes * 60 * 1000 - elapsed) / 1000))
    : 0;

  // 次の非ブレイクレベルを探す（ブレイク中でも次のブラインド額を予告）
  let nextLv = null;
  for (let i = tournament.currentLevelIdx + 1; i < tournament.levels.length; i++) {
    if (!tournament.levels[i].isBreak) { nextLv = tournament.levels[i]; break; }
  }

  const payload = {
    level:              lv.level,
    sb:                 lv.sb,
    bb:                 lv.bb,
    smallBet:           lv.smallBet,
    bigBet:             lv.bigBet,
    secondsToNextLevel: lv.durationMinutes === 0 ? 0 : remaining,
    isLastLevel:        lv.durationMinutes === 0 && !lv.isBreak,
    nextSb:             nextLv?.sb   ?? null,
    nextBb:             nextLv?.bb   ?? null,
    isBreak:            !!lv.isBreak,
    breakLabel:         lv.isBreak ? (lv.breakLabel ?? 'Break') : null,
    lateRegOpen:        tournament.lateRegOpen ?? false,
    lateRegLevelCutoff: tournament.lateLevelCutoff ?? 0,
    lateRegSecondsRemaining: (tournament.lateRegEndAt && tournament.lateRegOpen)
      ? Math.max(0, Math.round((tournament.lateRegEndAt - Date.now()) / 1000))
      : null,
    notify:             tournament._notifyBlindUpdate ?? null,  // 'blindUp' | 'break' | null
    pendingLevelUp:     tournament.pendingLevelUp ?? false,     // 次のハンドでブラインドアップ予定
  };
  tournament._notifyBlindUpdate = null;  // 一度送ったらリセット

  log(`[blind-debug] _broadcastBlindUpdate: tournamentId=${tournament.id.slice(-8)} pendingLevelUp=${payload.pendingLevelUp} level=${payload.level} secondsToNext=${payload.secondsToNextLevel}`);
  for (const tableId of tournament.tableIds) {
    _io.to(tableId).emit('t:blindUpdate', payload);
  }
}

/**
 * テーブルの gameState を全プレイヤー（および観戦者）へ配信する
 * BOT追加後・startTournament後など、index.js の _broadcast が呼べない場合に使う
 */
function broadcastTableState(tableId) {
  if (!_io) return;
  const { buildGameState, getOrCreateRoom: getRoom } = require('../poker/gameManager');
  const room = getRoom(tableId);
  if (!room) return;

  for (const player of [...room.players, ...room.pendingPlayers]) {
    const s = _io.sockets.sockets.get(player.id);
    if (!s) continue;
    const state   = buildGameState(room, player.id);
    const meta    = state.find((x) => x._meta);
    const players = state.filter((x) => !x._meta);
    s.emit('gameState', { players, meta });
  }
}

/**
 * balance移動後にBOTアクションチェーンを起動する
 * index.js の _broadcast チェーンと干渉しないよう、
 * _pendingBotAction で二重防止される triggerBotActions のみ呼ぶ
 * コールバックは index.js の _broadcast チェーンに委譲（_scheduleAutoStart経由）
 */
// balance後のBOTアクション起動は index.js の _broadcast チェーンに一本化
// _broadcastFn(tableId) を呼ぶことで gameState 送信 + triggerBotActions が1系統で実行される
// （2系統の triggerBotActions 競合による _pendingBotAction デッドロックを防ぐ）
function _kickstartAfterBalance(tableId) {
  if (_broadcastFn) {
    _broadcastFn(tableId);
  } else {
    // フォールバック: _broadcastFn 未注入の場合は gameState のみ送信
    broadcastTableState(tableId);
  }
  // バランシング後に移動先テーブルが自動開始できる状態なら開始を試みる。
  // 300ms 後のチェック時に別バランシングでプレイヤーが移動していると
  // canAutoStart=false になり _tryAutoStart が発火しないため、
  // 300ms / 1s / 3s / 7s と多段リトライしてテーブルが詰まらないようにする。
  if (_io && _tryAutoStartFn) {
    const _room = getOrCreateRoom(tableId);
    const _canStart = canAutoStart(tableId);
    log(`[stuck-debug] _kickstartAfterBalance table=${tableId.slice(-8)} phase=${_room?.phase} players=${_room?.players.length} pendingPlayers=${_room?.pendingPlayers?.length} canAutoStart=${_canStart}`);
    const _retryDelays = [300, 1000, 3000, 7000];
    for (const delay of _retryDelays) {
      setTimeout(() => {
        const r = getOrCreateRoom(tableId);
        if (r && r.phase === 'waiting' && canAutoStart(tableId)) {
          log(`[stuck-debug] _kickstartAfterBalance retry table=${tableId.slice(-8)} delay=${delay}`);
          _tryAutoStartFn(_io, tableId);
        }
      }, delay);
    }
  }
}

// ===== クエリ API =====
function isTournamentTable(tableId) {
  return roomToTournament.has(tableId);
}

function getTournamentByTable(tableId) {
  const id = roomToTournament.get(tableId);
  return id ? tournaments.get(id) : null;
}

function getTournament(tournamentId) {
  return tournaments.get(tournamentId) ?? null;
}

/**
 * accountId からそのプレイヤーが着席しているテーブルIDを返す
 * @returns {string|null}
 */
function getTableForPlayer(tournamentId, accountId) {
  const t = tournaments.get(tournamentId);
  if (!t) return null;
  const { getOrCreateRoom: getRoom } = require('../poker/gameManager');
  for (const tableId of t.tableIds) {
    const room = getRoom(tableId);
    if (!room) continue;
    const allPlayers = [...room.players, ...room.pendingPlayers];
    const found = allPlayers.find(p =>
      p.id === accountId ||
      p.accountId === accountId ||
      p.name === accountId
    );
    if (process.env.NODE_ENV !== 'production' && !found && allPlayers.length > 0) {
      const humanPlayers = allPlayers.filter(p => !p.id?.startsWith('bot::'));
      if (humanPlayers.length > 0) {
        log(`[getTableForPlayer] table=${tableId.slice(-8)} humans=[${humanPlayers.map(p => `${p.name}(id=${p.id?.slice(-8)},accId=${p.accountId})`).join(',')}] searching=${accountId}`);
      }
    }
    if (found) return tableId;
  }
  return null;
}

/**
 * 現在のブラインド情報を取得（接続直後の初回配信用）
 */
function getCurrentBlindPayload(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (!t) return null;

  const lv     = t.levels[t.currentLevelIdx];
  const nextLv = t.levels[t.currentLevelIdx + 1] ?? null;
  const elapsed = Date.now() - t.levelStartedAt;
  const remaining = lv.durationMinutes > 0
    ? Math.max(0, Math.floor((lv.durationMinutes * 60 * 1000 - elapsed) / 1000))
    : 0;

  // 次の非ブレイクレベルを探す
  let nextLvP = null;
  for (let i = t.currentLevelIdx + 1; i < t.levels.length; i++) {
    if (!t.levels[i].isBreak) { nextLvP = t.levels[i]; break; }
  }

  return {
    level:              lv.level,
    sb:                 lv.sb,
    bb:                 lv.bb,
    smallBet:           lv.smallBet,
    bigBet:             lv.bigBet,
    secondsToNextLevel: lv.durationMinutes === 0 ? 0 : remaining,
    isLastLevel:        lv.durationMinutes === 0 && !lv.isBreak,
    nextSb:             nextLvP?.sb ?? null,
    nextBb:             nextLvP?.bb ?? null,
    isBreak:            !!lv.isBreak,
    breakLabel:         lv.isBreak ? (lv.breakLabel ?? 'Break') : null,
    lateRegOpen:        t.lateRegOpen ?? false,
    lateRegLevelCutoff: t.lateLevelCutoff ?? 0,
    lateRegSecondsRemaining: (t.lateRegEndAt && t.lateRegOpen)
      ? Math.max(0, Math.round((t.lateRegEndAt - Date.now()) / 1000))
      : null,
    // 再接続時に pendingLevelUp 状態を正確に伝えるために追加
    pendingLevelUp:     t.pendingLevelUp ?? false,
  };
}

/**
 * 強制退場（タイムアウトキック・管理者キック）
 * index.js の _makeTimeoutHandler から呼ばれる
 */
function handleForcedLeave(tableId, playerId, reason) {
  const tournamentId = roomToTournament.get(tableId);
  if (!tournamentId) {
    leaveRoom(tableId, playerId);
    return;
  }
  const t = tournaments.get(tournamentId);
  if (!t) {
    leaveRoom(tableId, playerId);
    return;
  }

  const { getOrCreateRoom: getRoom } = require('../poker/gameManager');
  const room = getRoom(tableId);
  const player = room?.players.find(p => p.id === playerId);

  if (player) {
    log(`[TM] ${tournamentId}: forced leave ${player.name} (${reason}) chips=${player.chips}`);
    if (player.chips > 0) {
      // チップがある = 切断しただけで脱落ではない
      // チップを _disconnectedChips に退避してから leaveRoom する。
      // sittingOut=true を使うと startGame のリセットで毎ハンド上書きされるため使わない。
      const accountId = player.accountId ?? player.id;
      _disconnectedChips.set(accountId, { chips: player.chips, tableId, tournamentId });
      log(`[TM] ${tournamentId}: ${player.name} chips=${player.chips} preserved (disconnected)`);
      leaveRoom(tableId, playerId);
    } else {
      // チップ0 = 本当に脱落（ショーダウンで負けた後など）
      _disconnectedChips.delete(player.accountId ?? player.id);
      _eliminatePlayer(t, tableId, player);
      const remaining = _countRemaining(t);
      if (remaining <= 1) _finishTournament(t);
    }
  } else {
    leaveRoom(tableId, playerId);
  }
}

// ===== テーブルバランシング =====
/**
 * 複数テーブルのプレイヤー人数を均等化する
 * - テーブルが1人以下 → そのテーブルを解体して他テーブルへ移動
 * - テーブル間の差が2以上 → 多い方から少ない方へ1人移動
 * ハンド終了後（checkEliminations後）に呼ぶ
 */
function balanceTables(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (!t || t.status !== 'running') return;
  if (t.tableIds.length <= 1) return;

  const { getOrCreateRoom: getRoom, leaveRoom: lr, joinRoom: jr } = require('../poker/gameManager');
  const { isTournamentBotId, moveBot } = require('./tournamentBotManager');

  const MAX_PER_TABLE = 6;

  // バランシング開始スナップショット（開発時）
  const _elSetSnap = new Set(t.eliminationOrder);
  const _snapBefore = t.tableIds.map(tid => {
    const r = getRoom(tid);
    const alive = r ? r.players.filter(p => !_elSetSnap.has(p.accountId ?? p.id)).length : 0;
    return `${tid.slice(-8)}:${alive}人`;
  }).join(', ');
  const _totalSnap = _countRemaining(t);
  const _neededSnap = Math.max(1, Math.ceil(_totalSnap / MAX_PER_TABLE));
  logDev(`[balance] START tables=[${_snapBefore}] remaining=${_totalSnap} needed=${_neededSnap}`);

  // --- ヘルパー: 1テーブルを解体して全プレイヤーを他テーブルへ移動 ---
  const _dissolveTable = (tid) => {
    const room = getRoom(tid);
    if (!room) { t.tableIds = t.tableIds.filter(id => id !== tid); return; }

    // ゲーム進行中のテーブルは解体しない（showdown/waiting のみ許可）
    if (room.phase !== 'waiting' && room.phase !== 'showdown') {
      logDev(`[TM] balance: dissolve skipped (in-progress phase=${room.phase}) ${tid.slice(-8)}`);
      return;
    }

    for (const p of [...room.players]) {
      // 移動先: 現テーブル以外で最も人数が少ないテーブル（毎回再計算）
      const dest = t.tableIds
        .filter(id => id !== tid)
        .map(id => {
          const r = getRoom(id);
          return { id, cnt: (r?.players.length ?? 0) + (r?.pendingPlayers.length ?? 0) };
        })
        .sort((a, b) => a.cnt - b.cnt)[0];
      if (!dest) continue;

      logDev(`[TM] balance: dissolve-move ${p.name} ${tid.slice(-8)} → ${dest.id.slice(-8)}`);
      const chips = p.chips;
      const name  = p.name;
      const accId = p.accountId ?? p.id;
      if (_io) _io.to(tid).emit('t:playerLeft', { playerName: name });
      lr(p.id);
      jr(dest.id, p.id, name, { existingChips: chips, accountId: accId });
      if (isTournamentBotId(p.id)) moveBot(p.id, tid, dest.id);
      if (_io) {
        const sock = _io.sockets.sockets.get(p.id);
        if (sock) {
          // jr() が登録する id（p.id）と実際の sock.id が一致しているか関係なく
          // 常に最新の sock.id に更新する。これにより移動後のアクション拒否を防ぐ。
          {
            const { getOrCreateRoom: _gcr } = require('../poker/gameManager');
            const _destRoom = _gcr(dest.id);
            const _movedPlayer = _destRoom?.players.find(pp => pp.accountId === accId || pp.name === name)
                              ?? _destRoom?.pendingPlayers?.find(pp => pp.accountId === accId || pp.name === name);
            if (_movedPlayer && _movedPlayer.id !== sock.id) {
              logDev(`[TM] balance: update socket.id ${_movedPlayer.id.slice(-8)} → ${sock.id.slice(-8)} for ${name}`);
              _movedPlayer.id = sock.id;
            }
          }
          // Socket.IO ルームの切り替えは即時（遅らせるとゲーム開始後にgameStateが届かずタイムアウトするバグになる）
          // showdown 結果確認のための遅延は t:tableTransfer 通知のみに適用する
          sock.leave(tid);
          sock.join(dest.id);
          // t:tableJoin を即時送信: クライアントの tableIdRef を即座に更新して
          // アクションが旧テーブルに送られるバグを防ぐ（t:tableTransfer は3秒後に送る）
          sock.emit('t:tableJoin', { toTableId: dest.id });
          const _sock = sock;
          const _fromTid = tid, _toTid = dest.id, _pId = p.id;
          setTimeout(() => {
            _sock.emit('t:tableTransfer', { fromTableId: _fromTid, toTableId: _toTid });
            // pendingPlayersに入った場合（dest.id進行中テーブル）は待機通知を送る
            const destRoom = getRoom(_toTid);
            const isPending = destRoom?.pendingPlayers?.some(pp => pp.id === _pId || pp.id === _sock.id);
            if (isPending) {
              _sock.emit('t:pendingTableTransfer', {
                tableId: _toTid,
                message: '次のハンドから参加します',
              });
            }
          }, 3000);
        }
        _io.to(dest.id).emit('t:playerArrived', { playerName: name });
        // 移動先テーブルにBOTのターンが来ていたらアクションを起動
        _kickstartAfterBalance(dest.id);
      }
    }
    t.tableIds = t.tableIds.filter(id => id !== tid);
    roomToTournament.delete(tid);
    logDev(`[TM] balance: dissolved ${tid.slice(-8)}, tables left: ${t.tableIds.length}`);

    // 解体テーブルを観戦していたソケットへ移動先テーブルを通知
    // （観戦者は t:tableClosed を受け取って新テーブルへ切り替える）
    if (_io && t.tableIds.length > 0) {
      const newTid = t.tableIds[0];
      _io.to(tid).emit('t:tableClosed', { tournamentId: t.id, newTableId: newTid });
    }
  };

  // --- フェーズ1: テーブル数の最適化（過剰なテーブルを解消）---
  // 必要テーブル数 = ceil(totalRemaining / MAX_PER_TABLE)
  // 現在のテーブル数がそれより多ければ最小テーブルを解体して統合
  for (let pass = 0; pass < 20; pass++) {
    if (t.tableIds.length <= 1) break;
    const totalRemaining = _countRemaining(t);
    const neededTables = Math.max(1, Math.ceil(totalRemaining / MAX_PER_TABLE));
    if (t.tableIds.length <= neededTables) break;  // 最適なテーブル数に達した
    // 最も人数が少ないテーブルを解体（waiting/showdown のみ対象）
    const smallest = t.tableIds
      .map(tid => {
        const r = getRoom(tid);
        return { tid, cnt: (r?.players.length ?? 0) + (r?.pendingPlayers.length ?? 0), phase: r?.phase };
      })
      .filter(x => x.phase === 'waiting' || x.phase === 'showdown')  // ゲーム進行中は除外
      .sort((a, b) => a.cnt - b.cnt)[0];
    if (!smallest) break;  // 解体可能なテーブルがなければ終了
    _dissolveTable(smallest.tid);
  }

  // 統合直後に残ったテーブルが waiting なら autoStart
  if (t.tableIds.length === 1 && _io && _tryAutoStartFn) {
    const singleTid = t.tableIds[0];
    const { canAutoStart } = require('../poker/gameManager');
    if (canAutoStart(singleTid)) {
      logDev(`[TM] balance: kickstart final table ${singleTid.slice(-8)}`);
      setTimeout(() => _tryAutoStartFn(_io, singleTid), 500);
    }
  }

  if (t.tableIds.length <= 1) return;

  // フェーズ1終了後の「必要テーブル数」を再計算
  // これより少ないテーブルには統合しない（過剰な統合防止）
  const neededTablesAfterPhase1 = Math.max(1, Math.ceil(_countRemaining(t) / MAX_PER_TABLE));

  // --- フェーズ2: 1人以下のテーブルを解体 ---
  // ただし現在のテーブル数 > neededTables の場合のみ解体（必要数を下回らない）
  // counts はループ内で毎回再計算（stale-counts バグ防止）
  for (let pass = 0; pass < 20; pass++) {
    if (t.tableIds.length <= 1) break;
    if (t.tableIds.length <= neededTablesAfterPhase1) break;  // 必要数に達したら停止
    const counts = t.tableIds.map(tid => {
      const r = getRoom(tid);
      return { tid, count: (r?.players.length ?? 0) + (r?.pendingPlayers.length ?? 0) };
    });
    const toDissolve = counts.find(x => {
      if (x.count > 1) return false;
      const r = getRoom(x.tid);
      return r?.phase === 'waiting' || r?.phase === 'showdown';  // ゲーム進行中は除外
    });
    if (!toDissolve) break;
    _dissolveTable(toDissolve.tid);
  }

  if (t.tableIds.length <= 1) return;

  // --- フェーズ2.5: 2人テーブルを解消（他テーブルに余裕があれば統合） ---
  // テーブルが2以上あり、かつ現在のテーブル数 > neededTables の場合のみ統合
  for (let pass = 0; pass < 10; pass++) {
    if (t.tableIds.length <= 1) break;
    if (t.tableIds.length <= neededTablesAfterPhase1) break;  // 必要数に達したら停止
    const allCounts = t.tableIds.map(tid => {
      const r = getRoom(tid);
      return { tid, count: (r?.players.length ?? 0) + (r?.pendingPlayers.length ?? 0) };
    });
    const twoPersonTable = allCounts.find(x => x.count <= 2);
    if (!twoPersonTable) break;
    // 統合先テーブルに余裕があるか確認（MAX_PER_TABLE未満）
    const hasDest = allCounts.some(x => x.tid !== twoPersonTable.tid && x.count + twoPersonTable.count <= MAX_PER_TABLE);
    if (!hasDest) {
      // 統合できない場合: 最大テーブルから最小テーブルへ逆方向移動して均等化
      // 例: 6+2 → 5+3、6+2+2 → 5+2+3 のように大きいテーブルから1人移動
      const sortedBig = allCounts.filter(x => x.tid !== twoPersonTable.tid).sort((a,b) => b.count - a.count);
      const srcTable = sortedBig[0]; // 最も人数が多いテーブルを移動元に
      if (srcTable && srcTable.count > twoPersonTable.count + 1) {
        const roomSrc = getRoom(srcTable.tid);
        if (roomSrc?.phase === 'waiting' || roomSrc?.phase === 'showdown') {
          const candidate = roomSrc.players.find(p => p.folded || p.sittingOut) ?? roomSrc.players[0];
          if (candidate) {
            const chips = candidate.chips;
            const name  = candidate.name;
            const accId = candidate.accountId ?? candidate.id;
            if (_io) _io.to(srcTable.tid).emit('t:playerLeft', { playerName: name });
            const { leaveRoom: lr, joinRoom: jr } = require('../poker/gameManager');
            lr(candidate.id);
            jr(twoPersonTable.tid, candidate.id, name, { existingChips: chips, accountId: accId });
            const { isTournamentBotId, moveBot: moveBotFn } = require('./tournamentBotManager');
            if (isTournamentBotId(candidate.id)) moveBotFn(candidate.id, srcTable.tid, twoPersonTable.tid);
            if (_io) {
              const sock = _io.sockets.sockets.get(candidate.id);
              if (sock) { sock.emit('t:tableTransfer', { fromTableId: srcTable.tid, toTableId: twoPersonTable.tid }); sock.leave(srcTable.tid); sock.join(twoPersonTable.tid); }
              _io.to(twoPersonTable.tid).emit('t:playerArrived', { playerName: name });
            }
            logDev(`[TM] balance: dissolve-move ${name} ${srcTable.tid.slice(-8)} → ${twoPersonTable.tid.slice(-8)}`);
            continue; // 再チェック
          }
        }
      }
      break;
    }
    _dissolveTable(twoPersonTable.tid);
  }

  if (t.tableIds.length <= 1) return;

  // 差が2以上あれば均等になるまでループで移動
  const movedTables = new Set();
  for (let pass = 0; pass < 10; pass++) {  // 最大10回で安全上限
    const refreshed = t.tableIds.map(tid => ({ tid, count: (getRoom(tid)?.players ?? []).length }));
    const maxT = refreshed.reduce((a, b) => a.count > b.count ? a : b);
    const minT = refreshed.reduce((a, b) => a.count < b.count ? a : b);
    if (maxT.count - minT.count < 2) break;  // 均等になったら終了

    const roomMax = getRoom(maxT.tid);
    if (!roomMax || roomMax.players.length === 0) break;
    // showdown または waiting 以外（ゲーム進行中）のテーブルからは移動しない
    // 次のshowdown後に再度balanceTablesが呼ばれるのを待つ
    if (roomMax.phase !== 'waiting' && roomMax.phase !== 'showdown') break;
    // ゲーム中でないプレイヤーを優先して移動（folded or sittingOut）
    const candidate = roomMax.players.find(p => p.folded || p.sittingOut) ?? roomMax.players[0];
    if (!candidate) break;

    logDev(`[TM] balance: move ${candidate.name} ${maxT.tid.slice(-8)}(${maxT.count}) → ${minT.tid.slice(-8)}(${minT.count})`);
    const chips = candidate.chips;
    const name  = candidate.name;
    const accId = candidate.accountId ?? candidate.id;
    if (_io) _io.to(maxT.tid).emit('t:playerLeft', { playerName: name });
    lr(candidate.id);
    jr(minT.tid, candidate.id, name, { existingChips: chips, accountId: accId });
    if (isTournamentBotId(candidate.id)) moveBot(candidate.id, maxT.tid, minT.tid);

    if (_io) {
      const sock = _io.sockets.sockets.get(candidate.id);
      if (sock) {
        // jr() が登録する id に関係なく常に最新の sock.id に更新する
        {
          const { getOrCreateRoom: _gcr2 } = require('../poker/gameManager');
          const _destRoom2 = _gcr2(minT.tid);
          const _movedPlayer2 = _destRoom2?.players.find(pp => pp.accountId === accId || pp.name === name)
                             ?? _destRoom2?.pendingPlayers?.find(pp => pp.accountId === accId || pp.name === name);
          if (_movedPlayer2 && _movedPlayer2.id !== sock.id) {
            logDev(`[TM] balance: update socket.id ${_movedPlayer2.id.slice(-8)} → ${sock.id.slice(-8)} for ${name}`);
            _movedPlayer2.id = sock.id;
          }
        }
        // Socket.IO ルームは即時切り替え、t:tableTransfer 通知のみ 3 秒遅延
        sock.leave(maxT.tid);
        sock.join(minT.tid);
        // t:tableJoin を即時送信して tableIdRef を即更新
        sock.emit('t:tableJoin', { toTableId: minT.tid });
        const _sock2 = sock;
        const _fromTid2 = maxT.tid, _toTid2 = minT.tid;
        setTimeout(() => {
          _sock2.emit('t:tableTransfer', { fromTableId: _fromTid2, toTableId: _toTid2 });
          setTimeout(() => { _kickstartAfterBalance(_toTid2); }, 500);
        }, 3000);
      }
      _io.to(minT.tid).emit('t:playerArrived', { playerName: name });
    }
    movedTables.add(maxT.tid);
    movedTables.add(minT.tid);
  }
  for (const tid of movedTables) { _kickstartAfterBalance(tid); }

  // バランシング終了スナップショット（開発時）
  {
    const _elSetSnapEnd = new Set(t.eliminationOrder);
    const _snapAfter = t.tableIds.map(tid => {
      const r = getRoom(tid);
      const alive = r ? r.players.filter(p => !_elSetSnapEnd.has(p.accountId ?? p.id)).length : 0;
      return `${tid.slice(-8)}:${alive}人`;
    }).join(', ');
    logDev(`[balance] END tables=[${_snapAfter}]`);
  }

  // 差分移動後に移動先テーブルが waiting 状態なら autoStart をトリガー
  if (_io && _tryAutoStartFn) {
    for (const tid of movedTables) {
      const r = getRoom(tid);
      if (r && (r.phase === 'waiting' || r.players.length + r.pendingPlayers.length >= 2 && r.phase === 'showdown')) {
        const { canAutoStart } = require('../poker/gameManager');
        if (canAutoStart(tid)) {
          logDev(`[TM] balance: kickstart ${tid.slice(-8)} after move`);
          _tryAutoStartFn(_io, tid);
        }
      }
    }
  }
}

// ===== autoStart inject =====
let _tryAutoStartFn = null;
let _scheduleAutoStartFn = null;
let _broadcastFn = null;  // index.js の _broadcast を注入（BOTアクションチェーンに一本化）

function injectAutoStartHandlers(tryFn, scheduleFn) {
  _tryAutoStartFn = tryFn;
  _scheduleAutoStartFn = scheduleFn;
}

function injectBroadcast(broadcastFn) {
  _broadcastFn = broadcastFn;
}

// ===== テーブル動的追加 =====
/**
 * 実行中のトーナメントに新しい空テーブルを追加する
 * BOT追加時にテーブルが足りない場合に使う
 * @returns {string} 新テーブルのID
 */
/**
 * BOT追加時にtotalPlayersをインクリメントする
 * startTournament後にBOTを追加した場合、totalPlayersに含まれないため
 */
function incrementTotalPlayers(tournamentId, count = 1) {
  const t = tournaments.get(tournamentId);
  if (!t) return;
  t.totalPlayers += count;
}

function addTableToTournament(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (!t || t.status !== 'running') return null;

  const tableId = _createTable(t, []);
  // ゲーム開始（waiting状態で待機）
  const onTimeout = _makeTimeoutHandler ? _makeTimeoutHandler(tableId) : null;
  startGame(tableId, onTimeout);
  logDev(`[TM] addTable: ${tableId} → ${tournamentId}`);

  // 既存テーブルへブラインド通知
  _broadcastBlindUpdate(t);
  return tableId;
}

// ===== Sit & Go 自動起動チェック =====
/**
 * 参加登録のたびに呼ばれる。
 * is_sit_and_go=true かつ エントリー数 + 事前予約BOT数 >= min_players になったら _launchCallback を呼ぶ。
 * fire & forget（エラーはログのみ、呼び出し元はawait不要）。
 */
async function triggerSitAndGoCheck(tournamentId) {
  if (!_launchCallback) return;
  // すでにメモリで running なら何もしない
  if (tournaments.has(tournamentId)) return;

  try {
    const { getTournament, getEntries } = require('../db/tournament');
    const dbT = await getTournament(tournamentId);
    if (!dbT) return;
    if (!dbT.is_sit_and_go) return;                    // 通常トーナメントは無視
    if (dbT.status !== 'registering') return;          // 既に開始済み or 終了済みは無視

    const entries = await getEntries(tournamentId);
    const minPlayers = dbT.min_players ?? 3;

    // 事前予約 BOT 数も参加人数に含めて判定する
    const { getPreBotCount } = require('../adminMonitor');
    const preBotCount = getPreBotCount(tournamentId);
    const totalCount = entries.length + preBotCount;

    log(`[SNG] ${tournamentId.slice(-8)}: ${entries.length} humans + ${preBotCount} bots = ${totalCount}/${minPlayers}`);
    // キャンセル競合調査用: エントリー一覧を出力（開発環境のみ）
    logDev(`[SNG-debug] ${tournamentId.slice(-8)}: entries at check time = [${entries.map(e => e.nickname ?? e.account_id?.slice(-8)).join(', ')}]`);

    if (totalCount >= minPlayers) {
      log(`[SNG] ${tournamentId.slice(-8)}: min_players reached → launching`);
      _launchCallback(tournamentId);
    }
  } catch (err) {
    log(`[SNG] triggerSitAndGoCheck error: ${err.message}`);
  }
}

// 外部から呼び出し可能なブロードキャストラッパー
function broadcastStatus(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (t) _broadcastTournamentStatus(t);
}
function broadcastBlind(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (t) _broadcastBlindUpdate(t);
}
// 特定ソケットへの直接送信用: ステータスペイロードを返す
function getTournamentStatusPayload(tournamentId) {
  const t = tournaments.get(tournamentId);
  if (!t) return null;
  const remaining = _countRemaining(t);
  const total = remaining + t.eliminationOrder.length;
  if (total > t.totalPlayers) t.totalPlayers = total;
  const totalChips = t.totalPlayers * t.startingChips;
  const averageStack = remaining > 0 ? Math.floor(totalChips / remaining) : 0;
  const isFinalTable = t.tableIds.length === 1 && remaining > 1 && !t.lateRegOpen;
  return {
    tournamentId:     t.id,
    totalPlayers:     t.totalPlayers,
    remainingPlayers: remaining,
    averageStack,
    isFinalTable,
  };
}

module.exports = {
  injectAutoStartHandlers,
  injectBroadcast,
  init,
  startTournament,
  applyPendingLevelUp,
  checkEliminations,
  balanceTables,
  addTableToTournament,
  incrementTotalPlayers,
  handleForcedLeave,
  isTournamentTable,
  getTournamentByTable,
  getTournament,
  getTableForPlayer,
  getDisconnectedChips: () => _disconnectedChips,
  getCurrentBlindPayload,
  broadcastTableState,
  _broadcastTournamentStatus,
  _broadcastBlindUpdate,
  triggerSitAndGoCheck,
  broadcastStatus,
  broadcastBlind,
  getTournamentStatusPayload,
};
