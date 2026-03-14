'use client';
// app/tournament/[id]/draw/page.tsx
// トーナメントゲームページ（Socket.IO リアルタイム接続）

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { socket, connectWithAuth } from '../../../../socket';
import TournamentTable from '../../../components/TournamentTable';
import TournamentInfoBar from '../../../components/TournamentInfoBar';
import EliminatedOverlay from '../../../components/EliminatedOverlay';
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
  const tableIdRef = useRef<string | null>(null);  // サーバーから t:tournamentStarting で受信

  const [players,    setPlayers]    = useState<PlayerState[]>([]);
  const [meta,       setMeta]       = useState<GameMeta | null>(null);
  const [blind,      setBlind]      = useState<BlindUpdate | null>(null);
  const [status,     setStatus]     = useState<TournamentStatus | null>(null);
  const [timer,      setTimer]      = useState<TimerState | null>(null);
  const [actionLog,  setActionLog]  = useState<ActionLog[]>([]);
  const [eliminated, setEliminated] = useState<{ rank: number; total: number } | null>(null);
  const [finished,   setFinished]   = useState<TournamentRankEntry[] | null>(null);
  const [connected,  setConnected]  = useState(false);
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);

  const logAction = useCallback((text: string) => {
    setActionLog(prev => [...prev.slice(-29), { id: Date.now(), text }]);
  }, []);

  // ===== Socket.IO 接続 =====
  useEffect(() => {
    let cancelled = false;
    const tournamentId = params.id;

    connectWithAuth().then(ok => {
      if (cancelled) return;
      if (!ok) { router.push('/'); return; }
      setConnected(true);
      // 接続後すぐにテーブルを問い合わせ（直接ページを開いた場合の対策）
      if (!tableIdRef.current) {
        socket.emit('t:getMyTable', { tournamentId });
      }
    });

    // 接続済みの場合も問い合わせ
    if (socket.connected && !tableIdRef.current) {
      socket.emit('t:getMyTable', { tournamentId });
    }

    // ゲーム状態
    socket.on('gameState', ({ players: pl, meta: m, isSpectator }) => {
      setPlayers(pl ?? []);
      setMeta(m ?? null);
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

    // ブラインド更新
    socket.on('t:blindUpdate', (payload: BlindUpdate) => {
      setBlind(payload);
    });

    // ステータス更新
    socket.on('t:tournamentStatus', (payload: TournamentStatus) => {
      setStatus(payload);
    });

    // テーブル移動（バランシング）
    socket.on('t:tableTransfer', ({ fromTableId, toTableId }: { fromTableId: string; toTableId: string }) => {
      tableIdRef.current = toTableId;
      socket.emit('joinRoom', { roomId: toTableId });
      logAction('別テーブルへ移動しました');
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
      setEliminated({ rank, total: totalPlayers });
    });

    // トーナメント終了
    socket.on('t:tournamentFinished', ({ rankings }: { rankings: TournamentRankEntry[] }) => {
      setFinished(rankings);
      router.push(`/tournament/${params.id}/result`);
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
      socket.off('t:blindUpdate');
      socket.off('t:tournamentStatus');
      socket.off('t:tableTransfer');
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

      {/* ナビバー — PC: フルサイズ / スマホ: コンパクト（高さを抑えてテーブル領域を確保）*/}
      <nav style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'6px 10px', borderBottom:'1px solid var(--gold-dim)',
        background:'rgba(0,0,0,0.25)', flexShrink:0, gap:8,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
          <img src="/icons/icon-72.png" alt="logo" style={{ width:24, height:24, borderRadius:'50%' }} />
          <span style={{ fontFamily:'var(--font-title)', fontSize:13, color:'var(--gold)', letterSpacing:'0.06em', whiteSpace:'nowrap' as const }}>Pastis</span>
        </div>
        {/* トーナメント情報バー（中央）*/}
        <div style={{ flex:1, minWidth:0, overflow:'hidden' }}>
          <TournamentInfoBar blind={blind} status={status} />
        </div>
        <button
          onClick={() => router.push('/')}
          style={{ fontFamily:'var(--font-title)', fontSize:11, padding:'4px 10px', background:'rgba(139,26,26,0.55)', border:'1px solid rgba(204,34,34,0.4)', borderRadius:4, color:'#ffaaaa', cursor:'pointer', flexShrink:0, whiteSpace:'nowrap' as const }}
        >ロビーへ</button>
      </nav>

      {/* ゲームテーブル — flex:1 で残り全高さを使う。TournamentTable 内部もこの高さに合わせる */}
      {/* paddingTop: フラッシュバッジ（上方向に最大70px飛び出す）がナビバーで隠れないよう余白を確保 */}
      <div style={{ flex:1, display:'flex', overflow:'hidden', minHeight:0, paddingTop:8 }}>
        <TournamentTable
          players={players}
          meta={meta}
          timer={timer}
          onBetAction={handleBetAction}
          onDrawCards={handleDrawCards}
          onUpdateSelected={handleUpdateSelected}
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

      {/* 脱落オーバーレイ */}
      {eliminated && (
        <EliminatedOverlay
          rank={eliminated.rank}
          totalPlayers={eliminated.total}
          onClose={handleEliminatedClose}
        />
      )}
    </div>
  );
}
