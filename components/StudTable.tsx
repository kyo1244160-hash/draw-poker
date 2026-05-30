'use client';
/**
 * StudTable.tsx — 7カードスタッド系専用テーブル（BEAST+ / stud_mix）
 *
 * 修正内容（v3）:
 *   3. actionFlash を TournamentTable と同じ日本語ラベルに統一
 *   4. check も playerAction で通知（studBotManager 側も修正済み）
 *   5. ボタンスタイルを TournamentTable の btnStyle と統一
 *   6. 自分のカード: sm(32px)×7枚 / SELF_W = TW×0.70 で横1段収容
 *   7. 他プレイヤーカード: overflow:'visible' で見切れ解消
 *   8. PCレイアウト: TournamentTable の PC版と同構造
 */

import React, { useEffect, useRef, useState } from 'react';
import { socket } from '../socket';
import type { PlayerState, GameMeta, BlindUpdate } from '../app/types/tournament';
import { MODE_LABEL_FULL, MODE_COLOR } from '../lib/modeLabels';
import TableListModal from './TableListModal';

// ==========================================================
// ■ Card（TournamentTable 内蔵 Card と同じ実装）
// ==========================================================
const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLOR:  Record<string, string> = { S: '#1a1a2e', H: '#cc1111', D: '#1155cc', C: '#228833' };
const RANK_LABEL:  Record<string, string> = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
const SIZE_PRESET = {
  xs:  { w: 26, h: 38, fontSize: 11, suitSize: 8,  suitMult: 1.2 },
  sm:  { w: 32, h: 48, fontSize: 11, suitSize: 9,  suitMult: 1.3 },
  sm2: { w: 40, h: 60, fontSize: 14, suitSize: 12, suitMult: 1.8 },
  md:  { w: 52, h: 76, fontSize: 17, suitSize: 15, suitMult: 2.5 },
  lg:  { w: 66, h: 96, fontSize: 21, suitSize: 19, suitMult: 2.5 },
} as const;
type CardSize = 'xs' | 'sm' | 'sm2' | 'md' | 'lg';

