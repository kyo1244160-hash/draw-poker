'use client';
// app/components/TournamentTable.tsx
// PokerTable.tsx のPC版レイアウトをprops駆動で再現

import { useEffect, useRef, useState } from 'react';
import type { PlayerState, GameMeta } from '../types/tournament';

// ===== カード（PokerTable.tsx と同じ）=====
const SUIT_SYM: Record<string,string>   = {s:'♠',c:'♣',h:'♥',d:'♦'};
const SUIT_COLOR: Record<string,string> = {s:'#1a1a2e',c:'#1a1a2e',h:'#8b1a1a',d:'#8b1a1a'};
const RANK_LABEL: Record<string,string> = {T:'10',J:'J',Q:'Q',K:'K',A:'A'};

function Card({ code, selected, onClick }: { code:string; selected?:boolean; onClick?:()=>void }) {
  if (code === '??') return (
    <div style={{
      width:40,height:60,borderRadius:5,flexShrink:0,
      background:'linear-gradient(135deg,#1a3a6e,#0d1f3c)',
      border:'1.5px solid #2244aa',
      display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,
    }}>🂠</div>
  );
  const rank  = code.slice(0,-1);
  const suit  = code.slice(-1);
  const label = RANK_LABEL[rank] ?? rank;
  const color = SUIT_COLOR[suit] ?? '#1a1a2e';
  const sym   = SUIT_SYM[suit] ?? suit;
  return (
    <div onClick={onClick} style={{
      width:40,height:60,borderRadius:5,flexShrink:0,
      background: selected ? 'linear-gradient(180deg,#fffde0,#fff8c0)' : 'linear-gradient(180deg,#ffffff,#f0ece4)',
      border: selected ? '2px solid var(--gold-bright)' : '1.5px solid #c8b898',
      display:'flex',flexDirection:'column' as const,alignItems:'center',justifyContent:'space-between',
      padding:'3px 2px',color,
      transform: selected ? 'translateY(-10px)' : undefined,
      boxShadow: selected ? '0 0 0 3px rgba(240,208,96,0.5),0 4px 12px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.5)',
      transition:'all 0.15s', cursor: onClick ? 'pointer' : 'default',
    }}>
      <span style={{fontSize:12,fontWeight:700,lineHeight:1,fontFamily:'Georgia,serif'}}>{label}</span>
      <span style={{fontSize:15,lineHeight:1}}>{sym}</span>
      <span style={{fontSize:12,fontWeight:700,lineHeight:1,transform:'rotate(180deg)',display:'inline-block',fontFamily:'Georgia,serif'}}>{label}</span>
    </div>
  );
}

// ===== バッジ =====
function Badge({bg,color,label}:{bg:string;color:string;label:string}) {
  return <span style={{fontSize:9,fontFamily:'var(--font-title)',padding:'1px 5px',borderRadius:3,background:bg,color,flexShrink:0}}>{label}</span>;
}

// ===== タイマーバー =====
function TimerBar({remaining,limit}:{remaining:number;limit:number}) {
  const pct = limit>0 ? Math.min(100,(remaining/limit)*100) : 0;
  const color = pct>50?'#22c55e':pct>25?'#eab308':'#ef4444';
  return (
    <div style={{width:'100%',height:3,background:'rgba(255,255,255,0.1)',borderRadius:2,margin:'3px 0'}}>
      <div style={{height:'100%',width:`${pct}%`,background:color,borderRadius:2,transition:'width 0.5s linear'}}/>
    </div>
  );
}

const PHASE_LABEL: Record<string,string> = {
  waiting:'待機中',bet0:'第1ベット',draw1:'第1ドロー',bet1:'第2ベット',
  draw2:'第2ドロー',bet2:'第3ベット',draw3:'第3ドロー',bet3:'第4ベット',showdown:'ショーダウン',
};

// ===== メインコンポーネント =====
interface Props {
  players: PlayerState[];
  meta: GameMeta | null;
  timer: {remaining:number;limit:number} | null;
  isSpectator?: boolean;
  onBetAction: (action:string) => void;
  onDrawCards: (indices:number[]) => void;
  onUpdateSelected: (indices:number[]) => void;
}

