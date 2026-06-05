'use client';
/**
 * TournamentTable.tsx
 * PokerTable.tsx と完全統一したレイアウト（PC/スマホ縦/スマホ横）
 *
 * 主な統一点:
 *   - Card: 4色デッキ対応（S黒/H赤/D青/C緑）・xs/sm/lg サイズプリセット
 *   - PC版: 楕円テーブル + 右アクションパネル
 *   - スマホ縦: 楕円テーブル + 下固定アクションパネル
 *   - スマホ横: 楕円テーブル + 右カラムアクションパネル
 *   - フラッシュ演出: アクション表示・チェンジ枚数
 *   - ディーラーボタン・バッジ・タイマーバー
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { socket } from '../../socket';
import type { PlayerState, GameMeta, BlindUpdate } from '../types/tournament';
import TableListModal from '../../components/TableListModal';

// ==========================================================
// ■ Card（PokerTable.tsx と同じ 4色デッキ実装）
// ==========================================================
const SUIT_SYMBOL: Record<string, string> = { S:'♠', H:'♥', D:'♦', C:'♣' };
const SUIT_COLOR:  Record<string, string> = { S:'#1a1a2e', H:'#cc1111', D:'#1155cc', C:'#228833' };
const RANK_LABEL:  Record<string, string> = { T:'10', J:'J', Q:'Q', K:'K', A:'A' };
const SIZE_PRESET = {
  xs:  { w:26, h:38, fontSize:11, suitSize:8,  suitMult:1.2 },
  sm:  { w:32, h:48, fontSize:11, suitSize:9,  suitMult:1.3 },
  sm2: { w:40, h:60, fontSize:14, suitSize:12, suitMult:1.8 },
  md:  { w:52, h:76, fontSize:17, suitSize:15, suitMult:2.5 },
  lg:  { w:66, h:96, fontSize:21, suitSize:19, suitMult:2.5 },
} as const;
type CardSize = 'xs'|'sm'|'sm2'|'md'|'lg';

function Card({ code, size='md', selected=false, clickable=false, folded=false, onClick }:
  { code:string; size?:CardSize; selected?:boolean; clickable?:boolean; folded?:boolean; onClick?:()=>void }) {
  const dim    = SIZE_PRESET[size];
  const suit   = code && code !== '??' && code.length >= 2 ? code.slice(-1)   : null;
  const rank   = code && code !== '??' && code.length >= 2 ? code.slice(0,-1) : null;
  const isBack = !rank || !suit || !SUIT_SYMBOL[suit];
  const color  = !isBack ? SUIT_COLOR[suit!]  : '#fff';
  const symbol = !isBack ? SUIT_SYMBOL[suit!] : '';
  const rl     = !isBack ? (RANK_LABEL[rank!] ?? rank!) : '';

  return (
    <div onClick={clickable ? onClick : undefined} style={{
      position:'relative', width:dim.w, height:dim.h, flexShrink:0, borderRadius:5,
      background: isBack
        ? 'linear-gradient(135deg,#1a4a8a 0%,#0d2d5c 50%,#1a4a8a 100%)'
        : '#fffdf6',
      border: selected ? '2.5px solid #e84040' : '1.5px solid rgba(0,0,0,0.22)',
      boxShadow: selected
        ? '0 0 14px rgba(232,64,64,0.65),0 3px 8px rgba(0,0,0,0.5)'
        : '0 2px 8px rgba(0,0,0,0.45)',
      cursor: clickable ? 'pointer' : 'default',
      opacity: folded ? 0.35 : 1,
      transform: selected ? 'translateY(-14px)' : 'none',
      transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.1s',
      userSelect: 'none',
    }}>
      {isBack ? (
        <div style={{position:'absolute',inset:4,borderRadius:3,border:'1.5px solid rgba(255,255,255,0.25)',
          display:'flex',alignItems:'center',justifyContent:'center'}}>
          <span style={{fontSize:dim.fontSize*1.3,color:'rgba(255,255,255,0.3)',lineHeight:1}}>♦</span>
        </div>
      ) : (size==='xs'||size==='sm') ? (
        <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',
          alignItems:'center',justifyContent:'center',gap:2}}>
          <span style={{fontSize:dim.fontSize,fontWeight:'900',color,
            fontFamily:'Georgia,"Times New Roman",serif',lineHeight:1}}>{rl}</span>
          <span style={{fontSize:dim.suitSize*dim.suitMult,color,lineHeight:1}}>{symbol}</span>
        </div>
      ) : (
        <>
          <div style={{position:'absolute',top:3,left:5,lineHeight:1}}>
            <span style={{fontSize:dim.fontSize,fontWeight:'900',color,
              fontFamily:'Georgia,"Times New Roman",serif',lineHeight:1}}>{rl}</span>
          </div>
          <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
            <span style={{fontSize:dim.suitSize*dim.suitMult,color,lineHeight:1}}>{symbol}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ===== Badge =====
function Badge({bg,color,label}:{bg:string;color:string;label:string}) {
  return <span style={{fontSize:9,fontFamily:'var(--font-title)',padding:'1px 5px',
    borderRadius:3,background:bg,color,flexShrink:0}}>{label}</span>;
}

// ===== TimerBar =====
function TimerBar({remaining,limit}:{remaining:number;limit:number}) {
  const pct = limit>0 ? Math.min(100,(remaining/limit)*100) : 0;
  const color = pct>50?'#22c55e':pct>25?'#eab308':'#ef4444';
  return (
    <div style={{width:'100%',height:3,background:'rgba(255,255,255,0.1)',borderRadius:2,margin:'2px 0'}}>
      <div style={{height:'100%',width:`${pct}%`,background:color,borderRadius:2,
        transition:'width 0.5s linear'}}/>
    </div>
  );
}

// ===== 定数 =====
function fmtBlind(s: number) {
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

const PHASE_LABEL: Record<string,string> = {
  waiting:'待機中', bet0:'BET (Pre-Draw)',
  draw1:'DRAW I', bet1:'BET I', draw2:'DRAW II', bet2:'BET II',
  draw3:'DRAW III', bet3:'BET III', showdown:'SHOWDOWN',
};
const MODE_LABEL: Record<string,string> = {
  '27':'2-7 Triple Draw',
  badugi:'Badugi',
  mix:'Mix',
  a5:'A-5 Triple Draw',
  '27sd':'2-7 Single Draw',
  mix3:'Mix-3',
};

// ===== Props =====
interface TimerState { remaining:number; limit:number; }
interface Props {
  players:          PlayerState[];
  meta:             GameMeta | null;
  timer:            TimerState | null;
  isSpectator?:     boolean;
  /** NL対応: bet/raise時に amount を渡せる。リミット時は省略可 */
  onBetAction:      (action:string, amount?:number) => void;
  onDrawCards:      (indices:number[]) => void;
  onUpdateSelected: (indices:number[]) => void;
  blind?:           BlindUpdate | null;
  tournamentId?:    string;   // 他テーブル確認に使用
}

