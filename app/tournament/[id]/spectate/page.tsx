'use client';
// app/tournament/[id]/spectate/page.tsx
// トーナメント観戦ページ

import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { socket, connectWithAuth } from '../../../../socket';
import SpectatorView from '../../../components/SpectatorView';
import type { BlindUpdate, TournamentStatus, PlayerState, GameMeta } from '../../../types/tournament';

interface SpectateTablePlayer {
  name: string;
  chips: number;
  isSelf?: boolean;
  sittingOut?: boolean;
}
interface SpectateTableSummary {
  tableId: string;
  tableNo?: number;
  playerCount?: number;
  players: SpectateTablePlayer[];
}
interface SpectateOverview {
  remainingPlayers: number | null;
  averageStack: number | null;
  tables: SpectateTableSummary[];
}
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
  const leavingRef = useRef(false);
  // レイトレジスト時: 自分のテーブルID（ゲーム開始で /draw 遷移するための判定用）
  const myTableIdRef = useRef<string | null>(null);
  const [overview, setOverview] = useState<SpectateOverview>({ remainingPlayers: null, averageStack: null, tables: [] });
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [selectTab, setSelectTab] = useState<'table' | 'player'>('table');
  const [playerQuery, setPlayerQuery] = useState('');
  const [spectatingTableId, setSpectatingTableId] = useState<string | null>(targetTableId ?? null);

  const fetchOverview = async () => {
    if (leavingRef.current) return;
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const res = await fetch(`/api/tournament/${params.id}/tables`);
      if (!res.ok) {
        if (res.status === 410) {
          router.replace(`/tournament/${params.id}/result`);
          return;
        }
        setOverview({ remainingPlayers: null, averageStack: null, tables: [] });
        setOverviewError(res.status === 503 ? 'サーバー準備中です。少し待って再度お試しください' : `テーブル情報を取得できませんでした (${res.status})`);
        return;
      }
      const data = await res.json();
      setOverview({
        remainingPlayers: data.remainingPlayers ?? null,
        averageStack: data.averageStack ?? null,
        tables: Array.isArray(data.tables) ? data.tables : [],
      });
    } catch {
      setOverview({ remainingPlayers: null, averageStack: null, tables: [] });
      setOverviewError('通信エラーが発生しました');
    } finally {
      setOverviewLoading(false);
    }
  };

  const backToTableSelect = () => {
    const currentTableId = tableIdRef.current;
    if (currentTableId) socket.emit('t:leaveSpectate', { tableId: currentTableId });
    tableIdRef.current = null;
    setSpectatingTableId(null);
    setPlayers([]);
    setMeta(null);
    setTimer(null);
    fetchOverview();
  };

  const leaveSpectate = () => {
    leavingRef.current = true;
    const currentTableId = tableIdRef.current;
    if (currentTableId) socket.emit('t:leaveSpectate', { tableId: currentTableId });
    tableIdRef.current = null;
    setSpectatingTableId(null);
    router.replace('/');
  };

  const startSpectating = (tableId: string) => {
    tableIdRef.current = tableId;
    setSpectatingTableId(tableId);
    socket.emit('spectate', { tableId });
  };
  useEffect(() => {
    let cancelled = false;

    const handleTournamentStarting = ({ tournamentId: tid_t, tableId: tid }: { tournamentId: string; tableId: string }) => {
      if (leavingRef.current) return;
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
        fetchOverview();
      }
    };

    const handleGameState = ({ players: pl, meta: m }: { players?: PlayerState[]; meta?: GameMeta }) => {
      if (leavingRef.current) return;
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
      if (leavingRef.current) return;
      if (fromLateReg) {
        myTableIdRef.current = pendingTid;
        router.replace(`/tournament/${params.id}/draw`);
        return;
      }
      // fromLateReg でない場合はテーブル切替（バランシング後等）
      tableIdRef.current = pendingTid;
    };

    const handleTableJoin = ({ toTableId }: { toTableId: string }) => {
      if (leavingRef.current) return;
      if (fromLateReg) {
        myTableIdRef.current = toTableId;
        tableIdRef.current = toTableId;
        // t:tableTransfer（3秒後）を待たずに即 /draw へ遷移
        router.replace(`/tournament/${params.id}/draw`);
      }
    };

    const handleTableTransfer = ({ toTableId }: { fromTableId: string; toTableId: string }) => {
      if (leavingRef.current) return;
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
      if (leavingRef.current) return;
      router.push(`/tournament/${params.id}/result`);
    };
    const handleTournamentNotFound = () => {
      if (leavingRef.current) return;
      router.replace(`/tournament/${params.id}`);
    };
    const handleSpectateRejected = ({ message }: { message?: string }) => {
      if (leavingRef.current) return;
      setSpectatingTableId(null);
      tableIdRef.current = null;
      setPlayers([]);
      setMeta(null);
      setOverviewError(message ?? '観戦できません');
      fetchOverview();
    };

    const handleTableClosed = ({ tournamentId, newTableId }: { tournamentId: string; newTableId: string }) => {
      if (leavingRef.current) return;
      if (tournamentId !== params.id) return;
      startSpectating(newTableId);
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
        startSpectating(targetTableId);
      } else if (fromLateReg) {
        socket.emit('spectate', { tournamentId: params.id, fromLateReg: true });
        socket.on('t:tournamentStarting', handleTournamentStarting);
      } else {
        fetchOverview();
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
    socket.on('t:spectateRejected', handleSpectateRejected);

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
      socket.off('t:spectateRejected', handleSpectateRejected);
      socket.off('t:tableClosed', handleTableClosed);
      socket.off('t:pendingTableTransfer', handlePendingTableTransfer);
      socket.off('t:tableJoin', handleTableJoin);
      socket.off('t:tableTransfer', handleTableTransfer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const normalizedQuery = playerQuery.trim().toLowerCase();
  const playerRows = overview.tables.flatMap((table) =>
    table.players.map((player) => ({ table, player }))
  ).filter(({ player }) => !normalizedQuery || player.name.toLowerCase().includes(normalizedQuery));
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

  if (!fromLateReg && !spectatingTableId) {
    const tabButton = (tab: 'table' | 'player', label: string) => (
      <button
        type="button"
        onClick={() => setSelectTab(tab)}
        style={{
          flex: 1,
          padding: '10px 12px',
          borderRadius: 6,
          border: `1px solid ${selectTab === tab ? 'var(--gold)' : 'rgba(201,168,76,0.28)'}`,
          background: selectTab === tab ? 'rgba(201,168,76,0.18)' : 'rgba(0,0,0,0.22)',
          color: selectTab === tab ? 'var(--gold-bright)' : 'var(--cream-dim)',
          fontFamily: 'var(--font-title)',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >{label}</button>
    );

    return (
      <div style={{ minHeight:'100dvh', background:'var(--felt)', color:'var(--cream)', fontFamily:'var(--font-body)', padding:'18px 14px', overflowY:'auto' }}>
        <div style={{ maxWidth:900, margin:'0 auto' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, marginBottom:14 }}>
            <div>
              <div style={{ fontFamily:'var(--font-title)', color:'var(--gold)', fontSize:24, letterSpacing:'0.08em' }}>観戦テーブル選択</div>
              <div style={{ color:'var(--cream-dim)', fontSize:13, marginTop:4 }}>バースト後の観戦モードです</div>
            </div>
            <button
              type="button"
              onClick={leaveSpectate}
              style={{ border:'1px solid rgba(201,168,76,0.35)', background:'rgba(0,0,0,0.22)', color:'var(--gold-dim)', borderRadius:6, padding:'8px 12px', cursor:'pointer' }}
            >ロビーへ</button>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(2,minmax(0,1fr))', gap:10, marginBottom:14 }}>
            <div style={{ border:'1px solid rgba(201,168,76,0.25)', borderRadius:8, padding:'12px 14px', background:'rgba(0,0,0,0.18)' }}>
              <div style={{ color:'var(--gold-dim)', fontSize:11, marginBottom:4 }}>残り人数</div>
              <div style={{ fontFamily:'var(--font-title)', fontSize:22 }}>{overview.remainingPlayers ?? '-'}人</div>
            </div>
            <div style={{ border:'1px solid rgba(201,168,76,0.25)', borderRadius:8, padding:'12px 14px', background:'rgba(0,0,0,0.18)' }}>
              <div style={{ color:'var(--gold-dim)', fontSize:11, marginBottom:4 }}>平均スタック</div>
              <div style={{ fontFamily:'var(--font-title)', fontSize:22 }}>{overview.averageStack != null ? overview.averageStack.toLocaleString() : '-'}</div>
            </div>
          </div>

          <div style={{ display:'flex', gap:8, marginBottom:14 }}>
            {tabButton('table', 'テーブルから選ぶ')}
            {tabButton('player', 'プレイヤーから選ぶ')}
            <button
              type="button"
              onClick={fetchOverview}
              style={{ width:42, borderRadius:6, border:'1px solid rgba(201,168,76,0.28)', background:'rgba(0,0,0,0.22)', color:'var(--gold-dim)', cursor:'pointer' }}
              title="更新"
            >↻</button>
          </div>

          {overviewLoading && <div style={{ textAlign:'center', padding:36, color:'var(--cream-dim)' }}>読み込み中...</div>}
          {!overviewLoading && overviewError && <div style={{ textAlign:'center', padding:24, color:'#ffaaaa', border:'1px solid rgba(180,40,40,0.35)', borderRadius:8, background:'rgba(80,0,0,0.18)' }}>{overviewError}</div>}

          {!overviewLoading && !overviewError && selectTab === 'table' && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:12 }}>
              {overview.tables.map((table) => (
                <div key={table.tableId} style={{ border:'1px solid rgba(201,168,76,0.28)', borderRadius:8, overflow:'hidden', background:'rgba(0,0,0,0.18)' }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'9px 12px', background:'rgba(0,0,0,0.24)', borderBottom:'1px solid rgba(201,168,76,0.15)' }}>
                    <span style={{ fontFamily:'var(--font-title)', color:'var(--gold)' }}>Table {table.tableNo ?? overview.tables.indexOf(table) + 1}</span>
                    <span style={{ color:'var(--cream-dim)', fontSize:12 }}>{table.players.length}人</span>
                  </div>
                  <div style={{ padding:'6px 0' }}>
                    {[...table.players].sort((a,b) => b.chips - a.chips).map((p) => (
                      <div key={`${table.tableId}-${p.name}`} style={{ display:'flex', justifyContent:'space-between', padding:'6px 12px', color:p.sittingOut?'rgba(255,255,255,0.38)':'var(--cream)' }}>
                        <span>{p.name}{p.sittingOut ? ' (待機)' : ''}</span>
                        <span style={{ fontFamily:'var(--font-title)', color:'#9bea9b' }}>{p.chips.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding:'10px 12px 12px' }}>
                    <button type="button" onClick={() => startSpectating(table.tableId)} style={{ width:'100%', padding:'9px 12px', borderRadius:6, border:'1px solid var(--gold-dim)', background:'rgba(201,168,76,0.18)', color:'var(--gold-bright)', fontFamily:'var(--font-title)', cursor:'pointer' }}>観戦する</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!overviewLoading && !overviewError && selectTab === 'player' && (
            <div>
              <input
                value={playerQuery}
                onChange={(e) => setPlayerQuery(e.target.value)}
                placeholder="プレイヤー名で検索"
                style={{ width:'100%', boxSizing:'border-box', marginBottom:10, padding:'10px 12px', borderRadius:6, border:'1px solid rgba(201,168,76,0.28)', background:'rgba(0,0,0,0.22)', color:'var(--cream)' }}
              />
              <div style={{ border:'1px solid rgba(201,168,76,0.24)', borderRadius:8, overflow:'hidden', background:'rgba(0,0,0,0.18)' }}>
                {playerRows.map(({ table, player }) => (
                  <button
                    key={`${table.tableId}-${player.name}`}
                    type="button"
                    onClick={() => startSpectating(table.tableId)}
                    style={{ width:'100%', display:'grid', gridTemplateColumns:'1fr 90px 100px', gap:8, alignItems:'center', padding:'9px 12px', border:0, borderTop:'1px solid rgba(255,255,255,0.06)', background:'transparent', color:'var(--cream)', cursor:'pointer', textAlign:'left' }}
                  >
                    <span>{player.name}{player.sittingOut ? ' (待機)' : ''}</span>
                    <span style={{ color:'var(--gold-dim)' }}>Table {table.tableNo ?? overview.tables.indexOf(table) + 1}</span>
                    <span style={{ fontFamily:'var(--font-title)', color:'#9bea9b', textAlign:'right' }}>{player.chips.toLocaleString()}</span>
                  </button>
                ))}
                {playerRows.length === 0 && <div style={{ padding:24, textAlign:'center', color:'var(--cream-dim)' }}>該当するプレイヤーがいません</div>}
              </div>
            </div>
          )}
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
      onBackToTables={backToTableSelect}
      onLeave={leaveSpectate}
    />
  );
}
