'use client';
// app/tournament/[id]/draw/page.tsx
// トーナメントゲームページ（Socket.IO リアルタイム接続）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { socket, connectWithAuth } from '../../../../socket';
import TournamentTable from '../../../components/TournamentTable';
import StudTable from '../../../../components/StudTable';
import TournamentInfoBar from '../../../components/TournamentInfoBar';
import EliminatedOverlay from '../../../components/EliminatedOverlay';
import TableNoticeModal, { type NoticeType, type NoticeItem } from '../../../components/TableNoticeModal';
import GameErrorBoundary from '../../../components/GameErrorBoundary';
import type {
  BlindUpdate,
  TournamentStatus,
  PlayerState,
  GameMeta,
  TournamentRankEntry,
} from '../../../types/tournament';

// ===== 型 =====
interface TimerState { remaining: number; limit: number; }
interface ActionLog { id: number; text: string; }

// ===== 【001/008 修正】スタッド系モード判定 =====
// クライアント側の「単一の真実の源」。
// meta.isStud は サーバー側 buildGameState/buildStudGameState の実装に依存し、
// 過去に「currentMode=stud_e なのに isStud=undefined」という矛盾が発生した。
// currentMode から導出することで、サーバーがどう送ってきても矛盾を吸収する。
const STUD_MODES = ['stud_s', 'stud_e', 'razz'];
function isStudCurrentMode(mode: string | null | undefined): boolean {
  return !!mode && STUD_MODES.includes(mode);
}
/**
 * meta からスタッドUIを表示すべきか判定する。
 * 優先順位: currentMode（権威） → isStud（補助）。
 * currentMode がスタッド系なら isStud の値に関わらず true。
 * これにより isStud 欠落・矛盾時もドローUIへ誤切替しない。
 */
function shouldShowStudUI(meta: GameMeta | null): boolean {
  if (!meta) return false;
  if (isStudCurrentMode(meta.currentMode)) return true;
  // currentMode が非スタッドでも isStud=true なら念のためスタッド扱い
  // （将来モードが増えた場合の保険。currentMode 不明時のフォールバック）
  if (meta.isStud && !meta.currentMode) return true;
  return false;
}

