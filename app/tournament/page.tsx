'use client';
// app/tournament/page.tsx
// トーナメント一覧ページ

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { TournamentInfo } from '../types/tournament';

const MODE_LABEL: Record<string, string> = {
  '27': '2-7 ロウボール',
  badugi: 'バドゥギ',
  mix: 'ミックス',
};

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  registering: { label: '参加受付中', color: 'text-green-400 bg-green-900/40 border-green-700' },
  running:     { label: '進行中',     color: 'text-yellow-400 bg-yellow-900/40 border-yellow-700' },
  finished:    { label: '終了',       color: 'text-gray-400 bg-gray-800 border-gray-700' },
  cancelled:   { label: 'キャンセル', color: 'text-red-400 bg-red-900/40 border-red-700' },
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  });
}

export default function TournamentListPage() {
  const [tournaments, setTournaments] = useState<TournamentInfo[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/tournaments')
      .then(r => r.json())
      .then(d => setTournaments(d.tournaments ?? []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-white py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-yellow-400">🏆 トーナメント</h1>
            <p className="text-gray-400 text-sm mt-0.5">参加・観戦・結果を確認できます</p>
          </div>
          <Link
            href="/"
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            ← ロビー
          </Link>
        </div>

        {/* ローディング */}
        {loading && (
          <div className="text-center py-16 text-gray-500">
            <div className="animate-spin text-3xl mb-3">🃏</div>
            読み込み中...
          </div>
        )}

        {/* エラー */}
        {error && (
          <div className="text-center py-8 text-red-400">
            取得に失敗しました: {error}
          </div>
        )}

        {/* 一覧 */}
        {!loading && !error && (
          <div className="flex flex-col gap-3">
            {tournaments.length === 0 && (
              <div className="text-center py-16 text-gray-600">
                <p className="text-4xl mb-3">🎴</p>
                <p>現在トーナメントはありません</p>
              </div>
            )}
            {tournaments.map(t => {
              const st = STATUS_LABEL[t.status] ?? STATUS_LABEL.finished;
              return (
                <div
                  key={t.id}
                  className="bg-gray-900 border border-gray-700 rounded-xl p-4 hover:border-gray-500 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    {/* 左: 名前・モード */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="font-semibold text-white truncate">{t.name}</h2>
                        <span className={`text-xs border rounded px-2 py-0.5 ${st.color}`}>
                          {st.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-400 flex-wrap">
                        <span>{MODE_LABEL[t.mode] ?? t.mode}</span>
                        <span>開始: {formatDate(t.scheduled_start_at)}</span>
                        <span>
                          参加: {t.entry_count}
                          {t.max_players ? `/${t.max_players}` : ''}人
                        </span>
                        <span>初期チップ: {t.starting_chips.toLocaleString()}</span>
                      </div>
                    </div>

                    {/* 右: アクションボタン */}
                    <div className="flex flex-col gap-1.5 shrink-0">
                      {t.status === 'registering' && (
                        <Link
                          href={`/tournament/${t.id}`}
                          className="px-3 py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs font-semibold rounded transition-colors text-center"
                        >
                          詳細・参加
                        </Link>
                      )}
                      {t.status === 'running' && (
                        <Link
                          href={`/tournament/${t.id}/draw`}
                          className="px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 text-white text-xs font-semibold rounded transition-colors text-center"
                        >
                          ゲームへ
                        </Link>
                      )}
                      {t.status === 'finished' && (
                        <Link
                          href={`/tournament/${t.id}/result`}
                          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-semibold rounded transition-colors text-center"
                        >
                          結果
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
