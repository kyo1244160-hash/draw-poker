/**
 * components/ThreeCardTable.tsx
 * スリーカードポーカー テーブルUI
 *
 * 既存の PokerTable.tsx / TournamentTable.tsx と同じ楕円形テーブルレイアウト。
 * - 最大6プレイヤーが楕円状に着席
 * - 他プレイヤーの手は裏向き（reveal フェーズのみ表向き）
 * - テーブル中央に ANTE / PAIR+ / 6CARD ベットエリア
 * - 右パネルにチップ選択 + アクションボタン
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ===== 型定義 =====
interface TCResult {
  net:             number;
  dealerQualified: boolean;
  won:             boolean;
  push?:           boolean;
  folded?:         boolean;
  anteBonusMult?:  number;
  ppPayout?:       number;
  sixCardPayout?:  number;
  playerEval?:     string;
  dealerEval?:     string;
}

interface TCPlayer {
  name:      string;
  isSelf:    boolean;
  points:    number;
  bets:      { ante: number; pp: number; sixCard: number };
  hand:      string[];
  action:    string | null;
  betReady:  boolean;
  handLabel: string | null;   // action フェーズ以降に自分の役名が入る
  result:    TCResult | null;
}

export interface TCState {
  roomId:     string;
  phase:      string;
  handCount:  number;
  players:    TCPlayer[];
  dealerHand: string[] | null;
  maxPlayers: number;
}

interface Props {
  state:    TCState;
  onBet:    (ante: number, pp: number, sixCard: number) => void;
  onAction: (action: 'play' | 'fold') => void;
  onLeave:  () => void;
}

// ===== 定数 =====
const CHIP_VALUES = [1, 5, 10, 25, 50, 100];
const BET_MIN = 1;
const BET_MAX = 100;  // サーバーと同値に統一
const SUIT_SYMBOL: Record<string,string> = { S:'♠', H:'♥', D:'♦', C:'♣' };
const SUIT_COLOR:  Record<string,string> = { S:'#1a1a2e', H:'#c0392b', D:'#c0392b', C:'#1a1a2e' };
const RANK_LABEL:  Record<string,string> = { T:'10', J:'J', Q:'Q', K:'K', A:'A' };
const PHASE_LABEL: Record<string,string> = {
  waiting:'待機中', betting:'ベット', dealt:'配布中',
  action:'プレイ / フォールド', reveal:'公開中', result:'結果',
};

// ===== カード =====
function CardFace({ code, size='md' }: { code:string; size?:'sm'|'md'|'lg' }) {
  const r=code[0], s=code[1];
  const label=RANK_LABEL[r]??r, col=SUIT_COLOR[s]??'#1a1a2e', sym=SUIT_SYMBOL[s]??s;
  const [w,h,fs] = size==='lg'?[62,90,18]:size==='md'?[48,70,14]:[38,56,11];
  return (
    <div style={{width:w,height:h,borderRadius:6,background:'white',
      border:'1.5px solid rgba(0,0,0,0.15)',boxShadow:'0 2px 6px rgba(0,0,0,0.3)',
      display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
      position:'relative',flexShrink:0,userSelect:'none'}}>
      <div style={{position:'absolute',top:2,left:4,fontSize:fs-4,color:col,lineHeight:1,fontWeight:700}}>
        {label}<br/>{sym}
      </div>
      <div style={{fontSize:fs+2,color:col,lineHeight:1}}>{sym}</div>
      <div style={{position:'absolute',bottom:2,right:4,fontSize:fs-4,color:col,
        lineHeight:1,fontWeight:700,transform:'rotate(180deg)'}}>
        {label}<br/>{sym}
      </div>
    </div>
  );
}

function CardBack({ size='md' }: { size?:'sm'|'md'|'lg' }) {
  const [w,h] = size==='lg'?[62,90]:size==='md'?[48,70]:[38,56];
  return (
    <div style={{width:w,height:h,borderRadius:6,
      background:'linear-gradient(135deg,#1a4a3a,#0d2e24)',
      border:'1.5px solid rgba(201,168,76,0.5)',boxShadow:'0 2px 6px rgba(0,0,0,0.4)',
      display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
      <div style={{width:'70%',height:'80%',border:'1px solid rgba(201,168,76,0.3)',
        borderRadius:4,display:'flex',alignItems:'center',justifyContent:'center',
        fontSize:12,color:'rgba(201,168,76,0.35)'}}>♦</div>
    </div>
  );
}

function Hand({ cards, size='md', hidden=false }: { cards:string[]; size?:'sm'|'md'|'lg'; hidden?:boolean }) {
  const gap = size==='lg' ? 6 : 4;
  return (
    <div style={{display:'flex',gap}}>
      {(hidden ? ['??','??','??'] : cards.length>0 ? cards : ['??','??','??']).map((c,i)=>
        c==='??' ? <CardBack key={i} size={size}/> : <CardFace key={i} code={c} size={size}/>
      )}
    </div>
  );
}

// ===== ベットスポット =====
function BetSpot({ label, amount, active, onClick }: {
  label: string; amount: number; active: boolean; onClick?: () => void;
}) {
  return (
    <div onClick={onClick} style={{
      display:'flex',flexDirection:'column',alignItems:'center',gap:3,
      cursor:onClick?'pointer':'default',
    }}>
      <div style={{
        width:64,height:64,borderRadius:'50%',
        background: amount>0
          ? 'radial-gradient(circle,rgba(201,168,76,0.25),rgba(201,168,76,0.08))'
          : active
            ? 'radial-gradient(circle,rgba(255,255,255,0.06),rgba(255,255,255,0.02))'
            : 'rgba(0,0,0,0.2)',
        border: amount>0
          ? '2px solid var(--gold)'
          : active
            ? '2px dashed rgba(201,168,76,0.5)'
            : '2px dashed rgba(255,255,255,0.15)',
        boxShadow: amount>0 ? '0 0 12px rgba(201,168,76,0.3)' : 'none',
        display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
        transition:'all 0.15s',
      }}>
        <div style={{fontFamily:'var(--font-title)',fontSize:9,letterSpacing:'0.12em',
          color:amount>0?'var(--gold)':'rgba(255,255,255,0.4)',textAlign:'center',lineHeight:1.2}}>
          {label}
        </div>
        {amount>0&&(
          <div style={{fontFamily:'var(--font-title)',fontSize:11,color:'var(--gold)',marginTop:2}}>
            {amount}
          </div>
        )}
      </div>
    </div>
  );
}

// ===== プレイヤーボックス =====
function PlayerBox({ player, phase }: { player:TCPlayer; phase:string }) {
  const isReveal = phase==='reveal'||phase==='result';
  const showCards = player.isSelf || isReveal;
  const net = player.result?.net ?? 0;
  const showHandLabel = player.isSelf && (phase==='action'||phase==='reveal'||phase==='result') && player.handLabel;

  return (
    <div style={{
      display:'flex',flexDirection:'column',alignItems:'center',gap:4,
      background: player.isSelf
        ? 'linear-gradient(160deg,rgba(18,60,38,0.85),rgba(8,38,24,0.9))'
        : 'rgba(0,0,0,0.55)',
      border: player.isSelf
        ? '1px solid rgba(201,168,76,0.4)'
        : '1px solid rgba(255,255,255,0.12)',
      borderRadius:8,padding:'6px 8px',minWidth:140,
      backdropFilter:'blur(4px)',
    }}>
      {/* 名前 */}
      <div style={{fontFamily:'var(--font-title)',fontSize:10,letterSpacing:'0.08em',
        color:player.isSelf?'var(--gold)':'var(--cream-dim)',whiteSpace:'nowrap',maxWidth:130,
        overflow:'hidden',textOverflow:'ellipsis'}}>
        {player.isSelf?'▶ ':''}{player.name}
      </div>
      {/* ポイント */}
      <div style={{fontFamily:'var(--font-body)',fontSize:11,color:player.isSelf?'#88dd88':'var(--cream-dim)'}}>
        {player.points.toLocaleString()} pt
      </div>
      {/* 手札 */}
      <Hand cards={player.hand} size={player.isSelf?'md':'sm'} hidden={!showCards}/>
      {/* A) カードの下に役を常時表示（dealt以降） */}
      {showHandLabel && (
        <div style={{
          fontSize:11,fontFamily:'var(--font-title)',letterSpacing:'0.06em',
          color:'var(--gold)',marginTop:1,
          textShadow:'0 0 8px rgba(201,168,76,0.5)',
        }}>
          {player.handLabel}
        </div>
      )}
      {/* アクション表示 */}
      {player.action&&!isReveal&&(
        <div style={{fontSize:10,fontFamily:'var(--font-title)',letterSpacing:'0.05em',
          color:player.action==='play'?'#88cc88':'#e88',marginTop:2}}>
          {player.action==='play'?'PLAY':'FOLD'}
        </div>
      )}
      {/* ベット状態（betting フェーズ） */}
      {!isReveal&&player.betReady&&phase==='betting'&&(
        <div style={{fontSize:10,color:'var(--gold-dim)',fontFamily:'var(--font-title)'}}>
          {player.bets.ante>0?`ANTE ${player.bets.ante}`:'---'}
        </div>
      )}
      {/* 結果 */}
      {isReveal&&player.result&&(
        <div style={{fontSize:11,fontFamily:'var(--font-title)',letterSpacing:'0.05em',
          color:net>0?'#66cc88':net<0?'#cc5566':'var(--cream-dim)'}}>
          {net>0?'+':''}{net}pt
        </div>
      )}
    </div>
  );
}