// ==========================================================
// ■ メインコンポーネント
// ==========================================================
export default function TournamentTable({
  players, meta, timer, isSpectator,
  onBetAction, onDrawCards, onUpdateSelected,
  blind, tournamentId,
}: Props) {
  const [selected,      setSelected]      = useState<number[]>([]);
  const [layout,        setLayout]        = useState<'pc'|'portrait'|'landscape'|null>(null);
  const [containerSize, setContainerSize] = useState<{w:number;h:number}>({w:0,h:0});
  const containerRef = useRef<HTMLDivElement>(null);
  const [actionFlash,   setActionFlash]   = useState<Record<string,{label:string;key:number}>>({});
  const [showTableList, setShowTableList] = useState(false);
  const [tableListData, setTableListData] = useState<{tableId:string;players:{name:string;chips:number;isSelf:boolean;sittingOut:boolean}[]}[]>([]);
  const [tableListLoading, setTableListLoading] = useState(false);
  const [drawFlash,     setDrawFlash]     = useState<Record<string,{count:number;key:number}>>({});
  const [lastDrawCount, setLastDrawCount] = useState<Record<string,number|null>>({});
  const prevDrewRef = useRef<Record<string,boolean>>({});
  // NLベット用: ユーザーが入力中のベット額（totalBet）
  const [nlBetAmount, setNlBetAmount] = useState<number | null>(null);

  // レイアウト検出 + コンテナ実サイズ計測
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth, h = window.innerHeight;
      if (w >= 768) setLayout('pc');
      else setLayout(w < h ? 'portrait' : 'landscape');
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ w: rect.width || w, h: rect.height || h });
      }
    };
    update();
    const onOrientationChange = () => setTimeout(update, 100);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', onOrientationChange);
    // ResizeObserver で親要素の高さ変化を検知
    const ro = new ResizeObserver(update);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', onOrientationChange);
      ro.disconnect();
    };
  }, []);

  // ゲーム状態
  const phase         = meta?.phase ?? 'waiting';
  const isDrawPhase   = phase.startsWith('draw');
  const isBetPhase    = phase.startsWith('bet');
  const self          = players.find(p => p.isSelf) ?? null;
  const isMyTurn      = self?.isMyTurn ?? false;
  const myDrew        = self?.drewThisRound ?? false;
  const effectiveMode = meta?.currentMode ?? '27';
  const isNoLimitMode = effectiveMode === '27sd' || !!meta?.isNL;
  const selfIsNL      = !!self?.isNL || isNoLimitMode;
  const modeColor     = effectiveMode==='badugi' ? '#cc9966'
                      : effectiveMode==='a5'     ? '#bb88dd'
                      : effectiveMode==='27sd'   ? '#88dd88'
                      : '#88bbee';
  const drawRound     = ['draw1','draw2','draw3'].indexOf(phase)+1;
  const raiseCount    = meta?.raiseCount ?? 0;
  const timerSec      = timer?.remaining ?? null;
  const timerLimit    = timer?.limit ?? (meta?.timerLimit ?? 0);

  // テーブル一覧を取得してモーダル表示
  const openTableList = async () => {
    if (!tournamentId) return;
    setShowTableList(true);
    setTableListLoading(true);
    try {
      const res = await fetch(`/api/tournament/${tournamentId}/tables`);
      if (res.ok) {
        const data = await res.json();
        setTableListData(data.tables ?? []);
      }
    } catch { /* silent */ } finally {
      setTableListLoading(false);
    }
  };

  const HeaderTableListButton = () => {
    if (!tournamentId) return null;
    return (
      <button
        type="button"
        onClick={openTableList}
        aria-label="Table list"
        title="Table list"
        style={{
          position:'fixed',top:52,right:8,width:32,height:28,
          borderRadius:5,border:'1px solid rgba(201,168,76,0.45)',
          background:'rgba(6,45,28,0.95)',color:'var(--gold-bright)',
          display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:3,
          cursor:'pointer',zIndex:45,boxShadow:'0 2px 8px rgba(0,0,0,0.35)',
        }}
      >
        <span style={{width:15,height:2,borderRadius:2,background:'currentColor',display:'block'}} />
        <span style={{width:15,height:2,borderRadius:2,background:'currentColor',display:'block'}} />
        <span style={{width:15,height:2,borderRadius:2,background:'currentColor',display:'block'}} />
      </button>
    );
  };

  // 自分から時計回りに他プレイヤーを並べる
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

  // フェーズ変化 → 選択リセット
  useEffect(() => {
    setSelected([]);
    onUpdateSelected([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ===== ターン通知音 =====
  // isMyTurn が false→true に変化した瞬間だけ短いブザー音を再生する。
  // Web Audio API で生成するため外部ファイル不要。
  // suspended 状態で早期生成し、最初の pointerdown で resume() することで
  // ゲーム開始直後の最初のターンでも音が鳴るようにする。
  const audioCtxRef = useRef<AudioContext | null>(null);
  const prevIsMyTurnRef = useRef<boolean>(false);

  useEffect(() => {
    const AudioContextClass = window.AudioContext
      || (window as unknown as Record<string, unknown>).webkitAudioContext as typeof AudioContext;
    if (!AudioContextClass) return;
    // suspended 状態で作成（ブラウザの自動再生ポリシーに準拠）
    audioCtxRef.current = new AudioContextClass();
    const resume = () => {
      if (audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume();
      }
    };
    window.addEventListener('pointerdown', resume);
    return () => {
      window.removeEventListener('pointerdown', resume);
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, []);

  useEffect(() => {
    const wasMyTurn = prevIsMyTurnRef.current;
    prevIsMyTurnRef.current = isMyTurn;

    // false → true のときだけ鳴らす（自分のターン開始）
    if (!wasMyTurn && isMyTurn && audioCtxRef.current) {
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') return; // まだユーザー操作前なら鳴らさない
      // 「ピピピッ」: 1000Hz の短いビープを 3 回（間隔 0.12秒）
      const freq = 1000;
      const dur  = 0.07;   // 1音の長さ
      const gap  = 0.12;   // 音の間隔（start基準）
      for (let i = 0; i < 3; i++) {
        const t0   = ctx.currentTime + i * gap;
        const osc  = ctx.createOscillator();
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

  // ブラインドアップカウントダウン
  const [blindCountdown, setBlindCountdown] = useState<number>(0);
  useEffect(() => {
    const secs = blind?.secondsToNextLevel ?? 0;
    setBlindCountdown(secs);
    if (!blind || blind.isLastLevel || secs <= 0) return;
    const iv = setInterval(() => {
      setBlindCountdown(prev => { if (prev <= 1) { clearInterval(iv); return 0; } return prev - 1; });
    }, 1000);
    return () => clearInterval(iv);
  }, [blind?.secondsToNextLevel, blind?.isLastLevel, blind?.level]);

  // actionFlash 管理 — PokerTable.tsx と完全同一ロジック
  // socketリスナーをここで直接登録することで prop 経由の遅延を排除する
  useEffect(() => {
    const ACTION_LABEL: Record<string,string> = {
      fold:'フォールド', check:'チェック', call:'コール', bet:'ベット', raise:'レイズ',
    };
    const onPlayerAction = ({ playerName, action }: { playerName:string; action:string }) => {
      const label = ACTION_LABEL[action] ?? action;
      setActionFlash(prev => ({
        ...prev,
        [playerName]: { label, key: Date.now() },
      }));
      setTimeout(() => {
        setActionFlash(prev => {
          const next = { ...prev };
          delete next[playerName];
          return next;
        });
      }, 2000);
    };
    socket.on('playerAction', onPlayerAction);

    // gameStarted: リングゲームと同じリセット処理
    const onGameStarted = () => {
      setSelected([]);
      setLastDrawCount({});
      setDrawFlash({});
      setActionFlash({});
      prevDrewRef.current = {};
    };
    socket.on('gameStarted', onGameStarted);

    return () => {
      socket.off('playerAction', onPlayerAction);
      socket.off('gameStarted', onGameStarted);
    };
  }, []);

  // drawCount フラッシュ管理（PokerTable.tsx と同ロジック）
  useEffect(() => {
    if (!players.length) return;
    setLastDrawCount(prev => {
      const next = { ...prev };
      for (const p of players) { if (p.drawCount != null) next[p.id] = p.drawCount; }
      return next;
    });

    const fireFlashes = (list: {pid:string;cnt:number}[]) => {
      if (!list.length) return;
      const pids = list.map(f => f.pid);
      setDrawFlash(prev => {
        const next = { ...prev };
        for (const { pid, cnt } of list) next[pid] = { count:cnt, key:Date.now() };
        return next;
      });
      setTimeout(() => setDrawFlash(cur => {
        const n = { ...cur }; for (const pid of pids) delete n[pid]; return n;
      }), 2500);
    };

    if (isDrawPhase) {
      const newFlashes: {pid:string;cnt:number}[] = [];
      for (const p of players) {
        if (!p.drewThisRound || p.drawCount == null) continue;
        if (!(prevDrewRef.current[p.id] ?? false)) newFlashes.push({ pid:p.id, cnt:p.drawCount });
      }
      const newPrev: Record<string,boolean> = {};
      for (const p of players) newPrev[p.id] = p.drewThisRound ?? false;
      prevDrewRef.current = newPrev;
      fireFlashes(newFlashes);
    } else {
      const lateFlashes: {pid:string;cnt:number}[] = [];
      for (const p of players) {
        if (!p.drewThisRound || p.drawCount == null) continue;
        if (!(prevDrewRef.current[p.id] ?? false)) lateFlashes.push({ pid:p.id, cnt:p.drawCount });
      }
      const newPrev: Record<string,boolean> = {};
      for (const p of players) newPrev[p.id] = p.drewThisRound ?? false;
      prevDrewRef.current = newPrev;
      if (lateFlashes.length) {
        fireFlashes(lateFlashes);
      } else {
        // betフェーズ中のgameState毎にsetDrawFlash({})を呼ぶとlateFlashが消えるため
        // 新ハンド開始（全員drewThisRound=false）のときのみクリア
        const allNotDrew = players.every(p => !(p.drewThisRound ?? false));
        if (allNotDrew) setDrawFlash({});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players]);

  // カードクリック
  const handleCardClick = useCallback((j:number) => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    setSelected(prev => {
      const next = prev.includes(j) ? prev.filter(i => i!==j) : [...prev, j];
      onUpdateSelected(next);
      return next;
    });
  }, [isDrawPhase, isMyTurn, myDrew, onUpdateSelected]);

  // オールイン中（chips=0）で自分のターンが来たら自動的にチェック/コール送信（タイムアウト防止）
  useEffect(() => {
    if (!self?.isAllIn || !isMyTurn || !isBetPhase) return;
    const action = self?.canCheck ? 'check' : 'call';
    const timer = setTimeout(() => onBetAction(action), 100);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self?.isAllIn, isMyTurn, isBetPhase]);

  // ===== NLベット関連ヘルパー =====
  // 送信するベット額を決定。ショートスタック時は maxBet 固定（オールイン）
  const getNLSendAmount = (s: PlayerState): number => {
    const isBet      = (meta?.currentBet ?? 0) === 0;
    const minBet     = s.minBet ?? meta?.bigBlind ?? 10;
    const minRaiseT  = s.minRaiseTotal ?? ((meta?.currentBet ?? 0) + (meta?.bigBlind ?? 10));
    const maxBet     = s.maxBetTotal ?? ((s.bet ?? 0) + (s.chips ?? 0));
    const lowerBound = isBet ? minBet : minRaiseT;
    if (maxBet < lowerBound) return maxBet;
    return Math.max(lowerBound, Math.min(maxBet, nlBetAmount ?? lowerBound));
  };

  // NLベット時に下限が変わったら入力値を初期化
  useEffect(() => {
    if (!selfIsNL || !self?.canRaise) { setNlBetAmount(null); return; }
    const lowerBound = (meta?.currentBet ?? 0) === 0 ? (self.minBet ?? 10) : (self.minRaiseTotal ?? 10);
    if (nlBetAmount === null || nlBetAmount < lowerBound) {
      setNlBetAmount(lowerBound);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.currentBet, meta?.phase, self?.isMyTurn, selfIsNL, self?.canRaise, self?.minBet, self?.minRaiseTotal]);

  // NLベットコントロール（クイック選択 + スライダー）
  const NLBetControl = ({compact = false}:{compact?: boolean}) => {
    if (!self || !self.canRaise || !selfIsNL) return null;

    const isBet      = (meta?.currentBet ?? 0) === 0;
    const minBet     = self.minBet ?? meta?.bigBlind ?? 10;
    const minRaiseT  = self.minRaiseTotal ?? ((meta?.currentBet ?? 0) + (meta?.bigBlind ?? 10));
    const maxBet     = self.maxBetTotal ?? ((self.bet ?? 0) + (self.chips ?? 0));
    const lowerBound = isBet ? minBet : minRaiseT;
    const pot        = meta?.pot ?? 0;

    // ショートスタック: オールイン専用UI
    const isShortStack = maxBet < lowerBound;
    if (isShortStack) {
      return (
        <div style={{
          fontSize: compact ? 10 : 11,
          textAlign:'center' as const,
          color:'#c8bfee', fontFamily:'var(--font-body)',
          padding: compact ? '3px 6px' : '4px 8px',
          background:'rgba(100,80,200,0.15)',
          border:'0.5px solid rgba(150,130,240,0.3)',
          borderRadius: 4,
        }}>
          残りチップ不足 → オールイン専用 ({maxBet.toLocaleString()})
        </div>
      );
    }

    const currentAmt = nlBetAmount ?? lowerBound;
    const clampedAmt = Math.max(lowerBound, Math.min(maxBet, currentAmt));
    const bigBlind = meta?.bigBlind ?? minBet;
    const sliderUnit = Math.max(1, bigBlind);
    const sliderSteps = Math.max(1, Math.ceil((maxBet - lowerBound) / sliderUnit));
    const sliderValue = clampedAmt >= maxBet
      ? sliderSteps
      : Math.max(0, Math.min(sliderSteps, Math.round((clampedAmt - lowerBound) / sliderUnit)));
    const updateSliderAmount = (rawValue: string) => {
      const stepIndex = Number(rawValue);
      setNlBetAmount(stepIndex >= sliderSteps ? maxBet : Math.min(maxBet, lowerBound + stepIndex * sliderUnit));
    };
    const isPreDrawBet = meta?.phase === 'bet0';
    const quickAmounts = (isPreDrawBet
      ? [
          { label: '2BB', value: bigBlind * 2 },
          { label: '3BB', value: bigBlind * 3 },
          { label: '4BB', value: bigBlind * 4 },
        ]
      : [
          { label: '33%',  value: Math.floor(pot * 0.33) },
          { label: '50%',  value: Math.floor(pot * 0.50) },
          { label: '75%',  value: Math.floor(pot * 0.75) },
          { label: '100%', value: pot },
        ]
    ).map(q => ({ ...q, value: Math.max(lowerBound, Math.min(maxBet, q.value)) }));

    const fs = compact ? 9 : 11;
    const padY = compact ? 3 : 4;
    return (
      <div style={{display:'flex',flexDirection:'column',gap:compact?3:5,marginBottom:compact?3:5}}>
        <div style={{display:'flex',gap:compact?2:4}}>
          {quickAmounts.map((q,i) => (
            <button key={i} onClick={() => setNlBetAmount(q.value)} style={{
              flex:1, fontSize: fs, padding:`${padY}px 0`, borderRadius:4,
              border: clampedAmt === q.value ? '1px solid #c9a84c' : '1px solid rgba(255,255,255,0.2)',
              background: clampedAmt === q.value ? 'rgba(201,168,76,0.25)' : 'rgba(255,255,255,0.07)',
              color: clampedAmt === q.value ? '#e8d5a0' : 'rgba(255,255,255,0.6)',
              fontFamily:'var(--font-title)', cursor:'pointer',
            }}>{q.label}</button>
          ))}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:compact?4:6}}>
          <input type="range" min={0} max={sliderSteps}
            step={1}
            value={sliderValue}
            onInput={(e) => updateSliderAmount(e.currentTarget.value)}
            onChange={(e) => updateSliderAmount(e.currentTarget.value)}
            style={{flex:1, accentColor:'#c9a84c', height:compact?24:28, touchAction:'none', cursor:'pointer'}} />
          <span style={{fontSize:compact?11:13, fontWeight:600, color:'#e8d5a0',
            minWidth:compact?40:50, textAlign:'right' as const,
            fontFamily:'var(--font-body)'}}>{clampedAmt.toLocaleString()}</span>
        </div>
      </div>
    );
  };


  // ローディング
  if (layout === null) {
    return (
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',
        width:'100%',height:'100%',color:'var(--gold)',fontFamily:'var(--font-title)',fontSize:18}}>
        読み込み中...
      </div>
    );
  }

  // ==========================================================
  // ■ 共通ヘルパー
  // ==========================================================
  const btnStyle = (v:'gold'|'gray'|'red'|'outline', compact?:boolean): React.CSSProperties => ({
    padding: compact ? '9px 12px' : '12px 18px',
    border:'none', borderRadius:7, width:'100%',
    fontSize: compact ? 13 : 15, fontWeight:700, cursor:'pointer',
    fontFamily:'var(--font-title)', letterSpacing:'0.04em', lineHeight:1.2,
    ...(v==='gold'    ? { background:'linear-gradient(135deg,var(--gold),var(--gold-dim))',color:'#1a1200',boxShadow:'0 2px 10px rgba(201,168,76,0.4)' } : {}),
    ...(v==='gray'    ? { background:'rgba(255,255,255,0.12)',color:'var(--cream)',border:'1px solid rgba(255,255,255,0.25)' } : {}),
    ...(v==='red'     ? { background:'#8b1a1a',color:'#ffd0d0' } : {}),
    ...(v==='outline' ? { background:'rgba(255,255,255,0.06)',color:'var(--cream-dim)',border:'1px solid var(--gold-dim)' } : {}),
  });

  const infoTextStyle = (compact?:boolean): React.CSSProperties => ({
    fontFamily:'var(--font-body)', fontSize:compact?12:14, color:'var(--cream-dim)',
    fontStyle:'italic', textAlign:'center', padding:'4px 0', lineHeight:1.4,
  });

  // アクションボタン群（PC/スマホ横用）
  const ActionButtons = ({ compact }:{ compact?:boolean }) => {
    if (self?.isPendingPlayer) {
      return <div style={infoTextStyle(compact)}>🎯 次のハンドから参加します...</div>;
    }
    if (isSpectator) {
      return <div style={{...infoTextStyle(compact),color:'#b088ff',border:'1px solid #6644aa',borderRadius:6,padding:'4px 0'}}>観戦中</div>;
    }
    if (phase==='waiting') {
      return <div style={infoTextStyle(compact)}>{players.length<2?'もう1人参加を待っています':'ゲームを準備中...'}</div>;
    }
    if (isDrawPhase && isMyTurn && !myDrew) return (
      <div style={{display:'flex',flexDirection:'column',gap:compact?6:8}}>
        <div style={infoTextStyle(compact)}>{selected.length>0?`${selected.length}枚選択中`:'捨てるカードを選択'}</div>
        <button style={btnStyle('gold',compact)} onClick={()=>onDrawCards(selected)}>
          {selected.length>0?`🔄 ${selected.length}枚交換`:'✋ スタンドパット'}
        </button>
        {selected.length>0&&<button style={btnStyle('outline',compact)} onClick={()=>{setSelected([]);onUpdateSelected([]);}}>選択解除</button>}
      </div>
    );
    if (isDrawPhase) return <div style={infoTextStyle(compact)}>{myDrew?'他プレイヤーを待っています...':'ドロー中...'}</div>;
    if (isBetPhase && isMyTurn && !(self?.folded)) return (
      <div style={{display:'flex',flexDirection:'column',gap:compact?6:8}}>
        <div style={infoTextStyle(compact)}>
          {(self?.toCall??0)>0?`コール: ${self?.toCall}`:'チェック or ベット'}
          <span style={{fontSize:11,opacity:0.65,display:'block'}}>
            {selfIsNL ? 'No Limit' : `単位:${self?.betSize} Bet ${raiseCount}/5`}
          </span>
        </div>
        {/* NLモード: ベット額スライダーを表示 */}
        {selfIsNL && self?.canRaise && !self?.isAllIn && <NLBetControl compact={compact} />}
        {/* オールイン or チェック可能な場合はフォールドボタンを非表示 */}
        {!self?.isAllIn && !self?.canCheck && <button style={btnStyle('red',compact)} onClick={()=>onBetAction('fold')}>フォールド</button>}
        {self?.canCheck
          ? <button style={btnStyle('gray',compact)} onClick={()=>onBetAction('check')}>{self?.isAllIn?'オールイン中（待機）':'チェック'}</button>
          : <button style={btnStyle('gray',compact)} onClick={()=>onBetAction('call')}>コール ({self?.toCall})</button>
        }
        {self?.canRaise && !self?.isAllIn && (selfIsNL
          ? (() => {
              const sendAmt = getNLSendAmount(self);
              return (
                <button style={btnStyle('gold',compact)} onClick={()=>onBetAction((meta?.currentBet??0)===0?'bet':'raise', sendAmt)}>
                  {(meta?.currentBet??0)===0 ? `ベット ${sendAmt.toLocaleString()}` : `レイズ ${sendAmt.toLocaleString()}`}
                </button>
              );
            })()
          : <button style={btnStyle('gold',compact)} onClick={()=>onBetAction((meta?.currentBet??0)===0?'bet':'raise')}>
              {(meta?.currentBet??0)===0?`ベット (+${self?.betSize})`:`レイズ (+${self?.betSize})`}
            </button>
        )}
      </div>
    );
    if (isBetPhase) {
      const cur = players.find(p=>p.isMyTurn&&!p.isSelf);
      return <div style={infoTextStyle(compact)}>{cur?`${cur.name} がアクション中...`:'待機中...'}</div>;
    }
    if (phase==='showdown') return <div style={infoTextStyle(compact)}>次のゲームを準備中...</div>;
    return null;
  };

  // プレイヤーボックス（PC/スマホ共通の内側 div）
  const renderPlayerInner = (p: PlayerState, cardSize: CardSize, showChips: boolean) => (
    <>
      <div style={{display:'flex',gap:4,justifyContent:'center',marginBottom:4,flexWrap:'wrap'}}>
        {p.isDealer&&<Badge bg="#c9a84c" color="#1a1200" label="BTN"/>}
        {p.isSB&&<Badge bg="#2244aa" color="#fff" label="SB"/>}
        {p.isBB&&<Badge bg="#b85a10" color="#fff" label="BB"/>}
        {p.folded&&!p.sittingOut&&<Badge bg="#444" color="#aaa" label="FOLD"/>}
        {p.isWinner&&<Badge bg="#f0d060" color="#1a1200" label="🏆 WIN"/>}
      </div>
      <p style={{fontFamily:'var(--font-title)',fontSize:14,color:p.isSelf?'var(--gold-bright)':'var(--cream)',
        letterSpacing:'0.04em',margin:'0 0 3px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
        {p.isSelf?`${p.name} (YOU)`:p.name}
      </p>
      {showChips&&(
        <div style={{display:'flex',justifyContent:'center',gap:7,marginBottom:4,flexWrap:'wrap'}}>
          <span style={{fontFamily:'var(--font-body)',fontSize:16,color:'#88dd88'}}>💵 {p.chips}</span>
          {p.bet>0&&<span style={{fontFamily:'var(--font-body)',fontSize:15,color:'var(--gold)',
            background:'rgba(201,168,76,0.15)',borderRadius:3,padding:'0 5px'}}>BET {p.bet}</span>}
        </div>
      )}
    </>
  );

  // ==========================================================
  // ■ PC 版
  // ==========================================================
  if (layout === 'pc') {
    const TW = Math.min(1100, Math.max(600, window.innerWidth - 300));
    const TH = Math.min(760,  Math.max(460, window.innerHeight - 100));
    const CX = TW/2, CY = TH/2 - 10;
    const ACT_W = 280;
    const RX = TW*0.353, RY = TH*0.353;
    const BW = Math.max(175, Math.floor(TW*0.21));
    const others = orderedOthers;

    const getPos = (p:PlayerState) => {
      let ang: number;
      if (p.isSelf) { ang = 90; }
      else {
        const idx = others.findIndex(o => o.id===p.id);
        if (self) {
          // 自分がいる場合: 自分の席（90°）を除いた5スロット
          const slots = [150,-150,-90,-30,30];
          ang = slots[idx] ?? (-90+60*(idx+1));
        } else {
          // 観戦モード（self=null）: 全員を均等配置（360°/n 間隔、90°=下から反時計回り＝ポーカー時計回り順）
          const n = others.length || 1;
          ang = 90 + (360 / n) * idx;
        }
      }
      const rad = (ang*Math.PI)/180;
      const bh = p.isSelf ? Math.floor(TH*0.31) : Math.floor(TH*0.25);
      return { left: CX+RX*Math.cos(rad)-BW/2, top: CY+RY*Math.sin(rad)-bh/2 };
    };

    return (
      <>
      <HeaderTableListButton />
      <div ref={containerRef} style={{display:'flex',alignItems:'center',gap:0,width:'100%',
        maxWidth:TW+ACT_W+32,padding:'0 16px',flex:1,minHeight:0}}>
        {/* 楕円テーブル */}
        <div style={{position:'relative',width:TW,height:TH,flexShrink:0}}>
          {/* フェルト */}
          <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
            width:'70%',height:'62%',borderRadius:'50%',
            background:'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)',
            border:'8px solid var(--gold-dim)',
            boxShadow:'0 0 40px rgba(0,0,0,0.8),inset 0 0 30px rgba(0,0,0,0.4)',zIndex:0}}/>
          <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
            width:'calc(70% - 20px)',height:'calc(62% - 20px)',borderRadius:'50%',
            border:'1px solid rgba(201,168,76,0.25)',zIndex:0}}/>

          {/* テーブル中央 */}
          {phase!=='waiting'&&(
            <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',
              zIndex:2,pointerEvents:'none',textAlign:'center'}}>
              <div style={{fontFamily:'var(--font-title)',fontSize:9,color:modeColor,letterSpacing:'0.1em',opacity:0.8}}>
                {MODE_LABEL[effectiveMode]}
              </div>
              <div style={{fontFamily:'var(--font-title)',fontSize:20,letterSpacing:'0.15em',lineHeight:1.1,
                color:isBetPhase?'var(--gold-bright)':isDrawPhase?'#88ddff':'var(--cream-dim)',
                textShadow:'0 0 12px rgba(0,0,0,0.9)'}}>
                {PHASE_LABEL[phase]}
              </div>
              {(meta?.pot??0)>0&&(
                <div style={{marginTop:3,display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
                  {(meta?.pots&&meta.pots.length>1)?meta.pots.map((p,i)=>(
                    <div key={i} style={{fontFamily:'var(--font-title)',fontSize:i===0?15:12,
                      color:i===0?'#f0d060':'#ffaa44',fontWeight:700,
                      background:i===0?'rgba(240,208,96,0.12)':'rgba(255,160,60,0.12)',
                      border:`1px solid ${i===0?'rgba(240,208,96,0.35)':'rgba(255,160,60,0.3)'}`,
                      borderRadius:4,padding:'1px 8px',whiteSpace:'nowrap'}}>
                      🏦 {p.label} {p.amount}
                    </div>
                  )):(
                    <div style={{fontSize:16,color:'#f0d060',fontWeight:700,fontFamily:'var(--font-title)'}}>🏦 {meta?.pot}</div>
                  )}
                </div>
              )}
              {isBetPhase&&(meta?.currentBet??0)>0&&<div style={{fontSize:12,color:'#ffcc44',marginTop:1,fontFamily:'var(--font-body)'}}>BET {meta?.currentBet}</div>}
              {isBetPhase&&!isNoLimitMode&&<div style={{fontSize:9,color:'rgba(255,255,255,0.4)',fontFamily:'var(--font-body)'}}>Bet {raiseCount}/5</div>}
              {blind&&<div style={{fontSize:10,color:'#88ee88',marginTop:3,fontFamily:'var(--font-title)'}}>Lv.{blind.level} {blind.sb}/{blind.bb}</div>}
              {blind&&!blind.isLastLevel&&blindCountdown>0&&(
                <div style={{fontSize:10,fontFamily:'var(--font-title)',color:blindCountdown<60?'#ff6666':'rgba(255,255,255,0.5)',marginTop:1}}>⏱ {fmtBlind(blindCountdown)}</div>
              )}
              {blind?.isLastLevel&&<div style={{fontSize:10,color:'var(--gold)',fontFamily:'var(--font-title)',marginTop:1}}>最終Lv</div>}
              {blind?.isBreak&&(
                <div style={{fontSize:12,color:'#cc99ff',fontFamily:'var(--font-title)',fontWeight:700,marginTop:2,
                  textShadow:'0 0 8px rgba(160,100,255,0.6)'}}>
                  ☕ {blind.breakLabel??'Break'}
                </div>
              )}
              {isDrawPhase&&(
                <div style={{display:'flex',gap:4,justifyContent:'center',marginTop:4}}>
                  {[1,2,3].map(n=>(
                    <span key={n} style={{width:7,height:7,borderRadius:'50%',display:'inline-block',
                      background:n<=drawRound?'var(--gold-bright)':'rgba(255,255,255,0.2)',
                      boxShadow:n===drawRound?'0 0 4px var(--gold)':'none'}}/>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ディーラーボタン */}
          {(()=>{
            const btn = players.find(p=>p.isDealer);
            if (!btn || (meta?.dealerIndex??-1)<0) return null;
            const pos = getPos(btn);
            const bh = btn.isSelf ? Math.floor(TH*0.31) : Math.floor(TH*0.25);
            const cx = pos.left+BW/2, cy = pos.top+bh/2;
            const dx = cx-CX, dy = cy-CY;
            const dist = Math.sqrt(dx*dx+dy*dy);
            const scale = dist>0 ? Math.max(0,(dist-100))/dist : 0;
            return (
              <div key="d-btn" style={{position:'absolute',left:CX+dx*scale-14,top:CY+dy*scale-14,
                width:28,height:28,borderRadius:'50%',background:'#fff',border:'2px solid #444',
                display:'flex',alignItems:'center',justifyContent:'center',
                fontFamily:'var(--font-title)',fontSize:11,fontWeight:'900',color:'#1a1a1a',
                boxShadow:'0 2px 6px rgba(0,0,0,0.7)',zIndex:5,pointerEvents:'none'}}>D</div>
            );
          })()}

          {/* プレイヤーボックス */}
          {players.map(p => {
            const {left,top} = getPos(p);
            const flash  = actionFlash[p.name];
            const dflash = drawFlash[p.id];
            const active = p.isMyTurn && !p.folded && !p.sittingOut;
            // リングゲームと同じ: 常にボックス上
            const flashTop = -38;
            const dflashTop = flash ? -62 : -38;
            return (
              <div key={p.id} style={{position:'absolute',left,top,width:BW,zIndex:2,overflow:'visible'}}>
                {/* アクションフラッシュ */}
                {flash&&(
                  <div key={flash.key} style={{
                    position:'absolute',top:flashTop,
                    left:p.isDealer?'calc(50% + 22px)':'50%',transform:'translateX(-50%)',
                    background: flash.label==='フォールド'?'rgba(139,26,26,0.92)'
                      : flash.label==='チェック'?'rgba(30,100,60,0.92)'
                      : flash.label==='コール'?'rgba(30,80,160,0.92)'
                      : flash.label==='ベット'?'rgba(160,120,10,0.92)'
                      : 'rgba(160,60,10,0.92)',
                    color:'#fff',fontFamily:'var(--font-title)',fontSize:13,fontWeight:'700',
                    padding:'4px 14px',borderRadius:20,whiteSpace:'nowrap',
                    boxShadow:'0 2px 10px rgba(0,0,0,0.5)',pointerEvents:'none',zIndex:20,
                    animation:'actionPop 2s ease-out forwards',
                  }}>{flash.label}</div>
                )}
                {/* チェンジ枚数フラッシュ */}
                {dflash&&(
                  <div key={dflash.key} style={{
                    position:'absolute',top:dflashTop,left:'50%',transform:'translateX(-50%)',
                    background:'rgba(20,80,180,0.93)',color:'#fff',fontFamily:'var(--font-title)',
                    fontSize:13,fontWeight:'700',padding:'4px 14px',borderRadius:20,whiteSpace:'nowrap',
                    boxShadow:'0 2px 10px rgba(0,0,0,0.5)',pointerEvents:'none',zIndex:20,
                    animation:'actionPop 2.5s ease-out forwards',
                  }}>{dflash.count===0?'✋ パット':`🔄 ${dflash.count}枚チェンジ`}</div>
                )}
                <div style={{
                  position:'relative',textAlign:'center',padding:'8px 6px',borderRadius:11,
                  border:'1px solid transparent',transition:'all 0.25s',width:BW,
                  ...(p.isSelf ? {background:'rgba(10,50,30,0.8)',border:'1px solid rgba(201,168,76,0.35)'} : {}),
                  ...(active   ? {border:'1px solid var(--gold)',boxShadow:'0 0 18px rgba(201,168,76,0.5)',background:'rgba(201,168,76,0.08)'} : {}),
                  ...(p.folded&&!p.sittingOut ? {opacity:0.4} : {}),
                  ...(p.sittingOut ? {opacity:0.5,border:'1px solid rgba(255,255,255,0.1)'} : {}),
                  ...(p.isWinner ? {border:'3px solid var(--gold-bright)',boxShadow:'0 0 40px rgba(240,208,96,0.9),0 0 0 4px rgba(240,208,96,0.25)',background:'rgba(201,168,76,0.22)'} : {}),
                }}>
                  {renderPlayerInner(p,'lg',true)}
                  {/* タイマー */}
                  {active&&timerSec!==null&&timerLimit>0&&<TimerBar remaining={timerSec} limit={timerLimit}/>}
                  {/* カード */}
                  <div style={{display:'flex',justifyContent:'center',gap:p.isSelf?7:4,flexWrap:'nowrap',margin:'5px 0'}}>
                    {(p.hand ?? []).map((code,j)=>(
                      <div key={j} style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
                        <Card code={code} size={p.isSelf?'lg':'sm'}
                          selected={p.isSelf&&selected.includes(j)}
                          clickable={p.isSelf&&isDrawPhase&&isMyTurn&&!myDrew}
                          folded={p.folded}
                          onClick={()=>handleCardClick(j)}/>
                        {p.isSelf&&selected.includes(j)&&(
                          <span style={{fontSize:9,color:'#e84040',fontFamily:'var(--font-title)',marginTop:2}}>捨てる</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* ドロー枚数 */}
                  {(isDrawPhase||isBetPhase)&&(()=>{
                    const cnt = isDrawPhase
                      ? (p.drewThisRound?p.drawCount:null)
                      : (lastDrawCount[p.id]??null);
                    if (cnt===null) return (!p.isSelf&&isDrawPhase)
                      ? <p style={{fontSize:13,color:'#88bbff',fontStyle:'italic',marginTop:2}}>⏳ thinking...</p>
                      : null;
                    return <p style={{fontSize:15,color:p.isSelf?'#aaccff':'#88bbff',fontWeight:'700',marginTop:3}}>
                      {cnt===0?'✋ Stand pat':`🔄 ${cnt}枚`}
                    </p>;
                  })()}
                  {p.result&&(
                    <p style={{fontSize:13,color:p.isWinner?'var(--gold-bright)':'var(--cream-dim)',
                      fontFamily:'var(--font-title)',marginTop:4,letterSpacing:'0.04em',
                      fontWeight:p.isWinner?'700':'400'}}>{p.result}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* 右アクションパネル */}
        <div style={{
          width:ACT_W,flexShrink:0,
          background:'linear-gradient(160deg,rgba(22,92,56,0.5),rgba(10,51,32,0.7))',
          border:'1px solid var(--gold-dim)',borderRadius:12,padding:'20px 18px',
          display:'flex',flexDirection:'column',justifyContent:'center',gap:12,
          minHeight:280,marginLeft:10,
        }}>
          {self&&(
            <div style={{textAlign:'center',paddingBottom:10,borderBottom:'1px solid rgba(201,168,76,0.2)'}}>
              <div style={{fontFamily:'var(--font-title)',fontSize:14,color:'var(--gold-bright)',marginBottom:3}}>
                {self.name} (YOU)
              </div>
              <div style={{fontFamily:'var(--font-body)',fontSize:17,color:'#88dd88'}}>💵 {self.chips}</div>
              {self.result&&<div style={{fontFamily:'var(--font-title)',fontSize:14,color:'var(--cream-dim)',marginTop:3}}>{self.result}</div>}
            </div>
          )}
          <ActionButtons/>
        </div>
      </div>

      <TableListModal open={showTableList} loading={tableListLoading} data={tableListData} onClose={() => setShowTableList(false)} />
      </>
    );
  }

  // ==========================================================
  // ■ スマホ共通 (portrait / landscape)
  // ==========================================================
  const isPortrait = layout === 'portrait';
  const vw = window.innerWidth;
  // containerSize.h が計測済みならそれを使い、ナビバー込みの正確な残り高さにする
  // 未計測の場合は window.innerHeight からナビバー高さ(44px)を差し引いて近似する
  const availH = containerSize.h > 0 ? containerSize.h : Math.max(200, window.innerHeight - 44);
  const ACT_W_M = 148;
  const needsNLActionSpace =
    !!selfIsNL && !!self?.canRaise && isBetPhase && isMyTurn && !self?.isAllIn && !isSpectator;
  const ACT_H_M = 154;

  let TW_M: number, TH_M: number;
  if (isPortrait) {
    TW_M = vw - 8;
    TH_M = availH - ACT_H_M - 4;
  } else {
    TH_M = availH - 4;
    TW_M = vw - ACT_W_M - 4;
  }
  TW_M = Math.max(TW_M, 200);
  TH_M = Math.max(TH_M, 140);

  // 縦向きスマホ座標計算
  // 対称角度: [165,-165,-90,-15,15] → Dealer/Poker同左、Ace/Bluff同右
  const RX_M = isPortrait ? TW_M*0.32 : TW_M*0.44;
  const RY_M = isPortrait ? TH_M*0.31 : TH_M*0.40;
  const CX_M = TW_M/2;
  const CY_M = isPortrait ? TH_M*0.43 : TH_M/2;

  const OTH_W  = Math.min(TW_M - 16, Math.max(Math.floor(TW_M*0.40), 152));
  const SELF_W = Math.min(Math.floor(TW_M*0.60), TW_M-16);
  const SELF_H = isPortrait ? Math.floor(TH_M*0.36) : Math.floor(TH_M*0.40);
  const OTH_H  = isPortrait ? Math.floor(TH_M*0.26) : Math.floor(TH_M*0.32);
  const SELF_C: CardSize = isPortrait ? 'sm2' : 'sm';
  const OTH_C:  CardSize = 'xs';
  // スマホ縦は自席を下端固定にするため、相手席は上半分〜中段だけに配置する。
  const SLOTS_M = isPortrait ? [180,-150,-90,-30,0] : [150,-150,-90,-30,30];
  const oth_m = orderedOthers;
  const fs = { name: Math.max(9,Math.floor(OTH_W*0.10)), chip: Math.max(9,Math.floor(OTH_W*0.095)) };

  const getPosMobile = (p:PlayerState) => {
    const bw = p.isSelf ? SELF_W : OTH_W;
    const bh = p.isSelf ? SELF_H : OTH_H;
    const selfActionGap = -26;
    if (!p.isSelf && isPortrait && self) {
      const idx = oth_m.findIndex(o => o.id===p.id);
      const selfTop = TH_M - SELF_H - selfActionGap;
      const outerBleed = Math.min(12, Math.max(6, TW_M * 0.03));
      const slotTop = [
        TH_M * 0.46,
        TH_M * 0.22,
        TH_M * 0.025,
        TH_M * 0.22,
        TH_M * 0.46,
      ][idx] ?? TH_M * 0.30;
      const slotLeft = [
        -outerBleed,
        -outerBleed,
        TW_M * 0.50 - bw / 2,
        TW_M - bw + outerBleed,
        TW_M - bw + outerBleed,
      ][idx] ?? (TW_M * 0.50 - bw / 2);
      return {
        left: Math.max(-outerBleed, Math.min(TW_M - bw + outerBleed, slotLeft)),
        top:  Math.max(4, Math.min(selfTop - 82, slotTop)),
      };
    }
    let ang: number;
    if (p.isSelf) { ang = 90; }
    else {
      const idx = oth_m.findIndex(o => o.id===p.id);
      if (self) {
        ang = SLOTS_M[idx] ?? (-90+72*(idx+1));
      } else {
        const n = oth_m.length || 1;
        ang = 90 + (360 / n) * idx;
      }
    }
    const rad = (ang*Math.PI)/180;
    if (p.isSelf && isPortrait) {
      return {
        left: Math.max(4, Math.min(TW_M - bw - 4, CX_M - bw / 2)),
        top:  Math.max(4, TH_M - bh - selfActionGap),
      };
    }
    const rawLeft = CX_M+RX_M*Math.cos(rad)-bw/2;
    const rawTop  = CY_M+RY_M*Math.sin(rad)-bh/2;
    return {
      left: Math.max(4, Math.min(TW_M - bw - 4, rawLeft)),
      top:  Math.max(4, Math.min(TH_M - bh - 4, rawTop)),
    };
  };

  const renderMobile = (p:PlayerState) => {
    const {left,top} = getPosMobile(p);
    const active = p.isMyTurn&&!p.folded&&!p.sittingOut;
    const dc = isDrawPhase ? (p.drewThisRound?p.drawCount:null) : (lastDrawCount[p.id]??null);
    const bw = p.isSelf ? SELF_W : OTH_W;
    const flash  = actionFlash[p.name];
    const dflash = drawFlash[p.id];
    // リングゲームと同じ: 常にボックス上に表示（paddingTop:44で上段の見切れも防止）
    return (
      <div key={p.id} style={{position:'absolute',left,top,width:bw,overflow:'visible',zIndex:p.isSelf?3:2}}>
        {flash&&(
          <div key={flash.key} style={{
            position:'absolute',top:-32,
            left:p.isDealer?'calc(50% + 18px)':'50%',transform:'translateX(-50%)',
            background: flash.label==='フォールド'?'rgba(139,26,26,0.92)'
              : flash.label==='チェック'?'rgba(30,100,60,0.92)'
              : flash.label==='コール'?'rgba(30,80,160,0.92)'
              : flash.label==='ベット'?'rgba(160,120,10,0.92)'
              : 'rgba(160,60,10,0.92)',
            color:'#fff',fontFamily:'var(--font-title)',fontSize:11,fontWeight:'700',
            padding:'3px 10px',borderRadius:20,whiteSpace:'nowrap',
            boxShadow:'0 2px 8px rgba(0,0,0,0.5)',pointerEvents:'none',zIndex:10,
            animation:'actionPop 2s ease-out forwards',
          }}>{flash.label}</div>
        )}
        {dflash&&(
          <div key={dflash.key} style={{
            position:'absolute',top:flash?-52:-32,left:'50%',transform:'translateX(-50%)',
            background:'rgba(20,80,180,0.93)',color:'#fff',fontFamily:'var(--font-title)',
            fontSize:11,fontWeight:'700',padding:'3px 10px',borderRadius:20,whiteSpace:'nowrap',
            boxShadow:'0 2px 8px rgba(0,0,0,0.5)',pointerEvents:'none',zIndex:10,
            animation:'actionPop 2.5s ease-out forwards',
          }}>{dflash.count===0?'✋ パット':`🔄 ${dflash.count}枚チェンジ`}</div>
        )}
        <div style={{
          position:'relative',width:bw,textAlign:'center',padding:'3px 2px',borderRadius:7,
          overflow:'visible',transition:'all 0.2s',
          border: active?'1.5px solid var(--gold)':p.isWinner?'3px solid var(--gold-bright)':'1px solid rgba(201,168,76,0.2)',
          boxShadow: active?'0 0 10px rgba(201,168,76,0.5)':p.isWinner?'0 0 30px rgba(240,208,96,0.85)':'none',
          background: p.isSelf?'rgba(10,50,30,0.85)':active?'rgba(201,168,76,0.07)':'rgba(0,0,0,0.4)',
          opacity: (p.folded&&!p.sittingOut)?0.4:p.sittingOut?0.5:1,
        }}>
          <div style={{display:'flex',gap:2,justifyContent:'center',marginBottom:1,flexWrap:'wrap'}}>
            {p.isDealer&&<Badge bg="#c9a84c" color="#1a1200" label="BTN"/>}
            {p.isSB&&<Badge bg="#2244aa" color="#fff" label="SB"/>}
            {p.isBB&&<Badge bg="#b85a10" color="#fff" label="BB"/>}
            {p.folded&&!p.sittingOut&&<Badge bg="#444" color="#aaa" label="FOLD"/>}
                {p.isWinner&&<Badge bg="#f0d060" color="#1a1200" label="🏆 WIN"/>}
          </div>
          <div style={{fontFamily:'var(--font-title)',fontSize:fs.name,color:p.isSelf?'var(--gold-bright)':'var(--cream)',
            whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',letterSpacing:'0.02em'}}>
            {p.isSelf?`${p.name}(YOU)`:p.name}
          </div>
          <div style={{fontFamily:'var(--font-body)',fontSize:fs.chip,color:'#88dd88',lineHeight:1.2}}>
            💵{p.chips}
            {p.bet>0&&<span style={{display:'inline-block',marginLeft:3,padding:'0 4px',borderRadius:3,
              background:'rgba(201,168,76,0.25)',color:'#f0d060',fontWeight:'700',fontSize:fs.chip+1}}>B{p.bet}</span>}
          </div>
          {active&&timerSec!==null&&timerLimit>0&&<div style={{margin:'1px 0'}}><TimerBar remaining={timerSec} limit={timerLimit}/></div>}
          <div style={{display:'flex',gap:2,justifyContent:'center',flexWrap:'nowrap',margin:'2px 0',overflow:'visible'}}>
            {(p.hand ?? []).map((code,j)=>(
              <div key={j} style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
                <Card code={code} size={p.isSelf?SELF_C:OTH_C}
                  selected={p.isSelf&&selected.includes(j)}
                  clickable={p.isSelf&&isDrawPhase&&isMyTurn&&!myDrew}
                  folded={p.folded}
                  onClick={()=>handleCardClick(j)}/>
                {p.isSelf&&selected.includes(j)&&(
                  <span style={{fontSize:7,color:'#e84040',fontFamily:'var(--font-title)',marginTop:1}}>捨</span>
                )}
              </div>
            ))}
          </div>
          {(isDrawPhase||isBetPhase)&&dc!==null&&(
            <div style={{fontSize:Math.max(9,Math.floor(OTH_W*0.11)),color:'#fff',fontWeight:'700',marginTop:3,
              background:p.isSelf?'rgba(20,80,180,0.7)':'rgba(40,100,200,0.55)',
              borderRadius:4,padding:'1px 4px',display:'inline-block'}}>
              {dc===0?'pat':`${dc}枚`}
            </div>
          )}
          {p.result&&(
            <div style={{fontSize:Math.max(8,fs.name-1),color:p.isWinner?'var(--gold-bright)':'var(--cream-dim)',
              fontFamily:'var(--font-title)',fontWeight:p.isWinner?'700':'400',lineHeight:1.1}}>
              {p.result}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ===== テーブル部分（縦横共通） =====
  const MobileTable = () => (
    <div style={{position:'relative',width:TW_M,height:TH_M,
      ...(isPortrait?{margin:'0 auto',flexShrink:0}:{})}}>
      {/* フェルト */}
      <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
        width:'72%',height:isPortrait?'72%':'70%',borderRadius:'50%',
        background:'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)',
        border:'5px solid var(--gold-dim)',
        boxShadow:'0 0 20px rgba(0,0,0,0.8),inset 0 0 20px rgba(0,0,0,0.4)',zIndex:0}}/>
      {/* テーブル中央 */}
      {phase!=='waiting'&&(
        <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',
          textAlign:'center',zIndex:1,pointerEvents:'none'}}>
          <div style={{marginBottom:3,display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
            {(meta?.pots&&meta.pots.length>1)?meta.pots.map((p,i)=>(
              <div key={i} style={{fontFamily:'var(--font-title)',fontSize:i===0?(isPortrait?14:10):(isPortrait?11:8),
                color:i===0?'var(--gold-bright)':'#ffaa44',fontWeight:700,
                background:i===0?'rgba(240,208,96,0.12)':'rgba(255,160,60,0.12)',
                border:`1px solid ${i===0?'rgba(240,208,96,0.3)':'rgba(255,160,60,0.25)'}`,
                borderRadius:3,padding:'0px 5px',whiteSpace:'nowrap',
                textShadow:'0 0 6px rgba(201,168,76,0.6)'}}>
                🏦 {p.label} {p.amount}
              </div>
            )):(
              <div style={{fontFamily:'var(--font-title)',fontSize:isPortrait?14:10,color:'var(--gold-bright)',
                letterSpacing:'0.05em',textShadow:'0 0 6px rgba(201,168,76,0.6)'}}>
                🏦 {meta?.pot}
              </div>
            )}
            {isBetPhase&&(meta?.currentBet??0)>0&&(
              <span style={{padding:'1px 5px',borderRadius:3,
                background:'rgba(201,168,76,0.3)',color:'#f5cc40',fontSize:isPortrait?12:9,fontWeight:'700'}}>
                BET {meta?.currentBet}
              </span>
            )}
          </div>
          <div style={{fontFamily:'var(--font-title)',fontSize:isPortrait?11:9,color:modeColor,letterSpacing:'0.1em',opacity:0.8}}>
            {MODE_LABEL[effectiveMode]}
          </div>
          <div style={{fontFamily:'var(--font-title)',fontSize:isPortrait?15:12,letterSpacing:'0.15em',lineHeight:1.1,
            color:isBetPhase?'var(--gold-bright)':isDrawPhase?'#88ddff':'var(--cream-dim)',
            textShadow:'0 0 8px rgba(0,0,0,0.9)'}}>
            {PHASE_LABEL[phase]}
          </div>
          {isBetPhase&&!isNoLimitMode&&<div style={{fontSize:isPortrait?10:8,color:'rgba(255,255,255,0.45)',fontFamily:'var(--font-body)'}}>Bet {raiseCount}/5</div>}
          {blind&&<div style={{fontSize:isPortrait?10:8,color:'#88ee88',marginTop:2,fontFamily:'var(--font-title)'}}>Lv.{blind.level} {blind.sb}/{blind.bb}</div>}
          {blind&&!blind.isLastLevel&&blindCountdown>0&&(
            <div style={{fontSize:isPortrait?10:8,fontFamily:'var(--font-title)',color:blindCountdown<60?'#ff6666':'rgba(255,255,255,0.4)',marginTop:1}}>⏱{fmtBlind(blindCountdown)}</div>
          )}
          {blind?.isLastLevel&&<div style={{fontSize:8,color:'var(--gold)',fontFamily:'var(--font-title)',marginTop:1}}>最終Lv</div>}
          {blind?.isBreak&&(
            <div style={{fontSize:9,color:'#cc99ff',fontFamily:'var(--font-title)',fontWeight:700,marginTop:2}}>
              ☕ {blind.breakLabel??'Break'}
            </div>
          )}
          {isDrawPhase&&(
            <div style={{display:'flex',gap:4,justifyContent:'center',marginTop:2}}>
              {[1,2,3].map(n=>(
                <span key={n} style={{width:7,height:7,borderRadius:'50%',display:'inline-block',
                  background:n<=drawRound?'var(--gold-bright)':'rgba(255,255,255,0.2)',
                  boxShadow:n===drawRound?'0 0 4px var(--gold)':'none'}}/>
              ))}
            </div>
          )}
        </div>
      )}
      {/* ディーラーボタン */}
      {(()=>{
        const dp = players.find(p=>p.isDealer);
        if (!dp||(meta?.dealerIndex??-1)<0) return null;
        const {left:pl,top:pt} = getPosMobile(dp);
        const bh2 = dp.isSelf?SELF_H:OTH_H, bw2 = dp.isSelf?SELF_W:OTH_W;
        const dcx = pl+bw2/2, dcy = pt+bh2/2;
        const ddx = dcx-CX_M, ddy = dcy-CY_M;
        const dd = Math.sqrt(ddx*ddx+ddy*ddy);
        const sc = dd>0?Math.max(0,(dd-80))/dd:0;
        // 自プレイヤーがディーラーの時は名前と重ならないよう左にオフセット
        const selfDealerOffset = dp.isSelf ? -65 : 0;
        return (
          <div key="m-d" style={{position:'absolute',left:CX_M+ddx*sc-11+selfDealerOffset,top:CY_M+ddy*sc-11,
            width:22,height:22,borderRadius:'50%',background:'#fff',border:'2px solid #444',
            display:'flex',alignItems:'center',justifyContent:'center',
            fontSize:9,fontWeight:'900',color:'#1a1a1a',
            boxShadow:'0 1px 4px rgba(0,0,0,0.7)',zIndex:5,pointerEvents:'none',
            fontFamily:'var(--font-title)'}}>D</div>
        );
      })()}
      {players.map(p=>renderMobile(p))}
      {/* ?debug=1 で座標情報を表示 */}
      {typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1' && (
        <div style={{position:'absolute',top:0,left:0,zIndex:99,background:'rgba(0,0,0,0.7)',
          color:'#0f0',fontSize:9,fontFamily:'monospace',padding:'2px 4px',pointerEvents:'none',lineHeight:1.4}}>
          <div>TW:{TW_M} TH:{TH_M}</div>
          <div>CX:{Math.round(CX_M)} CY:{Math.round(CY_M)}</div>
          <div>RX:{Math.round(RX_M)} RY:{Math.round(RY_M)}</div>
          <div>OTH_H:{OTH_H} SELF_H:{SELF_H}</div>
          {players.map(p=>{
            const {left,top}=getPosMobile(p);
            const idx=oth_m.findIndex(o=>o.id===p.id);
            const ang=p.isSelf?90:(SLOTS_M[idx]??0);
            return <div key={p.id}>{p.name.slice(0,8)}: ({Math.round(left)},{Math.round(top)}) {ang}°</div>;
          })}
        </div>
      )}
    </div>
  );

  // ===== 縦表示 =====
  if (isPortrait) {
    return (
      <>
      <HeaderTableListButton />
      <div ref={containerRef} style={{display:'flex',flexDirection:'column',width:'100%',height:'100%',overflow:'visible'}}>
        <MobileTable/>
        {/* 下部アクションパネル */}
        <div style={{flex:1,display:'flex',flexDirection:'column',justifyContent:'flex-end',
          background:'rgba(0,0,0,0.35)',borderTop:'1px solid rgba(201,168,76,0.2)',
          padding:'6px 8px 8px',overflow:'hidden',minHeight:0}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
            <div style={{fontSize:9,color:'var(--gold-dim)',fontFamily:'var(--font-body)'}}>
              {effectiveMode==='badugi'?'★ Badugi: 全スート異なる低い4枚'
               :effectiveMode==='a5'?'★ A-5: A低い・ストレート/フラッシュ無視'
               :effectiveMode==='27sd'?'★ 2-7 SD: 1ドロー・ノーリミット'
               :'★ 2-7: 低い手が強い。A最高位'}
            </div>
          </div>
          {/* アクションボタン */}
          {self?.isPendingPlayer&&<div style={{textAlign:'center',fontSize:13,color:'var(--gold-dim)',fontFamily:'var(--font-body)',padding:'8px 0'}}>🎯 次のハンドから参加します...</div>}
          {isSpectator&&<div style={{textAlign:'center',fontSize:12,color:'#b088ff',border:'1px solid #6644aa',borderRadius:6,padding:'6px 0'}}>観戦中</div>}
          {!self?.isPendingPlayer&&!isSpectator&&phase==='waiting'&&<div style={{textAlign:'center',fontSize:13,color:'var(--cream-dim)',fontFamily:'var(--font-body)',padding:'8px 0'}}>{players.length<2?'もう1人参加を待っています':'ゲームを準備中...'}</div>}
          {!isSpectator&&isDrawPhase&&isMyTurn&&!myDrew&&(
            <div style={{display:'flex',gap:6}}>
              <button style={{...btnStyle('gold',true),flex:2}} onClick={()=>onDrawCards(selected)}>
                {selected.length>0?`🔄 ${selected.length}枚交換`:'✋ スタンドパット'}
              </button>
              {selected.length>0&&<button style={{...btnStyle('outline',true),flex:1}} onClick={()=>{setSelected([]);onUpdateSelected([]);}}>解除</button>}
            </div>
          )}
          {!isSpectator&&isDrawPhase&&(!isMyTurn||myDrew)&&(
            <div style={{textAlign:'center',fontSize:12,color:'var(--cream-dim)',fontFamily:'var(--font-body)',padding:'8px 0',fontStyle:'italic'}}>
              {myDrew?'他プレイヤーを待っています...':'ドロー中...'}
            </div>
          )}
          {!isSpectator&&isBetPhase&&isMyTurn&&!self?.isAllIn&&(
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {selfIsNL && self?.canRaise && <NLBetControl compact={true} />}
              <div style={{display:'flex',gap:6}}>
                {!self?.canCheck&&<button style={{...btnStyle('red',true),flex:1}} onClick={()=>onBetAction('fold')}>フォールド</button>}
                {self?.canCheck
                  ?<button style={{...btnStyle('gray',true),flex:1}} onClick={()=>onBetAction('check')}>チェック</button>
                  :<button style={{...btnStyle('gray',true),flex:1}} onClick={()=>onBetAction('call')}>コール({self?.toCall})</button>
                }
                {self?.canRaise && (selfIsNL
                  ? (() => {
                      const sendAmt = getNLSendAmount(self);
                      return (
                        <button style={{...btnStyle('gold',true),flex:1}} onClick={()=>onBetAction((meta?.currentBet??0)===0?'bet':'raise', sendAmt)}>
                          {(meta?.currentBet??0)===0 ? `BET ${sendAmt.toLocaleString()}` : `RAISE ${sendAmt.toLocaleString()}`}
                        </button>
                      );
                    })()
                  : <button style={{...btnStyle('gold',true),flex:1}} onClick={()=>onBetAction((meta?.currentBet??0)===0?'bet':'raise')}>
                      {(meta?.currentBet??0)===0?`BET+${self?.betSize}`:`RAISE+${self?.betSize}`}
                    </button>
                )}
              </div>
            </div>
          )}
          {!isSpectator&&isBetPhase&&isMyTurn&&self?.isAllIn&&(
            <div style={{textAlign:'center',fontSize:12,color:'var(--gold)',fontFamily:'var(--font-title)',padding:'8px 0',fontWeight:700}}>
              ⚡ オールイン中（待機）
            </div>
          )}
          {!isSpectator&&isBetPhase&&!isMyTurn&&(
            <div style={{textAlign:'center',fontSize:12,color:'var(--cream-dim)',fontFamily:'var(--font-body)',padding:'8px 0',fontStyle:'italic'}}>
              {players.find(p=>p.isMyTurn&&!p.isSelf)?.name??''}がアクション中...
            </div>
          )}
          {phase==='showdown'&&<div style={{textAlign:'center',fontSize:12,color:'var(--cream-dim)',fontFamily:'var(--font-body)',padding:'8px 0',fontStyle:'italic'}}>次のゲームを準備中...</div>}
        </div>
      </div>

      <TableListModal open={showTableList} loading={tableListLoading} data={tableListData} onClose={() => setShowTableList(false)} />
      </>
    );
  }

  // ===== 横表示 =====
  return (
    <>
    <HeaderTableListButton />
    <div ref={containerRef} style={{display:'flex',width:'100%',height:'100%',overflow:'visible'}}>
      <div style={{position:'relative',flex:1,minWidth:0,overflow:'visible'}}>
        <div style={{position:'absolute',top:0,left:0,width:TW_M,height:TH_M}}>
          <MobileTable/>
        </div>
      </div>
      {/* 右アクションカラム */}
      <div style={{width:ACT_W_M+4,flexShrink:0,background:'rgba(0,0,0,0.3)',
        borderLeft:'1px solid rgba(201,168,76,0.15)',
        display:'flex',flexDirection:'column',justifyContent:'center',overflow:'hidden',padding:'6px 8px'}}>
        <div style={{display:'flex',flexDirection:'column',gap:6,flex:1,justifyContent:'center'}}>
          <ActionButtons compact/>
        </div>
        <div style={{fontSize:8,color:'var(--gold-dim)',fontFamily:'var(--font-body)',textAlign:'center'}}>
          {effectiveMode==='badugi'?'★ Badugi'
           :effectiveMode==='a5'?'★ A-5 Low'
           :effectiveMode==='27sd'?'★ 2-7 SD'
           :'★ 2-7 Low'}
        </div>
      </div>
    </div>

    <TableListModal open={showTableList} loading={tableListLoading} data={tableListData} onClose={() => setShowTableList(false)} />
    </>
  );
}
