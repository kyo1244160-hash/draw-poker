/**
 * PokerTable.tsx — ゲームテーブル共通コンポーネント
 *
 * レイアウト:
 *   PC版        : 楕円テーブル、アクションボタンはカード右側
 *   スマホ縦表示: 相手は上部カード列、自分は中央、ボタンは右側
 *   スマホ横表示: 相手は左カラム、自分の手札は中央、ボタンは右カラム
 *
 * 全て viewport 内に収まり、スクロール不要。
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
const PHASE_LABEL: Record<string,string> = {
  waiting:'WAITING', bet0:'BET (Pre-Draw)',
  draw1:'DRAW I', bet1:'BET I', draw2:'DRAW II', bet2:'BET II',
  draw3:'DRAW III', bet3:'BET III', showdown:'SHOWDOWN',
};
const MODE_LABEL: Record<string,string> = { '27':'2-7 Triple Draw', badugi:'Badugi', mix:'Mix' };

// ===== メインコンポーネント =====
const PokerTable: React.FC<Props> = ({ roomId, name, mode }) => {
  const router = useRouter();

  const [players,       setPlayers]       = useState<Player[]>([]);
  const [meta,          setMeta]          = useState<Meta>({
    phase:'waiting', mode, currentMode: mode==='badugi'?'badugi':'27',
    pot:0, currentBet:0, betSize:10, raiseCount:0, maxRaises:4,
    dealerIndex:-1, timerRemaining:null, timerLimit:0,
    pendingPlayers:[], playerCount:0, maxPlayers:6,
  });
  const [selected,      setSelected]      = useState<number[]>([]);
  const [myDrew,        setMyDrew]        = useState(false);
  const [timerSec,      setTimerSec]      = useState<number | null>(null);
  const [lastDrawCount, setLastDrawCount] = useState<Record<string,number|null>>({});

  // デバイス判定（SSR安全）
  const [layout, setLayout] = useState<'pc'|'portrait'|'landscape'>('pc');

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w >= 768) { setLayout('pc'); return; }
      setLayout(w < h ? 'portrait' : 'landscape');
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', () => setTimeout(update, 100));
    return () => { window.removeEventListener('resize', update); };
  }, []);

  // ===== Socket.IO =====
  useEffect(() => {
    const onConnect     = () => socket.emit('joinRoom', { roomId, name });
    const onGameState   = ({ players:pl, meta:m }: { players:Player[]; meta:Meta }) => {
      setPlayers(pl); setMeta(m);
      const self = pl.find((p) => p.isSelf);
      if (self) setMyDrew(self.drewThisRound);
      setLastDrawCount((prev) => {
        const next = {...prev};
        for (const p of pl) { if (p.drawCount !== null) next[p.id] = p.drawCount; }
        return next;
      });
    };
    const onGameStarted = () => { setSelected([]); setMyDrew(false); setLastDrawCount({}); };
    const onTimerUpdate = ({ remaining }: { remaining:number }) => setTimerSec(remaining);
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
      socket.off('connect',onConnect); socket.off('gameState',onGameState);
      socket.off('gameStarted',onGameStarted); socket.off('timerUpdate',onTimerUpdate);
      socket.off('showdown'); socket.off('kicked',onKicked);
    };
  }, [roomId, name]);

  // ===== 計算 =====
  const self          = players.find((p) => p.isSelf);
  const isDrawPhase   = meta.phase.startsWith('draw');
  const isBetPhase    = meta.phase.startsWith('bet');
  const isMyTurn      = self?.isMyTurn ?? false;
  const drawRound     = ['draw1','draw2','draw3'].indexOf(meta.phase)+1;
  const curPlayer     = players.find((p) => p.isMyTurn);
  const effectiveMode = meta.currentMode ?? (mode==='mix'?'27':mode);
  const raiseDisplay  = `${meta.raiseCount}/${meta.maxRaises+1}`;
  const modeColor     = effectiveMode==='badugi' ? '#cc9966' : '#88bbee';
  const modeBg        = effectiveMode==='badugi' ? 'rgba(204,119,68,0.22)' : 'rgba(68,136,204,0.22)';
  const modeBorder    = effectiveMode==='badugi' ? 'rgba(204,119,68,0.45)' : 'rgba(68,136,204,0.45)';

  // ===== ハンドラ =====
  const handleCardClick = useCallback((j:number) => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    setSelected((prev) => {
      const next = prev.includes(j) ? prev.filter((i)=>i!==j) : [...prev, j];
      socket.emit('updateSelected', { roomId, indices: next });
      return next;
    });
  }, [isDrawPhase, isMyTurn, myDrew, roomId]);

  const handleDraw = () => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    socket.emit('drawCards', { roomId, indices: selected });
    setMyDrew(true); setSelected([]);
  };
  const clearSelected = () => { setSelected([]); socket.emit('updateSelected',{roomId,indices:[]}); };
  const handleBet   = (action:string) => socket.emit('betAction', {roomId, action});
  const handleLeave = () => { socket.emit('leaveRoom', {roomId}); router.push('/'); };

  // ===== バッジ =====
  const Badge = ({bg,color,label}:{bg:string,color:string,label:string}) => (
    <span style={{fontSize:9,fontFamily:'var(--font-title)',padding:'1px 5px',borderRadius:3,background:bg,color,flexShrink:0}}>{label}</span>
  );

  // ===== アクションボタン（縦積み）=====
  const ActionButtons = ({compact=false}:{compact?:boolean}) => {
    const fs = compact ? 12 : 15;
    const py = compact ? 8  : 12;
    const px = compact ? 12 : 22;
    const btn = (onClick:()=>void, label:string, variant:'gold'|'gray'|'red'|'outline') => {
      const base:React.CSSProperties = {
        padding: `${py}px ${px}px`, border:'none', borderRadius:6,
        fontSize:fs, fontWeight:'700', cursor:'pointer', width:'100%',
        fontFamily:'var(--font-title)', letterSpacing:'0.04em', textAlign:'center' as const,
      };
      const variants = {
        gold:    { background:'linear-gradient(135deg,var(--gold),var(--gold-dim))', color:'#1a1200', boxShadow:'0 2px 10px rgba(201,168,76,0.4)' },
        gray:    { background:'rgba(255,255,255,0.1)', color:'var(--cream)', border:'1px solid rgba(255,255,255,0.2)' },
        red:     { background:'var(--red)', color:'#ffd0d0' },
        outline: { background:'transparent', color:'var(--cream-dim)', border:'1px solid var(--gold-dim)' },
      };
      return <button onClick={onClick} style={{...base,...variants[variant]}}>{label}</button>;
    };

    if (meta.phase === 'waiting') return (
      <div style={actionColStyle}>
        <div style={actionInfoStyle(compact)}>
          {players.length < 2 ? 'もう1人参加を待っています' : 'ゲームを準備中...'}
        </div>
      </div>
    );

    if (isDrawPhase && isMyTurn && !myDrew) return (
      <div style={actionColStyle}>
        <div style={actionInfoStyle(compact)}>
          {selected.length > 0 ? `${selected.length}枚選択中` : '捨てるカードを選択'}
        </div>
        {btn(handleDraw, selected.length>0?`🔄 ${selected.length}枚ドロー`:'✋ Stand Pat', 'gold')}
        {selected.length>0 && btn(clearSelected,'選択解除','outline')}
      </div>
    );

    if (isDrawPhase && (!isMyTurn || myDrew)) return (
      <div style={actionColStyle}>
        <div style={actionInfoStyle(compact)}>
          {myDrew ? '他プレイヤーを待っています...' : `${curPlayer?.name??''} がドロー中...`}
        </div>
      </div>
    );

    if (isBetPhase && isMyTurn && self) return (
      <div style={actionColStyle}>
        <div style={actionInfoStyle(compact)}>
          {self.toCall!>0 ? `コール: ${self.toCall}` : 'チェック or ベット'}
          <span style={{fontSize:fs-3,opacity:0.7,display:'block'}}>単位:{self.betSize} Bet {raiseDisplay}</span>
        </div>
        {btn(()=>handleBet('fold'),'フォールド','red')}
        {self.canCheck
          ? btn(()=>handleBet('check'),'チェック','gray')
          : btn(()=>handleBet('call'),`コール (${self.toCall})`,'gray')
        }
        {self.canRaise && btn(
          ()=>handleBet(meta.currentBet===0?'bet':'raise'),
          meta.currentBet===0?`ベット(${self.betSize})`:`レイズ(+${self.betSize})`,
          'gold'
        )}
      </div>
    );

    if (isBetPhase && !isMyTurn) return (
      <div style={actionColStyle}>
        <div style={actionInfoStyle(compact)}>
          {curPlayer ? `${curPlayer.name} がアクション中...` : '待機中...'}
        </div>
      </div>
    );

    if (meta.phase === 'showdown') return (
      <div style={actionColStyle}>
        <div style={actionInfoStyle(compact)}>次のゲームを準備中... (3秒)</div>
      </div>
    );

    return <div style={actionColStyle} />;
  };

  const actionColStyle:React.CSSProperties = {
    display:'flex', flexDirection:'column', gap:8, justifyContent:'center',
  };
  const actionInfoStyle = (compact:boolean):React.CSSProperties => ({
    fontFamily:'var(--font-body)', fontSize: compact?12:15,
    color:'var(--cream-dim)', fontStyle:'italic', textAlign:'center' as const,
    padding: compact?'4px 0':'6px 0', lineHeight:1.4,
  });

  // ===== 共通ナビバー =====
  const NavBar = ({compact=false}:{compact?:boolean}) => (
    <nav style={{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      padding: compact?'6px 10px':'14px 24px',
      borderBottom:'1px solid var(--gold-dim)',
      background:'rgba(0,0,0,0.25)', flexShrink:0,
    }}>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <img src="/icons/icon-72.png" alt="logo" style={{width:compact?24:32,height:compact?24:32,borderRadius:'50%'}} />
        {!compact && <span style={{fontFamily:'var(--font-title)',fontSize:18,color:'var(--gold)',letterSpacing:'0.07em'}}>Poker Room Pastis</span>}
        {compact && <span style={{fontFamily:'var(--font-title)',fontSize:12,color:'var(--gold)'}}>Pastis</span>}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap' as const,justifyContent:'center'}}>
        <span style={{...modBadgeSt, background:modeBg, color:modeColor, border:`1px solid ${modeBorder}`, fontSize:compact?9:11}}>
          {mode==='mix'?`Mix→${effectiveMode==='badugi'?'Badugi':'2-7'}`:MODE_LABEL[effectiveMode]}
        </span>
        <span style={{...phaseBadgeSt, fontSize:compact?10:13, padding:compact?'2px 8px':'4px 12px'}}>
          {PHASE_LABEL[meta.phase]??meta.phase}
        </span>
        {isDrawPhase && [1,2,3].map((n)=>(
          <span key={n} style={{display:'inline-block',width:compact?8:11,height:compact?8:11,borderRadius:'50%',
            background:n<=drawRound?'var(--gold-bright)':'rgba(255,255,255,0.15)',
            boxShadow:n===drawRound?'0 0 6px var(--gold)':'none'}} />
        ))}
      </div>
      <button onClick={handleLeave} style={leaveBtnSt}>退室</button>
    </nav>
  );

  // ===== ポット表示 =====
  const PotBar = ({compact=false}:{compact?:boolean}) => meta.phase==='waiting' ? null : (
    <div style={{display:'flex',gap:8,justifyContent:'center',alignItems:'center',padding:compact?'3px 0':'5px 0',flexWrap:'wrap' as const,flexShrink:0}}>
      <span style={{...potChipSt, fontSize:compact?11:14}}>🏦 <b style={{color:'var(--gold-bright)'}}>{meta.pot}</b></span>
      {isBetPhase && meta.currentBet>0 && <span style={{...potChipSt, fontSize:compact?11:14}}>BET <b>{meta.currentBet}</b></span>}
    </div>
  );

  // ===== プレイヤーカード（他プレイヤー用）=====
  const OtherPlayerCard = ({p, cardSize='sm', compact=false}:{p:Player, cardSize?:'sm'|'md', compact?:boolean}) => {
    const dc = isDrawPhase ? (p.drewThisRound ? p.drawCount : null) : (lastDrawCount[p.id]??null);
    return (
      <div style={{
        background:'rgba(0,0,0,0.25)', border:'1px solid rgba(201,168,76,0.2)',
        borderRadius:8, padding:compact?'4px 6px':'6px 8px', textAlign:'center',
        ...(p.isMyTurn&&!p.folded?{border:'1px solid var(--gold)',boxShadow:'0 0 10px rgba(201,168,76,0.4)',background:'rgba(201,168,76,0.07)'}:{}),
        ...(p.isWinner?{border:'1px solid var(--gold-bright)',boxShadow:'0 0 12px rgba(240,208,96,0.5)'}:{}),
        ...(p.folded?{opacity:0.4}:{}),
      }}>
        <div style={{display:'flex',gap:2,justifyContent:'center',marginBottom:2,flexWrap:'wrap' as const}}>
          {p.isDealer && <Badge bg="#c9a84c" color="#1a1200" label="BTN"/>}
          {p.isSB     && <Badge bg="#2244aa" color="#fff"    label="SB"/>}
          {p.isBB     && <Badge bg="#b85a10" color="#fff"    label="BB"/>}
          {p.folded && !p.sittingOut && <Badge bg="#444" color="#aaa" label="FOLD"/>}
          {p.sittingOut && <Badge bg="#555" color="#bbb" label="WAIT"/>}
          {p.isWinner && <Badge bg="#f0d060" color="#1a1200" label="👑"/>}
        </div>
        <div style={{fontFamily:'var(--font-title)',fontSize:compact?9:11,color:'var(--cream)',
          whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis',maxWidth:100}}>{p.name}</div>
        <div style={{fontFamily:'var(--font-body)',fontSize:compact?10:12,color:'#88dd88'}}>
          💵{p.chips}{p.bet>0?` B${p.bet}`:''}
        </div>
        <div style={{display:'flex',gap:2,justifyContent:'center',margin:'3px 0'}}>
          {p.hand.map((code,j) => <Card key={j} code={code} size={cardSize} folded={p.folded}/>)}
        </div>
        {(isDrawPhase||isBetPhase) && dc!==null && (
          <div style={{fontSize:9,color:'#88bbff',fontStyle:'italic'}}>
            {dc===0?'✋ pat':`🔄 ${dc}`}
          </div>
        )}
        {p.result && (
          <div style={{fontSize:compact?9:10,color:p.isWinner?'var(--gold-bright)':'var(--cream-dim)',fontFamily:'var(--font-title)',fontWeight:p.isWinner?'700':'400'}}>
            {p.result}
          </div>
        )}
      </div>
    );
  };

  // ===== テーブル中央テキスト =====
  const CenterInfo = ({big=false}:{big?:boolean}) => meta.phase==='waiting' ? null : (
    <div style={{textAlign:'center',pointerEvents:'none'}}>
      <div style={{fontFamily:'var(--font-title)',fontSize:big?13:10,color:modeColor,letterSpacing:'0.12em',opacity:0.85,marginBottom:3}}>
        {MODE_LABEL[effectiveMode]}
      </div>
      <div style={{fontFamily:'var(--font-title)',fontSize:big?22:14,letterSpacing:'0.18em',
        color:isBetPhase?'var(--gold-bright)':isDrawPhase?'#88ddff':'var(--cream-dim)',
        textShadow:'0 0 12px rgba(0,0,0,0.9)',lineHeight:1.1}}>
        {PHASE_LABEL[meta.phase]}
      </div>
      {isBetPhase && <div style={{fontSize:big?12:9,color:'rgba(255,255,255,0.45)',marginTop:2,fontFamily:'var(--font-body)'}}>Bet {raiseDisplay}</div>}
    </div>
  );

  // ===== pending バー =====
  const PendingBar = () => meta.pendingPlayers.length===0 ? null : (
    <div style={{fontSize:11,color:'var(--gold-dim)',fontStyle:'italic',padding:'3px 12px',
      background:'rgba(201,168,76,0.07)',borderBottom:'1px solid rgba(201,168,76,0.15)',flexShrink:0}}>
      ⏳ 次ゲームから: {meta.pendingPlayers.join(', ')}
    </div>
  );

  // ==========================================================
  // ■ スマホ縦表示（portrait）
  // ==========================================================
  if (layout === 'portrait') {
    const others = players.filter((p)=>!p.isSelf);
    const selfPlayer = players.find((p)=>p.isSelf);

    return (
      <div style={{display:'flex',flexDirection:'column',height:'100dvh',overflow:'hidden',background:'var(--felt)',color:'var(--cream)',fontFamily:'var(--font-body)'}}>
        <NavBar compact />
        <PendingBar />
        <PotBar compact />

        {/* フェーズ表示 */}
        {meta.phase!=='waiting' && (
          <div style={{textAlign:'center',padding:'2px 0',background:'rgba(0,0,0,0.15)',flexShrink:0}}>
            <CenterInfo />
          </div>
        )}

        {/* 相手プレイヤー（横スクロール） */}
        <div style={{display:'flex',gap:6,overflowX:'auto' as const,padding:'4px 8px',flexShrink:0,minHeight:110}}>
          {others.map((p) => <OtherPlayerCard key={p.id} p={p} compact />)}
          {others.length===0 && <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',color:'var(--cream-dim)',fontSize:12,fontStyle:'italic'}}>他のプレイヤーを待っています...</div>}
        </div>

        <div style={{height:1,background:'rgba(201,168,76,0.2)',flexShrink:0}} />

        {/* 自分の手札エリア + ボタン（横並び）*/}
        <div style={{flex:1,display:'flex',overflow:'hidden',minHeight:0}}>
          {/* 手札エリア */}
          <div style={{flex:1,display:'flex',flexDirection:'column',justifyContent:'center',padding:'6px 8px',overflow:'hidden'}}>
            {selfPlayer && (
              <>
                {/* 名前・チップ */}
                <div style={{display:'flex',alignItems:'center',gap:5,flexWrap:'wrap' as const,marginBottom:4}}>
                  {selfPlayer.isDealer && <Badge bg="#c9a84c" color="#1a1200" label="BTN"/>}
                  {selfPlayer.isSB     && <Badge bg="#2244aa" color="#fff"    label="SB"/>}
                  {selfPlayer.isBB     && <Badge bg="#b85a10" color="#fff"    label="BB"/>}
                  {selfPlayer.isWinner && <Badge bg="#f0d060" color="#1a1200" label="👑WIN"/>}
                  <span style={{fontFamily:'var(--font-title)',fontSize:13,color:'var(--gold-bright)'}}>{selfPlayer.name}<span style={{opacity:0.6}}> (YOU)</span></span>
                  <span style={{fontFamily:'var(--font-body)',fontSize:13,color:'#88dd88'}}>💵{selfPlayer.chips}{selfPlayer.bet>0?<span style={{color:'var(--gold)'}}> B{selfPlayer.bet}</span>:''}</span>
                </div>
                {/* タイマー */}
                {selfPlayer.isMyTurn && meta.timerLimit>0 && timerSec!==null && (
                  <div style={{marginBottom:4}}><TimerBar remaining={timerSec} limit={meta.timerLimit}/></div>
                )}
                {/* 手札（横並び） */}
                <div style={{display:'flex',gap:5,justifyContent:'flex-start',flexWrap:'nowrap' as const}}>
                  {selfPlayer.hand.map((code,j) => (
                    <div key={j} style={{display:'flex',flexDirection:'column' as const,alignItems:'center'}}>
                      <Card code={code} size="md"
                        selected={selected.includes(j)}
                        clickable={isDrawPhase&&isMyTurn&&!myDrew}
                        folded={selfPlayer.folded}
                        onClick={()=>handleCardClick(j)} />
                      {selected.includes(j) && <span style={{fontSize:8,color:'#e84040',fontFamily:'var(--font-title)',marginTop:1}}>捨てる</span>}
                    </div>
                  ))}
                </div>
                {/* 役 */}
                {selfPlayer.result && (
                  <div style={{fontSize:12,color:selfPlayer.isWinner?'var(--gold-bright)':'var(--cream-dim)',fontFamily:'var(--font-title)',marginTop:4}}>
                    {selfPlayer.result}
                  </div>
                )}
              </>
            )}
          </div>

          {/* アクションボタン（右側縦積み）*/}
          <div style={{width:110,flexShrink:0,background:'rgba(0,0,0,0.3)',borderLeft:'1px solid rgba(201,168,76,0.15)',padding:'8px 6px',display:'flex',flexDirection:'column',justifyContent:'center',gap:7,overflow:'hidden'}}>
            <ActionButtons compact />
          </div>
        </div>

        {/* ルール */}
        <div style={{fontSize:9,color:'var(--gold-dim)',textAlign:'center',padding:'2px 8px',flexShrink:0}}>
          {effectiveMode==='badugi'?'★ Badugi: 全スート異なる低い4枚が最強':'★ 2-7: 低い手が強い。A最高位。'}
        </div>
      </div>
    );
  }

  // ==========================================================
  // ■ スマホ横表示（landscape）
  // ==========================================================
  if (layout === 'landscape') {
    const others = players.filter((p)=>!p.isSelf);
    const selfPlayer = players.find((p)=>p.isSelf);

    return (
      <div style={{display:'flex',flexDirection:'column',height:'100dvh',overflow:'hidden',background:'var(--felt)',color:'var(--cream)',fontFamily:'var(--font-body)'}}>
        <NavBar compact />

        <div style={{flex:1,display:'flex',overflow:'hidden',minHeight:0}}>
          {/* 左: 相手プレイヤー縦スクロール */}
          <div style={{width:110,flexShrink:0,overflowY:'auto' as const,padding:'4px 6px',borderRight:'1px solid rgba(201,168,76,0.15)',display:'flex',flexDirection:'column',gap:5}}>
            <PotBar compact />
            {others.map((p) => <OtherPlayerCard key={p.id} p={p} compact />)}
          </div>

          {/* 中央: 自分の手札 + フェーズ情報 */}
          <div style={{flex:1,display:'flex',flexDirection:'column',justifyContent:'center',alignItems:'center',padding:'4px 8px',overflow:'hidden'}}>
            <CenterInfo />
            {meta.pendingPlayers.length>0 && (
              <div style={{fontSize:9,color:'var(--gold-dim)',fontStyle:'italic',marginTop:2}}>
                ⏳ {meta.pendingPlayers.join(', ')}
              </div>
            )}
            {selfPlayer && (
              <div style={{marginTop:8,textAlign:'center'}}>
                <div style={{display:'flex',alignItems:'center',gap:4,justifyContent:'center',flexWrap:'wrap' as const,marginBottom:5}}>
                  {selfPlayer.isDealer && <Badge bg="#c9a84c" color="#1a1200" label="BTN"/>}
                  {selfPlayer.isSB     && <Badge bg="#2244aa" color="#fff"    label="SB"/>}
                  {selfPlayer.isBB     && <Badge bg="#b85a10" color="#fff"    label="BB"/>}
                  {selfPlayer.isWinner && <Badge bg="#f0d060" color="#1a1200" label="👑WIN"/>}
                  <span style={{fontFamily:'var(--font-title)',fontSize:12,color:'var(--gold-bright)'}}>{selfPlayer.name} (YOU)</span>
                  <span style={{fontFamily:'var(--font-body)',fontSize:12,color:'#88dd88'}}>💵{selfPlayer.chips}{selfPlayer.bet>0?` B${selfPlayer.bet}`:''}</span>
                </div>
                {selfPlayer.isMyTurn && meta.timerLimit>0 && timerSec!==null && (
                  <div style={{marginBottom:4,width:'100%'}}><TimerBar remaining={timerSec} limit={meta.timerLimit}/></div>
                )}
                <div style={{display:'flex',gap:5,justifyContent:'center'}}>
                  {selfPlayer.hand.map((code,j) => (
                    <div key={j} style={{display:'flex',flexDirection:'column' as const,alignItems:'center'}}>
                      <Card code={code} size="md"
                        selected={selected.includes(j)}
                        clickable={isDrawPhase&&isMyTurn&&!myDrew}
                        folded={selfPlayer.folded}
                        onClick={()=>handleCardClick(j)} />
                      {selected.includes(j) && <span style={{fontSize:7,color:'#e84040',fontFamily:'var(--font-title)',marginTop:1}}>捨</span>}
                    </div>
                  ))}
                </div>
                {selfPlayer.result && (
                  <div style={{fontSize:11,color:selfPlayer.isWinner?'var(--gold-bright)':'var(--cream-dim)',fontFamily:'var(--font-title)',marginTop:3}}>{selfPlayer.result}</div>
                )}
              </div>
            )}
          </div>

          {/* 右: アクションボタン縦積み */}
          <div style={{width:120,flexShrink:0,background:'rgba(0,0,0,0.3)',borderLeft:'1px solid rgba(201,168,76,0.15)',padding:'8px 6px',display:'flex',flexDirection:'column',justifyContent:'center',gap:7,overflow:'hidden'}}>
            <ActionButtons compact />
          </div>
        </div>
      </div>
    );
  }

  // ==========================================================
  // ■ PC版レイアウト（楕円テーブル）
  // ==========================================================
  const TW=1100; const TH=760;
  const CX=TW/2; const CY=TH/2-10;
  const RX=390; const RY=270;
  const BW=230;
  const others = players.filter((p)=>!p.isSelf);

  const getPos = (p:Player) => {
    let ang:number;
    if (p.isSelf) { ang=90; }
    else {
      const slots=[-90,-30,30,150,210];
      const idx=others.findIndex((o)=>o.id===p.id);
      ang=slots[idx]??(-90+60*(idx+1));
    }
    const rad=(ang*Math.PI)/180;
    const cx=CX+RX*Math.cos(rad); const cy=CY+RY*Math.sin(rad);
    const bh=p.isSelf?240:190;
    return {left:cx-BW/2, top:cy-bh/2};
  };

  const selfPlayer = players.find((p)=>p.isSelf);

  return (
    <div style={{minHeight:'100vh',display:'flex',flexDirection:'column',alignItems:'center',paddingBottom:16,position:'relative',zIndex:1,fontFamily:'var(--font-body)'}}>
      <NavBar />
      <PendingBar />
      <PotBar />

      {/* テーブル + アクション（横並び）*/}
      <div style={{display:'flex',alignItems:'center',gap:0,width:'100%',maxWidth:TW+280,padding:'0 16px'}}>
        {/* テーブル */}
        <div style={{position:'relative',width:TW,height:TH,flexShrink:0}}>
          <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',width:'70%',height:'62%',borderRadius:'50%',background:'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)',border:'8px solid var(--gold-dim)',boxShadow:'0 0 40px rgba(0,0,0,0.8),inset 0 0 30px rgba(0,0,0,0.4)',zIndex:0}} />
          <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',width:'calc(70% - 20px)',height:'calc(62% - 20px)',borderRadius:'50%',border:'1px solid rgba(201,168,76,0.25)',zIndex:0}} />

          {/* テーブル中央 */}
          {meta.phase!=='waiting' && (
            <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',zIndex:2,pointerEvents:'none'}}>
              <CenterInfo big />
            </div>
          )}

          {/* プレイヤーボックス */}
          {players.map((p) => {
            const {left,top}=getPos(p);
            return (
              <div key={p.id} style={{
                position:'absolute',zIndex:1,textAlign:'center',padding:'8px 6px',borderRadius:11,
                border:'1px solid transparent',transition:'all 0.25s',left,top,width:BW,
                ...(p.isSelf?{background:'rgba(10,50,30,0.8)',border:'1px solid rgba(201,168,76,0.35)'}:{}),
                ...(p.isMyTurn&&!p.folded&&!p.sittingOut?{border:'1px solid var(--gold)',boxShadow:'0 0 18px rgba(201,168,76,0.5)',background:'rgba(201,168,76,0.08)'}:{}),
                ...(p.folded&&!p.sittingOut?{opacity:0.4}:{}),
                ...(p.sittingOut?{opacity:0.5,border:'1px solid rgba(255,255,255,0.1)'}:{}),
                ...(p.isWinner?{border:'1px solid var(--gold-bright)',boxShadow:'0 0 22px rgba(240,208,96,0.6)',background:'rgba(201,168,76,0.12)'}:{}),
              }}>
                <div style={{display:'flex',gap:4,justifyContent:'center',marginBottom:4,flexWrap:'wrap' as const}}>
                  {p.isDealer   && <Badge bg="#c9a84c" color="#1a1200" label="BTN"/>}
                  {p.isSB       && <Badge bg="#2244aa" color="#fff"    label="SB"/>}
                  {p.isBB       && <Badge bg="#b85a10" color="#fff"    label="BB"/>}
                  {p.folded&&!p.sittingOut && <Badge bg="#444" color="#aaa" label="FOLD"/>}
                  {p.sittingOut && <Badge bg="#555" color="#bbb" label="WAIT"/>}
                  {p.isWinner   && <Badge bg="#f0d060" color="#1a1200" label="👑WIN"/>}
                </div>
                <p style={{fontFamily:'var(--font-title)',fontSize:14,color:p.isSelf?'var(--gold-bright)':'var(--cream)',letterSpacing:'0.04em',margin:'0 0 3px',whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis'}}>
                  {p.isSelf?`${p.name} (YOU)`:p.name}
                </p>
                <div style={{display:'flex',justifyContent:'center',gap:7,marginBottom:4,flexWrap:'wrap' as const}}>
                  <span style={{fontFamily:'var(--font-body)',fontSize:16,color:'#88dd88'}}>💵 {p.chips}</span>
                  {p.bet>0 && <span style={{fontFamily:'var(--font-body)',fontSize:15,color:'var(--gold)',background:'rgba(201,168,76,0.15)',borderRadius:3,padding:'0 5px'}}>BET {p.bet}</span>}
                </div>
                {p.isMyTurn&&meta.timerLimit>0&&timerSec!==null&&<TimerBar remaining={timerSec} limit={meta.timerLimit}/>}
                <div style={{display:'flex',justifyContent:'center',gap:p.isSelf?7:4,flexWrap:'nowrap' as const,margin:'5px 0'}}>
                  {p.hand.map((code,j)=>(
                    <div key={j} style={{display:'flex',flexDirection:'column' as const,alignItems:'center'}}>
                      <Card code={code} size={p.isSelf?'lg':'sm'}
                        selected={p.isSelf&&selected.includes(j)}
                        clickable={p.isSelf&&isDrawPhase&&isMyTurn&&!myDrew}
                        folded={p.folded}
                        onClick={()=>handleCardClick(j)} />
                      {p.isSelf&&selected.includes(j)&&<span style={{fontSize:9,color:'#e84040',fontFamily:'var(--font-title)',marginTop:2}}>捨てる</span>}
                    </div>
                  ))}
                </div>
                {!p.isSelf&&(isDrawPhase||isBetPhase)&&(()=>{
                  const cnt=isDrawPhase?(p.drewThisRound?p.drawCount:null):(lastDrawCount[p.id]??null);
                  if(cnt===null) return isDrawPhase?<p style={{fontSize:11,color:'#88bbff',fontStyle:'italic',marginTop:2}}>⏳ thinking...</p>:null;
                  return <p style={{fontSize:12,color:'#88bbff',fontStyle:'italic',marginTop:2}}>{cnt===0?'✋ Stand pat':`🔄 ${cnt} cards`}</p>;
                })()}
                {p.result&&<p style={{fontSize:13,color:p.isWinner?'var(--gold-bright)':'var(--cream-dim)',fontFamily:'var(--font-title)',marginTop:4,letterSpacing:'0.04em',fontWeight:p.isWinner?'700':'400'}}>{p.result}</p>}
              </div>
            );
          })}
        </div>

        {/* アクションパネル（テーブル右側縦積み）*/}
        <div style={{
          width:240,flexShrink:0,
          background:'linear-gradient(160deg,rgba(22,92,56,0.5),rgba(10,51,32,0.7))',
          border:'1px solid var(--gold-dim)',borderRadius:12,padding:'20px 16px',
          display:'flex',flexDirection:'column',justifyContent:'center',gap:12,
          minHeight:280, marginLeft:8,
        }}>
          {/* 自分の情報 */}
          {selfPlayer && (
            <div style={{textAlign:'center',paddingBottom:10,borderBottom:'1px solid rgba(201,168,76,0.2)'}}>
              <div style={{fontFamily:'var(--font-title)',fontSize:12,color:'var(--gold-bright)',marginBottom:2}}>{selfPlayer.name} (YOU)</div>
              <div style={{fontFamily:'var(--font-body)',fontSize:15,color:'#88dd88'}}>💵 {selfPlayer.chips}</div>
              {selfPlayer.result && <div style={{fontFamily:'var(--font-title)',fontSize:12,color:'var(--cream-dim)',marginTop:2}}>{selfPlayer.result}</div>}
            </div>
          )}
          <ActionButtons />
        </div>
      </div>

      <p style={{textAlign:'center',fontSize:13,color:'var(--gold-dim)',fontFamily:'var(--font-body)',marginTop:10,padding:'0 12px'}}>
        {effectiveMode==='badugi'?'★ Badugi: 全スート異なる低い4枚が最強。枚数が多い方が強い。':'★ 2-7 Lowball: 低い手が強い。フラッシュ・ストレートは弱い手。Aは常に最高位。'}
      </p>
    </div>
  );
};

// ===== 共通スタイル定数 =====
const modBadgeSt:React.CSSProperties = { fontFamily:'var(--font-title)', padding:'3px 9px', borderRadius:4 };
const phaseBadgeSt:React.CSSProperties = { fontFamily:'var(--font-title)', letterSpacing:'0.25em', color:'var(--gold-bright)', background:'rgba(201,168,76,0.12)', border:'1px solid var(--gold-dim)', borderRadius:4 };
const leaveBtnSt:React.CSSProperties = { fontFamily:'var(--font-title)', fontSize:11, padding:'5px 12px', background:'rgba(139,26,26,0.55)', border:'1px solid rgba(204,34,34,0.4)', borderRadius:4, color:'#ffaaaa', cursor:'pointer', flexShrink:0 };
const potChipSt:React.CSSProperties = { fontFamily:'var(--font-title)', color:'var(--cream-dim)', background:'rgba(0,0,0,0.3)', border:'1px solid var(--gold-dim)', borderRadius:16, padding:'5px 14px' };

export default PokerTable;