// ===== メインコンポーネント =====
export default function ThreeCardTable({ state, onBet, onAction, onLeave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // コンテナサイズ監視
  useEffect(() => {
    const update = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setSize({ w: width, h: height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // ベット状態
  const [selectedChip, setSelectedChip] = useState(10);
  const [pendingBets, setPendingBets] = useState({ ante: 0, pp: 0, sixCard: 0 });

  // B) 役ポップアップ（dealt直後に中央表示）
  const [handPopup, setHandPopup] = useState<{ label: string; visible: boolean } | null>(null);

  // 勝敗エフェクト
  const [resultEffect, setResultEffect] = useState<'win' | 'lose' | 'push' | null>(null);

  const self = state.players.find(p => p.isSelf);
  const others = state.players.filter(p => !p.isSelf);
  const phase = state.phase;
  const isReveal = phase === 'reveal' || phase === 'result';
  const isBetting = phase === 'betting';
  const isAction = phase === 'action';

  // フェーズ変化でベット状態リセット
  useEffect(() => {
    if (phase === 'betting') setPendingBets({ ante: 0, pp: 0, sixCard: 0 });
  }, [phase, state.handCount]);

  // B) dealt → action 遷移時に役ポップアップ表示
  useEffect(() => {
    if (phase === 'action' && self?.handLabel) {
      setHandPopup({ label: self.handLabel, visible: true });
      const t = setTimeout(() => setHandPopup(null), 2000);
      return () => clearTimeout(t);
    }
  }, [phase, state.handCount]); // eslint-disable-line

  // 結果エフェクト（result フェーズ移行時）
  useEffect(() => {
    if (phase === 'result' && self?.result) {
      const net = self.result.net ?? 0;
      const effect = net > 0 ? 'win' : net < 0 ? 'lose' : 'push';
      setResultEffect(effect);
      const t = setTimeout(() => setResultEffect(null), 2000);
      return () => clearTimeout(t);
    }
  }, [phase, state.handCount]); // eslint-disable-line

  // ベットスポットクリック
  const addBet = useCallback((spot: 'ante' | 'pp' | 'sixCard') => {
    if (!isBetting || self?.betReady) return;
    const myPoints = self?.points ?? 0;
    const current = pendingBets[spot];
    // 各スポットが BET_MAX を超えないようにキャップ
    const addAmount = Math.min(selectedChip, BET_MAX - current);
    if (addAmount <= 0) return;
    // 合計が所持ポイントを超えないようにチェック
    const total = pendingBets.ante + pendingBets.pp + pendingBets.sixCard + addAmount;
    if (total > myPoints) return;
    setPendingBets(prev => ({ ...prev, [spot]: prev[spot] + addAmount }));
  }, [isBetting, self, pendingBets, selectedChip]);

  const clearBets = () => setPendingBets({ ante: 0, pp: 0, sixCard: 0 });

  const handleDeal = () => {
    if (pendingBets.ante < 1) return;
    onBet(pendingBets.ante, pendingBets.pp, pendingBets.sixCard);
  };

  // ===== レイアウト計算 =====
  const isPC = size.w > 700;
  const ACT_W = isPC ? 220 : 0;
  const TW = isPC ? size.w - ACT_W - 8 : size.w;
  const TH = size.h;
  const CX = TW / 2;
  const CY = TH * 0.48;
  const RX = TW * 0.36;
  const RY = TH * 0.34;

  // プレイヤー座標（自分=下部90°、他は上部に分散）
  const getPos = (p: TCPlayer) => {
    let ang: number;
    if (p.isSelf) { ang = 90; }
    else {
      const slots = [-90, -150, -30, 150, 30]; // 上部を中心に配置
      const idx = others.findIndex(o => o.name === p.name);
      ang = slots[idx] ?? (-90 + 60 * (idx + 1));
    }
    const rad = (ang * Math.PI) / 180;
    return { x: CX + RX * Math.cos(rad), y: CY + RY * Math.sin(rad) };
  };

  // ディーラー座標（上部中央）
  const dealerPos = { x: CX, y: CY - RY - 60 };

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>

      {/* ===== CSS アニメーション定義 ===== */}
      <style>{`
        @keyframes tc-popup-in {
          0%   { opacity:0; transform:translate(-50%,-50%) scale(0.6); }
          35%  { opacity:1; transform:translate(-50%,-50%) scale(1.08); }
          60%  { transform:translate(-50%,-50%) scale(1); }
          80%  { opacity:1; }
          100% { opacity:0; transform:translate(-50%,-50%) scale(1.05); }
        }
        @keyframes tc-flash-win {
          0%   { opacity:0; }
          15%  { opacity:0.35; }
          60%  { opacity:0.18; }
          100% { opacity:0; }
        }
        @keyframes tc-flash-lose {
          0%   { opacity:0; }
          15%  { opacity:0.45; }
          60%  { opacity:0.2; }
          100% { opacity:0; }
        }
        @keyframes tc-result-text {
          0%   { opacity:0; transform:translate(-50%,-50%) scale(0.7) translateY(12px); }
          25%  { opacity:1; transform:translate(-50%,-50%) scale(1) translateY(0); }
          70%  { opacity:1; transform:translate(-50%,-50%) scale(1) translateY(0); }
          100% { opacity:0; transform:translate(-50%,-50%) scale(0.9) translateY(-8px); }
        }
      `}</style>

      {/* ===== 背景フラッシュエフェクト ===== */}
      {resultEffect && resultEffect !== 'push' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none',
          background: resultEffect === 'win'
            ? 'radial-gradient(ellipse at center,rgba(201,168,76,0.55),rgba(100,180,80,0.2) 60%,transparent 100%)'
            : 'radial-gradient(ellipse at center,rgba(180,40,40,0.6),rgba(120,20,20,0.2) 60%,transparent 100%)',
          animation: resultEffect === 'win' ? 'tc-flash-win 2s ease-out forwards' : 'tc-flash-lose 2s ease-out forwards',
        }} />
      )}

      {/* ===== 勝敗テキストエフェクト ===== */}
      {resultEffect && (
        <div style={{
          position: 'absolute', left: '50%', top: '45%',
          transform: 'translate(-50%,-50%)',
          zIndex: 21, pointerEvents: 'none',
          animation: 'tc-result-text 2s ease-out forwards',
          textAlign: 'center',
        }}>
          <div style={{
            fontFamily: 'var(--font-title)',
            fontSize: resultEffect === 'push' ? 28 : 42,
            letterSpacing: '0.2em',
            color: resultEffect === 'win' ? '#f5d76e' : resultEffect === 'lose' ? '#e07070' : 'var(--cream-dim)',
            textShadow: resultEffect === 'win'
              ? '0 0 30px rgba(201,168,76,0.9),0 0 60px rgba(201,168,76,0.5)'
              : resultEffect === 'lose'
                ? '0 0 30px rgba(200,60,60,0.8)'
                : 'none',
          }}>
            {resultEffect === 'win' ? 'WIN' : resultEffect === 'lose' ? 'LOSE' : 'PUSH'}
          </div>
          {self?.result && (
            <div style={{
              fontFamily: 'var(--font-title)', fontSize: 22, letterSpacing: '0.1em', marginTop: 6,
              color: resultEffect === 'win' ? '#f5d76e' : resultEffect === 'lose' ? '#e07070' : 'var(--cream-dim)',
              textShadow: resultEffect === 'win' ? '0 0 20px rgba(201,168,76,0.7)' : 'none',
            }}>
              {(self.result.net ?? 0) >= 0 ? '+' : ''}{self.result.net ?? 0} pt
            </div>
          )}
        </div>
      )}

      {/* ===== B) 役ポップアップ（dealt→action時） ===== */}
      {handPopup && (
        <div style={{
          position: 'absolute', left: '50%', top: '55%',
          zIndex: 18, pointerEvents: 'none',
          animation: 'tc-popup-in 2s ease-out forwards',
        }}>
          <div style={{
            fontFamily: 'var(--font-title)', fontSize: 20, letterSpacing: '0.25em',
            color: 'var(--gold)',
            textShadow: '0 0 20px rgba(201,168,76,0.8)',
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(201,168,76,0.4)',
            borderRadius: 8, padding: '8px 20px',
            whiteSpace: 'nowrap',
          }}>
            {handPopup.label}
          </div>
        </div>
      )}

      {/* ===== テーブルエリア ===== */}
      <div ref={containerRef} style={{ position: 'relative', flex: 1, minWidth: 0, height: '100%' }}>

        {/* 楕円フェルト */}
        <div style={{
          position: 'absolute',
          left: CX - RX - 24, top: CY - RY - 24,
          width: (RX + 24) * 2, height: (RY + 24) * 2,
          borderRadius: '50%',
          background: 'radial-gradient(ellipse at 40% 35%,#1a6b42,#0a3320)',
          border: '8px solid var(--gold-dim)',
          boxShadow: '0 0 40px rgba(0,0,0,0.8),inset 0 0 30px rgba(0,0,0,0.4)',
          zIndex: 0,
        }} />
        {/* 内枠 */}
        <div style={{
          position: 'absolute',
          left: CX - RX - 12, top: CY - RY - 12,
          width: (RX + 12) * 2, height: (RY + 12) * 2,
          borderRadius: '50%',
          border: '1px solid rgba(201,168,76,0.2)',
          zIndex: 0, pointerEvents: 'none',
        }} />

        {/* ===== テーブル中央：ベットエリア ===== */}
        <div style={{
          position: 'absolute',
          left: CX, top: CY - 20,
          transform: 'translate(-50%,-50%)',
          zIndex: 3,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        }}>
          {/* フェーズ表示 */}
          <div style={{ fontFamily: 'var(--font-title)', fontSize: 10, letterSpacing: '0.2em',
            color: 'rgba(201,168,76,0.6)', marginBottom: 2 }}>
            {PHASE_LABEL[phase] ?? phase}
          </div>

          {/* ベットスポット横並び */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <BetSpot
              label="ANTE"
              amount={isBetting && !self?.betReady ? pendingBets.ante : self?.bets.ante ?? 0}
              active={isBetting && !self?.betReady}
              onClick={() => addBet('ante')}
            />
            <BetSpot
              label={'PAIR\nPLUS'}
              amount={isBetting && !self?.betReady ? pendingBets.pp : self?.bets.pp ?? 0}
              active={isBetting && !self?.betReady}
              onClick={() => addBet('pp')}
            />
            <BetSpot
              label={'6CARD\nBONUS'}
              amount={isBetting && !self?.betReady ? pendingBets.sixCard : self?.bets.sixCard ?? 0}
              active={isBetting && !self?.betReady}
              onClick={() => addBet('sixCard')}
            />
          </div>

          {/* PLAY スポット（action フェーズ or 確定後） */}
          {(isAction || isReveal || (isBetting && self?.betReady)) && (
            <BetSpot
              label="PLAY"
              amount={
                isReveal
                  ? (self?.bets.ante ?? 0)
                  : isAction
                    ? (self?.action === 'play' ? self.bets.ante : 0)
                    : 0
              }
              active={false}
            />
          )}

          {/* ハンド番号 */}
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 10,
            color: 'rgba(201,168,76,0.4)', marginTop: 2 }}>
            Hand #{state.handCount}
          </div>
        </div>

        {/* ===== ディーラーエリア ===== */}
        <div style={{
          position: 'absolute',
          left: dealerPos.x, top: dealerPos.y,
          transform: 'translate(-50%,-50%)',
          zIndex: 4,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
        }}>
          <div style={{ fontFamily: 'var(--font-title)', fontSize: 10, letterSpacing: '0.15em',
            color: 'var(--gold-dim)' }}>DEALER</div>
          <Hand
            cards={isReveal && state.dealerHand ? state.dealerHand : ['??','??','??']}
            size={isPC ? 'md' : 'sm'}
          />
          {isReveal && self?.result && (
            <div style={{ fontSize: 10, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)',
              textAlign: 'center', maxWidth: 160 }}>
              {self.result.dealerEval}
              {!self.result.dealerQualified &&
                <span style={{ color: '#88cc88', marginLeft: 4 }}>（不参加）</span>}
            </div>
          )}
        </div>

        {/* ===== プレイヤーボックス ===== */}
        {state.players.map((p, i) => {
          const { x, y } = getPos(p);
          return (
            <div key={i} style={{
              position: 'absolute',
              left: x, top: y,
              transform: 'translate(-50%,-50%)',
              zIndex: 4,
            }}>
              <PlayerBox player={p} phase={phase} />
            </div>
          );
        })}
      </div>

      {/* ===== 右パネル（PC）===== */}
      {isPC && (
        <div style={{
          width: ACT_W, flexShrink: 0,
          background: 'linear-gradient(160deg,rgba(22,62,42,0.7),rgba(10,38,24,0.85))',
          border: '1px solid var(--gold-dim)', borderRadius: 12,
          margin: 8,
          display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 14px',
          overflowY: 'auto',
        }}>
          {/* 自分の情報 */}
          <div style={{ textAlign: 'center', borderBottom: '1px solid rgba(201,168,76,0.2)', paddingBottom: 10 }}>
            <div style={{ fontFamily: 'var(--font-title)', fontSize: 12, color: 'var(--gold)', letterSpacing: '0.1em' }}>
              {self?.name ?? '---'}
            </div>
            <div style={{ fontFamily: 'var(--font-title)', fontSize: 16, color: '#88dd88', marginTop: 4 }}>
              {(self?.points ?? 0).toLocaleString()} pt
            </div>
          </div>

          {/* チップ選択 */}
          {isBetting && !self?.betReady && (
            <div>
              <div style={{ fontFamily: 'var(--font-title)', fontSize: 9, letterSpacing: '0.15em',
                color: 'var(--gold-dim)', marginBottom: 8 }}>CHIP</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {CHIP_VALUES.map(v => (
                  <button key={v} onClick={() => setSelectedChip(v)} style={{
                    width: 42, height: 42, borderRadius: '50%',
                    background: selectedChip === v
                      ? 'radial-gradient(circle,#c9a84c,#8a6a20)'
                      : 'radial-gradient(circle,rgba(255,255,255,0.12),rgba(255,255,255,0.04))',
                    border: selectedChip === v ? '2px solid var(--gold)' : '2px solid rgba(255,255,255,0.2)',
                    color: selectedChip === v ? '#fff' : 'var(--cream-dim)',
                    fontFamily: 'var(--font-title)', fontSize: 11, fontWeight: 700,
                    cursor: 'pointer', boxShadow: selectedChip === v ? '0 0 8px rgba(201,168,76,0.5)' : 'none',
                    transition: 'all 0.15s',
                  }}>
                    {v}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: 'var(--cream-dim)', marginTop: 8, fontFamily: 'var(--font-body)' }}>
                ベットエリアをクリックして配置
              </div>
            </div>
          )}

          {/* ベット内訳 */}
          {isBetting && !self?.betReady && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[
                { label: 'ANTE', val: pendingBets.ante, required: true },
                { label: 'PAIR PLUS', val: pendingBets.pp, required: false },
                { label: '6CARD BONUS', val: pendingBets.sixCard, required: false },
              ].map(({ label, val, required }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: required ? 'var(--cream)' : 'var(--cream-dim)',
                    fontFamily: 'var(--font-body)' }}>
                    {label}{required && <span style={{ color: '#e77', fontSize: 9, marginLeft: 3 }}>必須</span>}
                  </span>
                  <span style={{ fontFamily: 'var(--font-title)', fontSize: 13,
                    color: val > 0 ? 'var(--gold)' : 'rgba(255,255,255,0.25)' }}>
                    {val > 0 ? val : '-'}
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 5 }}>
                <span style={{ fontSize: 10, color: 'var(--cream-dim)' }}>合計</span>
                <span style={{ fontFamily: 'var(--font-title)', fontSize: 13, color: 'var(--cream)' }}>
                  {pendingBets.ante + pendingBets.pp + pendingBets.sixCard}
                </span>
              </div>
            </div>
          )}

          {/* ベット確定後（待機中） */}
          {isBetting && self?.betReady && (
            <div style={{ fontSize: 12, color: 'var(--cream-dim)', textAlign: 'center', fontFamily: 'var(--font-body)' }}>
              ベット確定済み
            </div>
          )}

          {/* アクションボタン */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto' }}>
            {isBetting && !self?.betReady && (
              <>
                <button onClick={clearBets} style={{ ...Sb.btn, background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.15)', color: 'var(--cream-dim)', fontSize: 11 }}>
                  クリア
                </button>
                <button
                  onClick={handleDeal}
                  disabled={pendingBets.ante < 1}
                  style={{ ...Sb.btn,
                    background: pendingBets.ante >= 1 ? 'linear-gradient(135deg,#c9a84c,#a8862f)' : 'rgba(100,100,100,0.3)',
                    color: 'white', opacity: pendingBets.ante >= 1 ? 1 : 0.5,
                    cursor: pendingBets.ante >= 1 ? 'pointer' : 'not-allowed',
                  }}>
                  DEAL →
                </button>
              </>
            )}
            {isAction && self && !self.action && (
              <>
                <button onClick={() => onAction('fold')}
                  style={{ ...Sb.btn, background: 'linear-gradient(135deg,#7a2a2a,#5a1a1a)', color: 'white' }}>
                  FOLD
                </button>
                <button onClick={() => onAction('play')}
                  style={{ ...Sb.btn, background: 'linear-gradient(135deg,#2a7a4a,#1a5a34)', color: 'white' }}>
                  PLAY +{self.bets.ante}pt
                </button>
              </>
            )}
            {isAction && self?.action && (
              <div style={{ textAlign: 'center', fontFamily: 'var(--font-title)', fontSize: 13,
                color: self.action === 'play' ? '#88cc88' : '#e88', letterSpacing: '0.1em' }}>
                {self.action === 'play' ? '▶ PLAY' : '✕ FOLD'}
              </div>
            )}
            {isReveal && self?.result && (
              <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(201,168,76,0.2)',
                borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)' }}>
                    {self.result.folded ? 'FOLD' : self.result.push ? 'PUSH' : self.result.won ? 'WIN' : 'LOSE'}
                  </span>
                  <span style={{ fontFamily: 'var(--font-title)', fontSize: 14,
                    color: (self.result.net??0) > 0 ? '#66cc88' : (self.result.net??0) < 0 ? '#cc5566' : 'var(--cream-dim)' }}>
                    {(self.result.net??0) >= 0 ? '+' : ''}{self.result.net ?? 0}pt
                  </span>
                </div>
                {(self.result.anteBonusMult ?? 0) > 0 && (
                  <div style={Sb.bonus}>アンテボーナス ×{self.result.anteBonusMult}</div>
                )}
                {(self.result.ppPayout ?? 0) > 0 && (
                  <div style={Sb.bonus}>ペアプラス ×{self.result.ppPayout}</div>
                )}
                {(self.result.sixCardPayout ?? 0) > 0 && (
                  <div style={Sb.bonus}>6カード ×{self.result.sixCardPayout}</div>
                )}
                {!self.result.dealerQualified && !self.result.folded && (
                  <div style={Sb.bonus}>ディーラー不参加</div>
                )}
                <div style={{ fontSize: 10, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)',
                  marginTop: 4, textAlign: 'center' }}>
                  次のハンドを準備中...
                </div>
              </div>
            )}
            {/* 退席ボタン */}
            <button onClick={onLeave}
              style={{ ...Sb.btn, background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.35)',
                fontSize: 10, marginTop: 4 }}>
              退席
            </button>
          </div>
        </div>
      )}

      {/* ===== スマホ下部パネル ===== */}
      {!isPC && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: 'rgba(8,32,20,0.92)', borderTop: '1px solid rgba(201,168,76,0.2)',
          padding: '8px 12px', zIndex: 10,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {isBetting && !self?.betReady && (
            <>
              <div style={{ display: 'flex', gap: 5, justifyContent: 'center', flexWrap: 'wrap' }}>
                {CHIP_VALUES.map(v => (
                  <button key={v} onClick={() => setSelectedChip(v)} style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: selectedChip === v ? 'radial-gradient(circle,#c9a84c,#8a6a20)' : 'rgba(255,255,255,0.1)',
                    border: selectedChip === v ? '2px solid var(--gold)' : '1px solid rgba(255,255,255,0.2)',
                    color: selectedChip === v ? '#fff' : 'var(--cream-dim)',
                    fontFamily: 'var(--font-title)', fontSize: 10, cursor: 'pointer',
                  }}>{v}</button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                {(['ante','pp','sixCard'] as const).map(spot => (
                  <button key={spot} onClick={() => addBet(spot)} style={{
                    flex: 1, padding: '6px 0',
                    background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.3)',
                    borderRadius: 6, color: 'var(--gold)', fontFamily: 'var(--font-title)',
                    fontSize: 9, cursor: 'pointer',
                  }}>
                    {spot === 'ante' ? 'ANTE' : spot === 'pp' ? 'PP' : '6C'}
                    {pendingBets[spot] > 0 && <span style={{ display: 'block', fontSize: 10 }}>{pendingBets[spot]}</span>}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={clearBets} style={{ flex: 1, ...Sb.btn, fontSize: 11,
                  background: 'rgba(255,255,255,0.06)', color: 'var(--cream-dim)' }}>クリア</button>
                <button onClick={handleDeal} disabled={pendingBets.ante < 1} style={{ flex: 2, ...Sb.btn,
                  background: pendingBets.ante >= 1 ? 'linear-gradient(135deg,#c9a84c,#a8862f)' : 'rgba(100,100,100,0.3)',
                  color: 'white', opacity: pendingBets.ante >= 1 ? 1 : 0.5 }}>
                  DEAL →
                </button>
              </div>
            </>
          )}
          {isAction && self && !self.action && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => onAction('fold')}
                style={{ flex: 1, ...Sb.btn, background: 'linear-gradient(135deg,#7a2a2a,#5a1a1a)', color: 'white' }}>
                FOLD
              </button>
              <button onClick={() => onAction('play')}
                style={{ flex: 1, ...Sb.btn, background: 'linear-gradient(135deg,#2a7a4a,#1a5a34)', color: 'white' }}>
                PLAY +{self.bets.ante}pt
              </button>
            </div>
          )}
          {isReveal && self?.result && (
            <div style={{ textAlign: 'center', fontFamily: 'var(--font-title)', fontSize: 14,
              color: (self.result.net??0)>0?'#66cc88':(self.result.net??0)<0?'#cc5566':'var(--cream-dim)' }}>
              {(self.result.net??0)>=0?'+':''}{self.result.net??0}pt
            </div>
          )}
          <button onClick={onLeave} style={{ ...Sb.btn, background: 'rgba(255,255,255,0.04)',
            color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>退席</button>
        </div>
      )}
    </div>
  );
}

const Sb: Record<string, React.CSSProperties> = {
  btn: {
    fontFamily: 'var(--font-title)', fontSize: 12, letterSpacing: '0.08em',
    border: 'none', borderRadius: 7, padding: '10px 0', cursor: 'pointer', width: '100%',
  },
  bonus: {
    fontSize: 10, color: 'var(--gold)', background: 'rgba(201,168,76,0.1)',
    border: '1px solid rgba(201,168,76,0.2)', borderRadius: 3,
    padding: '2px 6px', fontFamily: 'var(--font-title)',
  },
};
