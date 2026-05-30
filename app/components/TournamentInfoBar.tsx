'use client';
// app/components/TournamentInfoBar.tsx
// ナビバー用コンパクト1行表示

import { useEffect, useRef, useState } from 'react';
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

/** pendingLevelUp中のカウントアップタイマー＋マーキー表示 */
function PendingLevelUpTimer() {
  const elapsed = useElapsed();
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [scrollStyle, setScrollStyle] = useState<React.CSSProperties>({});

  // マーキーが必要か判定して animation を設定
  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const outerW = outer.offsetWidth;
    const innerW = inner.scrollWidth;

    if (innerW <= outerW) {
      // 収まる → スクロール不要
      setScrollStyle({});
      return;
    }

    // スクロール距離 = テキスト幅（親の右端まで流れた後、完全に消えるまで）
    // duration = テキスト幅 ÷ 35px/秒（読みやすい速度）
    const dist = innerW;
    const duration = Math.round((dist / 35) * 10) / 10; // 小数1桁

    setScrollStyle({
      '--marquee-dist': `-${dist}px`,
      animation: `marqueeScroll ${duration}s linear infinite`,
      // 1.5秒の停止後にスクロール開始（読む時間を確保）
      animationDelay: '1.5s',
      willChange: 'transform',
    } as React.CSSProperties);
  }, [elapsed]); // elapsed変化ごとに再計測（テキスト幅が変わるため）

  return (
    <div
      ref={outerRef}
      style={{
        overflow: 'hidden',
        flex: 1,
        minWidth: 0,
        // グラデーションで右端をフェードアウト（スクロール中の切れ目を自然に見せる）
        maskImage: 'linear-gradient(to right, black 80%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to right, black 80%, transparent 100%)',
      }}
    >
      <span
        ref={innerRef}
        style={{
          display: 'inline-block',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-title)',
          fontSize: 11,
          color: '#ffcc44',
          fontWeight: 700,
          ...scrollStyle,
        }}
      >
        ⬆ 次ハンドでブラインドアップ &nbsp;
        <span style={{ color: '#ffee99', fontWeight: 400 }}>+{fmt(elapsed)}</span>
        &emsp;&emsp;{/* スクロール折り返しの間隔 */}
      </span>
    </div>
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
  const cdRunning = isBreak || (!blind?.isLastLevel && (blind?.secondsToNextLevel ?? 0) > 0);
  const countdown = useCountdown(blind?.secondsToNextLevel ?? 0, cdRunning);
  // ローカルカウントダウンが 0 になった場合も pendingLevelUp 扱い（"0:00" で止まるのを防ぐ）
  const pendingLevelUp = blind?.pendingLevelUp === true
    || ((blind?.secondsToNextLevel ?? 0) === 0 && !blind?.isLastLevel && !isBreak)
    || (countdown === 0 && !blind?.isLastLevel && !isBreak && (blind?.secondsToNextLevel ?? 0) > 0);
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
