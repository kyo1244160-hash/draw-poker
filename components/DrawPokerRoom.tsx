/**
 * DrawPokerRoom.tsx — 2-7 トリプルドロー ゲーム画面
 * カードはHTML/CSSで描画（画像ファイル不要）
 */
import { useEffect, useState } from 'react';
import { socket } from '../socket';

// ===== 型定義 =====
type Player = {
  id: string; name: string; chips: number; bet: number;
  folded: boolean; hand: string[]; isSelf: boolean; isMyTurn: boolean;
  drewThisRound: boolean; drawCount: number | null;
  result?: string; isWinner?: boolean;
  isDealer: boolean; isSB: boolean; isBB: boolean;
  toCall?: number; canCheck?: boolean; canRaise?: boolean; betSize?: number;
};
type Meta = { phase: string; pot: number; currentBet: number; betSize: number; raiseCount: number; dealerIndex: number; };
type Props = { roomId: string; name: string };

// ===== カード描画ヘルパー =====
const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLOR:  Record<string, string> = { S: '#1a1a2e', H: '#cc1111', D: '#cc1111', C: '#1a1a2e' };
const RANK_LABEL:  Record<string, string> = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };

function parseCard(code: string): { rank: string; suit: string } | null {
  if (!code || code === '??' || code.length < 2) return null;
  return { rank: code.slice(0, -1), suit: code.slice(-1) };
}

/** HTML カードコンポーネント */
function Card({
  code, size = 'md', selected = false, clickable = false, folded = false,
  onClick,
}: {
  code: string; size?: 'sm' | 'md' | 'lg';
  selected?: boolean; clickable?: boolean; folded?: boolean;
  onClick?: () => void;
}) {
  const dim = {
    sm: { w: 50, h: 72,  r: 5, ch: 17 },
    md: { w: 62, h: 88,  r: 6, ch: 21 },
    lg: { w: 80, h: 116, r: 7, ch: 27 },
  }[size];
  const parsed = parseCard(code);
  const isFaceDown = !parsed;
  const color = parsed ? SUIT_COLOR[parsed.suit] : '#fff';
  const symbol = parsed ? SUIT_SYMBOL[parsed.suit] : '';
  const rankStr = parsed ? (RANK_LABEL[parsed.rank] ?? parsed.rank) : '';

  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{
        position: 'relative',
        width: dim.w,
        height: dim.h,
        borderRadius: 6,
        background: isFaceDown
          ? 'linear-gradient(135deg, #1a4a8a 0%, #0d2d5c 50%, #1a4a8a 100%)'
          : '#fffdf6',
        border: selected ? '2.5px solid #e84040' : '1.5px solid rgba(0,0,0,0.25)',
        boxShadow: selected
          ? '0 0 12px rgba(232,64,64,0.6), 0 3px 10px rgba(0,0,0,0.5)'
          : '0 3px 10px rgba(0,0,0,0.45)',
        cursor: clickable ? 'pointer' : 'default',
        opacity: folded ? 0.35 : 1,
        transform: selected ? 'translateY(-14px)' : 'none',
        transition: 'transform 0.15s, box-shadow 0.15s, border 0.1s',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '3px 4px',
        userSelect: 'none',
      }}
    >
      {isFaceDown ? (
        // カード裏面: ダイヤ柄
        <div style={{ position: 'absolute', inset: 4, borderRadius: 4, border: '1.5px solid rgba(255,255,255,0.2)', background: 'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,0.04) 4px, rgba(255,255,255,0.04) 8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: dim.ch * 1.4, color: 'rgba(180,210,255,0.4)', lineHeight: 1 }}>♦</span>
        </div>
      ) : (
        <>
          {/* 左上: ランク + スート */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.1 }}>
            <span style={{ fontSize: dim.ch, fontWeight: '800', color, fontFamily: 'Georgia, serif', letterSpacing: '-0.03em' }}>{rankStr}</span>
            <span style={{ fontSize: dim.ch * 0.85, color, lineHeight: 1 }}>{symbol}</span>
          </div>
          {/* 中央スート */}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: dim.ch * 1.8, color, opacity: 0.12, lineHeight: 1 }}>{symbol}</span>
          </div>
          {/* 右下: ランク + スート（逆さ） */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1, transform: 'rotate(180deg)' }}>
            <span style={{ fontSize: dim.ch, fontWeight: '800', color, fontFamily: 'Georgia, serif', letterSpacing: '-0.03em' }}>{rankStr}</span>
            <span style={{ fontSize: dim.ch * 0.85, color, lineHeight: 1 }}>{symbol}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ===== メインコンポーネント =====
