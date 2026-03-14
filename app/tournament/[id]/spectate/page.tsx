'use client';
// app/tournament/[id]/spectate/page.tsx
// トーナメント観戦ページ

import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { socket, connectWithAuth } from '../../../../socket';
import SpectatorView from '../../../components/SpectatorView';
import type { BlindUpdate, TournamentStatus, PlayerState, GameMeta } from '../../../types/tournament';

export default function SpectatePage() {
  const params       = useParams() as { id: string };
  const searchParams = useSearchParams();
  const router       = useRouter();

  // ?tableId=xxx で特定テーブルを指定
  const targetTableId = searchParams?.get('tableId');

  const [players,  setPlayers]  = useState<PlayerState[]>([]);
  const [meta,     setMeta]     = useState<GameMeta | null>(null);
  const [blind,    setBlind]    = useState<BlindUpdate | null>(null);
  const [status,   setStatus]   = useState<TournamentStatus | null>(null);
  const [timer,    setTimer]    = useState<{ remaining: number; limit: number } | null>(null);
  const [connected, setConnected] = useState(false);
  const tableIdRef = useRef<string | null>(targetTableId ?? null);

  useEffect(() => {
    let cancelled = false;

    connectWithAuth().then(ok => {
      if (cancelled || !ok) return;
      setConnected(true);

      // テーブルIDが指定されていれば即観戦参加
      if (targetTableId) {
        socket.emit('spectate', { tableId: targetTableId });
      } else {
        // 指定なし: tournamentStarting を待って最初のテーブルへ
        socket.on('t:tournamentStarting', ({ tableId: tid }: { tournamentId: string; tableId: string }) => {
          if (!tableIdRef.current) {
            tableIdRef.current = tid;
            socket.emit('spectate', { tableId: tid });
          }
        });
      }
    });

    socket.on('gameState', ({ players: pl, meta: m }) => {
      setPlayers(pl ?? []);
      setMeta(m ?? null);
    });

    socket.on('timerUpdate', ({ remaining, limit }: { remaining: number; limit: number }) => {
      setTimer({ remaining, limit });
    });

    socket.on('t:blindUpdate', (p: BlindUpdate) => setBlind(p));
    socket.on('t:tournamentStatus', (p: TournamentStatus) => setStatus(p));

    socket.on('t:tournamentFinished', () => {
      router.push(`/tournament/${params.id}/result`);
    });

    return () => {
      cancelled = true;
      socket.off('gameState');
      socket.off('timerUpdate');
      socket.off('t:blindUpdate');
      socket.off('t:tournamentStatus');
      socket.off('t:tournamentStarting');
      socket.off('t:tournamentFinished');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!connected) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <div className="animate-spin text-4xl mb-4">🃏</div>
          <p className="text-gray-400">観戦準備中...</p>
        </div>
      </div>
    );
  }

  return (
    <SpectatorView
      players={players}
      meta={meta}
      blind={blind}
      status={status}
      timer={timer}
    />
  );
}
