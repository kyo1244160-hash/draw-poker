'use client';
// app/components/TournamentInfoBar.tsx
// ナビバー用コンパクト1行表示

import { useEffect, useState } from 'react';
import type { BlindUpdate, TournamentStatus } from '../types/tournament';

interface Props {
  blind:  BlindUpdate | null;
  status: TournamentStatus | null;
  tournamentName?: string;
}

function useCountdown(seconds: number, running: boolean) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    setRemaining(seconds);
    if (!running || seconds <= 0) return;
    const iv = setInterval(() => {
      setRemaining(prev => { if (prev <= 1) { clearInterval(iv); return 0; } return prev - 1; });
    }, 1000);
    return () => clearInterval(iv);
  }, [seconds, running]);
  return remaining;
}

/** ブラインドアップ待機中のカウントアップタイマー */
function useElapsed() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const iv = setInterval(() => setElapsed(prev => prev + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  return elapsed;
}

/** pendingLevelUp中のカウントアップタイマーコンポーネント */
function PendingLevelUpTimer() {
  const elapsed = useElapsed();
  return (
    <span style={{ fontFamily: 'var(--font-title)', fontSize: 11, color: '#ffcc44', fontWeight: 700, animation: 'pulse 1s infinite' }}>
      ⬆ 次ハンドでブラインドアップ &nbsp;
      <span style={{ color: '#ffee99', fontWeight: 400 }}>+{fmt(elapsed)}</span>
    </span>
  );
}

function fmt(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function LateRegCountdown({ seconds }: { seconds: number }) {
  const remaining = useCountdown(seconds, seconds > 0);
  return <>遅延参加 {fmt(remaining)}まで</>;
}

// バッジの共通スタイル
const badge = (bg: string, border: string, color: string): React.CSSProperties => ({
  fontFamily: 'var(--font-title)',
  fontSize: 10,
  fontWeight: 700,
  background: bg,
  border: `1px solid ${border}`,
  borderRadius: 4,
  padding: '1px 5px',
  color,
  whiteSpace: 'nowrap' as const,
  flexShrink: 0,
});

export default function TournamentInfoBar({ blind, status }: Props) {
  const isBreak  = blind?.isBreak ?? false;
  // pendingLevelUp: サーバーフラグ優先、フォールバックとして secondsToNextLevel===0 を使用
  const pendingLevelUp = blind?.pendingLevelUp === true
    || ((blind?.secondsToNextLevel ?? 0) === 0 && !blind?.isLastLevel && !isBreak);
  const cdRunning = isBreak || (!blind?.isLastLevel && (blind?.secondsToNextLevel ?? 0) > 0);
  const countdown = useCountdown(blind?.secondsToNextLevel ?? 0, cdRunning);
  const urgency   = !isBreak && countdown < 60 && !blind?.isLastLevel && countdown > 0;

  if (!blind && !status) return null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      flexWrap: 'nowrap', overflow: 'hidden', minWidth: 0, width: '100%',
    }}>

      {/* ブレイク中 */}
      {isBreak ? (
        <>
          <span style={badge('rgba(80,40,160,0.3)', 'rgba(160,100,255,0.5)', '#cc99ff')}>
            ☕ {blind?.breakLabel ?? 'Break'}
          </span>
          {countdown > 0 && (
            <span style={{ fontFamily: 'var(--font-title)', fontSize: 11, color: '#ffdd88', flexShrink: 0 }}>
              {fmt(countdown)}
            </span>
          )}
        </>
      ) : (
        <>
          {/* レベル */}
          {blind && (
            <span style={badge('rgba(201,168,76,0.15)', 'var(--gold-dim)', 'var(--cream)')}>
              Lv{blind.level}&nbsp;
              <span style={{ color: '#88ee88' }}>{blind.sb}/{blind.bb}</span>
            </span>
          )}

          {/* タイマー */}
          {/* pendingLevelUp中: タイマーが0になり次のハンドでブラインドアップ */}
          {pendingLevelUp && !isBreak && (
            <PendingLevelUpTimer />
          )}
          {blind && !blind.isLastLevel && !pendingLevelUp && (
            <span style={{
              fontFamily: 'var(--font-title)', fontSize: 11, flexShrink: 0,
              color: urgency ? '#ff6666' : 'var(--gold-bright)', fontWeight: 700,
            }}>
              {fmt(countdown)}
            </span>
          )}

          {/* 次レベル */}
          {blind?.nextSb && !blind.isLastLevel && !pendingLevelUp && (
            <span style={{ fontFamily: 'var(--font-title)', fontSize: 10, color: 'var(--cream-dim)', flexShrink: 0 }}>
              次&nbsp;<span style={{ color: '#aaddff' }}>{blind.nextSb}/{blind.nextBb}</span>
            </span>
          )}

          {/* 最終レベル */}
          {blind?.isLastLevel && (
            <span style={badge('rgba(201,168,76,0.15)', 'var(--gold)', 'var(--gold)')}>FINAL</span>
          )}
        </>
      )}

      {/* 残り人数・平均スタック */}
      {status && (
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, color: 'var(--cream-dim)', flexShrink: 0 }}>
          <span style={{ color: 'var(--gold)', fontWeight: 700 }}>{status.remainingPlayers}</span>/{status.totalPlayers}人
          &nbsp;avg&nbsp;<span style={{ color: 'var(--gold)' }}>{status.averageStack.toLocaleString()}</span>
        </span>
      )}

      {/* Final Table */}
      {status?.isFinalTable && (
        <span style={badge('rgba(240,208,96,0.2)', 'var(--gold)', 'var(--gold-bright)')}>🏆FT</span>
      )}

      {/* レイトレジスト */}
      {blind?.lateRegOpen && (
        <span style={badge('rgba(30,160,80,0.2)', 'rgba(60,200,100,0.5)', '#88ee88')}>
          {/* time-based: 残り時間カウントダウン / level-based: レベル表示 */}
          {(blind.lateRegSecondsRemaining != null)
            ? <LateRegCountdown seconds={blind.lateRegSecondsRemaining} />
            : (blind.lateRegLevelCutoff ?? 0) > 0
              ? `遅延参加 Lv${blind.lateRegLevelCutoff}まで`
              : 'レイトレジスト受付中'}
        </span>
      )}
    </div>
  );
}
