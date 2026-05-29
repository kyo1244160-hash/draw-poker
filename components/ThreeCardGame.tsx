/**
 * components/ThreeCardGame.tsx
 * スリーカードポーカー ゲームコンテナ
 * （SSR 無効化のため pages/ から dynamic import する）
 *
 * 設計:
 *   - 入室（3c:join）・state受信・ポイント取得をここで管理
 *   - 受け取った state を ThreeCardTable に渡す
 *   - ThreeCardTable はベット・アクション送信のみ担当
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter }           from 'next/router';
import { useSession }          from 'next-auth/react';
import { socket, connectWithAuth } from '../socket';
import ThreeCardTable from './ThreeCardTable';

interface TCResult {
  net:              number;
  dealerQualified:  boolean;
  won:              boolean;
  push?:            boolean;
  folded?:          boolean;
  anteBonusMult?:   number;
  ppPayout?:        number;
  sixCardPayout?:   number;
  playerEval?:      string;
  dealerHand?:      string[];
  dealerEval?:      string;
}

interface TCPlayer {
  name:      string;
  isSelf:    boolean;
  points:    number;
  bets:      { ante: number; pp: number; sixCard: number };
  hand:      string[];
  action:    string | null;
  betReady:  boolean;
  handLabel: string | null;
  result:    TCResult | null;
}

interface TCState {
  roomId:     string;
  phase:      string;
  handCount:  number;
  players:    TCPlayer[];
  dealerHand: string[] | null;
  maxPlayers: number;
}

export default function ThreeCardGame() {
  const router  = useRouter();
  const roomId  = router.query.roomId as string | undefined;
  const { data: session, status } = useSession();

  const [state,     setState]     = useState<TCState | null>(null);
  const [myPoints,  setMyPoints]  = useState<number | null>(null);
  const [fatalError, setFatalError] = useState('');   // 入室不可系（ロビー誘導）
  const [toastError, setToastError] = useState('');   // ベット・アクション系（3秒で消える）

  // 認証・接続
  useEffect(() => {
    if (status !== 'authenticated') return;
    connectWithAuth();
  }, [status]);

  // ポイント取得
  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch('/api/profile/points')
      .then(r => r.json())
      .then(d => setMyPoints(d.points ?? 0))
      .catch(() => setMyPoints(0));
  }, [status]);

  // 入室 + state 購読
  useEffect(() => {
    if (!roomId || status !== 'authenticated') return;

    const onState = (s: TCState) => {
      // 自テーブルのみ受け取る
      if (s.roomId && s.roomId !== roomId) return;
      setState(s);
    };
    const onError = (e: { message: string }) => {
      // 入室系エラーは致命的（ロビーに誘導）、それ以外はトーストで一時表示
      const FATAL_MSGS = ['ログインが必要です', 'ポイントが不足しています', '入室できませんでした', 'このテーブルは満員です'];
      if (FATAL_MSGS.some(m => e.message.includes(m))) {
        setFatalError(e.message);
      } else {
        setToastError(e.message);
        setTimeout(() => setToastError(''), 3000);
      }
    };

    socket.on('3c:state', onState);
    socket.on('3c:error', onError);

    socket.emit('3c:join', { roomId });

    return () => {
      socket.off('3c:state', onState);
      socket.off('3c:error', onError);
    };
  }, [roomId, status]);

  const handleBet = useCallback((ante: number, pp: number, sixCard: number) => {
    if (!roomId) return;
    socket.emit('3c:bet', { roomId, ante, pp, sixCard });
  }, [roomId]);

  const handleAction = useCallback((action: 'play' | 'fold') => {
    if (!roomId) return;
    socket.emit('3c:action', { roomId, action });
  }, [roomId]);

  const handleLeave = useCallback(() => {
    if (roomId) socket.emit('3c:leave', { roomId });
    router.replace('/');
  }, [roomId, router]);

  // ===== 表示分岐 =====
  if (status === 'loading') {
    return <Screen>認証確認中...</Screen>;
  }
  if (status === 'unauthenticated') {
    return <Screen>ログインが必要です</Screen>;
  }
  if (!roomId) {
    return <Screen>ルームIDが見つかりません</Screen>;
  }
  if (fatalError) {
    return (
      <div style={pageStyle}>
        <div style={{ textAlign: 'center', color: '#cc5566', padding: 32 }}>
          <div style={{ marginBottom: 16 }}>{fatalError}</div>
          <button onClick={handleLeave} style={backBtn}>ロビーに戻る</button>
        </div>
      </div>
    );
  }
  if (myPoints !== null && myPoints < 1) {
    return (
      <div style={pageStyle}>
        <div style={{ textAlign: 'center', color: 'var(--cream-dim)', padding: 32 }}>
          <div style={{ marginBottom: 8, fontSize: 16 }}>ポイントが不足しています</div>
          <div style={{ marginBottom: 16, fontSize: 13 }}>
            スリーカードポーカーで遊ぶには 1pt 以上が必要です。
          </div>
          <button onClick={handleLeave} style={backBtn}>ロビーに戻る</button>
        </div>
      </div>
    );
  }
  if (!state) {
    return <Screen>テーブルに接続中...</Screen>;
  }

  return (
    <div style={pageStyle}>
      {/* トーストエラー（ベット・アクション失敗時に3秒表示） */}
      {toastError && (
        <div style={{
          position: 'fixed', top: 56, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(160,40,40,0.92)', color: 'white',
          fontFamily: 'var(--font-body)', fontSize: 13,
          padding: '8px 20px', borderRadius: 6,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          zIndex: 9999, whiteSpace: 'nowrap',
          border: '1px solid rgba(255,100,100,0.4)',
        }}>
          ⚠ {toastError}
        </div>
      )}
      {/* ナビ */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px',
        background: 'rgba(0,0,0,0.5)', borderBottom: '1px solid rgba(201,168,76,0.15)',
        flexShrink: 0 }}>
        <button onClick={handleLeave} style={backBtn}>← ロビー</button>
        <span style={{ fontFamily: 'var(--font-title)', fontSize: 11,
          letterSpacing: '0.15em', color: 'var(--gold-dim)' }}>
          {roomId.toUpperCase()}
        </span>
        {myPoints !== null && (
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-title)',
            fontSize: 12, color: '#88dd88' }}>
            {myPoints.toLocaleString()} pt
          </span>
        )}
      </div>
      {/* テーブル */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <ThreeCardTable
          state={state}
          onBet={handleBet}
          onAction={handleAction}
          onLeave={handleLeave}
        />
      </div>
    </div>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...pageStyle, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', fontSize: 16 }}>
        {children}
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  display:        'flex',
  flexDirection:  'column',
  height:         '100dvh',
  background:     'linear-gradient(160deg, rgba(10,48,28,0.98), rgba(5,28,16,1))',
  color:          'var(--cream)',
  overflow:       'hidden',
};

const backBtn: React.CSSProperties = {
  fontFamily:    'var(--font-title)',
  fontSize:      11,
  letterSpacing: '0.08em',
  color:         'var(--gold-dim)',
  background:    'rgba(201,168,76,0.08)',
  border:        '1px solid rgba(201,168,76,0.25)',
  borderRadius:  4,
  padding:       '4px 10px',
  cursor:        'pointer',
};