// ===== ページ本体 =====
export default function TournamentDrawPage() {
  const params   = useParams() as { id: string };
  const router   = useRouter();
  const accountIdRef = useRef<string | null>(null); // 自分の accountId（/api/auth/session から取得）
  const tableIdRef = useRef<string | null>(null);  // サーバーから t:tournamentStarting で受信
  const prevModeRef = useRef<string | null>(null); // ゲームチェンジ検出用
  const transferTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]); // テーブル移動時の再送タイマー管理

  // players と meta を1つのstateにまとめて1回のレンダリングで更新（カクつき防止）
  const [gameState,  setGameState]  = useState<{ players: PlayerState[]; meta: GameMeta | null }>({ players: [], meta: null });
  const players = gameState.players;
  const meta    = gameState.meta;
  const [blind,      setBlind]      = useState<BlindUpdate | null>(null);
  const [status,     setStatus]     = useState<TournamentStatus | null>(null);
  const [timer,      setTimer]      = useState<TimerState | null>(null);
  const [actionLog,  setActionLog]  = useState<ActionLog[]>([]);
  const [eliminated, setEliminated] = useState<{ rank: number; total: number } | null>(null);
  const [finished,   setFinished]   = useState<TournamentRankEntry[] | null>(null);
  const [finishCountdown, setFinishCountdown] = useState<number | null>(null);
  const [isWinner, setIsWinner] = useState(false);
  const [shareMsg, setShareMsg] = useState<'copied' | 'error' | null>(null);
  const shareCanvasRef = useRef<HTMLCanvasElement>(null);
  const eliminatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // フォールバック用: 自分が最後に確認したチップ数を記録
  // t:eliminated が届かなかった場合でも gameState から脱落を検出するために使用
  const lastSelfChipsRef = useRef<number | null>(null);
  const eliminatedRef = useRef<boolean>(false); // クロージャ問題回避用 ref
  const [connected,  setConnected]  = useState(false);
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);
  const [isSpectator, setIsSpectator] = useState(false);
  const [actionErrorMsg, setActionErrorMsg] = useState<string | null>(null); // 一時的なアクションエラートースト
  const [finalTableAlert, setFinalTableAlert] = useState<boolean>(false);
  const [lateRegOpen, setLateRegOpen] = useState<boolean>(false);
  const [pendingTransfer, setPendingTransfer] = useState<string | null>(null); // pending待機中のテーブルID
  // テーブル通知モーダル（バスト/移動）— 複数通知を1つのモーダルにまとめて表示
  const [tableNotices, setTableNotices] = useState<NoticeItem[]>([]);
  const noticeIdRef = useRef(0);
  const pushNotice = useCallback((type: NoticeType, playerName: string, rank?: number, totalPlayers?: number) => {
    const item: NoticeItem = { id: ++noticeIdRef.current, type, playerName, rank, totalPlayers };
    setTableNotices(prev => [...prev, item]);
  }, []);
  const closeNotices = useCallback(() => setTableNotices([]), []);

  const logAction = useCallback((text: string) => {
    setActionLog(prev => [...prev.slice(-29), { id: Date.now(), text }]);
  }, []);

  useEffect(() => {
    if (!pendingTransfer) return;
    socket.emit('getGameState', { roomId: pendingTransfer });
    const interval = setInterval(() => {
      socket.emit('getGameState', { roomId: pendingTransfer });
    }, 1500);
    return () => clearInterval(interval);
  }, [pendingTransfer]);

  // ===== グローバルエラーキャッチ（window.onerror / unhandledrejection） =====
  // Next.js のエラーバウンダリでは非同期エラーを捕捉できないため
  // window レベルでも監視し、/api/debug/client-error へ送信する
  useEffect(() => {
    const sendError = (label: string, msg: string, stack: string, extra?: Record<string, unknown>) => {
      fetch('/api/debug/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label, message: msg, stack,
          url: window.location.href,
          ua: navigator.userAgent,
          ts: new Date().toISOString(),
          extra: extra ?? {},
        }),
      }).catch(() => {});
    };

    const onError = (event: ErrorEvent) => {
      sendError(
        'window.onerror',
        event.message ?? String(event.error),
        event.error?.stack ?? `${event.filename}:${event.lineno}:${event.colno}`,
        { filename: event.filename, lineno: event.lineno, colno: event.colno },
      );
    };

    const onUnhandled = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      sendError(
        'unhandledrejection',
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? (reason.stack ?? '') : '',
      );
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandled);
    };
  }, []);

  // ===== Socket.IO 接続 =====
  useEffect(() => {
    let cancelled = false;
    const tournamentId = params.id;

    // App Router は SessionProvider の外なので useSession() が使えない
    // /api/auth/session から accountId を取得して ref に保持する
    fetch('/api/auth/session')
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (s?.user?.accountId) accountIdRef.current = s.user.accountId; })
      .catch(() => {});

    // 【重要】サーバーからの emit を取り逃さないため、socket.on リスナーは
    //   socket.emit('t:getMyTable') より先に登録する。
    //   特に socket.connected===true で同期的に emit するパスでは、
    //   イベントループのタイミング次第で listener 登録より先にサーバー応答が
    //   到着する理論的リスクがあるため、リスナー登録を先に行う。

    // ゲーム状態（playersとmetaを1回のsetStateでまとめて更新）
    socket.on('gameState', (raw: unknown) => {
      // ===== gameState ハンドラーの try-catch について =====
      // 注意: これはハンドラー内の【同期エラー】のみ捕捉する観測用であり、
      // レンダリングフェーズで発生するエラー（React error #310 等）は捕捉できない。
      // それらは GameErrorBoundary が担当する。ここはペイロード処理の保険。
      try {
      // 実行時型チェック: サーバーからの予期しないペイロード形式を弾く（同期的に return）
      if (!raw || typeof raw !== 'object') return;
      const rawObj = raw as Record<string, unknown>;
      const pl = Array.isArray(rawObj.players) ? rawObj.players as PlayerState[] : [];
      const m  = (rawObj.meta && typeof rawObj.meta === 'object') ? rawObj.meta as GameMeta : null;
      const isSpectatorFlag = typeof rawObj.isSpectator === 'boolean' ? rawObj.isSpectator : undefined;
      // 受信した gameState が現在のテーブルのものか確認（別テーブルからの誤配信を防止）
      if (m?.roomId && tableIdRef.current && m.roomId !== tableIdRef.current) {
        return;  // 別テーブルの gameState は無視
      }
      // 【001/008 デバッグ】isStud と currentMode の矛盾を検出してログ送信
      // currentMode はスタッド系なのに isStud が falsy、またはその逆を観測する。
      if (m) {
        const _modeIsStud = isStudCurrentMode(m.currentMode);
        const _flagIsStud = !!m.isStud;
        const _willShowStud = shouldShowStudUI(m);
        if (_modeIsStud !== _flagIsStud) {
          // 矛盾検出 → サーバーに記録（恒久的には発生しないのが正常）
          fetch('/api/debug/client-error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              label: 'isStud-mismatch',
              message: `currentMode=${m.currentMode} isStud=${m.isStud} → modeIsStud=${_modeIsStud} flagIsStud=${_flagIsStud} willShowStud=${_willShowStud}`,
              stack: '', url: window.location.href, ts: new Date().toISOString(),
              extra: { phase: m.phase, roomId: m.roomId },
            }),
          }).catch(() => {});
        }
        if (typeof console !== 'undefined' && console.debug) {
          console.debug(`[gameState] mode=${m.currentMode} isStud=${m.isStud} phase=${m.phase} → showStud=${_willShowStud}`);
        }
      }
      setGameState({ players: pl ?? [], meta: m ?? null });
      // ゲームチェンジ検出（ハンド開始時に currentMode が変化したら通知）
      if (m?.currentMode && m.phase !== 'waiting' && m.phase !== 'showdown') {
        const prev = prevModeRef.current;
        if (prev && prev !== m.currentMode) {
          const MODE_NOTICE_LABEL: Record<string, string> = {
            '27': '2-7 Triple Draw', badugi: 'Badugi', mix: 'Mix', a5: 'A-5 Triple Draw',
            '27sd': '2-7 Single Draw', mix3: 'Mix-3',
            'beast+': 'BEAST+', stud_mix: 'Stud Mix',
            stud_s: '7 Card Stud', stud_e: 'Stud Hi/Lo', razz: 'Razz',
          };
          const label = MODE_NOTICE_LABEL[m.currentMode] ?? m.currentMode;
          pushNotice('gameChange', `ゲームが ${label} に変わりました`);
        }
        prevModeRef.current = m.currentMode;
      }
      // isSpectator 更新:
      //   - isSelf プレイヤーが見つかった場合は必ず false（spectate→lateReg参加後の観戦モード解除）
      //   - isPendingPlayer=true の場合も false（次のハンドから参加予定）
      //   - isSelf が見つからず isSpectatorFlag=true の場合のみ true にする
      // isSelf=true が含まれていれば必ず観戦モード解除（sittingOut=true でも）。
      // isPendingPlayer=true も同様（次ハンドから参加予定）。
      // isSpectatorFlag=true でも isSelf/pending があれば解除を優先する。
      const selfPlayer = pl?.find((p: PlayerState) => p.isSelf);
      const pendingPlayer = pl?.find((p: PlayerState) => p.isPendingPlayer);
      if (selfPlayer || pendingPlayer) {
        setIsSpectator(false);
      } else if (isSpectatorFlag === true) {
        // isSelf が一度も見つかっていない場合のみ観戦中にする
        setIsSpectator(true);
      }
      // isSpectatorFlag が undefined（送信されていない）の場合は現状維持
      if (selfPlayer && !selfPlayer.isPendingPlayer) setPendingTransfer(null);

      // フォールバック: t:eliminated が届かなかった場合の脱落検出
      if (selfPlayer) {
        lastSelfChipsRef.current = selfPlayer.chips;
        // chips=0 かつ showdown フェーズのときのみフォールバックタイマーを起動する。
        // オールイン中（bet/draw フェーズで chips=0）は発動させない。
        // gameState が届くたびにリセットしてはいけない（無限ループ対策）ため
        // eliminatedRef.current = true を先にセットして再入を防ぐ。
        const isShowdownPhase = m?.phase === 'showdown';
        if (selfPlayer.chips === 0 && isShowdownPhase && !eliminatedRef.current) {
          // 自分が chips=0 でも相手も chips=0（引き分けオールイン）または
          // 自分以外の全員が chips=0（＝自分が優勝）の場合はフォールバックを起動しない
          const activePlayers = pl?.filter((p: PlayerState) => !p.folded && !p.sittingOut) ?? [];
          const otherPlayersExist = activePlayers.some((p: PlayerState) => !p.isSelf && p.chips > 0);
          const iAmOnlyOneLeft = activePlayers.length <= 1 || !otherPlayersExist;
          if (iAmOnlyOneLeft) {
            // 自分が最後の1人 = 優勝確定 → フォールバック不要（t:tournamentFinished を待つ）
          } else {
            eliminatedRef.current = true;          // ← 先にロックして再入を防ぐ
            if (eliminatedTimerRef.current) clearTimeout(eliminatedTimerRef.current);
            eliminatedTimerRef.current = setTimeout(() => {
              // t:eliminated が届いて実際の rank で上書きされる場合もある。
              // t:eliminated はサーバーが showdown 後 1 秒で送信するため
              // 8 秒待てば通常は正確な rank が届いているはず
              setEliminated({ rank: 0, total: 0 });
            }, 8000);
          }
        }
      } else if (lastSelfChipsRef.current === 0 && !eliminatedRef.current) {
        // chips=0 の後に自分が players から消えた = 脱落
        // eliminatedRef を先にロックして、連続する gameState でタイマーがリセットされるのを防ぐ
        eliminatedRef.current = true;
        if (eliminatedTimerRef.current) clearTimeout(eliminatedTimerRef.current);
        eliminatedTimerRef.current = setTimeout(() => {
          setEliminated({ rank: 0, total: 0 }); // rank 不明のため 0 で表示
        }, 1500);
      }
      } catch (err: unknown) {
        // ===== gameState ハンドラー内の例外をキャッチ =====
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[gameState-handler] CRASH:', error, '\nraw data:', raw);
        fetch('/api/debug/client-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label:   'gameState-handler',
            message: error.message,
            stack:   error.stack ?? '',
            url:     window.location.href,
            ua:      navigator.userAgent,
            ts:      new Date().toISOString(),
            extra: {
              rawMeta:    JSON.stringify((raw as {meta?: unknown})?.meta ?? null),
              rawPlayers: JSON.stringify(((raw as {players?: unknown[]})?.players ?? []).slice(0,2)),
            },
          }),
        }).catch(() => {});
      }
    });

    // タイマー
    socket.on('timerUpdate', ({ remaining, limit }: TimerState) => {
      setTimer({ remaining, limit });
    });

    // トーナメント開始 or テーブル問い合わせ応答 → tableId を記録するだけ
    // 【重要】joinRoom emit は不要（サーバーの t:getMyTable 内で既に socket.join 済み）。
    //   joinRoom emit すると以下の問題が発生:
    //   1. サーバー側 joinPokerRoom が name で再接続判定 → 競合状態
    //   2. _broadcast が再度走り gameState の二重送信
    //   3. リソース無駄遣い・タイミング差で setGameState が古い値で上書きされるリスク
    socket.on('t:tournamentStarting', ({ tableId: tid }: { tournamentId: string; tableId: string }) => {
      tableIdRef.current = tid;
      setIsSpectator(false);
      setPendingTransfer(null);
    });

    // テーブルが見つからない場合
    socket.on('t:tournamentNotFound', () => {
      setErrorMsg('トーナメントが見つかりません。ロビーに戻ります。');
      setTimeout(() => router.push('/'), 2000);
    });

    // 脱落済みでレイトレジスト参加不可 → 観戦モードへ誘導
    socket.on('t:eliminatedSpectate', ({ tournamentId: tid }: { tournamentId: string }) => {
      router.replace(`/tournament/${tid}/spectate`);
    });

    // ブラインド更新
    // ファイナルテーブル通知
    socket.on('t:finalTable', () => {
      setFinalTableAlert(true);
      setTimeout(() => setFinalTableAlert(false), 6000);
    });

    // レイトレジスト終了通知
    socket.on('t:lateRegClosed', () => {
      setLateRegOpen(false);
    });

    // バスト通知（同テーブルの全員）
    socket.on('t:playerEliminated', ({ playerName, rank, totalPlayers }: { playerName: string; rank: number; totalPlayers: number }) => {
      pushNotice('bust', playerName, rank, totalPlayers);
    });
    // 移動元テーブル通知
    socket.on('t:playerLeft', ({ playerName }: { playerName: string }) => {
      pushNotice('left', playerName);
    });
    // 移動先テーブル通知
    socket.on('t:playerArrived', ({ playerName }: { playerName: string }) => {
      pushNotice('arrived', playerName);
    });

    socket.on('t:blindUpdate', (payload: BlindUpdate) => {
      setLateRegOpen(payload.lateRegOpen ?? false);
      setBlind(payload);
      // ブラインドアップ / ブレイク突入をモーダル通知
      if (payload.notify === 'blindUp') {
        pushNotice('blindUp', `ブラインドアップ！ Lv.${payload.level}  ${payload.sb}/${payload.bb}`);
      } else if (payload.notify === 'break') {
        pushNotice('break', `${payload.breakLabel ?? 'Break'} に入りました`);
      }
    });

    // ステータス更新
    socket.on('t:tournamentStatus', (payload: TournamentStatus) => {
      setStatus(payload);
    });

    // テーブル移動: 即時通知（tableIdRefのみ更新・画面は切り替えない）
    // t:tableTransfer（3秒後）が来るまでの間もアクションが正しいテーブルに送られるようにする
    socket.on('t:tableJoin', ({ toTableId }: { toTableId: string }) => {
      tableIdRef.current = toTableId;
    });

    // テーブル移動（バランシング）
    socket.on('t:tableTransfer', ({ fromTableId, toTableId }: { fromTableId: string; toTableId: string }) => {
      tableIdRef.current = toTableId;
      socket.emit('leaveSocketRoom', { roomId: fromTableId });
      socket.emit('joinSocketRoom', { roomId: toTableId });
      logAction('別テーブルへ移動しました');
      // 移動直後にgameStateをリセット（旧テーブルのshowdown画面に止まるバグ防止）
      setGameState({ players: [], meta: null });
      // 【修正】テーブル移動はゲーム種変更ではないため prevModeRef もリセット。
      // これを怠ると移動先で別ゲーム種が進行中の場合に誤った「ゲームが変わりました」通知が出る
      prevModeRef.current = null;
      // 移動先のゲーム状態を取得
      socket.emit('getGameState', { roomId: toTableId });
      // join完了後に確実にgameStateが届くよう再送（フリーズ防止）
      // 【修正】タイマーを ref で管理し、アンマウント時にクリーンアップする
      const transferTimer = setTimeout(() => {
        socket.emit('getGameState', { roomId: toTableId });
      }, 600);
      transferTimersRef.current.push(transferTimer);
    });

    // pending待機中のテーブル移動（ゲーム進行中テーブルへ移動 → 次のハンドまで待機）
    socket.on('t:pendingTableTransfer', ({ tableId }: { tableId: string; message: string }) => {
      tableIdRef.current = tableId;
      setIsSpectator(false);
      setPendingTransfer(tableId);
      logAction('次のハンドから参加します（テーブル移動）');
    });

    // ショーダウン
    socket.on('showdown', () => {
      logAction('ショーダウン！');
    });

    // プレイヤーアクション通知
    socket.on('playerAction', ({ playerName, action }: { playerName: string; action: string }) => {
      const labels: Record<string, string> = {
        fold:'フォールド', check:'チェック', call:'コール', bet:'ベット', raise:'レイズ',
      };
      logAction(`${playerName}: ${labels[action] ?? action}`);
    });

    // ゲーム開始
    socket.on('gameStarted', () => {
      logAction('新しいハンド開始');
      setTimer(null);
      const roomId = tableIdRef.current;
      if (roomId) {
        setTimeout(() => socket.emit('getGameState', { roomId }), 100);
        setTimeout(() => socket.emit('getGameState', { roomId }), 800);
      }
    });

    // 脱落
    socket.on('t:eliminated', ({ rank, totalPlayers }: { rank: number; totalPlayers: number }) => {
      eliminatedRef.current = true;
      setIsSpectator(true); // 脱落直後から観戦扱い（waiting画面を経由しない）
      // chips=0 フォールバックタイマーが走っている場合はキャンセルして上書き
      if (eliminatedTimerRef.current) clearTimeout(eliminatedTimerRef.current);
      // showdown結果を確認できるよう 4 秒待ってからオーバーレイ表示
      // （2秒では最終ハンドを確認できない・5秒はフリーズに見える）
      eliminatedTimerRef.current = setTimeout(() => {
        setEliminated({ rank, total: totalPlayers });
      }, 4000);
    });

    // トーナメント終了
    socket.on('t:tournamentFinished', ({ rankings }: { rankings: TournamentRankEntry[] }) => {
      // フォールバックタイマー・eliminatedRef を全てリセット
      // （オールイン優勝時に chips=0フォールバックが先に走って脱落オーバーレイが出るバグ対策）
      if (eliminatedTimerRef.current) {
        clearTimeout(eliminatedTimerRef.current);
        eliminatedTimerRef.current = null;
      }
      eliminatedRef.current = false; // ← フォールバックロックを解除
      setEliminated(null);
      setFinished(rankings);
      // 自分が1位かチェック（accountIdRef と rankings の accountId を比較）
      // ※ App Router は SessionProvider 外のため /api/auth/session で取得した値を使う
      const myAccountId = accountIdRef.current;
      const rank1Entry = rankings.find((r: TournamentRankEntry) => r.rank === 1);
      const isMyWin = !!(rank1Entry && myAccountId && rank1Entry.accountId === myAccountId);

      const startCountdown = (seconds: number) => {
        setFinishCountdown(seconds);
        let count = seconds;
        const interval = setInterval(() => {
          count -= 1;
          setFinishCountdown(count);
          if (count <= 0) {
            clearInterval(interval);
            router.push(`/tournament/${params.id}/result`);
          }
        }, 1000);
      };

      if (isMyWin) {
        // 優勝者: 即座にオーバーレイ表示（サーバーがshowdown後5秒待ってからemitするため
        // クライアントで追加遅延は不要）。カウントダウンバナーは優勝オーバーレイ内に表示。
        setIsWinner(true);
        startCountdown(10);
      } else {
        // 非優勝者: 即座に5秒カウントダウン
        startCountdown(5);
      }
    });

    // キック
    socket.on('kicked', ({ reason }: { reason?: string }) => {
      setErrorMsg(reason ?? '退室されました');
    });

    // エラー
    socket.on('error', ({ message }: { message: string }) => {
      if (message === 'そのアクションはできません') {
        // 一時的なトースト表示（3秒後に消える）＋ gameState を再取得
        setActionErrorMsg(message);
        setTimeout(() => setActionErrorMsg(null), 3000);
        if (tableIdRef.current) {
          socket.emit('getGameState', { roomId: tableIdRef.current });
        }
      } else {
        setErrorMsg(message);
      }
    });

    // 【重要】すべての socket.on リスナー登録が完了したあとで接続と t:getMyTable を行う。
    // これにより、サーバーから即時 emit される gameState / t:tournamentStarting を確実に受信できる。
    connectWithAuth().then(ok => {
      if (cancelled) return;
      if (!ok) { router.push('/'); return; }
      setConnected(true);
      socket.emit('t:getMyTable', { tournamentId });
    });
    // 接続済みの場合は connectWithAuth が即 true を返すが、上の then 内の emit は
    // 次のマイクロタスクで実行される。リスナーは同期登録済みのため取り逃しは発生しない。

    return () => {
      cancelled = true;
      socket.off('gameState');
      socket.off('timerUpdate');
      socket.off('t:tournamentStarting');
      socket.off('t:tournamentNotFound');
      socket.off('t:eliminatedSpectate');
      socket.off('t:finalTable');
      socket.off('t:lateRegClosed');
      socket.off('t:playerEliminated');
      socket.off('t:playerLeft');
      socket.off('t:playerArrived');
      socket.off('t:blindUpdate');
      socket.off('t:tournamentStatus');
      socket.off('t:tableJoin');
      socket.off('t:tableTransfer');
      socket.off('t:pendingTableTransfer');
      socket.off('showdown');
      socket.off('playerAction');
      socket.off('gameStarted');
      socket.off('t:eliminated');
      socket.off('t:tournamentFinished');
      socket.off('kicked');
      socket.off('error');
      // 【修正】テーブル移動再送タイマーをクリーンアップ（アンマウント後の emit 防止）
      transferTimersRef.current.forEach(clearTimeout);
      transferTimersRef.current = [];
    };
  // 依存配列を空にする意図:
  // 全ソケットハンドラは tableIdRef / eliminatedRef / fetchReadyRef 等の Ref を経由して
  // 最新の値を参照するため、初回マウント時の1回のみ登録で正しく動作する。
  // router は Next.js の useRouter が安定した参照を返すため問題ない。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== シェア（クリップボードコピー）=====
  async function handleShareCopy(rank: number, total: number) {
    const POINT_TABLE: Record<number, number> = { 1:100, 2:60, 3:40, 4:25, 5:15 };
    const pts   = POINT_TABLE[rank] ?? 0;
    const rankUnknown = rank === 0 || total === 0;
    const medal = rank === 1 ? '🏆' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '💀';

    const canvas = shareCanvasRef.current;
    if (!canvas) return;
    canvas.width  = 600;
    canvas.height = 300;
    const ctx = canvas.getContext('2d')!;

    // 背景
    const bg = rank === 1
      ? 'rgba(40,28,0,0.97)'
      : rank <= 3
        ? 'rgba(14,20,30,0.97)'
        : 'rgba(10,10,18,0.97)';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 600, 300);

    // 枠線
    ctx.strokeStyle = rank === 1 ? '#c9a84c' : rank <= 3 ? '#7ab3e0' : '#555';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 596, 296);

    // タイトル
    ctx.fillStyle = rank === 1 ? '#eab308' : '#94a3b8';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🃏 Poker Room Pastis', 300, 48);

    // 順位（大）
    ctx.fillStyle = rank === 1 ? '#fde68a' : '#ffffff';
    ctx.font = 'bold 76px sans-serif';
    ctx.fillText(rankUnknown ? `${medal} 脱落` : `${medal} ${rank}位`, 300, 162);

    // 参加人数
    ctx.fillStyle = '#94a3b8';
    ctx.font = '20px sans-serif';
    ctx.fillText(rankUnknown ? '集計中...' : `${total}名中`, 300, 206);

    // ポイント
    if (pts > 0) {
      ctx.fillStyle = '#eab308';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(`+${pts} pt 獲得`, 300, 248);
    }

    // URL
    ctx.fillStyle = '#64748b';
    ctx.font = '14px sans-serif';
    ctx.fillText('https://draw-poker.onrender.com', 300, 280);

    // 画像 Blob を生成
    let blob: Blob;
    try {
      blob = await new Promise<Blob>((res, rej) =>
        canvas.toBlob(b => b ? res(b) : rej(new Error('blob null')), 'image/png')
      );
    } catch {
      setShareMsg('error');
      setTimeout(() => setShareMsg(null), 6000);
      return;
    }

    const shareText = [
      '🃏 Poker Room Pastis でトーナメントに参加しました！',
      '#PastisPoker',
      'https://draw-poker.onrender.com',
    ].join('\n');

    // モバイル: Web Share API で画像ファイルをシェアシートに渡す
    // iOS 15+ / Android Chrome 対応。シェアシートから X を選ぶと画像つきで投稿できる。
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const imageFile = new File([blob], 'pastis-result.png', { type: 'image/png' });
    if (isMobile && typeof navigator.share === 'function' && navigator.canShare?.({ files: [imageFile] })) {
      try {
        await navigator.share({ files: [imageFile], text: shareText });
        setShareMsg('copied');
      } catch (e: unknown) {
        // ユーザーがキャンセルした場合（AbortError）はエラー扱いしない
        if (e instanceof Error && e.name !== 'AbortError') setShareMsg('error');
      }
      setTimeout(() => setShareMsg(null), 6000);
      return;
    }

    // デスクトップ: クリップボードに画像をコピー → X 投稿画面を開く
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setShareMsg('copied');
    } catch {
      setShareMsg('error');
    }
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`,
      '_blank'
    );

    setTimeout(() => setShareMsg(null), 6000);
  }

  // ===== アクションハンドラ =====
  function handleBetAction(action: string, amount?: number) {
    if (!tableIdRef.current) return;
    socket.emit('betAction', { roomId: tableIdRef.current, action, amount });
  }

  function handleDrawCards(indices: number[]) {
    if (!tableIdRef.current) return;
    socket.emit('drawCards', { roomId: tableIdRef.current, indices });
  }

  function handleUpdateSelected(indices: number[]) {
    if (!tableIdRef.current) return;
    socket.emit('updateSelected', { roomId: tableIdRef.current, indices });
  }

  // ===== 脱落後の処理 =====
  function handleEliminatedClose() {
    setEliminated(null);
    router.push(`/tournament/${params.id}/result`);
  }

  // ===== 紙吹雪パーティクル（安定した位置を useMemo で生成）=====
  const confettiParticles = useMemo(() =>
    Array.from({ length: 60 }, (_, i) => ({
      id: i,
      left: `${(i * 1.667) % 100}%`,
      color: ['#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#C9A84C'][i % 7],
      duration: 2 + (i % 10) * 0.3,
      delay: (i % 8) * 0.25,
      isCircle: i % 3 === 0,
      size: 8 + (i % 3) * 4,
    })),
  []);

  // ===== 未接続 =====
  if (!connected) {
    return (
      <div style={{ height:'100dvh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--felt)', fontFamily:'var(--font-body)' }}>
        <div style={{ textAlign:'center' as const }}>
          <div style={{ fontSize:48, marginBottom:16 }}>🃏</div>
          <p style={{ color:'var(--cream-dim)', fontSize:16 }}>接続中...</p>
        </div>
      </div>
    );
  }

  return (
    <GameErrorBoundary label="TournamentDrawPage">
    <div style={{ height:'100dvh', display:'flex', flexDirection:'column' as const, overflow:'hidden', background:'var(--felt)', color:'var(--cream)', fontFamily:'var(--font-body)' }}>

      {/* ナビバー — ロゴなし・完全1行でトーナメント情報を表示 */}
      <nav style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'3px 8px', borderBottom:'1px solid var(--gold-dim)',
        background:'rgba(0,0,0,0.25)', flexShrink:0, gap:6,
        height:32, minHeight:32, maxHeight:32, overflow:'hidden',
      }}>
        {/* トーナメント情報バー（左寄せ・flex:1で最大幅使用）*/}
        <div style={{ flex:1, minWidth:0, overflow:'hidden', display:'flex', alignItems:'center' }}>
          <TournamentInfoBar blind={blind} status={status} />
        </div>
        <button
          onClick={() => { window.location.href = '/'; }}
          style={{ fontFamily:'var(--font-title)', fontSize:10, padding:'2px 7px', background:'rgba(139,26,26,0.55)', border:'1px solid rgba(204,34,34,0.4)', borderRadius:4, color:'#ffaaaa', cursor:'pointer', flexShrink:0, whiteSpace:'nowrap' as const }}
        >ロビーへ</button>
      </nav>

      {/* ゲームモードバー — 現在のゲームを常時表示 */}
      {meta?.currentMode && meta.phase !== 'waiting' && (() => {
        const MODE_LABEL_MAP: Record<string, string> = {
          '27': '2-7 Triple Draw', badugi: 'Badugi', mix: 'Mix (2-7↔Badugi)',
          a5: 'A-5 Triple Draw', '27sd': '2-7 Single Draw', mix3: 'Mix-3',
          'beast+': 'BEAST+', stud_mix: 'Stud Mix',
          stud_s: '7 Card Stud', stud_e: 'Stud Hi/Lo', razz: 'Razz',
        };
        const MODE_COLOR_MAP: Record<string, string> = {
          stud_s: '#50c0d0', stud_e: '#50a0d0', razz: '#70b080',
          badugi: '#cc9966', '27': '#88bbee', a5: '#88dd88',
          mix: '#aa88dd', mix3: '#aa88dd', '27sd': '#dd88aa',
          'beast+': '#e0b050', stud_mix: '#50c0d0',
        };
        const label = MODE_LABEL_MAP[meta.currentMode] ?? meta.currentMode;
        const color = MODE_COLOR_MAP[meta.currentMode] ?? '#88bbee';
        return (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '2px 8px', flexShrink: 0,
            background: 'rgba(0,0,0,0.30)',
            borderBottom: `1px solid ${color}44`,
            gap: 6,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: `0 0 4px ${color}` }} />
            <span style={{ fontFamily: 'var(--font-title)', fontSize: 10, color, letterSpacing: '0.1em', fontWeight: 700 }}>
              {label}
            </span>
          </div>
        );
      })()}

      {/* ゲームテーブル — flex:1 で残り全高さを使う */}
      {/* paddingTop: フラッシュバッジ（上方向40px飛び出す）がナビバーで隠れないよう最小余白を確保 */}
      <div style={{ flex:1, display:'flex', overflow:'visible', minHeight:0, paddingTop:28 }}>
        {shouldShowStudUI(meta) ? (
          <StudTable
            key="stud-table"
            players={players}
            meta={meta}
            timer={timer}
            isSpectator={isSpectator}
            onBetAction={handleBetAction}
            blind={blind}
            tournamentId={params.id}
          />
        ) : (
          <TournamentTable
            key="draw-table"
            players={players}
            meta={meta}
            timer={timer}
            isSpectator={isSpectator}
            onBetAction={handleBetAction}
            onDrawCards={handleDrawCards}
            onUpdateSelected={handleUpdateSelected}
            blind={blind}
            tournamentId={params.id}
          />
        )}
      </div>

      {/* 一時的なアクションエラートースト（3秒で自動消去） */}
      {actionErrorMsg && (
        <div style={{
          position:'fixed' as const, top:60, left:'50%', transform:'translateX(-50%)',
          background:'rgba(120,30,30,0.92)', border:'1px solid #c44',
          borderRadius:8, padding:'10px 20px', zIndex:60,
          color:'#ffaaaa', fontFamily:'var(--font-body)', fontSize:14,
          pointerEvents:'none' as const,
        }}>
          ⚠️ {actionErrorMsg}（画面を更新しています…）
        </div>
      )}

      {/* エラーメッセージ */}
      {errorMsg && (
        <div style={{
          position:'fixed' as const, inset:0,
          display:'flex', alignItems:'center', justifyContent:'center',
          background:'rgba(0,0,0,0.78)', zIndex:50,
        }}>
          <div style={{
            background:'linear-gradient(160deg,#1a1a0a,#0d0d05)',
            border:'1px solid #6b1a1a',
            borderRadius:14, padding:'32px 28px',
            textAlign:'center' as const, maxWidth:360,
          }}>
            <p style={{ color:'#ff8888', fontFamily:'var(--font-body)', fontSize:16, marginBottom:16 }}>{errorMsg}</p>
            <button
              onClick={() => { window.location.href = '/'; }}
              style={{ padding:'8px 20px', borderRadius:6, background:'transparent', border:'1px solid var(--gold-dim)', color:'var(--cream-dim)', fontFamily:'var(--font-title)', fontSize:12, cursor:'pointer' }}
            >ロビーへ戻る</button>
          </div>
        </div>
      )}

      {/* テーブル移動後のpending待機オーバーレイ */}
      {pendingTransfer && (
        <div style={{
          position:'fixed' as const, bottom:32, left:'50%', transform:'translateX(-50%)',
          background:'linear-gradient(135deg,rgba(0,20,40,0.97),rgba(0,30,60,0.97))',
          border:'1px solid var(--gold-dim)', borderRadius:12,
          padding:'16px 28px', textAlign:'center' as const, zIndex:50,
          boxShadow:'0 4px 24px rgba(0,0,0,0.6)',
        }}>
          <div style={{ fontFamily:'var(--font-title)', fontSize:14, color:'var(--gold)', marginBottom:4 }}>
            🎯 テーブル移動完了
          </div>
          <div style={{ fontFamily:'var(--font-body)', fontSize:13, color:'var(--cream-dim)' }}>
            次のハンドから参加します。しばらくお待ちください...
          </div>
        </div>
      )}

      {/* トーナメント終了カウントダウン（優勝者はオーバーレイ内に表示するためここでは非表示）*/}
      {finishCountdown !== null && !isWinner && (
        <div style={{
          position:'fixed' as const, bottom:32, left:'50%', transform:'translateX(-50%)',
          background:'linear-gradient(135deg,rgba(20,10,0,0.97),rgba(40,25,0,0.97))',
          border:'2px solid var(--gold)', borderRadius:12,
          padding:'16px 32px', textAlign:'center' as const, zIndex:60,
          boxShadow:'0 4px 32px rgba(201,168,76,0.4)',
        }}>
          <div style={{ fontFamily:'var(--font-title)', fontSize:15, color:'var(--gold-bright)', marginBottom:4 }}>
            🏆 トーナメント終了
          </div>
          <div style={{ fontFamily:'var(--font-body)', fontSize:13, color:'var(--cream-dim)' }}>
            {finishCountdown}秒後に結果ページへ移動します
          </div>
        </div>
      )}

      {/* 脱落オーバーレイ */}
      {/* ファイナルテーブル通知オーバーレイ */}
      {finalTableAlert && (
        <div style={{
          position:'fixed' as const, top:80, left:'50%', transform:'translateX(-50%)',
          background:'linear-gradient(135deg,rgba(40,30,0,0.97),rgba(60,45,0,0.97))',
          border:'2px solid var(--gold)', borderRadius:12,
          padding:'18px 32px', textAlign:'center' as const, zIndex:60,
          boxShadow:'0 0 40px rgba(201,168,76,0.6)',
          animation:'fadeInDown 0.4s ease-out',
        }}>
          <div style={{ fontSize:28, marginBottom:6 }}>🏆</div>
          <div style={{ fontFamily:'var(--font-title)', fontSize:18, color:'var(--gold-bright)', letterSpacing:'0.1em' }}>
            FINAL TABLE
          </div>
          <div style={{ fontFamily:'var(--font-body)', fontSize:13, color:'var(--cream-dim)', marginTop:4 }}>
            最終テーブルに突入しました！
          </div>
        </div>
      )}

      {tableNotices.length > 0 && (
        <TableNoticeModal
          notices={tableNotices}
          onClose={closeNotices}
        />
      )}

      {eliminated && (
        <EliminatedOverlay
          rank={eliminated.rank}
          totalPlayers={eliminated.total}
          onClose={handleEliminatedClose}
          onShare={() => handleShareCopy(eliminated.rank, eliminated.total)}
          shareMsg={shareMsg}
        />
      )}

      {/* 優勝エフェクト（紙吹雪 + オーバーレイ） */}
      {isWinner && (
        <>
          <style dangerouslySetInnerHTML={{ __html: `
            @keyframes confettiFall {
              0%   { transform: translateY(-20px) rotate(0deg);   opacity: 1; }
              80%  { opacity: 1; }
              100% { transform: translateY(105vh) rotate(720deg); opacity: 0; }
            }
            @keyframes winnerPulse {
              0%, 100% { box-shadow: 0 0 60px rgba(201,168,76,0.7); }
              50%       { box-shadow: 0 0 100px rgba(201,168,76,1); }
            }
            @keyframes winnerTrophy {
              0%, 100% { transform: scale(1) rotate(-5deg); }
              50%       { transform: scale(1.15) rotate(5deg); }
            }
          `}} />
          {/* 紙吹雪レイヤー */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 90, pointerEvents: 'none', overflow: 'hidden' }}>
            {confettiParticles.map(p => (
              <div key={p.id} style={{
                position: 'absolute',
                top: '-20px',
                left: p.left,
                width: p.size,
                height: p.size,
                background: p.color,
                borderRadius: p.isCircle ? '50%' : 2,
                animation: `confettiFall ${p.duration}s ${p.delay}s ease-in infinite`,
              }} />
            ))}
          </div>
          {/* 優勝オーバーレイ */}
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'linear-gradient(135deg, rgba(18,12,0,0.97), rgba(40,28,0,0.97))',
            border: '3px solid var(--gold)',
            borderRadius: 20,
            padding: 'clamp(24px, 5vw, 44px) clamp(20px, 6vw, 48px)',
            textAlign: 'center' as const,
            zIndex: 100,
            animation: 'winnerPulse 1.8s ease-in-out infinite',
            minWidth: 280,
          }}>
            <div style={{ fontSize: 72, marginBottom: 8, display: 'inline-block', animation: 'winnerTrophy 1.2s ease-in-out infinite' }}>🏆</div>
            <div style={{
              fontFamily: 'var(--font-title)', fontSize: 40, color: 'var(--gold)',
              letterSpacing: '0.2em', margin: '8px 0 12px',
              textShadow: '0 0 20px rgba(201,168,76,0.9)',
            }}>
              優勝！
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 16, color: 'var(--cream)', marginBottom: 4 }}>
              おめでとうございます！
            </div>
            {/* シェアボタン */}
            <button
              onClick={() => handleShareCopy(1, finished?.length ?? 1)}
              style={{
                marginTop: 20, width: '100%', padding: '10px 16px',
                background: '#000', border: '1px solid #555', borderRadius: 8,
                color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                whiteSpace: 'nowrap', boxSizing: 'border-box',
              }}
            >
              <span style={{ fontWeight: 900 }}>𝕏</span>
              <span>結果をコピーして投稿</span>
            </button>
            {shareMsg === 'copied' && (
              <p style={{ color: '#4ade80', fontSize: 12, marginTop: 8, fontFamily: 'var(--font-body)' }}>
                ✅ 画像をコピーしました！X の投稿画面で貼り付けてください
              </p>
            )}
            {shareMsg === 'error' && (
              <p style={{ color: '#facc15', fontSize: 12, marginTop: 8, fontFamily: 'var(--font-body)' }}>
                ⚠️ クリップボードコピー非対応です（ブラウザの制限）
              </p>
            )}
            {finishCountdown !== null && (
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--cream-dim)', marginTop: 12 }}>
                {finishCountdown}秒後に結果ページへ移動します
              </div>
            )}
          </div>
        </>
      )}
      {/* 非表示Canvas（シェア画像生成用）*/}
      <canvas ref={shareCanvasRef} style={{ display: 'none' }} />
    </div>
    </GameErrorBoundary>
  );
}