function Card({
  code, size = 'md', selected = false, clickable = false,
  folded = false, isDown = false, onClick,
}: {
  code: string; size?: CardSize; selected?: boolean; clickable?: boolean;
  folded?: boolean; isDown?: boolean; onClick?: () => void;
}) {
  const dim    = SIZE_PRESET[size];
  const suit   = code && code !== '??' && code.length >= 2 ? code.slice(-1)   : null;
  const rank   = code && code !== '??' && code.length >= 2 ? code.slice(0, -1): null;
  const isBack = !rank || !suit || !SUIT_SYMBOL[suit];
  const color  = !isBack ? SUIT_COLOR[suit!] : '#fff';
  const symbol = !isBack ? SUIT_SYMBOL[suit!] : '';
  const rl     = !isBack ? (RANK_LABEL[rank!] ?? rank!) : '';

  const border = selected
    ? '2.5px solid #e84040'
    : isDown && !isBack
      ? '2px dashed #c9a84c'
      : '1.5px solid rgba(0,0,0,0.22)';

  return (
    <div onClick={clickable ? onClick : undefined} style={{
      position: 'relative', width: dim.w, height: dim.h, flexShrink: 0, borderRadius: 5,
      background: isBack ? 'linear-gradient(135deg,#1a4a8a 0%,#0d2d5c 50%,#1a4a8a 100%)' : '#fffdf6',
      border, boxShadow: selected ? '0 0 14px rgba(232,64,64,0.65),0 3px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.45)',
      cursor: clickable ? 'pointer' : 'default', opacity: folded ? 0.35 : 1,
      transform: selected ? 'translateY(-14px)' : 'none',
      transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.1s', userSelect: 'none',
    }}>
      {isBack ? (
        <div style={{ position: 'absolute', inset: 4, borderRadius: 3, border: '1.5px solid rgba(255,255,255,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: dim.fontSize * 1.3, color: 'rgba(255,255,255,0.3)', lineHeight: 1 }}>♦</span>
        </div>
      ) : (size === 'xs' || size === 'sm') ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          <span style={{ fontSize: dim.fontSize, fontWeight: '900', color, fontFamily: 'Georgia,"Times New Roman",serif', lineHeight: 1 }}>{rl}</span>
          <span style={{ fontSize: dim.suitSize * dim.suitMult, color, lineHeight: 1 }}>{symbol}</span>
        </div>
      ) : (
        <>
          <div style={{ position: 'absolute', top: 3, left: 5, lineHeight: 1 }}>
            <span style={{ fontSize: dim.fontSize, fontWeight: '900', color, fontFamily: 'Georgia,"Times New Roman",serif', lineHeight: 1 }}>{rl}</span>
          </div>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: dim.suitSize * dim.suitMult, color, lineHeight: 1 }}>{symbol}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ==========================================================
// ■ Badge / TimerBar（TournamentTable と同一）
// ==========================================================
function Badge({ bg, color, label }: { bg: string; color: string; label: string }) {
  return <span style={{ fontSize: 9, fontFamily: 'var(--font-title)', padding: '1px 5px', borderRadius: 3, background: bg, color, flexShrink: 0 }}>{label}</span>;
}

function TimerBar({ remaining, limit }: { remaining: number; limit: number }) {
  const pct   = limit > 0 ? Math.min(100, (remaining / limit) * 100) : 0;
  const color = pct > 50 ? '#22c55e' : pct > 25 ? '#eab308' : '#ef4444';
  return (
    <div style={{ width: '100%', height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, margin: '2px 0' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.5s linear' }} />
    </div>
  );
}

// ==========================================================
// ■ ボタンスタイル（TournamentTable の btnStyle と同一）
// ==========================================================
function btnStyle(v: 'gold' | 'gray' | 'red' | 'outline', compact?: boolean): React.CSSProperties {
  return {
    padding: compact ? '9px 12px' : '12px 18px',
    border: 'none', borderRadius: 7, width: '100%',
    fontSize: compact ? 13 : 15, fontWeight: 700, cursor: 'pointer',
    fontFamily: 'var(--font-title)', letterSpacing: '0.04em', lineHeight: 1.2,
    ...(v === 'gold'    ? { background: 'linear-gradient(135deg,var(--gold),var(--gold-dim))', color: '#1a1200', boxShadow: '0 2px 10px rgba(201,168,76,0.4)' } : {}),
    ...(v === 'gray'    ? { background: 'rgba(255,255,255,0.12)', color: 'var(--cream)', border: '1px solid rgba(255,255,255,0.25)' } : {}),
    ...(v === 'red'     ? { background: '#8b1a1a', color: '#ffd0d0' } : {}),
    ...(v === 'outline' ? { background: 'rgba(255,255,255,0.06)', color: 'var(--cream-dim)', border: '1px solid var(--gold-dim)' } : {}),
  };
}

// ==========================================================
// ■ スタッドカード列
// ==========================================================
interface StudCard { code: string; up: boolean; folded?: boolean }

/**
 * 他プレイヤーのカード列（xs 横1段）
 * xs(26px): 7枚フル = 重ね + up×4(26×4) + 7th + gap
 * overflow:'visible' で OTH_W を超えても見切れない
 * 最初の2枚のダウンカードは 4px ずつずらして「2枚ある」ことを視認可能にする
 */
function OtherStudCards({ cards, folded }: { cards: StudCard[]; folded?: boolean }) {
  if (!cards || cards.length === 0) return null;
  // stackW: xs(26px) + オフセット4px×(枚数-1) で重なりを視認可能にする
  const FRONT_OFFSET = 4;
  const w            = SIZE_PRESET.xs.w;
  const h            = SIZE_PRESET.xs.h;

  const downFront: StudCard[] = [];
  const ups:       StudCard[] = [];
  const downBack:  StudCard[] = [];
  cards.forEach((c, i) => {
    if (i < 2)        downFront.push(c);
    else if (i === 6) downBack.push(c);
    else              ups.push(c);
  });

  // ダウンフロントの幅 = カード幅 + ずらし分（2枚目以降のオフセット累積）
  const frontW = w + FRONT_OFFSET * Math.max(0, downFront.length - 1);

  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', opacity: folded ? 0.5 : 1 }}>
      {downFront.length > 0 && (
        <div style={{ position: 'relative', width: frontW, height: h, flexShrink: 0 }}>
          {downFront.map((c, i) => (
            <div key={`df${i}`} style={{ position: 'absolute', top: 0, left: i * FRONT_OFFSET }}>
              <Card code={c.code} size="xs" folded={folded} isDown={!c.up} />
            </div>
          ))}
        </div>
      )}
      {ups.map((c, i) => <Card key={`up${i}`} code={c.code} size="xs" folded={folded} />)}
      {downBack.length > 0 && (
        <div style={{ position: 'relative', width: w, height: h, flexShrink: 0 }}>
          <Card code={downBack[0].code} size="xs" folded={folded} isDown={!downBack[0].up} />
        </div>
      )}
    </div>
  );
}

/** 自分のカード列（sm 32px × 7枚横1段・ダウンカードは破線枠） */
function SelfStudCards({ cards, size = 'sm' }: { cards: StudCard[]; size?: CardSize }) {
  if (!cards || cards.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', justifyContent: 'center', flexWrap: 'nowrap' }}>
      {cards.map((c, i) => <Card key={i} code={c.code} size={size} isDown={!c.up} />)}
    </div>
  );
}

// ==========================================================
// ■ Props
// ==========================================================
interface TimerState { remaining: number; limit: number }
interface Props {
  players:       PlayerState[];
  meta:          GameMeta | null;
  timer:         TimerState | null;
  isSpectator?:  boolean;
  onBetAction:   (action: string, amount?: number) => void;
  blind?:        BlindUpdate | null;
  tournamentId?: string;
}

// actionFlash ラベル（TournamentTable と同一）
const ACTION_LABEL: Record<string, string> = {
  fold: 'フォールド', check: 'チェック', call: 'コール', bet: 'ベット', raise: 'レイズ',
};
const ACTION_COLOR: Record<string, string> = {
  フォールド: 'rgba(139,26,26,0.92)', チェック: 'rgba(30,100,60,0.92)',
  コール: 'rgba(30,80,160,0.92)', ベット: 'rgba(160,120,10,0.92)', レイズ: 'rgba(160,60,10,0.92)',
};

const STREET_LABEL: Record<string, string> = {
  '3rd': '3rd Street', '4th': '4th Street', '5th': '5th Street',
  '6th': '6th Street', '7th': '7th Street', showdown: 'SHOWDOWN',
};

// ==========================================================
// ■ メインコンポーネント
// ==========================================================
export default function StudTable({ players, meta, timer, isSpectator, onBetAction, blind, tournamentId }: Props) {
  const [layout, setLayout] = useState<'pc' | 'portrait' | 'landscape' | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const [showTableList, setShowTableList] = useState(false);
  const [tableListLoading, setTableListLoading] = useState(false);
  const [tableListData, setTableListData]   = useState<any[]>([]);

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth, h = window.innerHeight;
      if (w >= 768) setLayout('pc');
      else setLayout(w < h ? 'portrait' : 'landscape');
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ w: rect.width, h: rect.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // actionFlash: TournamentTable と同じ日本語ラベル方式
  const [actionFlash, setActionFlash] = useState<Record<string, { label: string; key: number }>>({});
  const flashTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    const onAction = ({ playerName, action }: { playerName: string; action: string }) => {
      if (!playerName) return;
      const label = ACTION_LABEL[action] ?? action;
      setActionFlash(prev => ({ ...prev, [playerName]: { label, key: Date.now() } }));
      // setTimeout を ref で管理してアンマウント後のリークを防止
      const t = setTimeout(() => {
        setActionFlash(prev => { const n = { ...prev }; delete n[playerName]; return n; });
      }, 2000);
      flashTimersRef.current.push(t);
    };
    const onGameStarted = () => setActionFlash({});
    socket.on('playerAction', onAction);
    socket.on('gameStarted',  onGameStarted);
    return () => {
      socket.off('playerAction', onAction);
      socket.off('gameStarted', onGameStarted);
      flashTimersRef.current.forEach(clearTimeout);
      flashTimersRef.current = [];
    };
  }, []);

  const openTableList = async () => {
    if (!tournamentId) return;
    setShowTableList(true); setTableListLoading(true);
    try { const res = await fetch(`/api/tournament/${tournamentId}/tables`); const d = await res.json(); setTableListData(d.tables ?? []); }
    catch { setTableListData([]); }
    setTableListLoading(false);
  };

  // ⚠️ Hook のルール: useRef は early return より前に置く必要がある
  // flashOverlays を useRef で管理（renderPlayer → MobileTable の描画順依存をなくす）
  const flashOverlaysRef = useRef<React.ReactNode[]>([]);

  if (layout === null) return <div style={{ minHeight: '100vh', background: '#0d2416' }} />;

  // 共通データ
  const self     = players.find(p => p.isSelf) ?? null;
  const phase    = meta?.phase ?? 'waiting';
  const mode     = meta?.currentMode ?? 'stud_s';
  const modeColor   = MODE_COLOR[mode] ?? '#50c0d0';
  const street      = meta?.street ?? null;
  const isBetPhase  = phase.startsWith('bet');
  const isShowdown  = phase === 'showdown';
  const isMyTurn    = self?.isMyTurn ?? false;
  const canCheck    = self?.canCheck ?? false;
  const toCall      = self?.toCall   ?? 0;
  const canRaise    = self?.canRaise  ?? false;
  const bringInPlayer = players.find(p => p.isBringIn);

  const orderedOthers = (() => {
    const selfIdx = players.findIndex(p => p.isSelf);
    if (selfIdx < 0) return players.filter(p => !p.isSelf);
    const result: PlayerState[] = [];
    for (let i = 1; i < players.length; i++) {
      const p = players[(selfIdx + i) % players.length];
      if (!p.isSelf) result.push(p);
    }
    return result;
  })();

  // ==========================================================
  // ■ PC レイアウト（TournamentTable PC版と同構造）
  // ==========================================================
  if (layout === 'pc') {
    const TW    = Math.min(1100, Math.max(600, window.innerWidth  - 300));
    const TH    = Math.min(760,  Math.max(460, window.innerHeight - 100));
    const CX    = TW / 2, CY = TH / 2 - 10;
    const ACT_W = 280;
    const RX    = TW * 0.353, RY = TH * 0.353;
    const BW    = Math.max(175, Math.floor(TW * 0.21));
    const others = orderedOthers;

    const getPos = (p: PlayerState) => {
      let ang: number;
      if (p.isSelf) { ang = 90; }
      else {
        const idx = others.findIndex(o => o.id === p.id);
        if (self) { ang = ([150, -150, -90, -30, 30][idx] ?? (-90 + 60 * (idx + 1))); }
        else { ang = 90 + (360 / (others.length || 1)) * idx; }
      }
      const rad = (ang * Math.PI) / 180;
      const bh = p.isSelf ? Math.floor(TH * 0.31) : Math.floor(TH * 0.25);
      let left = CX + RX * Math.cos(rad) - BW / 2;
      let top  = CY + RY * Math.sin(rad) - bh / 2;
      // 見切れ防止: カード列(7枚)がボックス幅 BW を左右に超える分のマージンを確保
      const MARGIN = p.isSelf ? 8 : 24;
      left = Math.max(MARGIN, Math.min(left, TW - BW - MARGIN));
      top  = Math.max(8, Math.min(top, TH - bh - 8));
      return { left, top };
    };

    return (
      <>
        <div ref={containerRef} style={{ display: 'flex', alignItems: 'center', gap: 0, width: '100%', maxWidth: TW + ACT_W + 32, padding: '0 16px', flex: 1, minHeight: 0 }}>
          {/* 楕円テーブル */}
          <div style={{ position: 'relative', width: TW, height: TH, flexShrink: 0 }}>
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '70%', height: '62%', borderRadius: '50%', background: 'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)', border: '8px solid var(--gold-dim)', boxShadow: '0 0 40px rgba(0,0,0,0.8),inset 0 0 30px rgba(0,0,0,0.4)', zIndex: 0 }} />
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 'calc(70% - 20px)', height: 'calc(62% - 20px)', borderRadius: '50%', border: '1px solid rgba(201,168,76,0.25)', zIndex: 0 }} />

            {/* テーブル中央 */}
            {phase !== 'waiting' && (
              <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', zIndex: 2, pointerEvents: 'none', textAlign: 'center' }}>
                {street && <div style={{ fontFamily: 'var(--font-title)', fontSize: 14, color: '#88ddff', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 2 }}>{STREET_LABEL[street] ?? street}</div>}
                {bringInPlayer && street === '3rd' && <div style={{ fontSize: 11, color: '#ffaa44', marginBottom: 2 }}>🔔 {bringInPlayer.name} BRING-IN</div>}
                <div style={{ fontFamily: 'var(--font-title)', fontSize: 9, color: modeColor, letterSpacing: '0.1em', opacity: 0.8 }}>{MODE_LABEL_FULL[mode] ?? mode}</div>
                {(meta?.pot ?? 0) > 0 && <div style={{ fontSize: 16, color: '#f0d060', fontWeight: 700, fontFamily: 'var(--font-title)' }}>🏦 {meta?.pot}</div>}
                {isBetPhase && (meta?.currentBet ?? 0) > 0 && <div style={{ fontSize: 12, color: '#ffcc44', marginTop: 1, fontFamily: 'var(--font-body)' }}>BET {meta?.currentBet}</div>}
                {isBetPhase && <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'var(--font-body)' }}>Bet {meta?.raiseCount ?? 0}/5</div>}
                {blind && <div style={{ fontSize: 10, color: '#88ee88', marginTop: 3, fontFamily: 'var(--font-title)' }}>Lv.{blind.level} {blind.sb}/{blind.bb}</div>}
              </div>
            )}

            {/* ディーラーボタン */}
            {(() => {
              const btn = players.find(p => p.isDealer);
              if (!btn || (meta?.dealerIndex ?? -1) < 0) return null;
              const pos = getPos(btn);
              const bh  = btn.isSelf ? Math.floor(TH * 0.31) : Math.floor(TH * 0.25);
              const cx  = pos.left + BW / 2, cy = pos.top + bh / 2;
              const dx  = cx - CX, dy = cy - CY;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const scale = dist > 0 ? Math.max(0, (dist - 100)) / dist : 0;
              return <div style={{ position: 'absolute', left: CX + dx * scale - 14, top: CY + dy * scale - 14, width: 28, height: 28, borderRadius: '50%', background: '#fff', border: '2px solid #444', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-title)', fontSize: 11, fontWeight: 900, color: '#1a1a1a', boxShadow: '0 2px 6px rgba(0,0,0,0.7)', zIndex: 5, pointerEvents: 'none' }}>D</div>;
            })()}

            {/* プレイヤーボックス */}
            {players.map(p => {
              const { left, top } = getPos(p);
              const bh     = p.isSelf ? Math.floor(TH * 0.31) : Math.floor(TH * 0.25);
              const active  = p.isMyTurn && !p.folded && !p.sittingOut;
              const flash   = actionFlash[p.name];
              const studCards = (p.studCards ?? (p.hand ?? []).map(code => ({ code, up: true }))) as StudCard[];
              return (
                <div key={p.id} style={{ position: 'absolute', left, top, width: BW, zIndex: 2, overflow: 'visible' }}>
                  {flash && (
                    <div key={flash.key} style={{ position: 'absolute', top: -38, left: '50%', transform: 'translateX(-50%)', background: ACTION_COLOR[flash.label] ?? 'rgba(160,60,10,0.92)', color: '#fff', fontFamily: 'var(--font-title)', fontSize: 13, fontWeight: 700, padding: '4px 14px', borderRadius: 20, whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.5)', pointerEvents: 'none', zIndex: 20, animation: 'actionPop 2s ease-out forwards' }}>{flash.label}</div>
                  )}
                  <div style={{ position: 'relative', textAlign: 'center', padding: '8px 6px', borderRadius: 11, border: '1px solid transparent', transition: 'all 0.25s', width: BW, ...(p.isSelf ? { background: 'rgba(10,50,30,0.8)', border: '1px solid rgba(201,168,76,0.35)' } : {}), ...(active ? { border: '1px solid var(--gold)', boxShadow: '0 0 18px rgba(201,168,76,0.5)', background: 'rgba(201,168,76,0.08)' } : {}), ...(p.folded && !p.sittingOut ? { opacity: 0.4 } : {}), ...(p.sittingOut ? { opacity: 0.5 } : {}), ...(p.isWinner ? { border: '3px solid var(--gold-bright)', boxShadow: '0 0 40px rgba(240,208,96,0.9)', background: 'rgba(201,168,76,0.22)' } : {}) }}>
                    <div style={{ display: 'flex', gap: 2, justifyContent: 'center', marginBottom: 2, flexWrap: 'wrap' }}>
                      {p.isDealer   && <Badge bg="#c9a84c" color="#1a1200" label="BTN" />}
                      {p.isBringIn  && <Badge bg="#b85a10" color="#ffd0a0" label="BI"  />}
                      {p.folded && !p.sittingOut && <Badge bg="#444" color="#aaa" label="FOLD" />}
                      {p.isWinner   && <Badge bg="#f0d060" color="#1a1200" label="🏆 WIN" />}
                    </div>
                    <div style={{ fontFamily: 'var(--font-title)', fontSize: 13, fontWeight: 700, color: p.isSelf ? 'var(--gold-bright)' : 'var(--cream)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}{p.isSelf ? ' (YOU)' : ''}</div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: '#88dd88' }}>💵 {p.chips.toLocaleString()}{p.bet > 0 ? ` (B${p.bet})` : ''}</div>
                    {p.isSelf && p.isMyTurn && timer && <TimerBar remaining={timer.remaining} limit={timer.limit} />}
                    <div style={{ display: 'flex', justifyContent: 'center', gap: p.isSelf ? 4 : 3, flexWrap: 'nowrap', margin: '5px 0', overflow: 'visible' }}>
                      {p.isSelf
                        ? <SelfStudCards cards={studCards} size="lg" />
                        : <OtherStudCards cards={studCards} folded={p.folded} />}
                    </div>
                    {isShowdown && p.result && !p.folded && <div style={{ fontSize: 13, color: p.isWinner ? 'var(--gold-bright)' : 'var(--cream-dim)', fontFamily: 'var(--font-title)', marginTop: 4 }}>{p.result}</div>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 右アクションパネル */}
          <div style={{ width: ACT_W, flexShrink: 0, background: 'linear-gradient(160deg,rgba(22,92,56,0.5),rgba(10,51,32,0.7))', border: '1px solid var(--gold-dim)', borderRadius: 12, padding: '20px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12, minHeight: 280, marginLeft: 10 }}>
            {self && (
              <div style={{ textAlign: 'center', paddingBottom: 10, borderBottom: '1px solid rgba(201,168,76,0.2)' }}>
                <div style={{ fontFamily: 'var(--font-title)', fontSize: 14, color: 'var(--gold-bright)', marginBottom: 3 }}>{self.name} (YOU)</div>
                <div style={{ fontSize: 18, color: '#88dd88', fontWeight: 700 }}>💵 {self.chips.toLocaleString()}</div>
                {self.bet > 0 && <div style={{ fontSize: 11, color: '#ffcc44' }}>BET {self.bet}</div>}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--gold-dim)', fontFamily: 'var(--font-body)', textAlign: 'center' }}>
              {mode === 'stud_e' ? '★ Hi/Lo: 8以下のローでポット折半'
                : mode === 'razz' ? '★ Razz: A-5ローボール'
                : '★ 7 Card Stud: 高い手が強い'}
            </div>
            {isSpectator && <div style={{ textAlign: 'center', fontSize: 12, color: '#b088ff', border: '1px solid #6644aa', borderRadius: 6, padding: '6px 0' }}>観戦中</div>}
            {!isSpectator && phase === 'waiting' && <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)' }}>{players.length < 2 ? 'もう1人参加を待っています' : 'ゲームを準備中...'}</div>}
            {!isSpectator && isBetPhase && isMyTurn && !self?.isAllIn && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {!canCheck && <button style={btnStyle('red')} onClick={() => onBetAction('fold')}>フォールド</button>}
                {canCheck
                  ? <button style={btnStyle('gray')} onClick={() => onBetAction('check')}>チェック</button>
                  : <button style={btnStyle('gray')} onClick={() => onBetAction('call')}>コール ({toCall})</button>}
                {canRaise && <button style={btnStyle('gold')} onClick={() => onBetAction(canCheck ? 'bet' : 'raise')}>{canCheck ? `BET+${self?.betSize ?? ''}` : `RAISE+${self?.betSize ?? ''}`}</button>}
              </div>
            )}
            {!isSpectator && isBetPhase && isMyTurn && self?.isAllIn && <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--gold)', fontFamily: 'var(--font-title)', fontWeight: 700 }}>⚡ オールイン中（待機）</div>}
            {!isSpectator && isBetPhase && !isMyTurn && <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', fontStyle: 'italic' }}>{players.find(p => p.isMyTurn && !p.isSelf)?.name ?? ''}がアクション中...</div>}
            {isShowdown && <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', fontStyle: 'italic' }}>次のゲームを準備中...</div>}
            {tournamentId && <button onClick={openTableList} style={{ fontFamily: 'var(--font-title)', fontSize: 10, letterSpacing: '0.08em', color: 'var(--gold-dim)', background: 'rgba(201,168,76,0.07)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 5, padding: '5px 0', cursor: 'pointer', width: '100%', marginTop: 4 }}>テーブル一覧</button>}
          </div>
        </div>
        <TableListModal open={showTableList} loading={tableListLoading} data={tableListData} onClose={() => setShowTableList(false)} />
      </>
    );
  }

  // ==========================================================
  // ■ スマホ共通レイアウト計算（TournamentTable と同一数値）
  // ==========================================================
  const isPortrait = layout !== 'landscape';
  const vw    = window.innerWidth;
  const availH = containerSize.h > 0 ? containerSize.h : Math.max(200, window.innerHeight - 44);
  const ACT_W_M = 148;
  const ACT_H_M = 110;

  let TW_M: number, TH_M: number;
  if (isPortrait) { TW_M = vw - 8; TH_M = availH - ACT_H_M - 4; }
  else            { TH_M = availH - 4; TW_M = vw - ACT_W_M - 4; }
  TW_M = Math.max(TW_M, 200);
  TH_M = Math.max(TH_M, 140);

  const RX_M = isPortrait ? TW_M * 0.32 : TW_M * 0.44;
  const RY_M = isPortrait ? TH_M * 0.36 : TH_M * 0.40;
  const CX_M = TW_M / 2;
  const CY_M = isPortrait ? TH_M * 0.54 : TH_M / 2;

  const OTH_W  = Math.max(Math.floor(TW_M * 0.36), Math.floor(Math.min(TW_M, TH_M) * 0.32));
  // 自分のカード: sm(32px)×7枚(242px) を収めるため TW×0.70 に拡大（修正6）
  const SELF_W = Math.min(Math.floor(TW_M * 0.70), TW_M - 16);
  const SELF_H = isPortrait ? Math.floor(TH_M * 0.36) : Math.floor(TH_M * 0.40);
  const OTH_H  = isPortrait ? Math.floor(TH_M * 0.26) : Math.floor(TH_M * 0.32);

  // 修正1: 名前・チップフォントはOTH_W基準で全員統一（ドローポーカーと同じ方式）
  const fs = {
    name: Math.max(9, Math.floor(OTH_W * 0.10)),
    chip: Math.max(9, Math.floor(OTH_W * 0.095)),
  };

  const SLOTS_M = isPortrait ? [165, -155, -90, -25, 15] : [150, -150, -90, -30, 30];
  const oth_m   = orderedOthers;

  const getPosMobile = (p: PlayerState) => {
    let ang: number;
    if (p.isSelf) { ang = 90; }
    else {
      const idx = oth_m.findIndex(o => o.id === p.id);
      if (self) { ang = SLOTS_M[idx] ?? (-90 + 72 * (idx + 1)); }
      else { ang = 90 + (360 / (oth_m.length || 1)) * idx; }
    }
    const rad = (ang * Math.PI) / 180;
    const bw  = p.isSelf ? SELF_W : OTH_W;
    const bh  = p.isSelf ? SELF_H : OTH_H;
    let left = CX_M + RX_M * Math.cos(rad) - bw / 2;
    let top  = CY_M + RY_M * Math.sin(rad) - bh / 2;
    // 画面端クランプ: ボックス（とカード）が左右にはみ出して見切れるのを防ぐ。
    // 他プレイヤーのカード列(最大7枚)はボックス幅 OTH_W を中央基準で左右に
    // 約20pxずつ超えるため、その分を MARGIN として確保する（自分は SELF_W に収まる）。
    const MARGIN = p.isSelf ? 4 : 22;
    left = Math.max(MARGIN, Math.min(left, TW_M - bw - MARGIN));
    top  = Math.max(4, Math.min(top, TH_M - bh - 4));
    return { left, top };
  };


  const renderPlayer = (p: PlayerState) => {
    const { left, top } = getPosMobile(p);
    const bw     = p.isSelf ? SELF_W : OTH_W;
    const active  = p.isMyTurn && !p.folded && !p.sittingOut;
    const flash   = actionFlash[p.name];
    const studCards = (p.studCards ?? (p.hand ?? []).map(code => ({ code, up: true }))) as StudCard[];

    // 修正1: フラッシュ要素を ref に積む（MobileTable で最上位描画）
    if (flash) {
      const flashLeft = left + bw / 2 + (p.isDealer ? 18 : 0);
      const flashTop  = top - 28;
      flashOverlaysRef.current.push(
        <div key={`flash-${p.id}`} style={{
          position: 'absolute',
          left: flashLeft, top: flashTop,
          transform: 'translateX(-50%)',
          background: ACTION_COLOR[flash.label] ?? 'rgba(160,60,10,0.92)',
          color: '#fff', fontFamily: 'var(--font-title)', fontSize: 11, fontWeight: 700,
          padding: '3px 10px', borderRadius: 20, whiteSpace: 'nowrap',
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)', pointerEvents: 'none',
          zIndex: 20,
          animation: 'actionPop 2s ease-out forwards',
        }}>{flash.label}</div>
      );
    }

    // 修正3: 自分の手役は 3枚以上あれば常時表示（ベット中も表示）
    const showSelfResult = p.isSelf && !p.folded && (p.studCards ?? (p.hand ?? [])).length >= 3 && !!p.result;

    return (
      <div key={p.id} style={{ position: 'absolute', left, top, width: bw, overflow: 'visible', zIndex: p.isSelf ? 3 : 2 }}>
        <div style={{
          position: 'relative', width: bw, textAlign: 'center', padding: '3px 2px 2px',
          borderRadius: 7,
          border: active ? '1.5px solid var(--gold)' : p.isWinner ? '3px solid var(--gold-bright)' : '1px solid rgba(201,168,76,0.2)',
          boxShadow: active ? '0 0 10px rgba(201,168,76,0.5)' : p.isWinner ? '0 0 30px rgba(240,208,96,0.85)' : 'none',
          background: p.isSelf ? 'rgba(10,50,30,0.85)' : active ? 'rgba(201,168,76,0.07)' : 'rgba(0,0,0,0.4)',
          opacity: (p.folded && !p.sittingOut) ? 0.4 : p.sittingOut ? 0.5 : 1,
          transition: 'all 0.2s',
        }}>
          <div style={{ display: 'flex', gap: 2, justifyContent: 'center', marginBottom: 1, flexWrap: 'wrap', overflow: 'hidden' }}>
            {p.isDealer    && <Badge bg="#c9a84c" color="#1a1200"  label="BTN" />}
            {p.isBringIn   && <Badge bg="#b85a10" color="#ffd0a0"  label="BI"  />}
            {p.folded && !p.sittingOut && <Badge bg="#555" color="#aaa" label="FOLD" />}
            {p.isWinner    && <Badge bg="#f0d060" color="#1a1200"  label="🏆 WIN" />}
            {p.disconnected && <Badge bg="#663333" color="#ffaaaa" label="切断" />}
          </div>
          <div style={{ fontSize: fs.name, color: p.isSelf ? 'var(--gold-bright)' : 'var(--cream)', fontFamily: 'var(--font-title)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '0.02em' }}>
            {p.name}{p.isSelf ? '(YOU)' : ''}
          </div>
          <div style={{ fontSize: fs.chip, color: '#88dd88', fontFamily: 'var(--font-body)', lineHeight: 1.2 }}>
            💵{p.chips.toLocaleString()}
            {p.bet > 0 && <span style={{ display: 'inline-block', marginLeft: 3, padding: '0 4px', borderRadius: 3, background: 'rgba(201,168,76,0.25)', color: '#f0d060', fontWeight: 700, fontSize: fs.chip + 1 }}>B{p.bet}</span>}
          </div>
          {p.isSelf && p.isMyTurn && timer && <TimerBar remaining={timer.remaining} limit={timer.limit} />}

          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 2, overflow: 'visible', position: 'relative', zIndex: 1 }}>
            {p.isSelf
              ? <SelfStudCards cards={studCards} size="sm" />
              : <OtherStudCards cards={studCards} folded={p.folded} />}
          </div>

          {/* 修正3: 自分の手役は常時表示、相手はショーダウン時のみ */}
          {showSelfResult && (
            <div style={{ fontSize: 9, color: '#aaddff', marginTop: 1, fontFamily: 'var(--font-body)', fontWeight: 700 }}>{p.result}</div>
          )}
          {!p.isSelf && isShowdown && p.result && !p.folded && (
            <div style={{ fontSize: 9, color: '#f5cc40', marginTop: 1, fontFamily: 'var(--font-body)' }}>{p.result}</div>
          )}
        </div>
      </div>
    );
  };

  // ==========================================================
  // ■ MobileTable
  // ==========================================================
  function renderMobileTable() {
    // 修正1: renderPlayer呼び出し前にrefをリセット
    flashOverlaysRef.current = [];
    const renderedPlayers = players.map(p => renderPlayer(p));
    // renderPlayer完了後にrefの内容を取得
    const currentFlashOverlays = [...flashOverlaysRef.current];

    return (
    <div style={{ position: 'relative', width: TW_M, height: TH_M, ...(isPortrait ? { margin: '0 auto', flexShrink: 0 } : {}) }}>
      {/* フェルト */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '72%', height: isPortrait ? '72%' : '70%', borderRadius: '50%', background: 'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)', border: '5px solid var(--gold-dim)', boxShadow: '0 0 20px rgba(0,0,0,0.8),inset 0 0 20px rgba(0,0,0,0.4)', zIndex: 0 }} />

      {/* 修正B: テーブル中央情報をzIndex:3に引き上げ（プレイヤーボックスzIndex:2より前面） */}
      {phase !== 'waiting' && (
        <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', zIndex: 3, pointerEvents: 'none' }}>
          {street && <div style={{ fontFamily: 'var(--font-title)', fontSize: isPortrait ? 12 : 10, color: '#88ddff', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 1 }}>{STREET_LABEL[street] ?? street}</div>}
          {bringInPlayer && street === '3rd' && <div style={{ fontSize: isPortrait ? 10 : 8, color: '#ffaa44', marginBottom: 1 }}>🔔 {bringInPlayer.name} BRING-IN</div>}
          <div style={{ fontFamily: 'var(--font-title)', fontSize: isPortrait ? 14 : 10, color: 'var(--gold-bright)', textShadow: '0 0 6px rgba(201,168,76,0.6)' }}>🏦 {meta?.pot ?? 0}</div>
          {isBetPhase && (meta?.currentBet ?? 0) > 0 && <span style={{ padding: '1px 5px', borderRadius: 3, background: 'rgba(201,168,76,0.3)', color: '#f5cc40', fontSize: isPortrait ? 12 : 9, fontWeight: 700 }}>BET {meta?.currentBet}</span>}
          <div style={{ fontFamily: 'var(--font-title)', fontSize: isPortrait ? 11 : 9, color: modeColor, letterSpacing: '0.1em', opacity: 0.8 }}>{MODE_LABEL_FULL[mode] ?? mode}</div>
          {isBetPhase && <div style={{ fontSize: isPortrait ? 10 : 8, color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-body)' }}>Bet {meta?.raiseCount ?? 0}/5</div>}
          {blind && <div style={{ fontSize: isPortrait ? 10 : 8, color: '#88ee88', marginTop: 2, fontFamily: 'var(--font-title)' }}>Lv.{blind.level} {blind.sb}/{blind.bb}</div>}
        </div>
      )}

      {/* ディーラーボタン */}
      {(() => {
        const dp = players.find(p => p.isDealer);
        if (!dp || (meta?.dealerIndex ?? -1) < 0) return null;
        const { left: pl, top: pt } = getPosMobile(dp);
        const bw2 = dp.isSelf ? SELF_W : OTH_W, bh2 = dp.isSelf ? SELF_H : OTH_H;
        const dcx = pl + bw2 / 2, dcy = pt + bh2 / 2;
        const ddx = dcx - CX_M, ddy = dcy - CY_M;
        const dd  = Math.sqrt(ddx * ddx + ddy * ddy);
        const sc  = dd > 0 ? Math.max(0, (dd - 80)) / dd : 0;
        return <div style={{ position: 'absolute', left: CX_M + ddx * sc - 11 + (dp.isSelf ? -65 : 0), top: CY_M + ddy * sc - 11, width: 22, height: 22, borderRadius: '50%', background: '#fff', border: '2px solid #444', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 900, color: '#1a1a1a', boxShadow: '0 1px 4px rgba(0,0,0,0.7)', zIndex: 5, pointerEvents: 'none', fontFamily: 'var(--font-title)' }}>D</div>;
      })()}

      {/* プレイヤーボックス */}
      {renderedPlayers}

      {/* 修正1: アクションフラッシュを最上位レイヤーで描画（zIndex:20） */}
      {currentFlashOverlays}
    </div>
    );
  };

  // ==========================================================
  // ■ アクションパネル（TournamentTable の btnStyle 統一）
  // ==========================================================
  function renderActionPanel() {
    return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: 'rgba(0,0,0,0.35)', borderTop: '1px solid rgba(201,168,76,0.2)', padding: '6px 8px 8px', overflow: 'hidden', minHeight: 0 }}>
      <div style={{ fontSize: 9, color: 'var(--gold-dim)', fontFamily: 'var(--font-body)', marginBottom: 4 }}>
        {mode === 'stud_e' ? '★ Stud Hi/Lo: 8以下のローでポット折半' : mode === 'razz' ? '★ Razz: A-5ローボール、低い手が強い' : '★ 7 Card Stud: 高い手が強い'}
      </div>
      {isSpectator && <div style={{ textAlign: 'center', fontSize: 12, color: '#b088ff', border: '1px solid #6644aa', borderRadius: 6, padding: '6px 0' }}>観戦中</div>}
      {!isSpectator && phase === 'waiting' && <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', padding: '8px 0' }}>{players.length < 2 ? 'もう1人参加を待っています' : 'ゲームを準備中...'}</div>}
      {!isSpectator && isBetPhase && isMyTurn && !self?.isAllIn && (
        <div style={{ display: 'flex', gap: 6 }}>
          {!canCheck && <button style={{ ...btnStyle('red', true), flex: 1 }} onClick={() => onBetAction('fold')}>フォールド</button>}
          {canCheck
            ? <button style={{ ...btnStyle('gray', true), flex: 1 }} onClick={() => onBetAction('check')}>チェック</button>
            : <button style={{ ...btnStyle('gray', true), flex: 1 }} onClick={() => onBetAction('call')}>コール({toCall})</button>}
          {canRaise && <button style={{ ...btnStyle('gold', true), flex: 1 }} onClick={() => onBetAction(canCheck ? 'bet' : 'raise')}>{canCheck ? `BET+${self?.betSize ?? ''}` : `RAISE+${self?.betSize ?? ''}`}</button>}
        </div>
      )}
      {!isSpectator && isBetPhase && isMyTurn && self?.isAllIn && <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--gold)', fontFamily: 'var(--font-title)', padding: '8px 0', fontWeight: 700 }}>⚡ オールイン中（待機）</div>}
      {!isSpectator && isBetPhase && !isMyTurn && <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', padding: '8px 0', fontStyle: 'italic' }}>{players.find(p => p.isMyTurn && !p.isSelf)?.name ?? ''}がアクション中...</div>}
      {isShowdown && <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', padding: '8px 0', fontStyle: 'italic' }}>次のゲームを準備中...</div>}
      {tournamentId && <button onClick={openTableList} style={{ fontFamily: 'var(--font-title)', fontSize: 10, letterSpacing: '0.08em', color: 'var(--gold-dim)', background: 'rgba(201,168,76,0.07)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 5, padding: '5px 0', cursor: 'pointer', width: '100%', marginTop: 4 }}>テーブル一覧</button>}
    </div>
    );
  }

  if (isPortrait) {
    return (
      <>
        <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'visible' }}>
          {renderMobileTable()}
          {renderActionPanel()}
        </div>
        <TableListModal open={showTableList} loading={tableListLoading} data={tableListData} onClose={() => setShowTableList(false)} />
      </>
    );
  }

  return (
    <>
      <div ref={containerRef} style={{ display: 'flex', alignItems: 'center', gap: 0, width: '100%', height: '100%', overflow: 'hidden' }}>
        {renderMobileTable()}
        <div style={{ width: ACT_W_M, height: '100%', display: 'flex', flexDirection: 'column' }}>
          {renderActionPanel()}
        </div>
      </div>
      <TableListModal open={showTableList} loading={tableListLoading} data={tableListData} onClose={() => setShowTableList(false)} />
    </>
  );
}
