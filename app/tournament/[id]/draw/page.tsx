'use client';
// app/tournament/[id]/draw/page.tsx
// トーナメントゲームページ（Socket.IO リアルタイム接続）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { socket, connectWithAuth } from '../../../../socket';
import TournamentTable from '../../../components/TournamentTable';
import TournamentInfoBar from '../../../components/TournamentInfoBar';
import EliminatedOverlay from '../../../components/EliminatedOverlay';
import TableNoticeModal, { type NoticeType, type NoticeItem } from '../../../components/TableNoticeModal';
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

// ===== ページ本体 =====
export default function TournamentDrawPage() {
  const params   = useParams() as { id: string };
  const router   = useRouter();
  const accountIdRef = useRef<string | null>(null); // 自分の accountId（/api/auth/session から取得）
  const tableIdRef = useRef<string | null>(null);  // サーバーから t:tournamentStarting で受信

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
  const eliminatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected,  setConnected]  = useState(false);
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);
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

    connectWithAuth().then(ok => {
      if (cancelled) return;
      if (!ok) { router.push('/'); return; }
      setConnected(true);
      if (tableIdRef.current) {
        // 再接続: 既知のテーブルに joinRoom を送り新しい socket ID でプレイヤー情報を更新
        socket.emit('joinRoom', { roomId: tableIdRef.current });
      } else {
        // 初回接続: テーブルを問い合わせ
        socket.emit('t:getMyTable', { tournamentId });
      }
    });

    // 接続済みの場合も問い合わせ
    if (socket.connected && !tableIdRef.current) {
      socket.emit('t:getMyTable', { tournamentId });
    }

    // ゲーム状態（playersとmetaを1回のsetStateでまとめて更新）
    socket.on('gameState', ({ players: pl, meta: m }: { players: PlayerState[]; meta: GameMeta; isSpectator?: boolean }) => {
      setGameState({ players: pl ?? [], meta: m ?? null });
      // 自分がplayersに含まれてpendingでなくなったらpending解除
      const selfPlayer = pl?.find((p: PlayerState) => p.isSelf);
      if (selfPlayer && !selfPlayer.isPendingPlayer) setPendingTransfer(null);
    });

    // タイマー
    socket.on('timerUpdate', ({ remaining, limit }: TimerState) => {
      setTimer({ remaining, limit });
    });

    // トーナメント開始 or テーブル問い合わせ応答 → テーブル参加
    socket.on('t:tournamentStarting', ({ tableId: tid }: { tournamentId: string; tableId: string }) => {
      tableIdRef.current = tid;
      socket.emit('joinRoom', { roomId: tid });
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

    // テーブル移動（バランシング）
    socket.on('t:tableTransfer', ({ fromTableId, toTableId }: { fromTableId: string; toTableId: string }) => {
      tableIdRef.current = toTableId;
      socket.emit('leaveSocketRoom', { roomId: fromTableId });
      socket.emit('joinSocketRoom', { roomId: toTableId });
      logAction('別テーブルへ移動しました');
      // 移動先のゲーム状態を取得
      socket.emit('getGameState', { roomId: toTableId });
      // join完了後に確実にgameStateが届くよう再送（フリーズ防止）
      setTimeout(() => {
        socket.emit('getGameState', { roomId: toTableId });
      }, 600);
    });

    // pending待機中のテーブル移動（ゲーム進行中テーブルへ移動 → 次のハンドまで待機）
    socket.on('t:pendingTableTransfer', ({ tableId }: { tableId: string; message: string }) => {
      tableIdRef.current = tableId;
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
    });

    // 脱落
    socket.on('t:eliminated', ({ rank, totalPlayers }: { rank: number; totalPlayers: number }) => {
      // showdown結果を確認できるよう5秒待ってからオーバーレイ表示
      eliminatedTimerRef.current = setTimeout(() => {
        setEliminated({ rank, total: totalPlayers });
      }, 5000);
    });

    // トーナメント終了
    socket.on('t:tournamentFinished', ({ rankings }: { rankings: TournamentRankEntry[] }) => {
      // eliminatedオーバーレイより終了カウントダウンを優先
      if (eliminatedTimerRef.current) {
        clearTimeout(eliminatedTimerRef.current);
        eliminatedTimerRef.current = null;
      }
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
      setErrorMsg(message);
    });

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
      socket.off('t:tableTransfer');
      socket.off('t:pendingTableTransfer');
      socket.off('showdown');
      socket.off('playerAction');
      socket.off('gameStarted');
      socket.off('t:eliminated');
      socket.off('t:tournamentFinished');
      socket.off('kicked');
      socket.off('error');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== アクションハンドラ =====
  function handleBetAction(action: string) {
    if (!tableIdRef.current) return;
    socket.emit('betAction', { roomId: tableIdRef.current, action });
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
          onClick={() => router.push('/')}
          style={{ fontFamily:'var(--font-title)', fontSize:10, padding:'2px 7px', background:'rgba(139,26,26,0.55)', border:'1px solid rgba(204,34,34,0.4)', borderRadius:4, color:'#ffaaaa', cursor:'pointer', flexShrink:0, whiteSpace:'nowrap' as const }}
        >ロビーへ</button>
      </nav>

      {/* ゲームテーブル — flex:1 で残り全高さを使う */}
      {/* paddingTop: フラッシュバッジ（上方向40px飛び出す）がナビバーで隠れないよう最小余白を確保 */}
      <div style={{ flex:1, display:'flex', overflow:'visible', minHeight:0, paddingTop:28 }}>
        <TournamentTable
          players={players}
          meta={meta}
          timer={timer}
          onBetAction={handleBetAction}
          onDrawCards={handleDrawCards}
          onUpdateSelected={handleUpdateSelected}
          blind={blind}
        />
      </div>

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
              onClick={() => router.push('/')}
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
            padding: '44px 64px',
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
            {finishCountdown !== null && (
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--cream-dim)', marginTop: 12 }}>
                {finishCountdown}秒後に結果ページへ移動します
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
