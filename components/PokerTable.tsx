/**
 * PokerTable.tsx — ゲームテーブル共通コンポーネント
 *
 * PC版 / スマホ版で完全にレイアウトを切り替えます。
 * - PC版:  楕円テーブル、大きな文字
 * - スマホ版: コンパクトなテーブル、修正済みレイアウト
 *
 * レイズ表示: "現在段階 / 上限" 形式（例: 1/5, 2/5）
 * タイムアウト:
 *   ドロー → 選択中カードを交換（updateSelected イベントで随時送信）
 *   ベット → フォールド
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

// ===== 定数 =====
const PHASE_LABEL: Record<string, string> = {
  waiting: 'WAITING', bet0: 'BET (Pre-Draw)',
  draw1: 'DRAW I', bet1: 'BET I',
  draw2: 'DRAW II', bet2: 'BET II',
  draw3: 'DRAW III', bet3: 'BET III',
  showdown: 'SHOWDOWN',
};

const MODE_LABEL: Record<string, string> = {
  '27': '2-7 Triple Draw', badugi: 'Badugi', mix: 'Mix',
};

// ===== コンポーネント =====
const PokerTable: React.FC<Props> = ({ roomId, name, mode }) => {
  const router = useRouter();

  // ----- 状態 -----
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
  // PC/スマホ判定（SSR安全）
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // ----- Socket.IO -----
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

  // ----- 計算 -----
  const self         = players.find((p) => p.isSelf);
  const isDrawPhase  = meta.phase.startsWith('draw');
  const isBetPhase   = meta.phase.startsWith('bet');
  const isMyTurn     = self?.isMyTurn ?? false;
  const drawRound    = ['draw1','draw2','draw3'].indexOf(meta.phase) + 1;
  const curPlayer    = players.find((p) => p.isMyTurn);
  const effectiveMode = meta.currentMode ?? (mode === 'mix' ? '27' : mode);
  const phaseIsBet   = meta.phase.startsWith('bet');
  const phaseIsDraw  = meta.phase.startsWith('draw');

  // レイズ表示: "現在段階/上限" → raiseCount + 1 が現在の「bet」段階
  // 例: raiseCount=0 → 誰もベット/レイズしていない → "0/5"（ベット前）
  //     raiseCount=1 → 1回ベット済み → "1/5"
  const raiseDisplay = `${meta.raiseCount}/${meta.maxRaises + 1}`;

  // ----- ハンドラ -----
  const handleCardClick = useCallback((j: number) => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    setSelected((prev) => {
      const next = prev.includes(j) ? prev.filter((i) => i !== j) : [...prev, j];
      // タイムアウト用に選択状態をサーバーに随時送信
      socket.emit('updateSelected', { roomId, indices: next });
      return next;
    });
  }, [isDrawPhase, isMyTurn, myDrew, roomId]);

  const handleDraw = () => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    socket.emit('drawCards', { roomId, indices: selected });
    setMyDrew(true); setSelected([]);
  };

  const handleBet   = (action: string) => socket.emit('betAction', { roomId, action });
  const handleLeave = () => { socket.emit('leaveRoom', { roomId }); router.push('/'); };

  // ----- モード色 -----
  const modeColor  = effectiveMode === 'badugi' ? '#cc9966' : '#88bbee';
  const modeBg     = effectiveMode === 'badugi' ? 'rgba(204,119,68,0.22)' : 'rgba(68,136,204,0.22)';
  const modeBorder = effectiveMode === 'badugi' ? 'rgba(204,119,68,0.45)' : 'rgba(68,136,204,0.45)';

  // ----- アクションパネル（共通）-----
  const ActionPanel = () => (
    <div style={isMobile ? SM.actionPanel : PC.actionPanel}>
      {meta.phase === 'waiting' && (
        <div style={isMobile ? SM.waitBox : PC.waitBox}>
          <span style={dot} />
          <span style={isMobile ? SM.waitText : PC.waitText}>
            {players.length < 2 ? 'もう1人参加するとゲームが自動で始まります' : 'ゲームを準備中...'}
          </span>
        </div>
      )}

      {isDrawPhase && isMyTurn && !myDrew && (
        <div style={isMobile ? SM.actionBox : PC.actionBox}>
          <p style={isMobile ? SM.actionHint : PC.actionHint}>
            {selected.length > 0 ? `${selected.length}枚選択中` : '捨てるカードを選択（0枚 = スタンドパット）'}
          </p>
          <div style={btnRow}>
            <button onClick={handleDraw} style={isMobile ? SM.btnGold : PC.btnGold}>
              {selected.length > 0 ? `🔄 ${selected.length}枚ドロー` : '✋ Stand Pat'}
            </button>
            {selected.length > 0 && (
              <button onClick={() => { setSelected([]); socket.emit('updateSelected', { roomId, indices: [] }); }} style={isMobile ? SM.btnOutline : PC.btnOutline}>解除</button>
            )}
          </div>
        </div>
      )}

      {isDrawPhase && (!isMyTurn || myDrew) && (
        <div style={isMobile ? SM.waitBox : PC.waitBox}>
          <span style={dot} />
          <span style={isMobile ? SM.waitText : PC.waitText}>
            {myDrew ? '他プレイヤーを待っています...' : `${curPlayer?.name ?? ''} がドロー中...`}
          </span>
        </div>
      )}

      {isBetPhase && isMyTurn && self && (
        <div style={isMobile ? SM.actionBox : PC.actionBox}>
          <p style={isMobile ? SM.actionHint : PC.actionHint}>
            {self.toCall! > 0
              ? `コール: ${self.toCall}　単位: ${self.betSize}　Bet ${raiseDisplay}`
              : `チェック or ベット　単位: ${self.betSize}　Bet ${raiseDisplay}`}
          </p>
          <div style={btnRow}>
            <button onClick={() => handleBet('fold')}  style={isMobile ? SM.btnRed  : PC.btnRed}>フォールド</button>
            {self.canCheck
              ? <button onClick={() => handleBet('check')} style={isMobile ? SM.btnGray : PC.btnGray}>チェック</button>
              : <button onClick={() => handleBet('call')}  style={isMobile ? SM.btnGray : PC.btnGray}>コール ({self.toCall})</button>
            }
            {self.canRaise && (
              <button onClick={() => handleBet(meta.currentBet === 0 ? 'bet' : 'raise')} style={isMobile ? SM.btnGold : PC.btnGold}>
                {meta.currentBet === 0 ? `ベット(${self.betSize})` : `レイズ(+${self.betSize})`}
              </button>
            )}
          </div>
        </div>
      )}

      {isBetPhase && !isMyTurn && (
        <div style={isMobile ? SM.waitBox : PC.waitBox}>
          <span style={dot} />
          <span style={isMobile ? SM.waitText : PC.waitText}>
            {curPlayer ? `${curPlayer.name} がアクション中...` : '待機中...'}
          </span>
        </div>
      )}

      {meta.phase === 'showdown' && (
        <div style={isMobile ? SM.waitBox : PC.waitBox}>
          <span style={dot} />
          <span style={isMobile ? SM.waitText : PC.waitText}>次のゲームを準備中... (3秒)</span>
        </div>
      )}
    </div>
  );

  // ==========================================================
  // ■ スマホ版レイアウト
  // ==========================================================
  if (isMobile) {
    const others = players.filter((p) => !p.isSelf);
    const selfPlayer = players.find((p) => p.isSelf);

    // スマホ版: 上部に相手プレイヤー、下部に自分
    return (
      <div style={SM.page}>
        {/* ナビ */}
        <nav style={SM.nav}>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <svg width="22" height="22" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="32" r="30" stroke="#c9a84c" strokeWidth="2" fill="#0a3320"/>
              <text x="32" y="40" fontSize="22" fontWeight="bold" fill="#c9a84c" fontFamily="serif" textAnchor="middle">P</text>
            </svg>
            <span style={{ fontFamily:'var(--font-title)', fontSize:13, color:'var(--gold)', letterSpacing:'0.06em' }}>Pastis</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ ...SM.modeBadge, background: modeBg, color: modeColor, border:`1px solid ${modeBorder}` }}>
              {mode === 'mix' ? `Mix→${effectiveMode==='badugi'?'Badugi':'2-7'}` : MODE_LABEL[effectiveMode]}
            </span>
            <span style={SM.phaseTagSm}>{PHASE_LABEL[meta.phase] ?? meta.phase}</span>
          </div>
          <button onClick={handleLeave} style={SM.leaveBtn}>退室</button>
        </nav>

        {/* pending */}
        {meta.pendingPlayers.length > 0 && (
          <div style={SM.pendingBar}>⏳ 次ゲームから: {meta.pendingPlayers.join(', ')}</div>
        )}

        {/* ポット */}
        {meta.phase !== 'waiting' && (
          <div style={SM.potBar}>
            <span style={SM.potChip}>🏦 <b style={{color:'var(--gold-bright)'}}>{meta.pot}</b></span>
            {isBetPhase && meta.currentBet > 0 && (
              <span style={SM.potChip}>BET <b>{meta.currentBet}</b></span>
            )}
            {isBetPhase && (
              <span style={SM.potChip}>Bet {raiseDisplay}</span>
            )}
          </div>
        )}

        {/* フェーズ中央表示 */}
        {meta.phase !== 'waiting' && (
          <div style={SM.centerPhase}>
            <span style={{ fontSize:10, color:modeColor, fontFamily:'var(--font-title)', letterSpacing:'0.1em' }}>
              {MODE_LABEL[effectiveMode]}
            </span>
            <span style={{
              fontSize: 16,
              fontFamily: 'var(--font-title)',
              color: phaseIsBet ? 'var(--gold-bright)' : phaseIsDraw ? '#88ddff' : 'var(--cream)',
              letterSpacing: '0.12em',
            }}>
              {PHASE_LABEL[meta.phase]}
            </span>
            {isDrawPhase && (
              <div style={{ display:'flex', gap:5 }}>
                {[1,2,3].map((n) => (
                  <span key={n} style={{ width:8, height:8, borderRadius:'50%', display:'inline-block',
                    background: n <= drawRound ? 'var(--gold-bright)' : 'rgba(255,255,255,0.2)',
                    boxShadow: n === drawRound ? '0 0 5px var(--gold)' : 'none' }} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* 相手プレイヤーエリア（横スクロール対応） */}
        <div style={SM.othersArea}>
          {others.map((p) => (
            <div key={p.id} style={{
              ...SM.otherBox,
              ...(p.isMyTurn && !p.folded ? SM.otherBoxActive : {}),
              ...(p.folded ? {opacity:0.45} : {}),
              ...(p.isWinner ? SM.winnerBox : {}),
            }}>
              {/* バッジ */}
              <div style={{display:'flex',gap:2,justifyContent:'center',marginBottom:2,flexWrap:'wrap' as const}}>
                {p.isDealer && <span style={badgeSm('#c9a84c','#1a1200')}>BTN</span>}
                {p.isSB     && <span style={badgeSm('#2244aa','#fff')}>SB</span>}
                {p.isBB     && <span style={badgeSm('#b85a10','#fff')}>BB</span>}
                {p.folded && !p.sittingOut && <span style={badgeSm('#444','#aaa')}>FOLD</span>}
                {p.sittingOut && <span style={badgeSm('#555','#bbb')}>WAIT</span>}
                {p.isWinner && <span style={badgeSm('#f0d060','#1a1200')}>👑</span>}
              </div>
              <p style={SM.otherName}>{p.name}</p>
              <p style={SM.otherChips}>💵{p.chips}{p.bet > 0 ? ` B${p.bet}` : ''}</p>
              {/* 手札（裏面 or showdown時表面）*/}
              <div style={{display:'flex',gap:2,justifyContent:'center',margin:'3px 0'}}>
                {p.hand.map((code, j) => (
                  <Card key={j} code={code} size="sm" folded={p.folded} />
                ))}
              </div>
              {/* ドロー枚数 */}
              {(isDrawPhase || isBetPhase) && p.drawCount !== null && (
                <p style={{fontSize:9,color:'#88bbff',fontStyle:'italic',margin:'1px 0'}}>
                  {p.drewThisRound || isBetPhase ? (p.drawCount === 0 ? '✋ pat' : `🔄 ${p.drawCount}`) : '⏳'}
                </p>
              )}
              {/* 役 */}
              {p.result && (
                <p style={{fontSize:10,color:p.isWinner?'var(--gold-bright)':'var(--cream-dim)',fontFamily:'var(--font-title)',fontWeight:p.isWinner?'700':'400'}}>
                  {p.result}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* 仕切り線 */}
        <div style={{width:'100%',height:1,background:'rgba(201,168,76,0.2)',margin:'4px 0'}} />

        {/* 自分の手札エリア */}
        {selfPlayer && (
          <div style={SM.selfArea}>
            {/* 自分のバッジ・名前・チップ */}
            <div style={{display:'flex',alignItems:'center',gap:6,justifyContent:'center',flexWrap:'wrap' as const,marginBottom:4}}>
              {selfPlayer.isDealer && <span style={badgeSm('#c9a84c','#1a1200')}>BTN</span>}
              {selfPlayer.isSB     && <span style={badgeSm('#2244aa','#fff')}>SB</span>}
              {selfPlayer.isBB     && <span style={badgeSm('#b85a10','#fff')}>BB</span>}
              {selfPlayer.folded   && <span style={badgeSm('#444','#aaa')}>FOLD</span>}
              {selfPlayer.isWinner && <span style={badgeSm('#f0d060','#1a1200')}>👑WIN</span>}
              <span style={{fontFamily:'var(--font-title)',fontSize:13,color:'var(--gold-bright)',letterSpacing:'0.05em'}}>
                {selfPlayer.name} (YOU)
              </span>
              <span style={{fontFamily:'var(--font-body)',fontSize:14,color:'#88dd88'}}>
                💵{selfPlayer.chips}
                {selfPlayer.bet > 0 && <span style={{color:'var(--gold)',marginLeft:4}}>B{selfPlayer.bet}</span>}
              </span>
            </div>

            {/* タイマーバー */}
            {selfPlayer.isMyTurn && meta.timerLimit > 0 && timerSec !== null && (
              <div style={{padding:'0 12px 4px'}}><TimerBar remaining={timerSec} limit={meta.timerLimit} /></div>
            )}

            {/* 手札 */}
            <div style={{display:'flex',gap:6,justifyContent:'center',margin:'4px 0 6px'}}>
              {selfPlayer.hand.map((code, j) => (
                <div key={j} style={{display:'flex',flexDirection:'column' as const,alignItems:'center'}}>
                  <Card
                    code={code} size="md"
                    selected={selected.includes(j)}
                    clickable={isDrawPhase && isMyTurn && !myDrew}
                    folded={selfPlayer.folded}
                    onClick={() => handleCardClick(j)}
                  />
                  {selected.includes(j) && (
                    <span style={{fontSize:9,color:'#e84040',fontFamily:'var(--font-title)',marginTop:1}}>捨てる</span>
                  )}
                </div>
              ))}
            </div>

            {/* 役名 */}
            {selfPlayer.result && (
              <p style={{textAlign:'center',fontSize:13,color:selfPlayer.isWinner?'var(--gold-bright)':'var(--cream-dim)',fontFamily:'var(--font-title)',marginBottom:4}}>
                {selfPlayer.result}
              </p>
            )}
          </div>
        )}

        {/* アクションパネル */}
        <ActionPanel />

        {/* ルール */}
        <p style={{textAlign:'center',fontSize:10,color:'var(--gold-dim)',fontFamily:'var(--font-body)',padding:'6px 12px'}}>
          {effectiveMode === 'badugi'
            ? '★ Badugi: 全スート異なる低い4枚が最強'
            : '★ 2-7 Lowball: 低い手が強い。フラッシュ・ストレートは弱い手。A最高位'}
        </p>
      </div>
    );
  }

  // ==========================================================
  // ■ PC版レイアウト（楕円テーブル）
  // ==========================================================
  const TW = 1100; const TH = 780;
  const CX = TW / 2; const CY = TH / 2 - 15;
  const RX = 395; const RY = 275;
  const BW = 235;
  const others = players.filter((p) => !p.isSelf);

  const getPos = (p: Player) => {
    let ang: number;
    if (p.isSelf) { ang = 90; }
    else {
      const slots = [-90, -30, 30, 150, 210];
      const idx   = others.findIndex((o) => o.id === p.id);
      ang = slots[idx] ?? (-90 + 60 * (idx + 1));
    }
    const rad = (ang * Math.PI) / 180;
    const cx  = CX + RX * Math.cos(rad);
    const cy  = CY + RY * Math.sin(rad);
    const bh  = p.isSelf ? 235 : 185;
    return { left: cx - BW / 2, top: cy - bh / 2 };
  };

  return (
    <div style={PC.page}>
      {/* ナビ */}
      <nav style={PC.nav}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <svg width="30" height="30" viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="30" stroke="#c9a84c" strokeWidth="2" fill="#0a3320"/>
            <text x="13" y="28" fontSize="14" fill="#f0d060" fontFamily="serif" textAnchor="middle">♠</text>
            <text x="51" y="28" fontSize="14" fill="#cc3333" fontFamily="serif" textAnchor="middle">♥</text>
            <text x="13" y="48" fontSize="14" fill="#f0d060" fontFamily="serif" textAnchor="middle">♣</text>
            <text x="51" y="48" fontSize="14" fill="#cc3333" fontFamily="serif" textAnchor="middle">♦</text>
            <text x="32" y="40" fontSize="20" fontWeight="bold" fill="#c9a84c" fontFamily="serif" textAnchor="middle">P</text>
          </svg>
          <span style={PC.navLogo}>Poker Room Pastis</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <span style={{...PC.modeBadge, background:modeBg, color:modeColor, border:`1px solid ${modeBorder}`}}>
            {mode === 'mix' ? `Mix→${effectiveMode==='badugi'?'Badugi':'2-7'}` : MODE_LABEL[effectiveMode]}
          </span>
          <span style={PC.phaseTag}>{PHASE_LABEL[meta.phase] ?? meta.phase}</span>
          {isDrawPhase && (
            <span style={{display:'flex',gap:8,alignItems:'center'}}>
              {[1,2,3].map((n) => (
                <span key={n} style={{display:'inline-block',width:13,height:13,borderRadius:'50%',transition:'all 0.3s',
                  background: n<=drawRound?'var(--gold-bright)':'rgba(255,255,255,0.15)',
                  boxShadow: n===drawRound?'0 0 8px var(--gold)':'none'}} />
              ))}
            </span>
          )}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <span style={PC.navRoom}>{roomId}</span>
          <button onClick={handleLeave} style={PC.leaveBtn}>退室</button>
        </div>
      </nav>

      {meta.pendingPlayers.length > 0 && (
        <div style={PC.pendingBar}>⏳ 次ゲームから参加: {meta.pendingPlayers.join(', ')}</div>
      )}

      {/* ポット */}
      {meta.phase !== 'waiting' && (
        <div style={{display:'flex',gap:14,alignItems:'center',padding:'7px 0 3px',justifyContent:'center',flexWrap:'wrap' as const}}>
          <div style={PC.potChip}><span>🏦</span><span style={PC.potAmt}>POT <b style={{color:'var(--gold-bright)',fontSize:20}}>{meta.pot}</b></span></div>
          {isBetPhase && meta.currentBet > 0 && (
            <div style={PC.potChip}><span style={PC.potAmt}>BET <b style={{color:'var(--cream)',fontSize:18}}>{meta.currentBet}</b></span></div>
          )}
        </div>
      )}

      {/* テーブル */}
      <div style={{...PC.tableWrap, width:TW, height:TH}}>
        <div style={PC.felt} />
        <div style={PC.feltInner} />

        {/* テーブル中央: フェーズ + ゲーム種類 */}
        {meta.phase !== 'waiting' && (
          <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',textAlign:'center',zIndex:2,pointerEvents:'none'}}>
            <div style={{fontFamily:'var(--font-title)',fontSize:13,color:modeColor,letterSpacing:'0.15em',marginBottom:5,opacity:0.85}}>
              {MODE_LABEL[effectiveMode]}
            </div>
            <div style={{
              fontFamily:'var(--font-title)', fontSize:22, letterSpacing:'0.2em',
              color: phaseIsBet?'var(--gold-bright)':phaseIsDraw?'#88ddff':'var(--cream-dim)',
              textShadow:'0 0 14px rgba(0,0,0,0.9)', lineHeight:1.1,
            }}>
              {PHASE_LABEL[meta.phase]}
            </div>
            {isBetPhase && (
              <div style={{fontSize:13,color:'rgba(255,255,255,0.5)',marginTop:4,fontFamily:'var(--font-body)'}}>
                Bet {raiseDisplay}
              </div>
            )}
          </div>
        )}

        {/* プレイヤーボックス */}
        {players.map((p) => {
          const {left, top} = getPos(p);
          return (
            <div key={p.id} style={{
              ...PC.pBox, left, top, width:BW,
              ...(p.isSelf ? PC.pBoxSelf : {}),
              ...(p.isMyTurn && !p.folded && !p.sittingOut ? PC.pBoxActive : {}),
              ...(p.folded && !p.sittingOut ? PC.pBoxFolded : {}),
              ...(p.sittingOut ? PC.pBoxSitting : {}),
              ...(p.isWinner ? PC.pBoxWinner : {}),
            }}>
              {/* バッジ */}
              <div style={{display:'flex',gap:4,justifyContent:'center',marginBottom:4,flexWrap:'wrap' as const}}>
                {p.isDealer   && <span style={badgePC('#c9a84c','#1a1200')}>BTN</span>}
                {p.isSB       && <span style={badgePC('#2244aa','#fff')}>SB</span>}
                {p.isBB       && <span style={badgePC('#b85a10','#fff')}>BB</span>}
                {p.folded && !p.sittingOut && <span style={badgePC('#444','#aaa')}>FOLD</span>}
                {p.sittingOut && <span style={badgePC('#555','#bbb')}>WAIT</span>}
                {p.isWinner   && <span style={badgePC('#f0d060','#1a1200')}>👑WIN</span>}
              </div>
              {/* 名前 */}
              <p style={{...PC.pName, ...(p.isSelf?{color:'var(--gold-bright)'}:{})}}>
                {p.isSelf ? `${p.name} (YOU)` : p.name}
              </p>
              {/* チップ */}
              <div style={{display:'flex',justifyContent:'center',gap:8,marginBottom:4,flexWrap:'wrap' as const}}>
                <span style={PC.chipAmt}>💵 {p.chips}</span>
                {p.bet > 0 && <span style={PC.betAmt}>BET {p.bet}</span>}
              </div>
              {/* タイマー */}
              {p.isMyTurn && meta.timerLimit > 0 && timerSec !== null && (
                <TimerBar remaining={timerSec} limit={meta.timerLimit} />
              )}
              {/* 手札 */}
              <div style={{display:'flex',justifyContent:'center',gap:p.isSelf?7:4,flexWrap:'nowrap' as const,margin:'5px 0'}}>
                {p.hand.map((code, j) => (
                  <div key={j} style={{display:'flex',flexDirection:'column' as const,alignItems:'center'}}>
                    <Card
                      code={code}
                      size={p.isSelf ? 'lg' : 'sm'}
                      selected={p.isSelf && selected.includes(j)}
                      clickable={p.isSelf && isDrawPhase && isMyTurn && !myDrew}
                      folded={p.folded}
                      onClick={() => handleCardClick(j)}
                    />
                    {p.isSelf && selected.includes(j) && (
                      <span style={{fontSize:9,color:'#e84040',fontFamily:'var(--font-title)',marginTop:2}}>捨てる</span>
                    )}
                  </div>
                ))}
              </div>
              {/* ドロー枚数 */}
              {!p.isSelf && (isDrawPhase || isBetPhase) && (() => {
                const cnt = isDrawPhase ? (p.drewThisRound ? p.drawCount : null) : (lastDrawCount[p.id] ?? null);
                if (cnt === null) return isDrawPhase ? <p style={{fontSize:11,color:'#88bbff',fontStyle:'italic',marginTop:2}}>⏳ thinking...</p> : null;
                return <p style={{fontSize:12,color:'#88bbff',fontStyle:'italic',marginTop:2}}>{cnt===0?'✋ Stand pat':`🔄 ${cnt} cards`}</p>;
              })()}
              {/* 役 */}
              {p.result && (
                <p style={{...PC.result, ...(p.isWinner?{color:'var(--gold-bright)',fontWeight:'700'}:{})}}>
                  {p.result}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* アクションパネル */}
      <ActionPanel />

      <p style={{textAlign:'center',fontSize:13,color:'var(--gold-dim)',fontFamily:'var(--font-body)',marginTop:12,padding:'0 12px'}}>
        {effectiveMode === 'badugi'
          ? '★ Badugi: 全スート異なる低い4枚が最強。枚数が多い方が強い。'
          : '★ 2-7 Lowball: 低い手が強い。フラッシュ・ストレートは弱い手。Aは常に最高位。'}
      </p>
    </div>
  );
};

// ===== ユーティリティ =====
const dot: React.CSSProperties = { display:'inline-block',width:8,height:8,borderRadius:'50%',background:'var(--gold)',opacity:0.7,flexShrink:0 };
const btnRow: React.CSSProperties = { display:'flex',gap:10,flexWrap:'wrap' as const,justifyContent:'center' };

const badgeSm = (bg: string, color: string): React.CSSProperties => ({
  fontSize:8, fontFamily:'var(--font-title)', padding:'1px 5px',
  borderRadius:3, background:bg, color,
});
const badgePC = (bg: string, color: string): React.CSSProperties => ({
  fontSize:11, fontFamily:'var(--font-title)', padding:'2px 7px',
  borderRadius:3, background:bg, color,
});

// ===== スマホスタイル =====
const SM: Record<string, React.CSSProperties> = {
  page:        { minHeight:'100vh', display:'flex', flexDirection:'column', background:'var(--felt)', color:'var(--cream)', fontFamily:'var(--font-body)' },
  nav:         { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 12px', borderBottom:'1px solid var(--gold-dim)', background:'rgba(0,0,0,0.3)' },
  modeBadge:   { fontFamily:'var(--font-title)', fontSize:9, padding:'2px 7px', borderRadius:4 },
  phaseTagSm:  { fontFamily:'var(--font-title)', fontSize:10, color:'var(--gold-bright)', background:'rgba(201,168,76,0.12)', border:'1px solid var(--gold-dim)', borderRadius:3, padding:'2px 8px' },
  leaveBtn:    { fontFamily:'var(--font-title)', fontSize:10, padding:'5px 10px', background:'rgba(139,26,26,0.6)', border:'1px solid rgba(204,34,34,0.4)', borderRadius:4, color:'#ffaaaa', cursor:'pointer' },
  pendingBar:  { fontSize:11, color:'var(--gold-dim)', fontStyle:'italic', padding:'4px 12px', background:'rgba(201,168,76,0.07)', borderBottom:'1px solid rgba(201,168,76,0.15)' },
  potBar:      { display:'flex', gap:8, justifyContent:'center', padding:'5px 0', flexWrap:'wrap' as const },
  potChip:     { fontFamily:'var(--font-title)', fontSize:13, color:'var(--cream-dim)', background:'rgba(0,0,0,0.3)', border:'1px solid var(--gold-dim)', borderRadius:14, padding:'4px 12px' },
  centerPhase: { display:'flex', flexDirection:'column', alignItems:'center', gap:3, padding:'6px 12px', background:'rgba(0,0,0,0.15)' },
  othersArea:  { display:'flex', gap:8, overflowX:'auto' as const, padding:'8px 10px', minHeight:120 },
  otherBox:    { flex:'0 0 auto', minWidth:90, background:'rgba(0,0,0,0.25)', border:'1px solid rgba(201,168,76,0.2)', borderRadius:8, padding:'6px 5px', textAlign:'center' },
  otherBoxActive: { border:'1px solid var(--gold)', boxShadow:'0 0 10px rgba(201,168,76,0.4)', background:'rgba(201,168,76,0.07)' },
  winnerBox:   { border:'1px solid var(--gold-bright)', boxShadow:'0 0 12px rgba(240,208,96,0.5)', background:'rgba(201,168,76,0.1)' },
  otherName:   { fontFamily:'var(--font-title)', fontSize:10, color:'var(--cream)', letterSpacing:'0.03em', margin:'1px 0', whiteSpace:'nowrap' as const, overflow:'hidden', textOverflow:'ellipsis' },
  otherChips:  { fontFamily:'var(--font-body)', fontSize:11, color:'#88dd88', margin:'1px 0' },
  selfArea:    { background:'rgba(10,50,30,0.6)', borderTop:'1px solid rgba(201,168,76,0.25)', borderRadius:'8px 8px 0 0', padding:'8px 10px' },
  actionPanel: { padding:'8px 10px', display:'flex', justifyContent:'center' },
  actionBox:   { background:'linear-gradient(160deg,rgba(22,92,56,0.5),rgba(10,51,32,0.7))', border:'1px solid var(--gold-dim)', borderRadius:9, padding:'12px 14px', display:'flex', flexDirection:'column' as const, alignItems:'center', gap:9, width:'100%' },
  actionHint:  { fontFamily:'var(--font-body)', fontSize:14, color:'var(--cream-dim)', fontStyle:'italic', textAlign:'center' as const },
  waitBox:     { display:'flex', alignItems:'center', gap:8, padding:'10px 14px', background:'rgba(0,0,0,0.2)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:8, width:'100%', justifyContent:'center' },
  waitText:    { fontFamily:'var(--font-body)', fontSize:14, color:'var(--cream-dim)', fontStyle:'italic' },
  btnGold:     { padding:'10px 18px', background:'linear-gradient(135deg,var(--gold),var(--gold-dim))', border:'none', borderRadius:6, color:'#1a1200', fontSize:14, fontWeight:'700', cursor:'pointer' },
  btnGray:     { padding:'10px 14px', background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.2)', borderRadius:6, color:'var(--cream)', fontSize:14, cursor:'pointer' },
  btnRed:      { padding:'10px 14px', background:'var(--red)', border:'none', borderRadius:6, color:'#ffd0d0', fontSize:14, cursor:'pointer' },
  btnOutline:  { padding:'10px 12px', background:'transparent', border:'1px solid var(--gold-dim)', borderRadius:6, color:'var(--cream-dim)', fontSize:13, cursor:'pointer' },
};

// ===== PCスタイル =====
const PC: Record<string, React.CSSProperties> = {
  page:        { minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center', paddingBottom:20, position:'relative', zIndex:1, fontFamily:'var(--font-body)' },
  nav:         { width:'100%', maxWidth:1140, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 28px 12px', borderBottom:'1px solid var(--gold-dim)' },
  navLogo:     { fontFamily:'var(--font-title)', fontSize:22, color:'var(--gold)', letterSpacing:'0.08em' },
  modeBadge:   { fontFamily:'var(--font-title)', fontSize:12, padding:'4px 12px', borderRadius:4, letterSpacing:'0.06em' },
  phaseTag:    { fontFamily:'var(--font-title)', fontSize:15, letterSpacing:'0.3em', color:'var(--gold-bright)', background:'rgba(201,168,76,0.12)', border:'1px solid var(--gold-dim)', borderRadius:4, padding:'5px 16px' },
  navRoom:     { fontFamily:'var(--font-title)', fontSize:13, color:'var(--cream-dim)', letterSpacing:'0.1em', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const },
  leaveBtn:    { fontFamily:'var(--font-title)', fontSize:12, padding:'7px 16px', background:'rgba(139,26,26,0.5)', border:'1px solid rgba(204,34,34,0.4)', borderRadius:5, color:'#ffaaaa', cursor:'pointer' },
  pendingBar:  { width:'100%', maxWidth:1140, background:'rgba(201,168,76,0.07)', borderBottom:'1px solid rgba(201,168,76,0.2)', padding:'6px 28px', fontFamily:'var(--font-body)', fontSize:14, color:'var(--gold-dim)', fontStyle:'italic' },
  potChip:     { display:'flex', alignItems:'center', gap:8, background:'rgba(0,0,0,0.3)', border:'1px solid var(--gold-dim)', borderRadius:18, padding:'6px 18px' },
  potAmt:      { fontFamily:'var(--font-title)', fontSize:15, color:'var(--cream-dim)', letterSpacing:'0.04em' },
  tableWrap:   { position:'relative', margin:'2px auto' },
  felt:        { position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:'70%', height:'62%', borderRadius:'50%', background:'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)', border:'8px solid var(--gold-dim)', boxShadow:'0 0 40px rgba(0,0,0,0.8),inset 0 0 30px rgba(0,0,0,0.4)', zIndex:0 },
  feltInner:   { position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:'calc(70% - 20px)', height:'calc(62% - 20px)', borderRadius:'50%', border:'1px solid rgba(201,168,76,0.25)', zIndex:0 },
  pBox:        { position:'absolute', zIndex:1, textAlign:'center', padding:'9px 7px', borderRadius:11, border:'1px solid transparent', transition:'all 0.25s' },
  pBoxSelf:    { background:'rgba(10,50,30,0.8)', border:'1px solid rgba(201,168,76,0.35)' },
  pBoxActive:  { border:'1px solid var(--gold)', boxShadow:'0 0 18px rgba(201,168,76,0.5)', background:'rgba(201,168,76,0.08)' },
  pBoxFolded:  { opacity:0.4 },
  pBoxSitting: { opacity:0.5, border:'1px solid rgba(255,255,255,0.1)' },
  pBoxWinner:  { border:'1px solid var(--gold-bright)', boxShadow:'0 0 22px rgba(240,208,96,0.6)', background:'rgba(201,168,76,0.12)' },
  pName:       { fontFamily:'var(--font-title)', fontSize:14, color:'var(--cream)', letterSpacing:'0.05em', margin:'0 0 3px', whiteSpace:'nowrap' as const, overflow:'hidden', textOverflow:'ellipsis' },
  chipAmt:     { fontFamily:'var(--font-body)', fontSize:16, color:'#88dd88' },
  betAmt:      { fontFamily:'var(--font-body)', fontSize:15, color:'var(--gold)', background:'rgba(201,168,76,0.15)', borderRadius:3, padding:'0 6px' },
  result:      { fontSize:13, color:'var(--cream-dim)', fontFamily:'var(--font-title)', marginTop:4, letterSpacing:'0.04em' },
  actionPanel: { width:'100%', maxWidth:1100, display:'flex', justifyContent:'center', padding:'8px 16px 0' },
  actionBox:   { background:'linear-gradient(160deg,rgba(22,92,56,0.5),rgba(10,51,32,0.7))', border:'1px solid var(--gold-dim)', borderRadius:11, padding:'18px 30px', display:'flex', flexDirection:'column' as const, alignItems:'center', gap:12, minWidth:420 },
  actionHint:  { fontFamily:'var(--font-body)', fontSize:18, color:'var(--cream-dim)', fontStyle:'italic', textAlign:'center' as const },
  waitBox:     { display:'flex', alignItems:'center', gap:10, padding:'14px 24px', background:'rgba(0,0,0,0.2)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:9 },
  waitText:    { fontFamily:'var(--font-body)', fontSize:18, color:'var(--cream-dim)', fontStyle:'italic' },
  btnGold:     { padding:'13px 28px', background:'linear-gradient(135deg,var(--gold),var(--gold-dim))', border:'none', borderRadius:7, color:'#1a1200', fontSize:16, fontWeight:'700', cursor:'pointer', letterSpacing:'0.06em', boxShadow:'0 3px 14px rgba(201,168,76,0.4)' },
  btnGray:     { padding:'13px 24px', background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.2)', borderRadius:7, color:'var(--cream)', fontSize:16, cursor:'pointer' },
  btnRed:      { padding:'13px 22px', background:'var(--red)', border:'none', borderRadius:7, color:'#ffd0d0', fontSize:16, cursor:'pointer' },
  btnOutline:  { padding:'13px 20px', background:'transparent', border:'1px solid var(--gold-dim)', borderRadius:7, color:'var(--cream-dim)', fontSize:15, cursor:'pointer' },
};

export default PokerTable;
