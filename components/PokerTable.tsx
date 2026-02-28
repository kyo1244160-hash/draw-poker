/**
 * PokerTable.tsx — ゲームテーブル共通コンポーネント
 *
 * 対応ゲーム: 2-7 Triple Draw / Badugi / Mix
 *
 * 機能:
 *   - テーブル中央にフェーズ（ベット/ドロー）とゲーム種類を表示
 *   - 退室ボタン（ナビバー右端）
 *   - タイマーバー（自分のターン時）
 *   - 4色デッキカード表示
 *   - pending / sittingOut プレイヤー表示
 *   - スマホ対応（レスポンシブ）
 *
 * フェーズ一覧:
 *   bet0   プリドロー（カード配布直後）
 *   draw1  1回目のドロー
 *   bet1   ドロー1後のベット
 *   draw2  2回目のドロー
 *   bet2   ドロー2後のベット
 *   draw3  3回目のドロー（最終）
 *   bet3   最終ベット
 *   showdown ショーダウン
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import { socket } from '../socket';
import Card from './Card';
import TimerBar from './TimerBar';

// ===== 型定義 =====
interface Player {
  id: string; name: string; chips: number; bet: number;
  folded: boolean; sittingOut: boolean; hand: string[];
  isSelf: boolean; isMyTurn: boolean;
  drewThisRound: boolean; drawCount: number | null;
  result?: string; isWinner?: boolean;
  isDealer: boolean; isSB: boolean; isBB: boolean;
  toCall?: number; canCheck?: boolean; canRaise?: boolean; betSize?: number;
  timerRemaining?: number;
}

interface Meta {
  phase: string; mode: string; currentMode: string;
  pot: number; currentBet: number; betSize: number;
  raiseCount: number; maxRaises: number; dealerIndex: number;
  timerRemaining: number | null; timerLimit: number;
  pendingPlayers: string[]; playerCount: number; maxPlayers: number;
}

interface Props { roomId: string; name: string; mode: '27' | 'badugi' | 'mix'; }

// ===== フェーズ表示 =====
const PHASE_LABEL: Record<string, string> = {
  waiting: 'WAITING', bet0: 'BET (Pre-Draw)',
  draw1: 'DRAW I', bet1: 'BET I',
  draw2: 'DRAW II', bet2: 'BET II',
  draw3: 'DRAW III', bet3: 'BET III (Final)',
  showdown: 'SHOWDOWN',
};

const PHASE_TYPE: Record<string, 'bet'|'draw'|'other'> = {
  bet0: 'bet', bet1: 'bet', bet2: 'bet', bet3: 'bet',
  draw1: 'draw', draw2: 'draw', draw3: 'draw',
};

const MODE_LABEL: Record<string, string> = {
  '27': '2-7 Triple Draw', badugi: 'Badugi', mix: 'Mix',
};

// ===== メインコンポーネント =====
const PokerTable: React.FC<Props> = ({ roomId, name, mode }) => {
  const router = useRouter();
  const [players,       setPlayers]       = useState<Player[]>([]);
  const [meta,          setMeta]          = useState<Meta>({
    phase: 'waiting', mode, currentMode: mode === 'badugi' ? 'badugi' : '27',
    pot: 0, currentBet: 0, betSize: 10, raiseCount: 0, maxRaises: 4,
    dealerIndex: -1, timerRemaining: null, timerLimit: 0,
    pendingPlayers: [], playerCount: 0, maxPlayers: 6,
  });
  const [selected,      setSelected]      = useState<number[]>([]);
  const [myDrew,        setMyDrew]        = useState(false);
  const [timerSec,      setTimerSec]      = useState<number | null>(null);
  const [lastDrawCount, setLastDrawCount] = useState<Record<string, number | null>>({});

  // ===== Socket.IO =====
  useEffect(() => {
    const onConnect     = () => socket.emit('joinRoom', { roomId, name });
    const onGameState   = ({ players: pl, meta: m }: { players: Player[]; meta: Meta }) => {
      setPlayers(pl); setMeta(m);
      const self = pl.find((p) => p.isSelf);
      if (self) setMyDrew(self.drewThisRound);
      setLastDrawCount((prev) => {
        const next = { ...prev };
        for (const p of pl) { if (p.drawCount !== null) next[p.id] = p.drawCount; }
        return next;
      });
    };
    const onGameStarted = () => { setSelected([]); setMyDrew(false); setLastDrawCount({}); };
    const onTimerUpdate = ({ remaining }: { remaining: number }) => setTimerSec(remaining);
    const onKicked      = () => router.push('/');

    socket.on('connect',     onConnect);
    socket.on('gameState',   onGameState);
    socket.on('gameStarted', onGameStarted);
    socket.on('timerUpdate', onTimerUpdate);
    socket.on('showdown',    () => {});
    socket.on('kicked',      onKicked);

    if (socket.connected) socket.emit('joinRoom', { roomId, name });
    else socket.connect();

    return () => {
      socket.off('connect', onConnect); socket.off('gameState', onGameState);
      socket.off('gameStarted', onGameStarted); socket.off('timerUpdate', onTimerUpdate);
      socket.off('showdown'); socket.off('kicked', onKicked);
    };
  }, [roomId, name]);

  // ===== 状態計算 =====
  const self         = players.find((p) => p.isSelf);
  const isDrawPhase  = meta.phase.startsWith('draw');
  const isBetPhase   = meta.phase.startsWith('bet');
  const isMyTurn     = self?.isMyTurn ?? false;
  const drawRound    = ['draw1','draw2','draw3'].indexOf(meta.phase) + 1;
  const curPlayer    = players.find((p) => p.isMyTurn);
  const effectiveMode = meta.currentMode ?? (mode === 'mix' ? '27' : mode);
  const phaseType    = PHASE_TYPE[meta.phase] ?? 'other';

  // ===== ハンドラ =====
  const handleCardClick = useCallback((j: number) => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    setSelected((prev) => prev.includes(j) ? prev.filter((i) => i !== j) : [...prev, j]);
  }, [isDrawPhase, isMyTurn, myDrew]);

  const handleDraw  = () => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    socket.emit('drawCards', { roomId, indices: selected });
    setMyDrew(true); setSelected([]);
  };
  const handleBet   = (action: string) => socket.emit('betAction', { roomId, action });
  const handleLeave = () => { socket.emit('leaveRoom', { roomId }); router.push('/'); };

  // ===== レイアウト計算（レスポンシブ）=====
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const TW  = isMobile ? window.innerWidth - 8 : 1100;
  const TH  = isMobile ? TW * 0.75 : 780;
  const CX  = TW / 2;
  const CY  = TH / 2 - (isMobile ? 5 : 15);
  const RX  = TW * (isMobile ? 0.38 : 0.37);
  const RY  = TH * (isMobile ? 0.36 : 0.35);
  const BW  = isMobile ? Math.floor(TW * 0.22) : 230;
  const cardSize = isMobile ? 'sm' : 'lg';
  const otherCardSize = isMobile ? 'sm' : 'sm';

  const others = players.filter((p) => !p.isSelf);

  const getPos = (p: Player) => {
    let ang: number;
    if (p.isSelf) { ang = 90; }
    else {
      const slots  = [-90, -30, 30, 150, 210];
      const idx    = others.findIndex((o) => o.id === p.id);
      ang = slots[idx] ?? (-90 + 60 * (idx + 1));
    }
    const rad = (ang * Math.PI) / 180;
    const cx  = CX + RX * Math.cos(rad);
    const cy  = CY + RY * Math.sin(rad);
    const bh  = p.isSelf ? (isMobile ? TH * 0.22 : 220) : (isMobile ? TH * 0.18 : 170);
    return { left: cx - BW / 2, top: cy - bh / 2 };
  };

  // モード表示
  const modeColor  = effectiveMode === 'badugi' ? '#cc9966' : '#88bbee';
  const modeBg     = effectiveMode === 'badugi' ? 'rgba(204,119,68,0.2)' : 'rgba(68,136,204,0.2)';
  const modeBorder = effectiveMode === 'badugi' ? 'rgba(204,119,68,0.4)' : 'rgba(68,136,204,0.4)';

  return (
    <div style={S.page}>

      {/* ===== ナビバー ===== */}
      <nav style={S.nav}>
        <div style={S.navLeft}>
          <svg width={isMobile ? 22 : 28} height={isMobile ? 22 : 28} viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="30" stroke="#c9a84c" strokeWidth="2" fill="#0a3320"/>
            <text x="13" y="28" fontSize="14" fill="#f0d060" fontFamily="serif" textAnchor="middle">♠</text>
            <text x="51" y="28" fontSize="14" fill="#cc3333" fontFamily="serif" textAnchor="middle">♥</text>
            <text x="13" y="48" fontSize="14" fill="#f0d060" fontFamily="serif" textAnchor="middle">♣</text>
            <text x="51" y="48" fontSize="14" fill="#cc3333" fontFamily="serif" textAnchor="middle">♦</text>
            <text x="32" y="40" fontSize="20" fontWeight="bold" fill="#c9a84c" fontFamily="serif" textAnchor="middle">P</text>
          </svg>
          {!isMobile && <span style={S.navLogo}>Poker Room Pastis</span>}
        </div>

        <div style={S.navCenter}>
          <span style={{ ...S.modeBadge, background: modeBg, color: modeColor, border: `1px solid ${modeBorder}` }}>
            {mode === 'mix' ? `Mix→${effectiveMode === 'badugi' ? 'Badugi' : '2-7'}` : MODE_LABEL[effectiveMode]}
          </span>
          {!isMobile && (
            <span style={S.phaseTag}>{PHASE_LABEL[meta.phase] ?? meta.phase}</span>
          )}
          {isDrawPhase && (
            <span style={S.dots}>
              {[1,2,3].map((n) => (
                <span key={n} style={{ ...S.dot, background: n <= drawRound ? 'var(--gold-bright)' : 'rgba(255,255,255,0.15)', boxShadow: n === drawRound ? '0 0 6px var(--gold)' : 'none' }} />
              ))}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!isMobile && <span style={S.navRoom}>{roomId}</span>}
          <button onClick={handleLeave} style={S.leaveBtn}>退室</button>
        </div>
      </nav>

      {/* ===== pending 通知 ===== */}
      {meta.pendingPlayers.length > 0 && (
        <div style={S.pendingBar}>
          ⏳ 次ゲームから参加: {meta.pendingPlayers.join(', ')}
        </div>
      )}

      {/* ===== ポット ===== */}
      {meta.phase !== 'waiting' && (
        <div style={S.potBar}>
          <div style={S.potChip}>
            <span>🏦</span>
            <span style={S.potAmt}>POT <b style={{ color: 'var(--gold-bright)', fontSize: isMobile ? 15 : 18 }}>{meta.pot}</b></span>
          </div>
          {isBetPhase && meta.currentBet > 0 && (
            <div style={S.potChip}>
              <span style={S.potAmt}>BET <b style={{ color: 'var(--cream)', fontSize: isMobile ? 14 : 16 }}>{meta.currentBet}</b></span>
            </div>
          )}
        </div>
      )}

      {/* ===== テーブル ===== */}
      <div style={{ ...S.tableWrap, width: TW, height: TH }}>
        {/* フェルト */}
        <div style={S.felt} />
        <div style={S.feltInner} />

        {/* テーブル中央: フェーズ + ゲーム種類 */}
        {meta.phase !== 'waiting' && (
          <div style={{
            position: 'absolute', left: '50%', top: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', zIndex: 2, pointerEvents: 'none',
          }}>
            {/* ゲーム種類 */}
            <div style={{
              fontFamily: 'var(--font-title)', fontSize: isMobile ? 9 : 12,
              color: modeColor, letterSpacing: '0.15em', marginBottom: 4, opacity: 0.85,
            }}>
              {MODE_LABEL[effectiveMode]}
            </div>
            {/* フェーズタイプ（BET / DRAW） */}
            <div style={{
              fontFamily: 'var(--font-title)',
              fontSize: isMobile ? 14 : 20,
              letterSpacing: '0.2em',
              color: phaseType === 'bet' ? 'var(--gold-bright)'
                   : phaseType === 'draw' ? '#88ddff'
                   : 'var(--cream-dim)',
              textShadow: '0 0 12px rgba(0,0,0,0.8)',
              lineHeight: 1.1,
            }}>
              {PHASE_LABEL[meta.phase] ?? meta.phase}
            </div>
            {/* ベットラウンドのレイズカウント */}
            {isBetPhase && (
              <div style={{ fontSize: isMobile ? 8 : 11, color: 'rgba(255,255,255,0.5)', marginTop: 3, fontFamily: 'var(--font-body)' }}>
                Raise {meta.raiseCount}/{meta.maxRaises}
              </div>
            )}
          </div>
        )}

        {/* プレイヤーボックス */}
        {players.map((p) => {
          const { left, top } = getPos(p);
          return (
            <div key={p.id} style={{
              ...S.pBox,
              left, top, width: BW,
              ...(p.isSelf                              ? S.pBoxSelf   : {}),
              ...(p.isMyTurn && !p.folded && !p.sittingOut ? S.pBoxActive : {}),
              ...(p.folded && !p.sittingOut             ? S.pBoxFolded : {}),
              ...(p.sittingOut                          ? S.pBoxSitting: {}),
              ...(p.isWinner                            ? S.pBoxWinner : {}),
            }}>
              {/* バッジ */}
              <div style={S.badgeRow}>
                {p.isDealer   && <span style={{ ...S.badge, background: 'var(--gold)',        color: '#1a1200' }}>BTN</span>}
                {p.isSB       && <span style={{ ...S.badge, background: 'var(--chip-blue)',   color: '#fff'   }}>SB</span>}
                {p.isBB       && <span style={{ ...S.badge, background: 'var(--chip-orange)', color: '#fff'   }}>BB</span>}
                {p.folded && !p.sittingOut && <span style={{ ...S.badge, background: '#444', color: '#aaa' }}>FOLD</span>}
                {p.sittingOut && <span style={{ ...S.badge, background: '#555', color: '#bbb' }}>WAIT</span>}
                {p.isWinner   && <span style={{ ...S.badge, background: 'var(--gold-bright)', color: '#1a1200' }}>👑WIN</span>}
              </div>

              {/* 名前 */}
              <p style={{ ...S.pName, ...(p.isSelf ? { color: 'var(--gold-bright)' } : {}), fontSize: isMobile ? 10 : 12 }}>
                {p.isSelf ? `${p.name} (YOU)` : p.name}
              </p>

              {/* チップ & ベット */}
              <div style={S.chipRow}>
                <span style={{ ...S.chipAmt, fontSize: isMobile ? 11 : 14 }}>💵{p.chips}</span>
                {p.bet > 0 && <span style={{ ...S.betAmt, fontSize: isMobile ? 10 : 13 }}>B{p.bet}</span>}
              </div>

              {/* タイマーバー */}
              {p.isMyTurn && meta.timerLimit > 0 && timerSec !== null && (
                <TimerBar remaining={timerSec} limit={meta.timerLimit} />
              )}

              {/* 手札 */}
              <div style={{ ...S.hand, gap: isMobile ? 2 : (p.isSelf ? 6 : 3) }}>
                {p.hand.map((code, j) => (
                  <Card
                    key={j} code={code}
                    size={p.isSelf ? cardSize : otherCardSize}
                    selected={p.isSelf && selected.includes(j)}
                    clickable={p.isSelf && isDrawPhase && isMyTurn && !myDrew}
                    folded={p.folded}
                    onClick={() => handleCardClick(j)}
                  />
                ))}
              </div>

              {/* 他プレイヤーのドロー枚数 */}
              {!p.isSelf && (isDrawPhase || isBetPhase) && (() => {
                const count = isDrawPhase
                  ? (p.drewThisRound ? p.drawCount : null)
                  : lastDrawCount[p.id] ?? null;
                if (count === null) return isDrawPhase ? <p style={S.drawInfo}>⏳</p> : null;
                return <p style={{ ...S.drawInfo, fontSize: isMobile ? 9 : 12 }}>{count === 0 ? '✋ pat' : `🔄 ${count}`}</p>;
              })()}

              {/* 役 */}
              {p.result && (
                <p style={{ ...S.result, ...(p.isWinner ? { color: 'var(--gold-bright)', fontWeight: '700' } : {}), fontSize: isMobile ? 9 : 12 }}>
                  {p.result}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* ===== アクションパネル ===== */}
      <div style={S.actionPanel}>

        {/* 待機中 */}
        {meta.phase === 'waiting' && (
          <div style={S.waitBox}>
            <span style={S.waitDot} />
            <span style={{ ...S.waitText, fontSize: isMobile ? 14 : 17 }}>
              {players.length < 2 ? 'もう1人参加するとゲームが自動で始まります' : 'ゲームを準備中...'}
            </span>
          </div>
        )}

        {/* ドロー: 自分のターン */}
        {isDrawPhase && isMyTurn && !myDrew && (
          <div style={S.actionBox}>
            <p style={{ ...S.actionHint, fontSize: isMobile ? 13 : 16 }}>
              {selected.length > 0 ? `${selected.length}枚選択中` : '捨てるカードを選択（0枚 = スタンドパット）'}
            </p>
            <div style={S.btnRow}>
              <button onClick={handleDraw} style={S.btnGold}>
                {selected.length > 0 ? `🔄 ${selected.length}枚ドロー` : '✋ Stand Pat'}
              </button>
              {selected.length > 0 && <button onClick={() => setSelected([])} style={S.btnOutline}>解除</button>}
            </div>
          </div>
        )}

        {/* ドロー: 待機 */}
        {isDrawPhase && (!isMyTurn || myDrew) && (
          <div style={S.waitBox}>
            <span style={S.waitDot} />
            <span style={{ ...S.waitText, fontSize: isMobile ? 13 : 16 }}>
              {myDrew ? '他のプレイヤーを待っています...' : `${curPlayer?.name ?? ''} がドロー中...`}
            </span>
          </div>
        )}

        {/* ベット: 自分のターン */}
        {isBetPhase && isMyTurn && self && (
          <div style={S.actionBox}>
            <p style={{ ...S.actionHint, fontSize: isMobile ? 12 : 15 }}>
              {self.toCall! > 0
                ? `コール: ${self.toCall}　ベット単位: ${self.betSize}　レイズ: ${meta.raiseCount}/${meta.maxRaises}`
                : `チェック or ベット　単位: ${self.betSize}　レイズ: ${meta.raiseCount}/${meta.maxRaises}`}
            </p>
            <div style={S.btnRow}>
              <button onClick={() => handleBet('fold')}  style={{ ...S.btnRed,  fontSize: isMobile ? 13 : 15 }}>フォールド</button>
              {self.canCheck
                ? <button onClick={() => handleBet('check')} style={{ ...S.btnGray, fontSize: isMobile ? 13 : 15 }}>チェック</button>
                : <button onClick={() => handleBet('call')}  style={{ ...S.btnGray, fontSize: isMobile ? 13 : 15 }}>コール ({self.toCall})</button>
              }
              {self.canRaise && (
                <button onClick={() => handleBet(meta.currentBet === 0 ? 'bet' : 'raise')} style={{ ...S.btnGold, fontSize: isMobile ? 13 : 15 }}>
                  {meta.currentBet === 0 ? `ベット(${self.betSize})` : `レイズ(+${self.betSize})`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ベット: 待機 */}
        {isBetPhase && !isMyTurn && (
          <div style={S.waitBox}>
            <span style={S.waitDot} />
            <span style={{ ...S.waitText, fontSize: isMobile ? 13 : 16 }}>
              {curPlayer ? `${curPlayer.name} がアクション中...` : '待機中...'}
            </span>
          </div>
        )}

        {/* ショーダウン後（次ゲームは自動スタート） */}
        {meta.phase === 'showdown' && (
          <div style={S.waitBox}>
            <span style={S.waitDot} />
            <span style={{ ...S.waitText, fontSize: isMobile ? 13 : 16 }}>
              次のゲームを準備中... (3秒)
            </span>
          </div>
        )}
      </div>

      {/* ルール注記 */}
      <p style={{ ...S.ruleNote, fontSize: isMobile ? 10 : 12 }}>
        {effectiveMode === 'badugi'
          ? '★ Badugi: 全スート異なる低い4枚が最強。枚数が多い方が強い。'
          : '★ 2-7 Lowball: 低い手が強い。フラッシュ・ストレートは弱い手。Aは常に最高位。'}
      </p>
    </div>
  );
};

// ===== スタイル =====
const S: Record<string, React.CSSProperties> = {
  page:        { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: 16, position: 'relative', zIndex: 1, fontFamily: 'var(--font-body)', overflowX: 'hidden' },
  nav:         { width: '100%', maxWidth: 1140, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 10px', borderBottom: '1px solid var(--gold-dim)' },
  navLeft:     { display: 'flex', alignItems: 'center', gap: 8 },
  navLogo:     { fontFamily: 'var(--font-title)', fontSize: 18, color: 'var(--gold)', letterSpacing: '0.07em' },
  navCenter:   { display: 'flex', alignItems: 'center', gap: 10 },
  modeBadge:   { fontFamily: 'var(--font-title)', fontSize: 10, padding: '3px 8px', borderRadius: 4, letterSpacing: '0.05em' },
  phaseTag:    { fontFamily: 'var(--font-title)', fontSize: 13, letterSpacing: '0.25em', color: 'var(--gold-bright)', background: 'rgba(201,168,76,0.12)', border: '1px solid var(--gold-dim)', borderRadius: 4, padding: '4px 12px' },
  dots:        { display: 'flex', gap: 6, alignItems: 'center' },
  dot:         { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', transition: 'all 0.3s' },
  navRoom:     { fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--cream-dim)', letterSpacing: '0.1em', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  leaveBtn:    { fontFamily: 'var(--font-title)', fontSize: 10, padding: '5px 11px', background: 'rgba(139,26,26,0.5)', border: '1px solid rgba(204,34,34,0.4)', borderRadius: 4, color: '#ffaaaa', cursor: 'pointer' },
  pendingBar:  { width: '100%', maxWidth: 1140, background: 'rgba(201,168,76,0.08)', borderBottom: '1px solid rgba(201,168,76,0.2)', padding: '5px 16px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--gold-dim)', fontStyle: 'italic' },
  potBar:      { display: 'flex', gap: 12, alignItems: 'center', padding: '6px 0 2px', justifyContent: 'center', flexWrap: 'wrap' as const },
  potChip:     { display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--gold-dim)', borderRadius: 16, padding: '5px 14px' },
  potAmt:      { fontFamily: 'var(--font-title)', fontSize: 12, color: 'var(--cream-dim)', letterSpacing: '0.04em' },
  tableWrap:   { position: 'relative', margin: '2px auto' },
  felt:        { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '68%', height: '60%', borderRadius: '50%', background: 'radial-gradient(ellipse at 40% 40%, #1a6b42, #0a3320)', border: '6px solid var(--gold-dim)', boxShadow: '0 0 30px rgba(0,0,0,0.8), inset 0 0 24px rgba(0,0,0,0.4)', zIndex: 0 },
  feltInner:   { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 'calc(68% - 16px)', height: 'calc(60% - 16px)', borderRadius: '50%', border: '1px solid rgba(201,168,76,0.2)', zIndex: 0 },
  pBox:        { position: 'absolute', zIndex: 1, textAlign: 'center', padding: '6px 5px', borderRadius: 10, border: '1px solid transparent', transition: 'all 0.25s' },
  pBoxSelf:    { background: 'rgba(10,50,30,0.8)', border: '1px solid rgba(201,168,76,0.35)' },
  pBoxActive:  { border: '1px solid var(--gold)', boxShadow: '0 0 16px rgba(201,168,76,0.5)', background: 'rgba(201,168,76,0.08)' },
  pBoxFolded:  { opacity: 0.4 },
  pBoxSitting: { opacity: 0.5, border: '1px solid rgba(255,255,255,0.1)' },
  pBoxWinner:  { border: '1px solid var(--gold-bright)', boxShadow: '0 0 20px rgba(240,208,96,0.6)', background: 'rgba(201,168,76,0.12)' },
  badgeRow:    { display: 'flex', gap: 3, justifyContent: 'center', marginBottom: 3, flexWrap: 'wrap' as const },
  badge:       { fontSize: 9, fontFamily: 'var(--font-title)', padding: '1px 5px', borderRadius: 3 },
  pName:       { fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--cream)', letterSpacing: '0.04em', margin: '0 0 2px', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  chipRow:     { display: 'flex', justifyContent: 'center', gap: 5, marginBottom: 3, flexWrap: 'wrap' as const },
  chipAmt:     { fontFamily: 'var(--font-body)', fontSize: 13, color: '#88dd88' },
  betAmt:      { fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--gold)', background: 'rgba(201,168,76,0.15)', borderRadius: 3, padding: '0 4px' },
  hand:        { display: 'flex', justifyContent: 'center', flexWrap: 'nowrap' as const, margin: '3px 0' },
  drawInfo:    { fontSize: 11, color: '#88bbff', fontFamily: 'var(--font-body)', marginTop: 2, fontStyle: 'italic' },
  result:      { fontSize: 11, color: 'var(--cream-dim)', fontFamily: 'var(--font-title)', marginTop: 3, letterSpacing: '0.03em' },
  actionPanel: { width: '100%', maxWidth: 1100, display: 'flex', justifyContent: 'center', padding: '6px 12px 0' },
  actionBox:   { background: 'linear-gradient(160deg, rgba(22,92,56,0.5), rgba(10,51,32,0.7))', border: '1px solid var(--gold-dim)', borderRadius: 10, padding: '14px 20px', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 10, width: '100%', maxWidth: 600 },
  actionHint:  { fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--cream-dim)', fontStyle: 'italic', textAlign: 'center' as const },
  btnRow:      { display: 'flex', gap: 10, flexWrap: 'wrap' as const, justifyContent: 'center' },
  btnGold:     { padding: '11px 22px', background: 'linear-gradient(135deg, var(--gold), var(--gold-dim))', border: 'none', borderRadius: 6, color: '#1a1200', fontSize: 14, fontWeight: '700', cursor: 'pointer', letterSpacing: '0.05em', boxShadow: '0 3px 12px rgba(201,168,76,0.4)' },
  btnGray:     { padding: '11px 18px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: 'var(--cream)', fontSize: 14, cursor: 'pointer' },
  btnRed:      { padding: '11px 18px', background: 'var(--red)', border: 'none', borderRadius: 6, color: '#ffd0d0', fontSize: 14, cursor: 'pointer' },
  btnOutline:  { padding: '11px 16px', background: 'transparent', border: '1px solid var(--gold-dim)', borderRadius: 6, color: 'var(--cream-dim)', fontSize: 13, cursor: 'pointer' },
  waitBox:     { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 },
  waitDot:     { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--gold)', opacity: 0.7, flexShrink: 0 },
  waitText:    { fontFamily: 'var(--font-body)', fontSize: 16, color: 'var(--cream-dim)', fontStyle: 'italic' },
  ruleNote:    { textAlign: 'center' as const, fontSize: 11, color: 'var(--gold-dim)', fontFamily: 'var(--font-body)', marginTop: 10, padding: '0 12px' },
};

export default PokerTable;
