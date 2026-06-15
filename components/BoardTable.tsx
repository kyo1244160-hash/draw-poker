'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { socket } from '../socket';
import type { BlindUpdate, GameMeta, PlayerState } from '../app/types/tournament';
import { MODE_COLOR, MODE_LABEL_FULL } from '../lib/modeLabels';

interface Props {
  players: PlayerState[];
  meta: GameMeta | null;
  timer: { remaining: number; limit: number } | null;
  isSpectator: boolean;
  onBetAction: (action: string, amount?: number) => void;
  blind: BlindUpdate | null;
  tournamentId: string;
}

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLOR: Record<string, string> = { S: '#1a1a2e', H: '#cc1111', D: '#1155cc', C: '#228833' };
const RANK_LABEL: Record<string, string> = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
const SIZE = {
  xs: { w: 26, h: 38, rank: 11, suit: 10 },
  sm: { w: 32, h: 48, rank: 11, suit: 12 },
  sm2: { w: 40, h: 60, rank: 14, suit: 22 },
  md: { w: 52, h: 76, rank: 17, suit: 34 },
  lg: { w: 66, h: 96, rank: 21, suit: 46 },
};

function Card({ code, size = 'md', folded = false }: { code: string; size?: keyof typeof SIZE; folded?: boolean }) {
  const dim = SIZE[size];
  const suit = code && code !== '??' && code.length >= 2 ? code.slice(-1) : null;
  const rank = code && code !== '??' && code.length >= 2 ? code.slice(0, -1) : null;
  const isBack = !rank || !suit || !SUIT_SYMBOL[suit];
  const color = !isBack ? SUIT_COLOR[suit] : '#fff';
  return (
    <div style={{
      position: 'relative',
      width: dim.w,
      height: dim.h,
      flexShrink: 0,
      borderRadius: 5,
      background: isBack
        ? 'linear-gradient(135deg,#1a4a8a 0%,#0d2d5c 50%,#1a4a8a 100%)'
        : '#fffdf6',
      border: '1.5px solid rgba(0,0,0,0.22)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
      opacity: folded ? 0.38 : 1,
      userSelect: 'none',
    }}>
      {isBack ? (
        <div style={{ position: 'absolute', inset: 4, borderRadius: 3, border: '1.5px solid rgba(255,255,255,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: dim.rank * 1.3, color: 'rgba(255,255,255,0.3)', lineHeight: 1 }}>♦</span>
        </div>
      ) : (size === 'xs' || size === 'sm') ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          <span style={{ fontSize: dim.rank, fontWeight: 900, color, fontFamily: 'Georgia,"Times New Roman",serif', lineHeight: 1 }}>
            {RANK_LABEL[rank] ?? rank}
          </span>
          <span style={{ fontSize: dim.suit * 1.35, color, lineHeight: 1 }}>{SUIT_SYMBOL[suit]}</span>
        </div>
      ) : (
        <>
          <div style={{ position: 'absolute', top: 3, left: 5, lineHeight: 1 }}>
            <span style={{ fontSize: dim.rank, fontWeight: 900, color, fontFamily: 'Georgia,"Times New Roman",serif', lineHeight: 1 }}>
              {RANK_LABEL[rank] ?? rank}
            </span>
          </div>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: dim.suit, color, lineHeight: 1 }}>{SUIT_SYMBOL[suit]}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Badge({ bg, color, label }: { bg: string; color: string; label: string }) {
  return <span style={{ fontSize: 9, fontFamily: 'var(--font-title)', padding: '1px 5px', borderRadius: 3, background: bg, color, flexShrink: 0 }}>{label}</span>;
}

function TimerBar({ remaining, limit }: { remaining: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (remaining / limit) * 100) : 0;
  const color = pct > 50 ? '#22c55e' : pct > 25 ? '#eab308' : '#ef4444';
  return <div style={{ width: '100%', height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, margin: '2px 0' }}>
    <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.5s linear' }} />
  </div>;
}

const STREET_LABEL: Record<string, string> = {
  waiting: '待機中',
  preflop: 'BET (PRE-FLOP)',
  flop: 'FLOP',
  turn: 'TURN',
  river: 'RIVER',
  showdown: 'SHOWDOWN',
};
const ACTION_LABEL: Record<string, string> = {
  fold: 'フォールド',
  check: 'チェック',
  call: 'コール',
  bet: 'ベット',
  raise: 'レイズ',
};
const ACTION_COLOR: Record<string, string> = {
  フォールド: 'rgba(139,26,26,0.92)',
  チェック: 'rgba(30,100,60,0.92)',
  コール: 'rgba(30,80,160,0.92)',
  ベット: 'rgba(160,120,10,0.92)',
  レイズ: 'rgba(160,60,10,0.92)',
};

function fmtBlind(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function BoardTable({ players, meta, timer, isSpectator, onBetAction, blind }: Props) {
  const [layout, setLayout] = useState<'pc' | 'portrait' | 'landscape' | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [actionFlash, setActionFlash] = useState<Record<string, { label: string; key: number }>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const flashTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const prevIsMyTurnRef = useRef<boolean>(false);

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w >= 768) setLayout('pc');
      else setLayout(w < h ? 'portrait' : 'landscape');
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ w: rect.width || w, h: rect.height || Math.max(200, h - 44) });
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    const ro = new ResizeObserver(update);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      ro.disconnect();
    };
  }, []);

  const self = players.find((p) => p.isSelf) ?? null;
  const phase = meta?.phase ?? 'waiting';
  const isBetPhase = ['preflop', 'flop', 'turn', 'river'].includes(phase);
  const isMyTurn = !!self?.isMyTurn;
  const mode = meta?.currentMode ?? 'fl_holdem';
  const modeColor = MODE_COLOR[mode] ?? '#5fb8c8';
  const board = meta?.board ?? [];
  const raiseCount = meta?.raiseCount ?? 0;
  const blindCountdown = blind?.secondsToNextLevel ?? 0;
  const activeTimer = {
    remaining: timer?.remaining ?? meta?.timerRemaining ?? 0,
    limit: timer?.limit ?? meta?.timerLimit ?? 0,
  };
  const orderedOthers = useMemo(() => {
    const seated = players.filter((p) => !p.isPendingPlayer);
    const selfIdx = seated.findIndex((p) => p.isSelf);
    if (selfIdx < 0) return seated.filter((p) => !p.isSelf);
    const result: PlayerState[] = [];
    for (let i = 1; i < seated.length; i++) {
      const p = seated[(selfIdx + i) % seated.length];
      if (!p.isSelf) result.push(p);
    }
    return result;
  }, [players]);

  useEffect(() => {
    const onAction = ({ playerName, action, amount, totalBet }: { playerName: string; action: string; amount?: number; totalBet?: number }) => {
      if (!playerName) return;
      const base = ACTION_LABEL[action] ?? action;
      let label = base;
      if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
        if (action === 'raise') label = `${base} +${amount}`;
        else if (action === 'bet' || action === 'call') label = `${base} ${amount}`;
      } else if ((action === 'bet' || action === 'raise') && typeof totalBet === 'number' && Number.isFinite(totalBet) && totalBet > 0) {
        label = action === 'raise' ? `${base} ${totalBet}` : `${base} ${totalBet}`;
      }
      setActionFlash((prev) => ({ ...prev, [playerName]: { label, key: Date.now() } }));
      const t = setTimeout(() => {
        setActionFlash((prev) => {
          const next = { ...prev };
          delete next[playerName];
          return next;
        });
      }, 2000);
      flashTimersRef.current.push(t);
    };
    const onGameStarted = () => setActionFlash({});
    socket.on('playerAction', onAction);
    socket.on('gameStarted', onGameStarted);
    return () => {
      socket.off('playerAction', onAction);
      socket.off('gameStarted', onGameStarted);
      flashTimersRef.current.forEach(clearTimeout);
      flashTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    const AudioContextClass = window.AudioContext
      || (window as unknown as Record<string, unknown>).webkitAudioContext as typeof AudioContext;
    if (!AudioContextClass) return;
    audioCtxRef.current = new AudioContextClass();
    const resume = () => {
      if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
    };
    window.addEventListener('pointerdown', resume);
    return () => {
      window.removeEventListener('pointerdown', resume);
      try { audioCtxRef.current?.close().catch(() => {}); } catch { /* noop */ }
      audioCtxRef.current = null;
    };
  }, []);

  useEffect(() => {
    const wasMyTurn = prevIsMyTurnRef.current;
    prevIsMyTurnRef.current = isMyTurn;
    if (!wasMyTurn && isMyTurn && audioCtxRef.current) {
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') return;
      const freq = 1000;
      const dur = 0.07;
      const gap = 0.12;
      for (let i = 0; i < 3; i++) {
        const t0 = ctx.currentTime + i * gap;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.4, t0);
        gain.gain.linearRampToValueAtTime(0, t0 + dur);
        osc.start(t0);
        osc.stop(t0 + dur);
      }
    }
  }, [isMyTurn]);

  if (layout === null) {
    return <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gold)', fontFamily: 'var(--font-title)' }}>読み込み中...</div>;
  }

  const btnStyle = (v: 'gold' | 'gray' | 'red' | 'outline', compact = false): React.CSSProperties => ({
    padding: compact ? '6px 8px' : '10px 16px',
    border: 'none',
    borderRadius: 7,
    width: '100%',
    height: compact ? 40 : 48,
    minHeight: compact ? 40 : 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: compact ? 13 : 15,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'var(--font-title)',
    letterSpacing: '0.04em',
    lineHeight: 1.08,
    textAlign: 'center',
    whiteSpace: 'normal',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    ...(v === 'gold' ? { background: 'linear-gradient(135deg,var(--gold),var(--gold-dim))', color: '#1a1200', boxShadow: '0 2px 10px rgba(201,168,76,0.4)' } : {}),
    ...(v === 'gray' ? { background: 'rgba(255,255,255,0.12)', color: 'var(--cream)', border: '1px solid rgba(255,255,255,0.25)' } : {}),
    ...(v === 'red' ? { background: '#8b1a1a', color: '#ffd0d0' } : {}),
    ...(v === 'outline' ? { background: 'rgba(255,255,255,0.06)', color: 'var(--cream-dim)', border: '1px solid var(--gold-dim)' } : {}),
  });

  const logActionHit = (label: string, e: React.MouseEvent<HTMLButtonElement>, amount?: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    console.info('[action-hit][board]', {
      label,
      amount,
      phase,
      currentBet: meta?.currentBet ?? 0,
      isMyTurn,
      self: self?.name,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  };

  const ActionPanel = ({ compact = false }: { compact?: boolean }) => {
    const toCall = self?.toCall ?? 0;
    if (self?.isPendingPlayer) return <Info compact={compact}>次のハンドから参加します...</Info>;
    if (isSpectator) return <Info compact={compact}>観戦中</Info>;
    if (self?.isAway) return <Info compact={compact}>離席中</Info>;
    if (phase === 'waiting') return <Info compact={compact}>{players.length < 2 ? 'もう1人参加を待っています' : 'ゲームを準備中...'}</Info>;
    if (isBetPhase && isMyTurn && !self?.folded) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 8 }}>
          <div style={{
            fontFamily: 'var(--font-body)',
            fontSize: compact ? 9 : 14,
            color: compact ? 'var(--gold-dim)' : 'var(--cream-dim)',
            textAlign: 'center',
            lineHeight: compact ? 1.25 : 1.5,
            marginBottom: compact ? -1 : 0,
          }}>
            {toCall > 0 ? `コール: ${toCall}` : 'チェック or ベット'}
            <span style={{ display: 'block', fontSize: compact ? 9 : 11, opacity: compact ? 0.85 : 0.72 }}>
              単位:{self?.betSize ?? meta?.betSize ?? 0} Bet {raiseCount}/{meta?.maxRaises ?? 5}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: compact ? 'row' : 'column', gap: compact ? 6 : 8 }}>
            {toCall > 0 && <button style={{ ...btnStyle('red', compact), flex: compact ? 1 : undefined }} onClick={(e) => { logActionHit('fold', e); onBetAction('fold'); }}>フォールド</button>}
            <button style={{ ...btnStyle('gray', compact), flex: compact ? 1 : undefined }} onClick={(e) => { const action = toCall > 0 ? 'call' : 'check'; logActionHit(action, e, toCall); onBetAction(action); }}>
              {toCall > 0 ? (compact ? `コール(${toCall})` : `コール (${toCall})`) : 'チェック'}
            </button>
            {self?.canRaise && (
              <button style={{ ...btnStyle('gold', compact), flex: compact ? 1 : undefined }} onClick={(e) => { const action = (meta?.currentBet ?? 0) === 0 ? 'bet' : 'raise'; logActionHit(action, e, self?.betSize ?? meta?.betSize ?? 0); onBetAction(action); }}>
                {(meta?.currentBet ?? 0) === 0
                  ? (compact ? `BET+${self?.betSize ?? meta?.betSize ?? 0}` : `ベット (+${self?.betSize ?? meta?.betSize ?? 0})`)
                  : (compact ? `RAISE+${self?.betSize ?? meta?.betSize ?? 0}` : `レイズ (+${self?.betSize ?? meta?.betSize ?? 0})`)}
              </button>
            )}
          </div>
        </div>
      );
    }
    if (isBetPhase) {
      const cur = players.find((p) => p.isMyTurn && !p.isSelf);
      return <Info compact={compact}>{cur ? `${cur.name} がアクション中...` : '待機中...'}</Info>;
    }
    if (phase === 'showdown') return <Info compact={compact}>次のゲームを準備中...</Info>;
    return null;
  };

  const renderPlayer = (p: PlayerState, size: { w: number; h: number }, cardSize: keyof typeof SIZE, active: boolean) => {
    const flash = actionFlash[p.name];
    const flashColor = flash
      ? Object.entries(ACTION_COLOR).find(([label]) => flash.label.startsWith(label))?.[1] ?? 'rgba(160,60,10,0.92)'
      : 'rgba(160,60,10,0.92)';
    return (
    <div style={{
      position: 'relative',
      width: size.w,
      minHeight: size.h,
      textAlign: 'center',
      padding: p.isSelf ? '4px 4px 6px' : '3px 2px',
      borderRadius: 7,
      border: active ? '1.5px solid var(--gold)' : p.isWinner ? '3px solid var(--gold-bright)' : '1px solid rgba(201,168,76,0.2)',
      boxShadow: active ? '0 0 10px rgba(201,168,76,0.5)' : p.isWinner ? '0 0 30px rgba(240,208,96,0.85)' : 'none',
      background: p.isSelf ? 'rgba(10,50,30,0.85)' : active ? 'rgba(201,168,76,0.07)' : 'rgba(0,0,0,0.4)',
      opacity: p.folded && !p.sittingOut ? 0.42 : p.sittingOut ? 0.55 : 1,
      overflow: 'visible',
    }}>
      {flash && (
        <div key={flash.key} style={{
          position: 'absolute',
          top: -38,
          left: p.isDealer ? 'calc(50% + 22px)' : '50%',
          transform: 'translateX(-50%)',
          background: flashColor,
          color: '#fff',
          fontFamily: 'var(--font-title)',
          fontSize: 13,
          fontWeight: 700,
          padding: '4px 14px',
          borderRadius: 20,
          whiteSpace: 'nowrap',
          boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          pointerEvents: 'none',
          zIndex: 20,
          animation: 'actionPop 2s ease-out forwards',
        }}>{flash.label}</div>
      )}
      <div style={{ display: 'flex', gap: 2, justifyContent: 'center', marginBottom: 2, flexWrap: 'wrap' }}>
        {p.isDealer && <Badge bg="#c9a84c" color="#1a1200" label="BTN" />}
        {p.isSB && <Badge bg="#2244aa" color="#fff" label="SB" />}
        {p.isBB && <Badge bg="#b85a10" color="#fff" label="BB" />}
        {p.isAway && <Badge bg="#7a4b12" color="#ffe0a0" label="離席中" />}
        {p.folded && !p.sittingOut && <Badge bg="#444" color="#aaa" label="FOLD" />}
        {p.isWinner && <Badge bg="#f0d060" color="#1a1200" label="WIN" />}
      </div>
      <div style={{ fontFamily: 'var(--font-title)', fontSize: p.isSelf ? 12 : 11, color: p.isSelf ? 'var(--gold-bright)' : 'var(--cream)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: 0 }}>
        {p.isSelf ? `${p.name} (YOU)` : p.name}
      </div>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: p.isSelf ? 18 : 16, color: '#88dd88', lineHeight: 1.1, marginTop: 2 }}>
        💵 {p.chips}
        {p.bet > 0 && <span style={{ marginLeft: 8, padding: '2px 7px', borderRadius: 3, background: 'rgba(201,168,76,0.15)', color: 'var(--gold)', fontFamily: 'var(--font-title)' }}>BET {p.bet}</span>}
      </div>
      {active && activeTimer.limit > 0 && <TimerBar remaining={activeTimer.remaining} limit={activeTimer.limit} />}
      <HoleCards cards={p.hand ?? []} cardSize={cardSize} folded={p.folded} playerId={p.id} isSelf={p.isSelf} />
      {p.result && (
        <div style={{ fontSize: 12, color: p.isWinner ? 'var(--gold-bright)' : 'var(--cream-dim)', fontFamily: 'var(--font-title)', lineHeight: 1.15 }}>
          {p.result}
        </div>
      )}
    </div>
    );
  };

  const HoleCards = ({ cards, cardSize, folded, playerId, isSelf }: { cards: string[]; cardSize: keyof typeof SIZE; folded: boolean; playerId: string; isSelf: boolean }) => {
    const tight = cards.length >= 4;
    const gap = tight ? 2 : 6;
    const rowWidth = cards.length > 0
      ? SIZE[cardSize].w * cards.length + gap * Math.max(0, cards.length - 1)
      : 0;
    return (
      <div style={{
        display: 'flex',
        gap,
        justifyContent: 'center',
        alignItems: 'center',
        flexWrap: 'nowrap',
        width: rowWidth || undefined,
        maxWidth: '100%',
        margin: tight ? '4px auto 2px' : '8px auto 2px',
        overflow: 'visible',
      }}>
        {cards.map((code, i) => <Card key={`${playerId}-${i}`} code={code} size={cardSize} folded={folded} />)}
      </div>
    );
  };

  if (layout === 'pc') {
    const actionW = 280;
    const tw = Math.min(1100, Math.max(600, window.innerWidth - 300));
    const th = Math.min(760, Math.max(460, window.innerHeight - 100));
    const cx = tw / 2;
    const cy = th / 2 - 10;
    const rx = tw * 0.35;
    const ry = th * 0.34;
    const boxW = Math.max(175, Math.floor(tw * 0.21));
    const otherSlots = [150, -150, -90, -30, 30];
    const getPos = (p: PlayerState) => {
      const idx = orderedOthers.findIndex((o) => o.id === p.id);
      const ang = p.isSelf ? 90 : (otherSlots[idx] ?? (-90 + 60 * (idx + 1)));
      const rad = (ang * Math.PI) / 180;
      const bh = p.isSelf ? Math.floor(th * 0.31) : Math.floor(th * 0.25);
      return { left: cx + rx * Math.cos(rad) - boxW / 2, top: cy + ry * Math.sin(rad) - bh / 2, h: bh };
    };

    return (
      <div ref={containerRef} style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%', maxWidth: tw + actionW + 48, padding: '0 16px', flex: 1, minHeight: 0 }}>
        <div style={{ position: 'relative', width: tw, height: th, flexShrink: 0 }}>
          <Felt tw={tw} th={th} />
          <CenterInfo meta={meta} board={board} mode={mode} modeColor={modeColor} blind={blind} blindCountdown={blindCountdown} />
          {players.map((p) => {
            const pos = getPos(p);
            const hasFlash = !!actionFlash[p.name];
            return (
            <div key={p.id} style={{ position: 'absolute', left: pos.left, top: pos.top, zIndex: hasFlash ? 30 : p.isSelf ? 3 : 2 }}>
              {renderPlayer(p, { w: boxW, h: pos.h }, p.isSelf ? ((p.hand?.length ?? 0) > 2 ? 'sm2' : 'md') : 'sm', !!p.isMyTurn && !p.isAway)}
              </div>
            );
          })}
          <DealerButton players={players} getPos={getPos} cx={cx} cy={cy} boxW={boxW} />
        </div>

        <div style={{
          width: actionW,
          flexShrink: 0,
          background: 'linear-gradient(160deg,rgba(22,92,56,0.5),rgba(10,51,32,0.7))',
          border: '1px solid var(--gold-dim)',
          borderRadius: 12,
          padding: '20px 18px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 12,
          minHeight: 280,
          marginLeft: 10,
        }}>
          {self && (
            <div style={{ textAlign: 'center', paddingBottom: 10, borderBottom: '1px solid rgba(201,168,76,0.2)' }}>
              <div style={{ fontFamily: 'var(--font-title)', color: 'var(--gold-bright)', fontSize: 12, marginBottom: 3 }}>{`${self.name} (YOU)`}</div>
              <div style={{ color: '#88dd88', fontSize: 20 }}>{`💵 ${self.chips}`}</div>
              {self?.result && <div style={{ marginTop: 3, color: 'var(--cream-dim)', fontFamily: 'var(--font-title)', fontSize: 14 }}>{self.result}</div>}
            </div>
          )}
          <ActionPanel />
        </div>
      </div>
    );
  }

  const portrait = layout === 'portrait';
  const vw = window.innerWidth;
  const availH = containerSize.h > 0 ? containerSize.h : Math.max(200, window.innerHeight - 44);
  const actW = 148;
  const actH = 112;
  const tw = portrait ? Math.max(200, vw - 8) : Math.max(360, vw - actW - 4);
  const th = portrait ? Math.max(260, availH - actH - 4) : Math.max(240, availH - 4);
  const cx = tw / 2;
  const cy = portrait ? th * 0.43 : th / 2;
  const rx = portrait ? tw * 0.32 : tw * 0.44;
  const ry = portrait ? th * 0.31 : th * 0.40;
  const otherW = portrait ? Math.min(tw - 16, Math.max(Math.floor(tw * 0.40), 152)) : 132;
  const selfW = portrait ? Math.min(Math.floor(tw * 0.64), tw - 16) : 132;
  const slots = portrait ? [180, -150, -90, -30, 0] : [150, -150, -90, -30, 30];
  const getPosMobile = (p: PlayerState) => {
    const boxW = p.isSelf ? selfW : otherW;
    const boxH = p.isSelf ? (portrait ? Math.max(128, Math.floor(th * 0.22)) : 132) : (portrait ? Math.floor(th * 0.19) : 112);
    if (!p.isSelf && portrait && self) {
      const idx = orderedOthers.findIndex((o) => o.id === p.id);
      const selfTop = th - boxH - 4;
      const outerBleed = Math.min(12, Math.max(6, tw * 0.03));
      const slotTop = [
        th * 0.48,
        th * 0.16,
        th * 0.00,
        th * 0.16,
        th * 0.48,
      ][idx] ?? th * 0.30;
      const slotLeft = [
        -outerBleed,
        -outerBleed,
        tw * 0.50 - boxW / 2,
        tw - boxW + outerBleed,
        tw - boxW + outerBleed,
      ][idx] ?? (tw * 0.50 - boxW / 2);
      return {
        left: Math.max(-outerBleed, Math.min(tw - boxW + outerBleed, slotLeft)),
        top: Math.max(4, Math.min(selfTop - 82, slotTop)),
        h: boxH,
        w: boxW,
      };
    }
    const idx = orderedOthers.findIndex((o) => o.id === p.id);
    const ang = p.isSelf ? 90 : (slots[idx] ?? 0);
    const rad = (ang * Math.PI) / 180;
    if (p.isSelf && portrait) {
      return {
        left: Math.max(4, Math.min(tw - boxW - 4, cx - boxW / 2)),
        top: Math.max(4, th - boxH - 4),
        h: boxH,
        w: boxW,
      };
    }
    return {
      left: Math.max(4, Math.min(tw - boxW - 4, cx + rx * Math.cos(rad) - boxW / 2)),
      top: Math.max(4, Math.min(th - boxH - 4, cy + ry * Math.sin(rad) - boxH / 2)),
      h: boxH,
      w: boxW,
    };
  };

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: portrait ? 'column' : 'row', width: '100%', height: '100%', overflow: 'visible' }}>
      <div style={{ position: 'relative', width: tw, height: th, margin: portrait ? '0 auto' : 0, flexShrink: 0 }}>
        <Felt tw={tw} th={th} mobile />
        <CenterInfo meta={meta} board={board} mode={mode} modeColor={modeColor} blind={blind} blindCountdown={blindCountdown} mobile={portrait} />
        {players.map((p) => {
          const pos = getPosMobile(p);
          const hasFlash = !!actionFlash[p.name];
          return (
            <div key={p.id} style={{ position: 'absolute', left: pos.left, top: pos.top, zIndex: hasFlash ? 30 : p.isSelf ? 3 : 2 }}>
              {renderPlayer(
                p,
                { w: pos.w, h: pos.h },
                p.isSelf ? (portrait ? 'sm' : ((p.hand?.length ?? 0) > 2 ? 'xs' : 'sm')) : 'xs',
                !!p.isMyTurn && !p.isAway
              )}
            </div>
          );
        })}
      </div>
      <div style={{
        flex: 1,
        minWidth: portrait ? undefined : actW,
        minHeight: portrait ? 0 : undefined,
        padding: portrait ? '6px 8px 8px' : '14px 12px',
        borderTop: portrait ? '1px solid rgba(201,168,76,0.2)' : undefined,
        borderLeft: portrait ? undefined : '1px solid rgba(201,168,76,0.2)',
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: portrait ? 'flex-start' : 'center',
        overflow: 'hidden',
      }}>
        <ActionPanel compact />
      </div>
    </div>
  );
}

