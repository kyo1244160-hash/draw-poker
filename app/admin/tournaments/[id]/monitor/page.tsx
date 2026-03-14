'use client';
// app/admin/tournaments/[id]/monitor/page.tsx
// 管理者: トーナメントリアルタイム監視ページ

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface TableSnap {
  tableId: string;
  phase: string;
  pot: number;
  handCount: number;
  blinds: { sb: number; bb: number };
  players: {
    id: string; name: string; chips: number; bet: number;
    folded: boolean; sittingOut: boolean; disconnected: boolean;
    timeoutCount: number; isDealer: boolean;
  }[];
}

interface TournamentDetail {
  id: string;
  name: string;
  mode: string;
  status: string;
  totalPlayers: number;
  remainingPlayers: number;
  startingChips: number;
  blind: {
    level: number; sb: number; bb: number;
    isLastLevel: boolean; secondsToNextLevel: number;
    nextSb: number | null; nextBb: number | null;
  };
  eliminationOrder: string[];
  tables: TableSnap[];
}

const PHASE_LABELS: Record<string, string> = {
  waiting:'待機',bet0:'BET0',draw1:'DRAW1',bet1:'BET1',
  draw2:'DRAW2',bet2:'BET2',draw3:'DRAW3',bet3:'BET3',showdown:'SHOW',
};

function fmt(s: number) {
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

async function fetchWithToken(url: string, opts?: RequestInit) {
  const tokenRes = await fetch('/api/auth/socket-token');
  const { token } = await tokenRes.json();
  return fetch(url, {
    ...opts,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  });
}

export default function AdminMonitorPage() {
  const rawParams = useParams();
  const params    = rawParams as { id: string } | null;
  const tournamentId = params?.id ?? '';
  const [data,    setData]    = useState<TournamentDetail | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [kicking, setKicking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchWithToken(`/api/admin/monitor/tournaments/${tournamentId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  async function kickPlayer(tableId: string, playerId: string, name: string) {
    if (!confirm(`${name} をトーナメントから強制退場しますか？`)) return;
    setKicking(playerId);
    try {
      await fetchWithToken(`/api/admin/monitor/tables/${tableId}/kickPlayer`, {
        method: 'POST',
        body: JSON.stringify({ playerId }),
      });
      await refresh();
    } finally {
      setKicking(null);
    }
  }

  async function forceFinish() {
    if (!confirm('トーナメントを強制終了しますか？')) return;
    await fetchWithToken(`/api/admin/monitor/tournaments/${tournamentId}/forceFinish`, { method: 'POST' });
    await refresh();
  }

  if (loading) return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
      <div className="animate-spin text-3xl">🃏</div>
    </div>
  );

  if (error || !data) return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-red-400">
      エラー: {error ?? 'データなし'}
    </div>
  );

  const b = data.blind;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-4">
      <div className="max-w-5xl mx-auto">
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2">
              <Link href="/admin/tournaments" className="text-gray-500 hover:text-white text-sm">← 管理</Link>
              <span className="text-gray-700">/</span>
              <h1 className="text-xl font-bold text-white">{data.name}</h1>
              <span className={`text-xs px-2 py-0.5 rounded border ${
                data.status === 'running' ? 'text-yellow-400 border-yellow-700 bg-yellow-900/30'
                : 'text-gray-400 border-gray-700'
              }`}>{data.status}</span>
            </div>
            <p className="text-gray-500 text-xs mt-0.5">5秒ごとに自動更新 · ID: {data.id}</p>
          </div>
          {data.status === 'running' && (
            <button
              onClick={forceFinish}
              className="px-3 py-1.5 bg-red-800 hover:bg-red-700 text-red-200 text-sm rounded border border-red-700"
            >
              強制終了
            </button>
          )}
        </div>

        {/* 概要カード */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            { label: '残り', value: `${data.remainingPlayers} / ${data.totalPlayers}人` },
            { label: 'テーブル', value: `${data.tables.length}卓` },
            { label: 'Lv.', value: `${b.level}  ${b.sb}/${b.bb}` },
            { label: '次レベル', value: b.isLastLevel ? '最終' : fmt(b.secondsToNextLevel) },
          ].map(c => (
            <div key={c.label} className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3">
              <p className="text-gray-500 text-xs mb-1">{c.label}</p>
              <p className="text-white font-bold font-mono">{c.value}</p>
            </div>
          ))}
        </div>

        {/* テーブル一覧 */}
        <div className="flex flex-col gap-4">
          {data.tables.map(table => (
            <div key={table.tableId} className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
              {/* テーブルヘッダー */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-gray-800/50">
                <div className="flex items-center gap-3 text-sm">
                  <span className="font-mono text-gray-400 text-xs">{table.tableId}</span>
                  <span className="bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded font-mono">
                    {PHASE_LABELS[table.phase] ?? table.phase}
                  </span>
                  <span className="text-gray-500 text-xs">
                    POT: <span className="text-yellow-400">{table.pot.toLocaleString()}</span>
                  </span>
                  <span className="text-gray-500 text-xs">Hand #{table.handCount}</span>
                </div>
                <span className="text-xs text-gray-500">
                  SB/BB: {table.blinds.sb}/{table.blinds.bb}
                </span>
              </div>

              {/* プレイヤー行 */}
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-gray-800">
                    <th className="px-4 py-1.5 text-left font-normal">名前</th>
                    <th className="px-3 py-1.5 text-right font-normal">チップ</th>
                    <th className="px-3 py-1.5 text-right font-normal">ベット</th>
                    <th className="px-3 py-1.5 text-center font-normal">状態</th>
                    <th className="px-3 py-1.5 text-center font-normal">TO</th>
                    <th className="px-3 py-1.5 text-center font-normal"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {table.players.map(p => (
                    <tr key={p.id} className={p.disconnected ? 'bg-red-950/20' : ''}>
                      <td className="px-4 py-2">
                        <span className="text-white">{p.name}</span>
                        {p.isDealer && <span className="ml-1 text-[10px] bg-gray-600 px-1 rounded">D</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-yellow-400">{p.chips.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono text-green-400">
                        {p.bet > 0 ? p.bet.toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2 text-center text-xs">
                        {p.disconnected && <span className="text-red-400">切断</span>}
                        {p.folded && !p.disconnected && <span className="text-gray-500">fold</span>}
                        {p.sittingOut && <span className="text-gray-600">待機</span>}
                        {!p.disconnected && !p.folded && !p.sittingOut && <span className="text-green-400">●</span>}
                      </td>
                      <td className="px-3 py-2 text-center font-mono text-xs text-gray-400">
                        {p.timeoutCount > 0
                          ? <span className={p.timeoutCount >= 2 ? 'text-red-400' : 'text-yellow-400'}>{p.timeoutCount}/3</span>
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => kickPlayer(table.tableId, p.id, p.name)}
                          disabled={kicking === p.id}
                          className="text-xs text-red-500 hover:text-red-300 disabled:opacity-40"
                        >
                          {kicking === p.id ? '...' : 'kick'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* 脱落順 */}
        {data.eliminationOrder.length > 0 && (
          <div className="mt-6 bg-gray-900 border border-gray-700 rounded-xl p-4">
            <h3 className="text-xs text-gray-500 font-semibold mb-2">脱落順（早い順）</h3>
            <div className="flex flex-wrap gap-2">
              {data.eliminationOrder.map((id, i) => (
                <span key={id} className="text-xs bg-gray-800 border border-gray-700 px-2 py-1 rounded text-gray-400">
                  {i + 1}. {id.slice(0, 12)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