const PHASE_LABEL: Record<string, string> = {
  waiting: 'WAITING', draw1: 'DRAW  I', bet1: 'BET  I',
  draw2: 'DRAW  II', bet2: 'BET  II',
  draw3: 'DRAW  III', bet3: 'BET  III', showdown: 'SHOWDOWN',
};

export default function DrawPokerRoom({ roomId, name }: Props) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [meta, setMeta] = useState<Meta>({ phase: 'waiting', pot: 0, currentBet: 0, betSize: 10, raiseCount: 0, dealerIndex: -1 });
  const [selected, setSelected] = useState<number[]>([]);
  const [myDrew, setMyDrew] = useState(false);

  useEffect(() => {
    const onConnect = () => socket.emit('joinRoom', { roomId, name });
    const onGameState = ({ players: pl, meta: m }: { players: Player[]; meta: Meta }) => {
      setPlayers(pl); setMeta(m);
      const self = pl.find((p) => p.isSelf);
      if (self) setMyDrew(self.drewThisRound);
    };
    const onGameStarted = () => { setSelected([]); setMyDrew(false); };
    socket.on('connect', onConnect);
    socket.on('gameState', onGameState);
    socket.on('gameStarted', onGameStarted);
    socket.on('showdown', () => {});
    if (socket.connected) socket.emit('joinRoom', { roomId, name });
    else socket.connect();
    return () => {
      socket.off('connect', onConnect); socket.off('gameState', onGameState);
      socket.off('gameStarted', onGameStarted); socket.off('showdown');
    };
  }, [roomId, name]);

  const self = players.find((p) => p.isSelf);
  const isDrawPhase = meta.phase.startsWith('draw');
  const isBetPhase = meta.phase.startsWith('bet');
  const isMyTurn = self?.isMyTurn ?? false;
  const drawRound = ['draw1','draw2','draw3'].indexOf(meta.phase) + 1;

  const handleCardClick = (j: number) => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    setSelected((prev) => prev.includes(j) ? prev.filter((i) => i !== j) : [...prev, j]);
  };
  const handleDraw = () => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    socket.emit('drawCards', { roomId, indices: selected });
    setMyDrew(true); setSelected([]);
  };
  const handleBet = (action: string) => socket.emit('betAction', { roomId, action });

  // テーブルレイアウト
  const TW = 1100; const TH = 820;
  const CX = TW / 2; const CY = TH / 2 - 10;
  const RX = 400; const RY = 285;
  const BW = 260;
  const others = players.filter((p) => !p.isSelf);

  const getPos = (p: Player) => {
    let ang: number;
    if (p.isSelf) { ang = 90; }
    else {
      const slots = [-90, -30, 30, 150, 210];
      const idx = others.findIndex((o) => o.id === p.id);
      ang = slots[idx] ?? -90 + 60 * (idx + 1);
    }
    const rad = (ang * Math.PI) / 180;
    const cx = CX + RX * Math.cos(rad);
    const cy = CY + RY * Math.sin(rad);
    const bh = p.isSelf ? 240 : 185;
    return { left: cx - BW / 2, top: cy - bh / 2 };
  };

  const curPlayer = players.find((p) => p.isMyTurn);

  return (
    <div style={S.page}>
      {/* ナビ */}
      <nav style={S.nav}>
        <span style={S.navLogo}>2-7 Triple Draw</span>
        <div style={S.navCenter}>
          <span style={S.phaseTag}>{PHASE_LABEL[meta.phase] ?? meta.phase}</span>
          {isDrawPhase && (
            <span style={S.dots}>
              {[1,2,3].map((n) => (
                <span key={n} style={{ ...S.dot, background: n <= drawRound ? 'var(--gold-bright)' : 'rgba(255,255,255,0.15)', boxShadow: n === drawRound ? '0 0 8px var(--gold)' : 'none' }} />
              ))}
            </span>
          )}
        </div>
        <span style={S.navRoom}>{roomId.toUpperCase()}</span>
      </nav>

      {/* ポット */}
      {meta.phase !== 'waiting' && (
        <div style={S.potBar}>
          <div style={S.potChip}>
            <span style={S.potIcon}>🏦</span>
            <span style={S.potAmt}>POT&nbsp;&nbsp;<b style={{ color: 'var(--gold-bright)', fontSize: '20px' }}>{meta.pot}</b></span>
          </div>
          {isBetPhase && meta.currentBet > 0 && (
            <div style={S.potChip}>
              <span style={S.potAmt}>CURRENT BET&nbsp;&nbsp;<b style={{ color: 'var(--cream)', fontSize: '18px' }}>{meta.currentBet}</b></span>
            </div>
          )}
        </div>
      )}

      {/* テーブル */}
      <div style={{ ...S.tableWrap, width: TW, height: TH }}>
        <div style={S.felt} />
        <div style={S.feltInner} />

        {players.map((p) => {
          const { left, top } = getPos(p);
          // 自分のカードは大きく、他プレイヤーは小さく
          const cardSize = p.isSelf ? 'lg' : 'sm';

          return (
            <div key={p.id} style={{
              ...S.pBox, left, top, width: BW,
              ...(p.isSelf ? S.pBoxSelf : {}),
              ...(p.isMyTurn && !p.folded ? S.pBoxActive : {}),
              ...(p.folded ? S.pBoxFolded : {}),
              ...(p.isWinner ? S.pBoxWinner : {}),
            }}>
              {/* バッジ */}
              <div style={S.badgeRow}>
                {p.isDealer && <span style={{ ...S.badge, background: 'var(--gold)', color: '#1a1200' }}>BTN</span>}
                {p.isSB    && <span style={{ ...S.badge, background: 'var(--chip-blue)', color: '#fff' }}>SB</span>}
                {p.isBB    && <span style={{ ...S.badge, background: 'var(--chip-orange)', color: '#fff' }}>BB</span>}
                {p.folded  && <span style={{ ...S.badge, background: '#444', color: '#aaa' }}>FOLD</span>}
                {p.isWinner && <span style={{ ...S.badge, background: 'var(--gold-bright)', color: '#1a1200' }}>WIN 👑</span>}
              </div>

              {/* 名前 */}
              <p style={{ ...S.pName, ...(p.isSelf ? { color: 'var(--gold-bright)' } : {}) }}>
                {p.isSelf ? `${p.name} (YOU)` : p.name}
              </p>

              {/* チップ & ベット */}
              <div style={S.chipRow}>
                <span style={S.chipAmt}>💵 {p.chips}</span>
                {p.bet > 0 && <span style={S.betAmt}>BET {p.bet}</span>}
              </div>

              {/* 手札 */}
              <div style={{ ...S.hand, gap: p.isSelf ? '7px' : '4px' }}>
                {p.hand.map((card, j) => (
                  <Card
                    key={j}
                    code={card}
                    size={cardSize}
                    selected={p.isSelf && selected.includes(j)}
                    clickable={p.isSelf && isDrawPhase && isMyTurn && !myDrew}
                    folded={p.folded}
                    onClick={() => handleCardClick(j)}
                  />
                ))}
              </div>

              {/* 選択中ガイド */}
              {p.isSelf && selected.length > 0 && !myDrew && (
                <p style={S.discardHint}>選択中 {selected.length} 枚 — もう一度タップで解除</p>
              )}

              {/* 他プレイヤーのドロー枚数通知 */}
              {!p.isSelf && isDrawPhase && p.drawCount !== null && (
                <p style={S.drawInfo}>
                  {p.drewThisRound
                    ? p.drawCount === 0 ? '✋ Stand pat' : `🔄 ${p.drawCount} cards`
                    : '⏳ thinking...'}
                </p>
              )}

              {/* 役 */}
              {p.result && (
                <p style={{ ...S.result, ...(p.isWinner ? { color: 'var(--gold-bright)', fontWeight: '700' } : {}) }}>
                  {p.result}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* アクションパネル */}
      <div style={S.actionPanel}>
        {meta.phase === 'waiting' && (
          <div style={S.actionBox}>
            <p style={S.actionHint}>2人以上集まったらゲームを開始できます</p>
            <button onClick={() => socket.emit('startGame', { roomId })} style={S.btnGold}>ゲームを開始する</button>
          </div>
        )}

        {isDrawPhase && isMyTurn && !myDrew && (
          <div style={S.actionBox}>
            <p style={S.actionHint}>
              {selected.length > 0 ? `${selected.length}枚を選択中 — もう一度タップで解除` : '捨てるカードをタップして選択（0〜5枚）'}
            </p>
            <div style={S.btnRow}>
              <button onClick={handleDraw} style={S.btnGold}>
                {selected.length > 0 ? `🔄 ${selected.length}枚ドロー` : '✋ Stand Pat（交換なし）'}
              </button>
              {selected.length > 0 && (
                <button onClick={() => setSelected([])} style={S.btnOutline}>選択解除</button>
              )}
            </div>
          </div>
        )}

        {isDrawPhase && (!isMyTurn || myDrew) && (
          <div style={S.waitBox}>
            <span style={S.waitDot} />
            <span style={S.waitText}>
              {myDrew ? '他のプレイヤーを待っています...' : curPlayer ? `${curPlayer.name} がドロー中...` : '待機中...'}
            </span>
          </div>
        )}

        {isBetPhase && isMyTurn && self && (
          <div style={S.actionBox}>
            <p style={S.actionHint}>
              {self.toCall! > 0 ? `コールに必要: ${self.toCall}　ベット単位: ${self.betSize}` : `チェックまたはベット可能　ベット単位: ${self.betSize}`}
            </p>
            <div style={S.btnRow}>
              <button onClick={() => handleBet('fold')} style={S.btnRed}>フォールド</button>
              {self.canCheck
                ? <button onClick={() => handleBet('check')} style={S.btnGray}>チェック</button>
                : <button onClick={() => handleBet('call')} style={S.btnGray}>コール ({self.toCall})</button>
              }
              {self.canRaise && (
                <button onClick={() => handleBet(meta.currentBet === 0 ? 'bet' : 'raise')} style={S.btnGold}>
                  {meta.currentBet === 0 ? `ベット (${self.betSize})` : `レイズ (+${self.betSize})`}
                </button>
              )}
            </div>
          </div>
        )}

        {isBetPhase && !isMyTurn && (
          <div style={S.waitBox}>
            <span style={S.waitDot} />
            <span style={S.waitText}>{curPlayer ? `${curPlayer.name} がアクション中...` : '待機中...'}</span>
          </div>
        )}

        {meta.phase === 'showdown' && (
          <div style={S.actionBox}>
            <button onClick={() => socket.emit('startGame', { roomId })} style={S.btnGold}>🔁 もう一度プレイ</button>
          </div>
        )}
      </div>

      <p style={S.ruleNote}>♠ 2-7 Lowball: 低い手が強い。フラッシュ・ストレートは弱い手。A は常に最高位。</p>
    </div>
  );
}

// ===== スタイル =====
const S: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: '24px', position: 'relative', zIndex: 1, fontFamily: 'var(--font-body)' },
  nav: { width: '100%', maxWidth: '1140px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px 14px', borderBottom: '1px solid var(--gold-dim)' },
  navLogo: { fontFamily: 'var(--font-title)', fontSize: '24px', color: 'var(--gold)', letterSpacing: '0.08em' },
  navCenter: { display: 'flex', alignItems: 'center', gap: '16px' },
  phaseTag: { fontFamily: 'var(--font-title)', fontSize: '16px', letterSpacing: '0.35em', color: 'var(--gold-bright)', background: 'rgba(201,168,76,0.12)', border: '1px solid var(--gold-dim)', borderRadius: '4px', padding: '6px 18px' },
  dots: { display: 'flex', gap: '9px', alignItems: 'center' },
  dot: { display: 'inline-block', width: '13px', height: '13px', borderRadius: '50%', transition: 'all 0.3s' },
  navRoom: { fontFamily: 'var(--font-title)', fontSize: '16px', color: 'var(--cream-dim)', letterSpacing: '0.2em' },
  potBar: { display: 'flex', gap: '28px', alignItems: 'center', padding: '10px 0 6px', justifyContent: 'center' },
  potChip: { display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--gold-dim)', borderRadius: '24px', padding: '7px 22px' },
  potIcon: { fontSize: '20px' },
  potAmt: { fontFamily: 'var(--font-title)', fontSize: '15px', color: 'var(--cream-dim)', letterSpacing: '0.05em' },
  tableWrap: { position: 'relative', margin: '2px auto' },
  felt: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '70%', height: '62%', borderRadius: '50%', background: 'radial-gradient(ellipse at 40% 40%, #1a6b42, #0a3320)', border: '8px solid var(--gold-dim)', boxShadow: '0 0 40px rgba(0,0,0,0.8), inset 0 0 30px rgba(0,0,0,0.4)', zIndex: 0 },
  feltInner: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 'calc(70% - 20px)', height: 'calc(62% - 20px)', borderRadius: '50%', border: '1px solid rgba(201,168,76,0.25)', zIndex: 0 },
  pBox: { position: 'absolute', zIndex: 1, textAlign: 'center', padding: '10px 8px', borderRadius: '12px', border: '1px solid transparent', transition: 'all 0.25s' },
  pBoxSelf: { background: 'rgba(10,50,30,0.75)', border: '1px solid rgba(201,168,76,0.3)' },
  pBoxActive: { border: '1px solid var(--gold)', boxShadow: '0 0 20px rgba(201,168,76,0.5)', background: 'rgba(201,168,76,0.08)' },
  pBoxFolded: { opacity: 0.45 },
  pBoxWinner: { border: '1px solid var(--gold-bright)', boxShadow: '0 0 24px rgba(240,208,96,0.6)', background: 'rgba(201,168,76,0.12)' },
  badgeRow: { display: 'flex', gap: '5px', justifyContent: 'center', marginBottom: '5px', flexWrap: 'wrap' as const },
  badge: { fontSize: '11px', fontFamily: 'var(--font-title)', padding: '3px 8px', borderRadius: '4px', letterSpacing: '0.05em' },
  pName: { fontFamily: 'var(--font-title)', fontSize: '13px', color: 'var(--cream)', letterSpacing: '0.05em', margin: '0 0 4px', whiteSpace: 'nowrap' as const },
  chipRow: { display: 'flex', justifyContent: 'center', gap: '10px', marginBottom: '6px', flexWrap: 'wrap' as const },
  chipAmt: { fontFamily: 'var(--font-body)', fontSize: '16px', color: '#88dd88' },
  betAmt: { fontFamily: 'var(--font-body)', fontSize: '15px', color: 'var(--gold)', background: 'rgba(201,168,76,0.15)', borderRadius: '3px', padding: '0 6px' },
  hand: { display: 'flex', justifyContent: 'center', flexWrap: 'nowrap' as const, margin: '5px 0' },
  discardHint: { fontSize: '11px', color: '#e84040', fontFamily: 'var(--font-body)', margin: '4px 0 0', fontStyle: 'italic' },
  drawInfo: { fontSize: '13px', color: '#88bbff', fontFamily: 'var(--font-body)', marginTop: '4px', fontStyle: 'italic' },
  result: { fontSize: '14px', color: 'var(--cream-dim)', fontFamily: 'var(--font-title)', marginTop: '4px', letterSpacing: '0.04em' },
  actionPanel: { width: '100%', maxWidth: '1100px', display: 'flex', justifyContent: 'center', padding: '8px 16px 0' },
  actionBox: { background: 'linear-gradient(160deg, rgba(22,92,56,0.5), rgba(10,51,32,0.7))', border: '1px solid var(--gold-dim)', borderRadius: '12px', padding: '20px 36px', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: '14px', minWidth: '440px' },
  actionHint: { fontFamily: 'var(--font-body)', fontSize: '19px', color: 'var(--cream-dim)', fontStyle: 'italic', textAlign: 'center' as const },
  btnRow: { display: 'flex', gap: '14px', flexWrap: 'wrap' as const, justifyContent: 'center' },
  btnGold: { padding: '14px 32px', background: 'linear-gradient(135deg, var(--gold), var(--gold-dim))', border: 'none', borderRadius: '7px', color: '#1a1200', fontSize: '16px', fontWeight: '700', cursor: 'pointer', letterSpacing: '0.06em', boxShadow: '0 3px 14px rgba(201,168,76,0.4)' },
  btnGray: { padding: '14px 28px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '7px', color: 'var(--cream)', fontSize: '16px', cursor: 'pointer', letterSpacing: '0.04em' },
  btnRed: { padding: '14px 26px', background: 'var(--red)', border: 'none', borderRadius: '7px', color: '#ffd0d0', fontSize: '16px', cursor: 'pointer', letterSpacing: '0.04em' },
  btnOutline: { padding: '14px 24px', background: 'transparent', border: '1px solid var(--gold-dim)', borderRadius: '7px', color: 'var(--cream-dim)', fontSize: '15px', cursor: 'pointer' },
  waitBox: { display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 28px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px' },
  waitDot: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: 'var(--gold)', opacity: 0.7 },
  waitText: { fontFamily: 'var(--font-body)', fontSize: '19px', color: 'var(--cream-dim)', fontStyle: 'italic' },
  ruleNote: { textAlign: 'center' as const, fontSize: '14px', color: 'var(--gold-dim)', fontFamily: 'var(--font-body)', marginTop: '16px', letterSpacing: '0.02em' },
};
