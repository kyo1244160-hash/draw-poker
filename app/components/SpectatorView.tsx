'use client';
// app/components/SpectatorView.tsx
// 観戦ビュー（draw/page.tsx と同じ全画面レイアウトを使用）

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
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column' as const,
      overflow: 'hidden', background: 'var(--felt)',
      color: 'var(--cream)', fontFamily: 'var(--font-body)',
    }}>
      {/* ナビバー — draw ページと同じ高さ・構造 */}
      <nav style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '3px 8px', borderBottom: '1px solid var(--gold-dim)',
        background: 'rgba(0,0,0,0.25)', flexShrink: 0, gap: 6,
        height: 32, minHeight: 32, maxHeight: 32, overflow: 'hidden',
      }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
          <TournamentInfoBar blind={blind} status={status} tournamentName={tournamentName} />
        </div>
        {/* 観戦バッジ */}
        <span style={{
          background: 'rgba(80,20,120,0.6)', border: '1px solid rgba(150,60,220,0.5)',
          color: '#c088ff', fontSize: 10, padding: '2px 10px', borderRadius: 12,
          fontFamily: 'var(--font-title)', letterSpacing: '0.04em', flexShrink: 0,
          whiteSpace: 'nowrap' as const,
        }}>
          👁 観戦中
        </span>
      </nav>

      {/* ゲームテーブル — draw ページと完全同一の flex:1 全画面レイアウト */}
      <div style={{ flex: 1, display: 'flex', overflow: 'visible', minHeight: 0, paddingTop: 28 }}>
        <TournamentTable
          players={players}
          meta={meta}
          timer={timer}
          isSpectator
          blind={blind}
          onBetAction={() => {}}
          onDrawCards={() => {}}
          onUpdateSelected={() => {}}
        />
      </div>
    </div>
  );
}
