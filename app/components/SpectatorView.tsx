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
  onBackToTables?: () => void;
  onLeave?: () => void;
  spectatorAnchorPlayerName?: string | null;
}

export default function SpectatorView({
  players, meta, blind, status, tournamentName, timer, onBackToTables, onLeave, spectatorAnchorPlayerName,
}: Props) {
  const modeLabelMap: Record<string, string> = {
    '27': '2-7 Triple Draw', badugi: 'Badugi', mix: 'Mix (2-7↔Badugi)',
    a5: 'A-5 Triple Draw', '27sd': '2-7 Single Draw', mix3: 'Mix-3',
    'beast+': 'BEAST+', stud_mix: 'Stud Mix',
    horse: 'HORSE', fl_holdem: "Fixed Limit Hold'em", fl_omaha8: 'Omaha Hi-Lo',
    stud_s: '7 Card Stud', stud_e: 'Stud Hi/Lo', razz: 'Razz',
  };
  const modeColorMap: Record<string, string> = {
    stud_s: '#50c0d0', stud_e: '#50a0d0', razz: '#70b080',
    badugi: '#cc9966', '27': '#88bbee', a5: '#88dd88',
    mix: '#aa88dd', mix3: '#aa88dd', '27sd': '#dd88aa',
    'beast+': '#e0b050', stud_mix: '#50c0d0',
    horse: '#d0b85a', fl_holdem: '#5fb8c8', fl_omaha8: '#70b080',
  };
  const modeLabel = meta?.currentMode ? modeLabelMap[meta.currentMode] ?? meta.currentMode : '';
  const modeColor = meta?.currentMode ? modeColorMap[meta.currentMode] ?? '#88bbee' : '#88bbee';

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
          <TournamentInfoBar
            blind={blind}
            status={status}
            tournamentName={tournamentName}
            showBbAnte={!!meta?.isNL && meta?.currentMode === '27sd'}
          />
        </div>
        {/* 観戦バッジ */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{
            background: 'rgba(80,20,120,0.6)', border: '1px solid rgba(150,60,220,0.5)',
            color: '#c088ff', fontSize: 10, padding: '2px 10px', borderRadius: 12,
            fontFamily: 'var(--font-title)', letterSpacing: '0.04em',
            whiteSpace: 'nowrap' as const,
          }}>
            👁 観戦中
          </span>
          {onBackToTables && (
            <button
              onClick={onBackToTables}
              style={{
                background: 'rgba(201,168,76,0.18)', border: '1px solid rgba(201,168,76,0.45)',
                color: 'var(--gold-bright)', fontSize: 10, padding: '2px 7px', borderRadius: 4,
                cursor: 'pointer', fontFamily: 'var(--font-title)', whiteSpace: 'nowrap' as const,
              }}
            >
              テーブル選択
            </button>
          )}
          {onLeave && (
            <button
              onClick={onLeave}
              style={{
                background: 'rgba(139,26,26,0.55)', border: '1px solid rgba(204,34,34,0.4)',
                color: '#ffaaaa', fontSize: 10, padding: '2px 7px', borderRadius: 4,
                cursor: 'pointer', fontFamily: 'var(--font-title)', whiteSpace: 'nowrap' as const,
              }}
            >
              ロビーへ
            </button>
          )}
        </div>
      </nav>

      {/* ゲームモードバー — プレイ画面と同じ高さ計算に揃える */}
      {meta?.currentMode && meta.phase !== 'waiting' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '2px 8px', flexShrink: 0,
          background: 'rgba(0,0,0,0.30)',
          borderBottom: `1px solid ${modeColor}44`,
          gap: 6,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: modeColor, flexShrink: 0, boxShadow: `0 0 4px ${modeColor}` }} />
          <span style={{ fontFamily: 'var(--font-title)', fontSize: 10, color: modeColor, letterSpacing: '0.1em', fontWeight: 700 }}>
            {modeLabel}
          </span>
        </div>
      )}

      {/* ゲームテーブル — draw ページと完全同一の flex:1 全画面レイアウト */}
      <div style={{ flex: 1, display: 'flex', overflow: 'visible', minHeight: 0, paddingTop: 16, boxSizing: 'border-box' }}>
        <TournamentTable
          players={players}
          meta={meta}
          timer={timer}
          isSpectator
          spectatorAnchorPlayerName={spectatorAnchorPlayerName}
          blind={blind}
          onBetAction={() => {}}
          onDrawCards={() => {}}
          onUpdateSelected={() => {}}
        />
      </div>
    </div>
  );
}