export default function TournamentTable({players,meta,timer,isSpectator,onBetAction,onDrawCards,onUpdateSelected}:Props) {
  const [selected, setSelected] = useState<number[]>([]);
  const [winW, setWinW] = useState(1000);
  const [winH, setWinH] = useState(700);

  useEffect(()=>{
    const update=()=>{ setWinW(window.innerWidth); setWinH(window.innerHeight); };
    update();
    window.addEventListener('resize',update);
    return ()=>window.removeEventListener('resize',update);
  },[]);

  const phase       = meta?.phase ?? 'waiting';
  const isDrawPhase = phase.startsWith('draw');
  const isBetPhase  = phase.startsWith('bet');
  const self        = players.find(p=>p.isSelf) ?? null;
  const others      = players.filter(p=>!p.isSelf);

  // フェーズ変わったら選択リセット
  useEffect(()=>{ setSelected([]); onUpdateSelected([]); },[phase]);

  function toggleCard(i:number) {
    setSelected(prev => {
      const next = prev.includes(i) ? prev.filter(x=>x!==i) : [...prev,i];
      onUpdateSelected(next);
      return next;
    });
  }

  // === PC版テーブル寸法 ===
  const ACT_W = 270;
  const TW = Math.min(980, Math.max(500, winW - ACT_W - 64));
  const TH = Math.min(680, Math.max(400, winH - 140));
  const CX = TW/2, CY = TH/2 - 10;
  const RX = TW*0.353, RY = TH*0.353;
  const BW = Math.max(155, Math.floor(TW*0.20));

  const SLOTS = [150,-150,-90,-30,30];
  const getPos = (p:PlayerState) => {
    let ang = 90;
    if (!p.isSelf) {
      const idx = others.findIndex(o=>o.id===p.id);
      ang = SLOTS[idx] ?? (-90+60*(idx+1));
    }
    const rad = (ang*Math.PI)/180;
    const cx = CX + RX*Math.cos(rad);
    const cy = CY + RY*Math.sin(rad);
    const bh = p.isSelf ? Math.floor(TH*0.30) : Math.floor(TH*0.24);
    return {left:cx-BW/2, top:cy-bh/2};
  };

  // === アクションパネル ===
  const btnStyle = (variant:'gold'|'gray'|'red'|'outline'):React.CSSProperties => {
    const base:React.CSSProperties = {
      padding:'12px 18px',border:'none',borderRadius:7,width:'100%',
      fontSize:15,fontWeight:700,cursor:'pointer',fontFamily:'var(--font-title)',
      letterSpacing:'0.04em',lineHeight:1.2,
    };
    const v = {
      gold:    {background:'linear-gradient(135deg,var(--gold),var(--gold-dim))',color:'#1a1200',boxShadow:'0 2px 10px rgba(201,168,76,0.4)'},
      gray:    {background:'rgba(255,255,255,0.12)',color:'var(--cream)',border:'1px solid rgba(255,255,255,0.25)'},
      red:     {background:'#8b1a1a',color:'#ffd0d0'},
      outline: {background:'rgba(255,255,255,0.06)',color:'var(--cream-dim)',border:'1px solid var(--gold-dim)'},
    };
    return {...base,...v[variant]};
  };

  const infoText:React.CSSProperties = {
    fontFamily:'var(--font-body)',fontSize:14,color:'var(--cream-dim)',
    fontStyle:'italic',textAlign:'center' as const,padding:'4px 0',lineHeight:1.4,
  };

  const ActionPanel = () => {
    if (phase==='waiting') return <div style={infoText}>{players.length<2?'もう1人参加を待っています':'ゲームを準備中...'}</div>;
    if (isDrawPhase && self?.isMyTurn && !self?.drewThisRound) return (
      <div style={{display:'flex',flexDirection:'column' as const,gap:8}}>
        <div style={infoText}>{selected.length>0?`${selected.length}枚選択中`:'捨てるカードを選択'}</div>
        <button style={btnStyle('gold')} onClick={()=>onDrawCards(selected)}>
          {selected.length>0?`🔄 ${selected.length}枚交換`:'✋ スタンドパット'}
        </button>
        {selected.length>0&&<button style={btnStyle('outline')} onClick={()=>{setSelected([]);onUpdateSelected([]);}}>選択解除</button>}
      </div>
    );
    if (isDrawPhase) return <div style={infoText}>{self?.drewThisRound?'他プレイヤーを待っています...':'ドロー中...'}</div>;
    if (isBetPhase && self?.isMyTurn) return (
      <div style={{display:'flex',flexDirection:'column' as const,gap:8}}>
        <div style={infoText}>
          {(self.toCall??0)>0?`コール: ${self.toCall}`:'チェック or ベット'}
          <span style={{fontSize:11,opacity:0.65,display:'block'}}>単位:{self.betSize} Bet {meta?.raiseCount??0}/{5}</span>
        </div>
        <button style={btnStyle('red')} onClick={()=>onBetAction('fold')}>フォールド</button>
        {self.canCheck
          ? <button style={btnStyle('gray')} onClick={()=>onBetAction('check')}>チェック</button>
          : <button style={btnStyle('gray')} onClick={()=>onBetAction('call')}>コール ({self.toCall})</button>
        }
        {self.canRaise&&<button style={btnStyle('gold')} onClick={()=>onBetAction((meta?.currentBet??0)===0?'bet':'raise')}>
          {(meta?.currentBet??0)===0?`ベット (+${self.betSize})`:`レイズ (+${self.betSize})`}
        </button>}
      </div>
    );
    if (isBetPhase) {
      const cur = players.find(p=>p.isMyTurn&&!p.isSelf);
      return <div style={infoText}>{cur?`${cur.name} がアクション中...`:'待機中...'}</div>;
    }
    if (phase==='showdown') return <div style={infoText}>次のゲームを準備中...</div>;
    return null;
  };

  return (
    <div style={{
      display:'flex',alignItems:'center',gap:12,
      width:'100%',padding:'0 8px',
    }}>
      {/* 楕円テーブル */}
      <div style={{position:'relative',width:TW,height:TH,flexShrink:0}}>
        {/* 外枠 */}
        <div style={{
          position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
          width:'70%',height:'62%',borderRadius:'50%',
          background:'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)',
          border:'8px solid var(--gold-dim)',
          boxShadow:'0 0 40px rgba(0,0,0,0.8),inset 0 0 30px rgba(0,0,0,0.4)',
          zIndex:0,
        }}/>
        <div style={{
          position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
          width:'calc(70% - 20px)',height:'calc(62% - 20px)',borderRadius:'50%',
          border:'1px solid rgba(201,168,76,0.25)',zIndex:0,
        }}/>

        {/* テーブル中央 */}
        {phase!=='waiting' && (
          <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',zIndex:2,pointerEvents:'none',textAlign:'center' as const}}>
            <div style={{fontFamily:'var(--font-title)',fontSize:20,letterSpacing:'0.15em',
              color:isBetPhase?'var(--gold-bright)':isDrawPhase?'#88ddff':'var(--cream-dim)',
              textShadow:'0 0 12px rgba(0,0,0,0.9)',lineHeight:1.1}}>
              {PHASE_LABEL[phase]}
            </div>
            {meta&&meta.pot>0&&<div style={{fontSize:16,color:'#f0d060',fontWeight:700,marginTop:3,fontFamily:'var(--font-title)'}}>🏦 {meta.pot}</div>}
            {isBetPhase&&(meta?.currentBet??0)>0&&<div style={{fontSize:12,color:'#ffcc44',marginTop:1,fontFamily:'var(--font-body)'}}>BET {meta?.currentBet}</div>}
          </div>
        )}

        {/* ディーラーボタン */}
        {(()=>{
          const dp = players.find(p=>p.isDealer);
          if (!dp || (meta?.dealerIndex??-1)<0) return null;
          const pos=getPos(dp);
          const bh=dp.isSelf?Math.floor(TH*0.30):Math.floor(TH*0.24);
          const cx=pos.left+BW/2, cy=pos.top+bh/2;
          const dx=cx-CX, dy=cy-CY;
          const dist=Math.sqrt(dx*dx+dy*dy);
          const scale=dist>0?Math.max(0,(dist-100))/dist:0;
          return <div key="d" style={{position:'absolute',left:CX+dx*scale-14,top:CY+dy*scale-14,width:28,height:28,borderRadius:'50%',background:'#fff',border:'2px solid #444',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'var(--font-title)',fontSize:11,fontWeight:900,color:'#1a1a1a',boxShadow:'0 2px 6px rgba(0,0,0,0.7)',zIndex:5,pointerEvents:'none'}}>D</div>;
        })()}

        {/* プレイヤーボックス */}
        {players.map(p=>{
          const {left,top}=getPos(p);
          const active=p.isMyTurn&&!p.folded;
          const bh=p.isSelf?Math.floor(TH*0.30):Math.floor(TH*0.24);
          return (
            <div key={p.id} style={{position:'absolute',left,top,width:BW,zIndex:2}}>
              <div style={{
                textAlign:'center' as const,padding:'8px 6px',borderRadius:11,
                transition:'all 0.25s',width:BW,
                background:p.isSelf?'rgba(10,50,30,0.8)':'rgba(0,0,0,0.3)',
                border: p.isWinner?'3px solid var(--gold-bright)':active?'1px solid var(--gold)':'1px solid rgba(201,168,76,0.2)',
                boxShadow: p.isWinner?'0 0 40px rgba(240,208,96,0.9)':active?'0 0 18px rgba(201,168,76,0.5)':'none',
                opacity:p.folded&&!p.sittingOut?0.4:p.sittingOut?0.5:1,
              }}>
                <div style={{display:'flex',gap:4,justifyContent:'center',marginBottom:4,flexWrap:'wrap' as const}}>
                  {p.isDealer&&<Badge bg="#c9a84c" color="#1a1200" label="BTN"/>}
                  {p.isSB&&<Badge bg="#2244aa" color="#fff" label="SB"/>}
                  {p.isBB&&<Badge bg="#b85a10" color="#fff" label="BB"/>}
                  {p.folded&&!p.sittingOut&&<Badge bg="#444" color="#aaa" label="FOLD"/>}
                  {p.isWinner&&<Badge bg="#f0d060" color="#1a1200" label="🏆 WIN"/>}
                </div>
                <p style={{fontFamily:'var(--font-title)',fontSize:13,color:p.isSelf?'var(--gold-bright)':'var(--cream)',letterSpacing:'0.04em',margin:'0 0 3px',whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis'}}>
                  {p.isSelf?`${p.name} (YOU)`:p.name}
                </p>
                <div style={{display:'flex',justifyContent:'center',gap:6,marginBottom:4,flexWrap:'wrap' as const}}>
                  <span style={{fontFamily:'var(--font-body)',fontSize:15,color:'#88dd88'}}>💵 {p.chips}</span>
                  {p.bet>0&&<span style={{fontFamily:'var(--font-body)',fontSize:14,color:'var(--gold)',background:'rgba(201,168,76,0.15)',borderRadius:3,padding:'0 5px'}}>BET {p.bet}</span>}
                </div>
                {active&&timer&&<TimerBar remaining={timer.remaining} limit={timer.limit}/>}
                {/* 自分の手札（ドローフェーズは選択可能） */}
                {p.isSelf && p.hand.length>0 && (
                  <div style={{display:'flex',justifyContent:'center',gap:6,flexWrap:'nowrap' as const,margin:'6px 0'}}>
                    {p.hand.map((code,j)=>(
                      <div key={j} style={{display:'flex',flexDirection:'column' as const,alignItems:'center'}}>
                        <Card code={code} selected={isDrawPhase&&selected.includes(j)} onClick={isDrawPhase&&p.isMyTurn&&!p.drewThisRound?()=>toggleCard(j):undefined}/>
                        {isDrawPhase&&selected.includes(j)&&<span style={{fontSize:9,color:'#e84040',fontFamily:'var(--font-title)',marginTop:2}}>捨てる</span>}
                      </div>
                    ))}
                  </div>
                )}
                {/* 他プレイヤーの手札（裏/表）*/}
                {!p.isSelf&&p.hand.length>0&&(
                  <div style={{display:'flex',justifyContent:'center',gap:4,flexWrap:'nowrap' as const,margin:'4px 0'}}>
                    {p.hand.map((code,j)=><Card key={j} code={code}/>)}
                  </div>
                )}
                {p.disconnected&&<div style={{fontSize:10,color:'#ff8888',marginTop:2}}>⚡ 切断中</div>}
                {p.result&&<p style={{fontSize:12,color:p.isWinner?'var(--gold-bright)':'var(--cream-dim)',fontFamily:'var(--font-title)',marginTop:3,letterSpacing:'0.04em',fontWeight:p.isWinner?700:400}}>{p.result}</p>}
              </div>
            </div>
          );
        })}
      </div>

      {/* アクションパネル（右側）*/}
      <div style={{
        width:ACT_W,flexShrink:0,
        background:'linear-gradient(160deg,rgba(22,92,56,0.5),rgba(10,51,32,0.7))',
        border:'1px solid var(--gold-dim)',borderRadius:12,padding:'20px 18px',
        display:'flex',flexDirection:'column' as const,justifyContent:'center',gap:12,
        minHeight:280,
      }}>
        {self&&(
          <div style={{textAlign:'center' as const,paddingBottom:10,borderBottom:'1px solid rgba(201,168,76,0.2)'}}>
            <div style={{fontFamily:'var(--font-title)',fontSize:14,color:'var(--gold-bright)',marginBottom:3}}>{self.name} (YOU)</div>
            <div style={{fontFamily:'var(--font-body)',fontSize:17,color:'#88dd88'}}>💵 {self.chips}</div>
            {self.result&&<div style={{fontFamily:'var(--font-title)',fontSize:13,color:'var(--cream-dim)',marginTop:3}}>{self.result}</div>}
          </div>
        )}
        <ActionPanel/>
        {isSpectator&&(
          <div style={{textAlign:'center' as const,fontSize:11,color:'#b088ff',border:'1px solid #6644aa',borderRadius:6,padding:'4px 0',marginTop:4}}>観戦中</div>
        )}
      </div>
    </div>
  );
}
