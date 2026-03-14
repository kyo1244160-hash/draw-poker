'use client';
// app/tournament/[id]/result/page.tsx
// トーナメント結果ページ

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface RankEntry {
  accountId: string;
  nickname?: string;
  rank: number;
  chips?: number;
  points?: number;
}

const POINT_TABLE: Record<number, number> = {
  1: 100, 2: 60, 3: 40, 4: 25, 5: 15,
};

const MEDAL: Record<number, string> = { 1: '🏆', 2: '🥈', 3: '🥉' };

export default function TournamentResultPage() {
  const params = useParams() as { id: string };
  const router = useRouter();
  const [rankings, setRankings]   = useState<RankEntry[]>([]);
  const [loading,  setLoading]    = useState(true);
  const [error,    setError]      = useState<string | null>(null);
  const [myRank,   setMyRank]     = useState<RankEntry | null>(null);

  useEffect(() => {
    fetch(`/api/tournament/${params.id}/entry`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        setRankings(data.rankings ?? []);
        setMyRank(data.myEntry ?? null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.id]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <div className="animate-spin text-4xl mb-4">🃏</div>
          <p className="text-gray-400">結果を読み込み中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <p className="text-red-400 mb-4">結果の取得に失敗しました</p>
          <Link href="/tournament" className="text-blue-400 hover:underline">
            トーナメント一覧へ
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white py-8 px-4">
      <div className="max-w-lg mx-auto">
        {/* ヘッダー */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-yellow-400 mb-1">🎴 トーナメント結果</h1>
          <p className="text-gray-400 text-sm">Tournament #{params.id.slice(0, 8)}</p>
        </div>

        {/* 自分の成績 */}
        {myRank && (
          <div className={[
            'rounded-xl p-5 mb-6 border text-center',
            myRank.rank <= 3
              ? 'border-yellow-500 bg-yellow-900/20'
              : 'border-gray-600 bg-gray-800/60',
          ].join(' ')}>
            <p className="text-gray-400 text-xs mb-1">あなたの結果</p>
            <div className="text-4xl mb-1">{MEDAL[myRank.rank] ?? '🃏'}</div>
            <p className="text-2xl font-bold">{myRank.rank}位</p>
            {(POINT_TABLE[myRank.rank] ?? 0) > 0 && (
              <p className="text-yellow-400 font-semibold mt-2">
                +{POINT_TABLE[myRank.rank]} pt 獲得
              </p>
            )}
          </div>
        )}

        {/* 全体順位表 */}
        <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700">
            <h2 className="font-semibold text-gray-300">最終順位</h2>
          </div>
          <div className="divide-y divide-gray-800">
            {rankings.length === 0 && (
              <p className="text-gray-500 text-sm text-center py-6">順位データなし</p>
            )}
            {rankings.map(entry => {
              const pts = POINT_TABLE[entry.rank] ?? 0;
              const isSelf = entry.accountId === myRank?.accountId;
              return (
                <div
                  key={entry.accountId}
                  className={[
                    'flex items-center gap-4 px-4 py-3',
                    isSelf ? 'bg-blue-900/20' : '',
                  ].join(' ')}
                >
                  {/* 順位 */}
                  <div className="w-10 text-center font-bold">
                    {MEDAL[entry.rank]
                      ? <span className="text-xl">{MEDAL[entry.rank]}</span>
                      : <span className="text-gray-400">{entry.rank}</span>
                    }
                  </div>
                  {/* 名前 */}
                  <div className="flex-1">
                    <span className={isSelf ? 'text-blue-300 font-semibold' : 'text-white'}>
                      {entry.nickname ?? entry.accountId.slice(0, 8)}
                    </span>
                    {isSelf && <span className="ml-2 text-xs text-blue-400">(あなた)</span>}
                  </div>
                  {/* ポイント */}
                  <div className={`text-sm font-mono ${pts > 0 ? 'text-yellow-400' : 'text-gray-600'}`}>
                    {pts > 0 ? `+${pts} pt` : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* フッターボタン */}
        <div className="flex gap-3 mt-6">
          <Link
            href="/tournament"
            className="flex-1 py-3 text-center bg-gray-800 hover:bg-gray-700 rounded-lg text-sm font-medium transition-colors"
          >
            トーナメント一覧
          </Link>
          <Link
            href="/"
            className="flex-1 py-3 text-center bg-blue-800 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
          >
            ロビーへ
          </Link>
        </div>
      </div>
    </div>
  );
}
