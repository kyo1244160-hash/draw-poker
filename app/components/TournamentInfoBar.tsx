'use client';
// app/components/TournamentInfoBar.tsx — リングゲームと統一されたデザイン

import { useEffect, useState } from 'react';
import type { BlindUpdate, TournamentStatus } from '../types/tournament';

interface Props {
  blind: BlindUpdate | null;
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

function fmt(s: number) {
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

export default function TournamentInfoBar({ blind, status, tournamentName }: Props) {
  const countdown = useCountdown(blind?.secondsToNextLevel ?? 0, !blind?.isLastLevel);
  if (!blind && !status) return null;
  const urgency = countdown < 60 && !blind?.isLastLevel;

  return (
    <div style={{ display:'flex', flexWrap:'wrap' as const, alignItems:'center', justifyContent:'center', gap:'8px 20px' }}>
      {/* レベル・ブラインド */}
      {blind && (
        <span style={{
          fontFamily:'var(--font-title)', fontSize:12,
          background:'rgba(201,168,76,0.12)', border:'1px solid var(--gold-dim)',
          borderRadius:4, padding:'2px 10px', color:'var(--cream)',
        }}>
          Lv.{blind.level}&nbsp;
          <span style={{ color:'#88ee88' }}>{blind.sb}/{blind.bb}</span>
        </span>
      )}
      {/* 残りプレイヤー */}
      {status && (
        <span style={{ fontFamily:'var(--font-body)', color:'var(--cream-dim)', fontSize:13 }}>
          残り&nbsp;<span style={{ color:'var(--gold)', fontWeight:700 }}>{status.remainingPlayers}</span>/{status.totalPlayers}人
          &nbsp;·&nbsp;平均&nbsp;<span style={{ color:'var(--gold)' }}>{status.averageStack.toLocaleString()}</span>
        </span>
      )}
      {/* 次レベルまで */}
      {blind && !blind.isLastLevel && (
        <span style={{ fontFamily:'var(--font-title)', fontSize:12, color: urgency ? '#ff6666' : 'var(--cream-dim)' }}>
          次レベル&nbsp;<span style={{ color: urgency ? '#ff6666' : 'var(--gold-bright)', fontWeight:700 }}>{fmt(countdown)}</span>
        </span>
      )}
      {blind?.isLastLevel && (
        <span style={{ fontFamily:'var(--font-title)', fontSize:12, color:'var(--gold)', fontWeight:700 }}>最終レベル</span>
      )}
    </div>
  );
}
