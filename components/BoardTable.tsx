'use client';

import React, { useMemo } from 'react';
import type { BlindUpdate, GameMeta, PlayerState } from '../app/types/tournament';
import { MODE_COLOR, MODE_LABEL_FULL } from '../lib/modeLabels';

interface Props {
  players: PlayerState[];
  meta: GameMeta | null;
  timer: { remaining: number; limit: number } | null;
  isSpectator: boolean;
  onBetAction: (action: 'fold' | 'check' | 'call' | 'bet' | 'raise') => void;
  blind: BlindUpdate | null;
  tournamentId: string;
}

const CARD_W = 44;
const CARD_H = 62;

function Card({ code }: { code: string }) {
  const hidden = !code || code === '??';
  const suit = hidden ? '' : code.slice(-1);
  const rank = hidden ? '' : code.slice(0, -1);
  const red = suit === 'H' || suit === 'D';
  return (
    <div style={{
      width: CARD_W,
      height: CARD_H,
      borderRadius: 7,
      border: hidden ? '1px solid rgba(201,168,76,0.35)' : '1px solid rgba(255,255,255,0.28)',
      background: hidden ? 'linear-gradient(145deg,#2b1f10,#0d0b08)' : 'linear-gradient(145deg,#fffaf0,#d9cfb5)',
      color: hidden ? 'rgba(201,168,76,0.6)' : red ? '#a32626' : '#171717',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      fontFamily: 'var(--font-title)',
      fontSize: hidden ? 18 : 18,
      boxShadow: '0 8px 18px rgba(0,0,0,0.28)',
      flex: '0 0 auto',
    }}>
      {hidden ? '◆' : (
        <>
          <span>{rank}</span>
          <span style={{ fontSize: 14 }}>{suitSymbol(suit)}</span>
        </>
      )}
    </div>
  );
}

function suitSymbol(suit: string) {
  if (suit === 'S') return '♠';
  if (suit === 'H') return '♥';
  if (suit === 'D') return '♦';
  if (suit === 'C') return '♣';
  return suit;
}

const STREET_LABEL: Record<string, string> = {
  preflop: 'PREFLOP',
  flop: 'FLOP',
  turn: 'TURN',
  river: 'RIVER',
  showdown: 'SHOWDOWN',
  waiting: 'WAITING',
};

export default function BoardTable({ players, meta, timer, isSpectator, onBetAction, blind }: Props) {
  const self = players.find((p) => p.isSelf);
  const current = players.find((p) => p.isMyTurn);
  const board = meta?.board ?? [];
  const mode = meta?.currentMode ?? 'fl_holdem';
  const modeColor = MODE_COLOR[mode] ?? '#5fb8c8';
  const toCall = self?.toCall ?? 0;
  const canAct = !!self?.isMyTurn && !isSpectator && !self?.folded && !self?.sittingOut;
  const betLabel = toCall > 0 ? `Call ${toCall}` : 'Check';
  const raiseLabel = (meta?.currentBet ?? 0) > 0 ? `Raise +${meta?.betSize ?? 0}` : `Bet ${meta?.betSize ?? 0}`;
  const seats = useMemo(() => players.filter((p) => !p.isPendingPlayer), [players]);

  return (
    <div style={{
      width: '100%',
      minHeight: 0,
      padding: '12px clamp(10px,2vw,22px) 18px',
      display: 'grid',
      gridTemplateRows: 'auto 1fr auto',
      gap: 12,
      color: 'var(--cream)',
      fontFamily: 'var(--font-body)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-title)', fontSize: 12, color: modeColor, letterSpacing: 0 }}>
            {MODE_LABEL_FULL[mode] ?? mode}
          </div>
          <div style={{ fontSize: 12, color: 'var(--cream-dim)' }}>
            {STREET_LABEL[meta?.phase ?? 'waiting'] ?? meta?.phase} / Pot {meta?.pot ?? 0}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: 'var(--cream-dim)' }}>
          <span>SB {blind?.sb ?? meta?.smallBlind ?? '-'}</span>
          <span>BB {blind?.bb ?? meta?.bigBlind ?? '-'}</span>
          <span>{meta?.raiseCount ?? 0}/{meta?.maxRaises ?? 0}</span>
          {timer && <span>{Math.ceil(timer.remaining)}s</span>}
        </div>
      </div>

      <div style={{
        minHeight: 0,
        border: '1px solid rgba(201,168,76,0.18)',
        borderRadius: 8,
        background: 'radial-gradient(circle at center, rgba(24,92,70,0.72), rgba(9,28,24,0.96))',
        display: 'grid',
        gridTemplateRows: '1fr auto 1fr',
        gap: 12,
        padding: 'clamp(12px,2vw,24px)',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {seats.filter((p) => !p.isSelf).map((p) => (
            <div key={p.id} style={{
              minWidth: 118,
              maxWidth: 154,
              padding: '8px 10px',
              borderRadius: 8,
              border: p.isMyTurn ? `1px solid ${modeColor}` : '1px solid rgba(255,255,255,0.12)',
              background: p.folded ? 'rgba(40,40,40,0.62)' : 'rgba(0,0,0,0.34)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <span>{p.chips}</span>
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--cream-dim)' }}>
                {p.folded ? 'Fold' : p.bet > 0 ? `Bet ${p.bet}` : p.isMyTurn ? 'Turn' : ''}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, minHeight: CARD_H }}>
          {Array.from({ length: 5 }, (_, i) => <Card key={i} code={board[i] ?? '??'} />)}
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{
            minWidth: 260,
            maxWidth: 520,
            width: 'min(100%, 520px)',
            padding: 12,
            borderRadius: 8,
            border: canAct ? `1px solid ${modeColor}` : '1px solid rgba(255,255,255,0.16)',
            background: 'rgba(0,0,0,0.48)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontFamily: 'var(--font-title)' }}>{self?.name ?? (isSpectator ? 'Spectator' : '')}</div>
                <div style={{ fontSize: 12, color: 'var(--cream-dim)' }}>{self ? `${self.chips} chips` : current ? `${current.name} action` : ''}</div>
              </div>
              {self?.result && <div style={{ fontSize: 12, color: modeColor, textAlign: 'right' }}>{self.result}</div>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 12, minHeight: CARD_H }}>
              {(self?.hand?.length ? self.hand : ['??', '??']).map((c, i) => <Card key={`${c}-${i}`} code={c} />)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
              {toCall > 0 && <button disabled={!canAct} onClick={() => onBetAction('fold')} style={btn(false)}>Fold</button>}
              <button disabled={!canAct} onClick={() => onBetAction(toCall > 0 ? 'call' : 'check')} style={btn(false)}>{betLabel}</button>
              {self?.canRaise && <button disabled={!canAct} onClick={() => onBetAction((meta?.currentBet ?? 0) > 0 ? 'raise' : 'bet')} style={btn(true)}>{raiseLabel}</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    height: 38,
    borderRadius: 7,
    border: primary ? '1px solid var(--gold)' : '1px solid rgba(255,255,255,0.22)',
    background: primary ? 'rgba(160,120,10,0.34)' : 'rgba(255,255,255,0.08)',
    color: 'var(--cream)',
    fontFamily: 'var(--font-title)',
    fontSize: 12,
    cursor: 'pointer',
  };
}
