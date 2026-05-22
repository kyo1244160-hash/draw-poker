/**
 * ZoomTable.tsx — FastFold（Zoom）テーブルコンポーネント
 */

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import { socket, connectWithAuth } from '../socket';

const PokerTable = dynamic(() => import('./PokerTable'), { ssr: false });

interface Props {
  poolId: string;
  name:   string;
  mode:   '27' | 'badugi' | 'mix';
}

const ZoomTable: React.FC<Props> = ({ poolId, name, mode }) => {
  const router    = useRouter();
  const [roomId,    setRoomId]    = useState<string | null>(null);
  const [waiting,   setWaiting]   = useState(true);
  const [waitCount,  setWaitCount]  = useState(0);  // 待機列（テーブル配置待ち）
  const [totalCount, setTotalCount] = useState(0);  // プール全体（ロビー表示用）
  // 退室予約: 予約が入っている場合は次のテーブル配置時にロビーへ戻る
  const leaveReservedRef = useRef(false);
  // ベット or showdownフェーズ中はFastFoldボタンを表示
  const [canFastFold, setCanFastFold] = useState(false);
  // bet0でコール/レイズ済みの場合はFastFold不可
  const [hasActedInBet0, setHasActedInBet0] = useState(false);
  const currentPhaseRef = useRef<string>('waiting');
  // 初回joinを1度だけ送るためのフラグ
  const joinedRef = useRef(false);

  useEffect(() => {
    if (!socket.connected) {
      connectWithAuth().then((ok) => {
        if (!ok) router.replace('/');
      });
    }

    // 初回のみ z:join を送信
    if (!joinedRef.current) {
      joinedRef.current = true;
      socket.emit('z:join', { poolId, name });
    }

    const onWaiting = ({ waitingCount, totalCount: tc }: { waitingCount: number; totalCount: number }) => {
      setWaiting(true);
      setWaitCount(waitingCount);
      setTotalCount(tc);
      setCanFastFold(false);
    };


    const onAssigned = ({ roomId: rid }: { roomId: string }) => {
      if (leaveReservedRef.current) {
        socket.emit('z:leave', { poolId });
        router.push('/');
        return;
      }
      setRoomId(rid);
      setWaiting(false);
      setHasActedInBet0(false); // 新テーブルではリセット
      // 500ms後サーバーがbroadcast → さらに700msでrequestGameState（二重保険）
      setTimeout(() => {
        socket.emit('z:requestGameState', { roomId: rid });
      }, 1500);  // 1200ms後のbroadcastよりも後に届くように
    };

    const onLeaveReservation = ({ type }: { type: null|'afterHand'|'nextBB' }) => {
      leaveReservedRef.current = !!type;
    };

    const onPoolState = ({ poolId: pid, waitingCount, totalCount: tc }: { poolId: string; waitingCount: number; totalCount: number }) => {
      if (pid === poolId) { setWaitCount(waitingCount); setTotalCount(tc); }
    };

    // タイムスタンプ付きデバッグログ
    const _ts = () => { const n = new Date(); return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}.${String(n.getMilliseconds()).padStart(3,'0')}`; };
    // ゲーム状態からFastFoldボタンの表示を制御
    const onGameState = (gs: { meta: { phase: string }, players?: any[] }) => {
      const phase = gs.meta.phase;
      currentPhaseRef.current = phase;
      setCanFastFold(phase.startsWith('bet') || phase === 'showdown');
      // デバッグログ
      const me = gs.players?.find((p: any) => p.isSelf);
    };

    // 新しいハンド開始時にbet0アクション履歴をリセット
    const onGameStarted = () => {
      setHasActedInBet0(false);
    };

    const onKicked = () => { router.push('/'); };

    socket.on('z:waiting',        onWaiting);
    socket.on('z:assigned',       onAssigned);
    socket.on('z:poolState',      onPoolState);
    socket.on('gameState',        onGameState);
    socket.on('gameStarted',      onGameStarted);
    socket.on('kicked',           onKicked);
    socket.on('leaveReservation', onLeaveReservation);

    return () => {
      socket.off('z:waiting',        onWaiting);
      socket.off('z:assigned',       onAssigned);
      socket.off('z:poolState',      onPoolState);
      socket.off('gameState',        onGameState);
      socket.off('gameStarted',      onGameStarted);
      socket.off('kicked',           onKicked);
      socket.off('leaveReservation', onLeaveReservation);
      socket.emit('z:leave', { poolId });
    };
  }, [poolId, name]);

  // タイムスタンプ付きクライアントログ
  // ⚡ FastFold: 即フォールド → 次のテーブルへ移動
  const handleFastFold = () => {
    socket.emit('z:fastFold', { poolId, roomId });
  };

  // bet0でコール/レイズ/ベットした場合にFastFold不可フラグを立てる
  const handleBetAction = (action: string) => {
    if (currentPhaseRef.current === 'bet0' && (action === 'call' || action === 'raise' || action === 'bet')) {
      setHasActedInBet0(true);
    }
  };

  // 📺 フォールドして観戦: フォールドするが現テーブルに留まりゲーム終了まで見る
  const handleFoldStay = () => {
    socket.emit('z:foldStay', { poolId });
  };

  const handleLeave = () => {
    socket.emit('z:leave', { poolId });
    router.push('/');
  };

  // ===== 待機中 =====
  if (waiting || !roomId) {
    return (
      <div style={S.waitScreen}>
        <div style={S.waitCard}>
          <div style={S.waitTitle}>⚡ FastFold</div>
          <div style={S.waitSub}>次のテーブルへの配置を待っています...</div>
          <div style={S.waitCount}>
            {totalCount} <span style={S.waitCountLabel}>人参加中</span>
          </div>
          <div style={S.waitBar}>
            <div style={{ ...S.waitBarFill, width: `${Math.min((waitCount / 6) * 100, 100)}%` }} />
          </div>
          <div style={S.waitNote}>待機中 {waitCount} 人 / あと {Math.max(6 - waitCount, 0)} 人で開始</div>
          <button onClick={handleLeave} style={S.leaveBtn}>ロビーへ戻る</button>
        </div>
      </div>
    );
  }

  // ===== ゲーム中 =====
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <PokerTable key={roomId} roomId={roomId} name={name} mode={mode} onFastFold={canFastFold && !hasActedInBet0 ? handleFastFold : undefined} onFoldStay={handleFoldStay} onBetAction={handleBetAction} />
    </div>
  );
};

export default ZoomTable;

const S: Record<string, React.CSSProperties> = {
  waitScreen: {
    minHeight: '100dvh', display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'var(--felt)',
    fontFamily: 'var(--font-body)',
  },
  waitCard: {
    background: 'linear-gradient(160deg, rgba(22,92,56,0.8), rgba(10,51,32,0.95))',
    border: '1px solid var(--gold-dim)', borderRadius: 16,
    padding: '40px 48px', textAlign: 'center',
    boxShadow: '0 8px 40px rgba(0,0,0,0.5)', maxWidth: 360, width: '90%',
  },
  waitTitle: {
    fontFamily: 'var(--font-title)', fontSize: 32, color: '#88ee66',
    letterSpacing: '0.1em', marginBottom: 8,
  },
  waitSub:   { color: 'var(--cream-dim)', fontSize: 15, marginBottom: 28 },
  waitCount: { fontSize: 56, fontWeight: 700, color: 'var(--gold-bright)', lineHeight: 1, marginBottom: 12 },
  waitCountLabel: { fontSize: 18, color: 'var(--cream-dim)', fontWeight: 400 },
  waitBar: {
    height: 8, background: 'rgba(255,255,255,0.1)', borderRadius: 4,
    overflow: 'hidden', marginBottom: 10,
  },
  waitBarFill: {
    height: '100%', background: 'linear-gradient(90deg, #44bb33, #88ee66)',
    borderRadius: 4, transition: 'width 0.4s ease',
  },
  waitNote: {
    color: 'var(--cream-dim)', fontSize: 13, marginBottom: 28,
    fontFamily: 'var(--font-title)', letterSpacing: '0.1em',
  },
  leaveBtn: {
    padding: '10px 24px', background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: 7,
    color: 'var(--cream-dim)', fontSize: 14, fontFamily: 'var(--font-title)',
    cursor: 'pointer', letterSpacing: '0.06em',
  },
  // fastFoldBtn は PokerTable の onFastFold prop 経由で表示するため未使用
  // fastFoldBtn: { position: 'fixed', ... }
};