function Info({ children, compact }: { children: React.ReactNode; compact?: boolean }) {
  return <div style={{ fontFamily: 'var(--font-body)', fontSize: compact ? 12 : 14, color: 'var(--cream-dim)', fontStyle: 'italic', textAlign: 'center', padding: '8px 0', lineHeight: 1.4 }}>{children}</div>;
}

function Felt({ tw, th, mobile = false }: { tw: number; th: number; mobile?: boolean }) {
  return (
    <>
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: mobile ? '72%' : '70%', height: mobile ? '70%' : '62%', borderRadius: '50%', background: 'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)', border: `${mobile ? 5 : 8}px solid var(--gold-dim)`, boxShadow: '0 0 40px rgba(0,0,0,0.8),inset 0 0 30px rgba(0,0,0,0.4)', zIndex: 0 }} />
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: mobile ? 'calc(72% - 16px)' : 'calc(70% - 20px)', height: mobile ? 'calc(70% - 16px)' : 'calc(62% - 20px)', borderRadius: '50%', border: '1px solid rgba(201,168,76,0.25)', zIndex: 0 }} />
    </>
  );
}

function CenterInfo({ meta, board, mode, modeColor, blind, blindCountdown, mobile = false }: { meta: GameMeta | null; board: string[]; mode: string; modeColor: string; blind: BlindUpdate | null; blindCountdown: number; mobile?: boolean }) {
  const phase = meta?.phase ?? 'waiting';
  const isBetPhase = ['preflop', 'flop', 'turn', 'river'].includes(phase);
  const cardSize = mobile ? 'sm' : 'md';
  const visibleBoard = board.filter((code) => code && code !== '??');
  return (
    <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', zIndex: 1, pointerEvents: 'none', textAlign: 'center' }}>
      {visibleBoard.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: mobile ? 4 : 8, marginBottom: mobile ? 8 : 12 }}>
          {visibleBoard.map((code, i) => <Card key={`${code}-${i}`} code={code} size={cardSize as keyof typeof SIZE} />)}
        </div>
      )}
      <div style={{ fontFamily: 'var(--font-title)', fontSize: mobile ? 9 : 10, color: modeColor, letterSpacing: '0.1em', opacity: 0.9 }}>
        {MODE_LABEL_FULL[mode] ?? mode}
      </div>
      <div style={{ fontFamily: 'var(--font-title)', fontSize: mobile ? 14 : 20, letterSpacing: '0.15em', lineHeight: 1.1, color: isBetPhase ? 'var(--gold-bright)' : 'var(--cream-dim)', textShadow: '0 0 12px rgba(0,0,0,0.9)' }}>
        {STREET_LABEL[phase] ?? phase}
      </div>
      {(meta?.pot ?? 0) > 0 && <div style={{ fontSize: mobile ? 14 : 17, color: '#f0d060', fontWeight: 700, fontFamily: 'var(--font-title)', marginTop: 4 }}>🏦 {meta?.pot}</div>}
      {isBetPhase && (meta?.currentBet ?? 0) > 0 && <div style={{ fontSize: mobile ? 10 : 12, color: '#ffcc44', marginTop: 2, fontFamily: 'var(--font-body)' }}>BET {meta?.currentBet}</div>}
      {isBetPhase && <div style={{ fontSize: mobile ? 8 : 9, color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-body)' }}>Bet {meta?.raiseCount ?? 0}/{meta?.maxRaises ?? 5}</div>}
      {blind && <div style={{ fontSize: mobile ? 9 : 10, color: '#88ee88', marginTop: 3, fontFamily: 'var(--font-title)' }}>Lv.{blind.level} {blind.sb}/{blind.bb}</div>}
      {blind && !blind.isLastLevel && blindCountdown > 0 && <div style={{ fontSize: mobile ? 9 : 10, fontFamily: 'var(--font-title)', color: blindCountdown < 60 ? '#ff6666' : 'rgba(255,255,255,0.5)', marginTop: 1 }}>⏱ {fmtBlind(blindCountdown)}</div>}
    </div>
  );
}

function DealerButton({ players, getPos, cx, cy, boxW }: { players: PlayerState[]; getPos: (p: PlayerState) => { left: number; top: number; h: number }; cx: number; cy: number; boxW: number }) {
  const dealer = players.find((p) => p.isDealer);
  if (!dealer) return null;
  const pos = getPos(dealer);
  const dcx = pos.left + boxW / 2;
  const dcy = pos.top + pos.h / 2;
  const dx = dcx - cx;
  const dy = dcy - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const scale = dist > 0 ? Math.max(0, (dist - 100)) / dist : 0;
  return <div style={{ position: 'absolute', left: cx + dx * scale - 14, top: cy + dy * scale - 14, width: 28, height: 28, borderRadius: '50%', background: '#fff', border: '2px solid #444', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-title)', fontSize: 11, fontWeight: 900, color: '#1a1a1a', boxShadow: '0 2px 6px rgba(0,0,0,0.7)', zIndex: 5, pointerEvents: 'none' }}>D</div>;
}
