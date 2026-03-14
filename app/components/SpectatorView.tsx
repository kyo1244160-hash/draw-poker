'use client';
// app/components/SpectatorView.tsx
// 観戦ビュー（手札非公開・全プレイヤーの状況を表示）

import TournamentTable from './TournamentTable';
import TournamentInfoBar from './TournamentInfoBar';
import type { PlayerState, GameMeta, BlindUpdate, TournamentStatus } from '../types/tournament';

interface Props {
  players: PlayerState[];
  meta: GameMeta | null;
  blind: BlindUpdate | null;
  status: TournamentStatus | null;
  tournamentName?: string;
  timer: { remaining: number; limit: number } | null;
}

export default function SpectatorView({
  players, meta, blind, status, tournamentName, timer,
}: Props) {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      <TournamentInfoBar blind={blind} status={status} tournamentName={tournamentName} />

      <div className="flex-1 p-4 max-w-3xl mx-auto w-full">
        {/* 観戦バッジ */}
        <div className="flex items-center gap-2 mb-4">
          <span className="bg-purple-900 border border-purple-600 text-purple-300 text-xs px-3 py-1 rounded-full font-semibold">
            👁 観戦モード
          </span>
          <span className="text-gray-500 text-xs">手札は非公開です</span>
        </div>

        <TournamentTable
          players={players}
          meta={meta}
          timer={timer}
          isSpectator
          onBetAction={() => {}}
          onDrawCards={() => {}}
          onUpdateSelected={() => {}}
        />

        {/* 全プレイヤースタック一覧 */}
        {players.length > 0 && (
          <div className="mt-4 bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-700 text-xs text-gray-400 font-semibold">
              スタック状況
            </div>
            <div className="divide-y divide-gray-800">
              {[...players]
                .sort((a, b) => b.chips - a.chips)
                .map(p => (
                  <div key={p.id} className="flex items-center gap-3 px-4 py-2">
                    <span className="flex-1 text-sm text-white truncate">{p.name}</span>
                    {p.disconnected && <span className="text-red-400 text-xs">切断中</span>}
                    {p.folded && <span className="text-gray-600 text-xs">フォールド</span>}
                    <span className="text-yellow-400 font-mono text-sm">
                      {p.chips.toLocaleString()}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
