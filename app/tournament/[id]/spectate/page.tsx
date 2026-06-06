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
  // ?fromLateReg=1 でレイトレジスト後の観戦待機モード
  const fromLateReg = searchParams?.get('fromLateReg') === '1';
  // ?myTournamentId=xxx で自分が参加登録しているトーナメントIDを受け取る
  // 観戦中に自分のトーナメントが開始したら /draw へ遷移するための判定に使用
  const myTournamentId = searchParams?.get('myTournamentId') ?? null;

  const [players,  setPlayers]  = useState<PlayerState[]>([]);
  const [meta,     setMeta]     = useState<GameMeta | null>(null);
  const [blind,    setBlind]    = useState<BlindUpdate | null>(null);
  const [status,   setStatus]   = useState<TournamentStatus | null>(null);
  const [timer,    setTimer]    = useState<{ remaining: number; limit: number } | null>(null);
  const [connected, setConnected] = useState(false);
  const tableIdRef = useRef<string | null>(targetTableId ?? null);
  // レイトレジスト時: 自分のテーブルID（ゲーム開始で /draw 遷移するための判定用）
  const myTableIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const handleTournamentStarting = ({ tournamentId: tid_t, tableId: tid }: { tournamentId: string; tableId: string }) => {
      // 【重要】自分が参加登録しているトーナメント（別のトーナメント）が開始した場合も検知する。
      // ユーザーが「Aトーナメントを観戦しながらBトーナメントの開始を待つ」ケース:
      //   - params.id === A（観戦中）
      //   - myTournamentId === B（自分が参加登録しているもの）
      //   - t:tournamentStarting の tournamentId === B → /tournament/B/draw へ遷移
      if (myTournamentId && tid_t === myTournamentId) {
        router.replace(`/tournament/${myTournamentId}/draw`);
        return;
      }
      if (fromLateReg) {
        // レイトレジスト時: 自分のテーブルとして記憶し、そのテーブルを観戦
        myTableIdRef.current = tid;
        tableIdRef.current = tid;
        socket.emit('spectate', { tableId: tid });
        return;
      }
      if (!tableIdRef.current) {
        tableIdRef.current = tid;
        socket.emit('spectate', { tableId: tid });
      }
    };

    const handleGameState = ({ players: pl, meta: m }: { players?: PlayerState[]; meta?: GameMeta }) => {
      setPlayers(pl ?? []);
      setMeta(m ?? null);
      // レイトレジスト観戦中: 自分がそのテーブルのプレイヤー（またはpending）として
      // gameState が届いたら /draw へ遷移する。
      // 判定: isSelf=true のプレイヤーが players に含まれる = 自分がこのテーブルの参加者
      if (fromLateReg) {
        const selfEntry = (pl ?? []).find((p: { isSelf?: boolean }) => p.isSelf);
        if (selfEntry) {
          // myTableIdRef が未セットの場合でも meta.roomId から補完する
          const myTid = myTableIdRef.current ?? m?.roomId ?? null;
          if (myTid) myTableIdRef.current = myTid;
          // ゲーム進行中（bet/draw フェーズ）または pending（次のハンドから参加）どちらでも /draw へ
          router.replace(`/tournament/${params.id}/draw`);
          return;
        }
      }
      // レイトレジスト観戦中: 旧ロジック（myTableIdRef が先にセットされたケースのフォールバック）
      if (fromLateReg && myTableIdRef.current && m?.roomId === myTableIdRef.current) {
        if (m.phase && m.phase !== 'waiting') {
          router.replace(`/tournament/${params.id}/draw`);
        }
      }
    };

    const handlePendingTableTransfer = ({ tableId: pendingTid }: { tableId: string; message?: string }) => {
      if (fromLateReg) {
        myTableIdRef.current = pendingTid;
        router.replace(`/tournament/${params.id}/draw`);
        return;
      }
      // fromLateReg でない場合はテーブル切替（バランシング後等）
      tableIdRef.current = pendingTid;
    };

    const handleTableJoin = ({ toTableId }: { toTableId: string }) => {
      if (fromLateReg) {
        myTableIdRef.current = toTableId;
        tableIdRef.current = toTableId;
        // t:tableTransfer（3秒後）を待たずに即 /draw へ遷移
        router.replace(`/tournament/${params.id}/draw`);
      }
    };

    const handleTableTransfer = ({ toTableId }: { fromTableId: string; toTableId: string }) => {
      if (fromLateReg) {
        myTableIdRef.current = toTableId;
        router.replace(`/tournament/${params.id}/draw`);
      }
    };

    const handleTimerUpdate = ({ remaining, limit }: { remaining: number; limit: number }) => {
      setTimer({ remaining, limit });
    };
    const handleBlindUpdate = (p: BlindUpdate) => setBlind(p);
    const handleTournamentStatus = (p: TournamentStatus) => setStatus(p);
    const handleTournamentFinished = () => {
      router.push(`/tournament/${params.id}/result`);
    };
    const handleTournamentNotFound = () => {
      router.replace(`/tournament/${params.id}`);
    };
    const handleTableClosed = ({ tournamentId, newTableId }: { tournamentId: string; newTableId: string }) => {
      if (tournamentId !== params.id) return;
      tableIdRef.current = newTableId;
      // 新テーブルを観戦開始（setPlayers/setMetaは新テーブルのgameStateで上書きされる）
      socket.emit('spectate', { tableId: newTableId });
    };

    connectWithAuth().then(ok => {
      if (cancelled || !ok) return;
      setConnected(true);

      // レイトレジスト後: t:getMyTable で配置をトリガするが、即遷移せず観戦継続する。
      // t:tournamentStarting で自分のテーブルIDを記憶し、ゲームが実際に開始されたら /draw へ遷移する。
      if (fromLateReg) {
        socket.emit('t:getMyTable', { tournamentId: params.id });
      }

      // テーブルIDが指定されていれば即観戦参加。
      // 指定なしの場合も tournamentId をサーバーに渡して即解決する
      // （サーバーの spectate ハンドラが tournamentId → tableId を自動解決）
      if (targetTableId) {
        socket.emit('spectate', { tableId: targetTableId });
      } else {
        // 進行中トーナメントなら tournamentId だけで即解決できる
        socket.emit('spectate', { tournamentId: params.id });
        // 未開始の場合に備えて t:tournamentStarting も待つ
        socket.on('t:tournamentStarting', handleTournamentStarting);
      }
    });

    socket.on('gameState', handleGameState);

    // レイトレジスト: pending プレイヤーとして配置された場合のハンドラ。
    // ゲーム進行中テーブルに pending で追加されると t:tournamentStarting ではなく
    // t:pendingTableTransfer が届く。fromLateReg=true の場合は /draw に遷移する。
    socket.on('t:pendingTableTransfer', handlePendingTableTransfer);

    // バランシングによるテーブル移動通知。
    // fromLateReg=true: 新テーブルに配置後にバランシングで別テーブルへ移動するケース。
    // サーバーから t:tableJoin（即時）と t:tableTransfer（3秒後）が届く。
    // これらも /draw への遷移トリガーとして使う。
    socket.on('t:tableJoin', handleTableJoin);
    socket.on('t:tableTransfer', handleTableTransfer);

    socket.on('timerUpdate', handleTimerUpdate);

    socket.on('t:blindUpdate', handleBlindUpdate);
    socket.on('t:tournamentStatus', handleTournamentStatus);

    socket.on('t:tournamentFinished', handleTournamentFinished);

    // トーナメントが見つからない（終了・未起動）→ 登録ページへ
    socket.on('t:tournamentNotFound', handleTournamentNotFound);

    // 観戦中テーブルがバランシングで解体された → 新テーブルへ切り替え
    socket.on('t:tableClosed', handleTableClosed);

    return () => {
      cancelled = true;
      socket.off('gameState', handleGameState);
      socket.off('timerUpdate', handleTimerUpdate);
      socket.off('t:blindUpdate', handleBlindUpdate);
      socket.off('t:tournamentStatus', handleTournamentStatus);
      socket.off('t:tournamentStarting', handleTournamentStarting);
      socket.off('t:tournamentFinished', handleTournamentFinished);
      socket.off('t:tournamentNotFound', handleTournamentNotFound);
      socket.off('t:tableClosed', handleTableClosed);
      socket.off('t:pendingTableTransfer', handlePendingTableTransfer);
      socket.off('t:tableJoin', handleTableJoin);
      socket.off('t:tableTransfer', handleTableTransfer);
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
      onLeave={() => { window.location.href = '/'; }}
    />
  );
}
