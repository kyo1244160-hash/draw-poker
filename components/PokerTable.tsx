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

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { socket, connectWithAuth } from '../socket';
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
  // NL（27sd）対応
  isNL?: boolean;
  minBet?: number;
  minRaiseTotal?: number;
  maxBetTotal?: number;
  timerRemaining?: number;
}

interface PotEntry { amount: number; label: string; }
interface Meta {
  phase: string; mode: string; currentMode: string;
  pot: number; pots?: PotEntry[];
  currentBet: number; betSize: number;
  raiseCount: number; maxRaises: number; dealerIndex: number;
  timerRemaining: number | null; timerLimit: number;
  pendingPlayers: string[]; playerCount: number; maxPlayers: number;
  // NL（27sd）対応
  isNL?: boolean;
  bigBlind?: number;
  lastRaiseSize?: number;
}

interface Props { roomId: string; name: string; mode: '27' | 'badugi' | 'mix' | 'a5' | '27sd' | 'mix3'; onFastFold?: () => void; onFoldStay?: () => void; onBetAction?: (action: string) => void; }

// ===== 定数 =====
const PHASE_LABEL: Record<string,string> = {
  waiting:'WAITING', bet0:'BET (Pre-Draw)',
  draw1:'DRAW I', bet1:'BET I', draw2:'DRAW II', bet2:'BET II',
  draw3:'DRAW III', bet3:'BET III', showdown:'SHOWDOWN',
};
const MODE_LABEL: Record<string,string> = {
  '27':'2-7 Triple Draw',
  badugi:'Badugi',
  mix:'Mix',
  a5:'A-5 Triple Draw',
  '27sd':'2-7 Single Draw (NL)',
  mix3:'Mix-3',
};

/**
 * Mix系モード判定（複数ゲームをローテーションする親モード）
 * サーバー側 gameManager.isMixMode と同じロジック。
 * 将来 mix4 等を追加する場合はここに追加するだけで全箇所に伝播する。
 */
function isMixMode(mode: string): boolean {
  return mode === 'mix' || mode === 'mix3';
}

// ===== メインコンポーネント =====
const PokerTable: React.FC<Props> = ({ roomId, name, mode, onFastFold, onFoldStay, onBetAction }) => {
  const router = useRouter();

  const [players,       setPlayers]       = useState<Player[]>([]);
  const [meta,          setMeta]          = useState<Meta>({
    // mix/mix3 は初期表示で2-7にフォールバック（startGame まで currentMode 未確定のため）。
    // それ以外（27/badugi/a5/27sd）は mode をそのまま currentMode に入れる。
    phase:'waiting', mode, currentMode: isMixMode(mode) ? '27' : mode,
    // ⚠️ maxRaises はサーバー側 MAX_RAISES と同期させる（5bet-cap）。
    // raiseDisplay = `${raiseCount}/${maxRaises}` で表示式が決まるため、ここを4にすると 0/4 表示の不整合が起きる。
    pot:0, currentBet:0, betSize:10, raiseCount:0, maxRaises:5,
    dealerIndex:-1, timerRemaining:null, timerLimit:0,
    pendingPlayers:[], playerCount:0, maxPlayers:6,
  });
  const [selected,      setSelected]      = useState<number[]>([]);
  const [myDrew,        setMyDrew]        = useState(false);
  const [timerSec,      setTimerSec]      = useState<number | null>(null);
  const [lastDrawCount, setLastDrawCount] = useState<Record<string,number|null>>({});
  // ショーダウン後のカウントダウン（3→2→1）
  const [countdown, setCountdown] = useState<number|null>(null);
  // 退室予約: null | 'afterHand' | 'nextBB'
  const [leaveReservation, setLeaveReservation] = useState<null|'afterHand'|'nextBB'>(null);
  // NLベット用: ユーザーが入力中のベット額（totalBet）
  const [nlBetAmount, setNlBetAmount] = useState<number | null>(null);
  // kicked通知メッセージ
  const [kickedMsg, setKickedMsg] = useState<string|null>(null);
  const [tableNotice, setTableNotice] = useState<{message:string; key:number} | null>(null);
  // pending待機中メッセージ（ゲーム進行中に入室→次のハンドから参加）
  const [pendingMsg, setPendingMsg] = useState<string|null>(null);
  // トーナメント開始通知 { tournamentId, tableId, countdown }
  const [tournamentAlert, setTournamentAlert] = useState<{ tournamentId:string; countdown:number } | null>(null);
  // アクション表示 { playerName -> { label, key } }
  const [actionFlash, setActionFlash] = useState<Record<string,{label:string,key:number}>>({});
  // チェンジ枚数フラッシュ { playerName -> { count, key } }
  const [drawFlash, setDrawFlash] = useState<Record<string,{count:number,key:number}>>({});
  // 前回gameStateでのdrewThisRound状態 { playerId -> boolean }
  // false→true に変化したときだけフラッシュ発火（再発火防止）
  const prevDrewRef = useRef<Record<string,boolean>>({});

  // デバイス判定（SSR安全）: 初期値をSSR時は null にしてフラッシュを防ぐ
  const [layout, setLayout] = useState<'pc'|'portrait'|'landscape'|null>(null);

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w >= 768) { setLayout('pc'); return; }
      setLayout(w < h ? 'portrait' : 'landscape');
    };
    // orientationchange はアロー関数を変数に切り出してアンマウント時に削除できるようにする
    const onOrientationChange = () => setTimeout(update, 100);
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', onOrientationChange);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', onOrientationChange);
    };
  }, []);

  // ===== Socket.IO =====
  useEffect(() => {
    const onConnect     = () => socket.emit('joinRoom', { roomId });
    const onGameState   = ({ players:pl, meta:m }: { players:Player[]; meta:Meta }) => {
      // 別テーブルの gameState は無視（FastFold後に旧テーブルのbroadcastが届く対策）
      if ((m as any).roomId && (m as any).roomId !== roomId) return;
      setMeta((prev) => { return m; });
      setPlayers(pl);
      // pending待機中にgameStateが届いた = ゲーム開始 or 自分が参加中 → メッセージ消去
      if (pl.some((p: Player) => p.isSelf)) setPendingMsg(null);
      const self = pl.find((p) => p.isSelf);
      if (self) setMyDrew(self.drewThisRound);
      setLastDrawCount((prev) => {
        const next = {...prev};
        for (const p of pl) { if (p.drawCount !== null) next[p.id] = p.drawCount; }
        return next;
      });
      // チェンジフラッシュ: 前回からdrewThisRound が false→true になったプレイヤーだけ発火
      // これにより同じラウンド内での再発火を確実に防止する
      if (m.phase.startsWith('draw')) {
        const newFlashes: {pid:string, cnt:number}[] = [];
        for (const p of pl) {
          if (!p.drewThisRound || p.drawCount === null) continue;
          const wasDrawn = prevDrewRef.current[p.id] ?? false;
          if (!wasDrawn) {
            // 今回初めてdrewThisRound=trueになった → フラッシュ発火
            newFlashes.push({ pid: p.id, cnt: p.drawCount as number });
          }
        }
        // prevDrewRefを今回のstateで更新
        const newPrevDrew: Record<string,boolean> = {};
        for (const p of pl) { newPrevDrew[p.id] = p.drewThisRound; }
        prevDrewRef.current = newPrevDrew;

        if (newFlashes.length > 0) {
          setDrawFlash((prev) => {
            const next2 = { ...prev };
            for (const { pid, cnt } of newFlashes) {
              next2[pid] = { count: cnt, key: Date.now() };
            }
            return next2;
          });
          const pidsToRemove = newFlashes.map(f => f.pid);
          setTimeout(() => {
            setDrawFlash((cur) => {
              const n = { ...cur };
              for (const pid of pidsToRemove) delete n[pid];
              return n;
            });
          }, 2500);
        }
      } else {
        // ドローフェーズ以外（BETフェーズ・showdown）に遷移した場合、
        // 最後にドローしたプレイヤー（draw中にフラッシュ未発火）がいればここで発火させてからリセット
        const lateFlashes: {pid:string, cnt:number}[] = [];
        for (const p of pl) {
          if (!p.drewThisRound || p.drawCount === null) continue;
          const wasDrawn = prevDrewRef.current[p.id] ?? false;
          if (!wasDrawn) {
            lateFlashes.push({ pid: p.id, cnt: p.drawCount as number });
          }
        }
        // prevDrewRefを現在のstateで更新（BETフェーズ中の再発火を防ぐ）
        const newPrevDrew2: Record<string,boolean> = {};
        for (const p of pl) { newPrevDrew2[p.id] = p.drewThisRound; }
        prevDrewRef.current = newPrevDrew2;
        if (lateFlashes.length > 0) {
          setDrawFlash(() => {
            const next2: Record<string,{count:number,key:number}> = {};
            for (const { pid, cnt } of lateFlashes) {
              next2[pid] = { count: cnt, key: Date.now() };
            }
            return next2;
          });
          const pidsToRemove = lateFlashes.map(f => f.pid);
          setTimeout(() => {
            setDrawFlash((cur) => {
              const n = { ...cur };
              for (const pid of pidsToRemove) delete n[pid];
              return n;
            });
          }, 2500);
        } else {
          setDrawFlash({});
        }
      }
    };
    const onGameStarted = () => {
      setSelected([]); setMyDrew(false); setLastDrawCount({});
      setCountdown(null); setDrawFlash({});
      prevDrewRef.current = {};
      setPendingMsg(null);  // 待機メッセージを消す
    };
    const onTimerUpdate = ({ remaining }: { remaining:number }) => setTimerSec(remaining);
    const onKicked = ({ reason }:{ reason?:string } = {}) => {
      if (reason && reason !== 'reserved') {
        // タイムアウトキックなど → 1.5秒メッセージ表示してからロビーへ
        setKickedMsg(reason);
        setTimeout(() => router.push('/'), 1500);
      } else {
        router.push('/');
      }
    };
    // joinError: 入室失敗（満員など）→ メッセージを表示してロビーへ戻す
    const onJoinError = ({ message }:{ message:string; fullRoomId?:string }) => {
      setKickedMsg(message);
      setTimeout(() => router.push('/'), 2500);
    };
    // pendingJoin: ゲーム進行中に入室 → 次のハンドから参加（待機表示）
    const onPendingJoin = ({ message }:{ message:string }) => {
      setPendingMsg(message);
    };
    const onTableNotice = ({ message }:{ message:string }) => {
      const key = Date.now();
      setTableNotice({ message, key });
      setTimeout(() => {
        setTableNotice((cur) => (cur?.key === key ? null : cur));
      }, 3000);
    };
    // gameStarted で pending 解除（ゲームが始まったら待機メッセージを消す）
    // ※ gameStarted は既に onGameStarted で購読済みだが、pendingMsg クリアを追記

    socket.on('connect',     onConnect);
    socket.on('gameState',   onGameState);
    socket.on('gameStarted', onGameStarted);
    socket.on('timerUpdate', onTimerUpdate);
    const onShowdown = () => {
      // 3秒カウントダウン表示
      setCountdown(3);
      const tick = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 1) { clearInterval(tick); return null; }
          return prev - 1;
        });
      }, 1000);
    };
    socket.on('showdown', onShowdown);
    socket.on('kicked',      onKicked);
    socket.on('joinError',   onJoinError);
    socket.on('pendingJoin', onPendingJoin);
    socket.on('tableNotice', onTableNotice);
    const onLeaveReservation = ({ type }: { type: null|'afterHand'|'nextBB' }) => setLeaveReservation(type);
    socket.on('leaveReservation', onLeaveReservation);
    const ACTION_LABEL: Record<string,string> = {
      fold:'フォールド', check:'チェック', call:'コール', bet:'ベット', raise:'レイズ',
    };
    const onPlayerAction = ({ playerName, action }: { playerName:string; action:string }) => {
      const label = ACTION_LABEL[action] ?? action;
      setActionFlash((prev) => ({
        ...prev,
        [playerName]: { label, key: Date.now() },
      }));
      // 2秒後に消去
      setTimeout(() => {
        setActionFlash((prev) => {
          const next = {...prev};
          delete next[playerName];
          return next;
        });
      }, 2000);
    };
    socket.on('playerAction', onPlayerAction);

    // トーナメント開始通知（リングゲーム中に受け取った場合）
    const onTournamentStarting = ({ tournamentId }: { tournamentId:string; tableId:string }) => {
      setTournamentAlert({ tournamentId, countdown: 5 });
    };
    socket.on('t:tournamentStarting', onTournamentStarting);

    if (socket.connected) {
      socket.emit('joinRoom', { roomId });
    } else {
      connectWithAuth().then((ok) => {
        if (!ok) router.replace('/');
      });
    }

    return () => {
      socket.off('connect',onConnect); socket.off('gameState',onGameState);
      socket.off('gameStarted',onGameStarted); socket.off('timerUpdate',onTimerUpdate);
      socket.off('showdown',onShowdown); socket.off('kicked',onKicked);
      socket.off('joinError',   onJoinError);
      socket.off('pendingJoin', onPendingJoin);
      socket.off('tableNotice', onTableNotice);
      socket.off('leaveReservation', onLeaveReservation);
      socket.off('playerAction', onPlayerAction);
      socket.off('t:tournamentStarting', onTournamentStarting);
    };
  }, [roomId, name]);

  // ===== トーナメント開始カウントダウン =====
  useEffect(() => {
    if (!tournamentAlert) return;
    if (tournamentAlert.countdown <= 0) {
      router.push(`/tournament/${tournamentAlert.tournamentId}/draw`);
      return;
    }
    const t = setTimeout(() => {
      setTournamentAlert((prev) => prev ? { ...prev, countdown: prev.countdown - 1 } : null);
    }, 1000);
    return () => clearTimeout(t);
  }, [tournamentAlert, router]);

  // ===== 計算 =====
  const self          = players.find((p) => p.isSelf);

  /**
   * 他プレイヤーを「自分の右隣（時計回り）から」の順に並べる。
   * players 配列は座席順（index = テーブル上の席番号）なので、
   * 自分のインデックスを起点に +1, +2, ... と時計回りにたどる。
   */
  const orderedOthers = (() => {
    const selfIdx = players.findIndex((p) => p.isSelf);
    if (selfIdx < 0) return players.filter((p) => !p.isSelf);
    const len = players.length;
    const result: Player[] = [];
    // 配列上の右隣(selfIdx-1)から逆順 → 画面上は右→上→左(時計回り)
    for (let i = 1; i < len; i++) {
      const p = players[(selfIdx + i) % len];
      if (!p.isSelf) result.push(p);
    }
    return result;
  })();
  const isDrawPhase   = meta.phase.startsWith('draw');
  const isBetPhase    = meta.phase.startsWith('bet');
  const isMyTurn      = self?.isMyTurn ?? false;
  const drawRound     = ['draw1','draw2','draw3'].indexOf(meta.phase)+1;
  const curPlayer     = players.find((p) => p.isMyTurn);
  const effectiveMode = meta.currentMode ?? (isMixMode(mode) ? '27' : mode);
  const isNoLimitMode = effectiveMode === '27sd' || !!meta.isNL;
  const selfIsNL      = !!self?.isNL || isNoLimitMode;
  // ⚠️ 変更禁止: raiseCount/maxRaises が正しい表示式。(maxRaises+1) にすると分母が6になり5/6表示になるバグになる。
  const raiseDisplay  = `${meta.raiseCount}/${meta.maxRaises}`;
  const modeColor     = effectiveMode==='badugi' ? '#cc9966'
                      : effectiveMode==='a5'     ? '#bb88dd'
                      : effectiveMode==='27sd'   ? '#88dd88'
                      : '#88bbee';
  const modeBg        = effectiveMode==='badugi' ? 'rgba(204,119,68,0.22)'
                      : effectiveMode==='a5'     ? 'rgba(187,136,221,0.22)'
                      : effectiveMode==='27sd'   ? 'rgba(136,221,136,0.22)'
                      : 'rgba(68,136,204,0.22)';
  const modeBorder    = effectiveMode==='badugi' ? 'rgba(204,119,68,0.45)'
                      : effectiveMode==='a5'     ? 'rgba(187,136,221,0.45)'
                      : effectiveMode==='27sd'   ? 'rgba(136,221,136,0.45)'
                      : 'rgba(68,136,204,0.45)';
  const formatBB = (amount: number): string => {
    const bb = meta.bigBlind ?? 0;
    if (!bb || bb <= 0) return '';
    const value = amount / bb;
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}BB`;
  };
  const BetBadge = ({ amount, compact = false }: { amount: number; compact?: boolean }) => {
    const bbText = isNoLimitMode ? formatBB(amount) : '';
    return (
      <span style={{
        display:'inline-flex',
        flexDirection: compact ? 'row' as const : 'column' as const,
        alignItems:'center',
        justifyContent:'center',
        verticalAlign:'middle',
        marginLeft: compact ? 3 : 0,
        gap: compact ? 2 : 0,
        padding: compact ? '0 3px' : '2px 6px',
        minWidth: compact ? 0 : 46,
        borderRadius:3,
        background: compact ? 'rgba(201,168,76,0.25)' : 'rgba(201,168,76,0.15)',
        color: compact ? '#f0d060' : 'var(--gold)',
        fontFamily:'var(--font-body)',
        fontWeight: compact ? '700' : undefined,
        fontSize: compact ? 9 : 13,
        lineHeight:compact ? 1 : 1.08,
        whiteSpace:'nowrap' as const,
      }}>
        <span>{compact ? `B${amount}` : `BET ${amount}`}</span>
        {bbText && <span style={{fontSize: compact ? 8 : 11, lineHeight:1.05, fontWeight:800, color:'#ffe08a'}}>{bbText}</span>}
      </span>
    );
  };
  const StackDisplay = ({ chips, compact = false }: { chips: number; compact?: boolean }) => {
    const bbText = isNoLimitMode ? formatBB(chips) : '';
    return (
      <span style={{
        display:'inline-flex',
        flexDirection: 'row' as const,
        alignItems:'baseline',
        justifyContent:'center',
        gap: compact ? 2 : 4,
        fontFamily:'var(--font-body)',
        fontSize: compact ? 9 : 16,
        color:'#88dd88',
        lineHeight: compact ? 1 : 1.1,
        whiteSpace:'nowrap' as const,
      }}>
        <span>💵 {chips}</span>
        {bbText && <span style={{fontSize: compact ? 8 : 11, color:'#baf7ba', fontWeight:800}}>{bbText}</span>}
      </span>
    );
  };
  const PotAmount = ({ amount, compact = false }: { amount: number; compact?: boolean }) => {
    const bbText = isNoLimitMode ? formatBB(amount) : '';
    return (
      <>
        {amount}
        {bbText && <span style={{fontSize: compact ? 8 : 10, marginLeft:3, color:'#ffe08a', fontWeight:800}}>{bbText}</span>}
      </>
    );
  };
  const logActionHit = (label: string, e: React.MouseEvent<HTMLButtonElement>, amount?: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    console.info('[action-hit][ring]', {
      label,
      amount,
      phase: meta.phase,
      currentBet: meta.currentBet,
      isMyTurn,
      self: self?.name,
      clientX: e.clientX,
      clientY: e.clientY,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      targetTag: (e.target as HTMLElement)?.tagName,
    });
  };

  // ===== ターン通知音 =====
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const prevIsMyTurnRef = React.useRef<boolean>(false);

  // AudioContext をページロード時に suspended 状態で生成し、
  // 最初の pointerdown で resume() する。
  // これにより「参加ボタンを押す = pointerdown」の時点で再生可能になり、
  // ゲーム開始直後の最初のターンでも音が鳴る。
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
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

  React.useEffect(() => {
    const wasMyTurn = prevIsMyTurnRef.current;
    prevIsMyTurnRef.current = isMyTurn;
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
  const handleBet = (action: string, amount?: number) => {
    socket.emit('betAction', { roomId, action, amount });
    onBetAction?.(action);
  };
  const handleLeave = () => { socket.emit('leaveRoom', {roomId}); router.push('/'); };
  const handleLeaveReserve = (type: 'afterHand'|'nextBB'|'cancel') => {
    socket.emit('reserveLeave', { roomId, type });
  };

  // ===== バッジ =====
  const Badge = ({bg,color,label}:{bg:string,color:string,label:string}) => (
    <span style={{fontSize:9,fontFamily:'var(--font-title)',padding:'1px 5px',borderRadius:3,background:bg,color,flexShrink:0}}>{label}</span>
  );


  // NLベット送信時の amount を決定
  // ショートスタック (maxBet < lowerBound) → maxBet（オールイン）
  // 通常 → ユーザーが設定した nlBetAmount、未設定なら lowerBound
  const getNLSendAmount = (self: Player): number => {
    const isBet      = meta.currentBet === 0;
    const minBet     = self.minBet ?? meta.bigBlind ?? 10;
    const minRaiseT  = self.minRaiseTotal ?? (meta.currentBet + (meta.bigBlind ?? 10));
    const maxBet     = self.maxBetTotal ?? (self.bet + self.chips);
    const lowerBound = isBet ? minBet : minRaiseT;
    if (maxBet < lowerBound) return maxBet; // ショートスタック → オールイン固定
    return Math.max(lowerBound, Math.min(maxBet, nlBetAmount ?? lowerBound));
  };

  // ===== NLベットコントロール =====
  // currentBet=0時はベット、>0時はレイズ。ユーザーがminBet/minRaise〜maxBet間で額を選択する。
  // PC/モバイル両対応のコンパクトレイアウト。
  const NLBetControl = ({compact}:{compact:boolean}) => {
    const self = players.find(p => p.isSelf);
    if (!self || !self.canRaise) return null;

    const isBet      = meta.currentBet === 0;
    const minBet     = self.minBet ?? meta.bigBlind ?? 10;
    const minRaiseT  = self.minRaiseTotal ?? (meta.currentBet + (meta.bigBlind ?? 10));
    const maxBet     = self.maxBetTotal ?? (self.bet + self.chips);
    const lowerBound = isBet ? minBet : minRaiseT;
    const pot        = meta.pot;

    // ショートスタック: 通常のミニマム（bet:BB / raise:currentBet+lastRaiseSize）に届かない場合
    // → オールインのみ可能（サーバー側は isAllIn=true でminRaise下限を緩和して受理する）
    const isShortStack = maxBet < lowerBound;
    if (isShortStack) {
      // オールイン専用UI: スライダー・クイック選択は表示せず、額情報のみ
      const fs = compact ? 9 : 11;
      return (
        <div style={{display:'flex',flexDirection:'column',gap:compact?3:5,marginBottom:compact?3:5}}>
          <div style={{
            fontSize: fs, textAlign:'center' as const,
            color:'var(--cream-dim)', fontFamily:'var(--font-body)',
            padding: compact ? '3px 6px' : '4px 8px',
            background:'rgba(100,80,200,0.15)',
            border:'0.5px solid rgba(150,130,240,0.3)',
            borderRadius: 4,
          }}>
            残りチップ不足 → オールイン専用 ({maxBet.toLocaleString()})
          </div>
        </div>
      );
    }

    // 現在の入力値（未設定なら lowerBound を使う）
    const currentAmt = nlBetAmount ?? lowerBound;
    const clampedAmt = Math.max(lowerBound, Math.min(maxBet, currentAmt));

    const bigBlind = meta.bigBlind ?? minBet;
    const sliderUnit = Math.max(1, bigBlind);
    const sliderSteps = Math.max(1, Math.ceil((maxBet - lowerBound) / sliderUnit));
    const sliderValue = clampedAmt >= maxBet
      ? sliderSteps
      : Math.max(0, Math.min(sliderSteps, Math.round((clampedAmt - lowerBound) / sliderUnit)));
    const amountFromSliderStep = (stepIndex: number) =>
      stepIndex >= sliderSteps ? maxBet : Math.min(maxBet, lowerBound + stepIndex * sliderUnit);
    const logSliderDebug = (event: string, data: Record<string, unknown>) => {
      console.info('[slider-debug][ring]', {
        event,
        phase: meta.phase,
        lowerBound,
        maxBet,
        bigBlind,
        sliderUnit,
        sliderSteps,
        sliderValue,
        currentAmount: clampedAmt,
        ...data,
      });
    };
    const updateSliderAmount = (stepIndex: number) => {
      const amount = amountFromSliderStep(stepIndex);
      setNlBetAmount(amount);
      return amount;
    };
    const updateSliderFromPointer = (clientX: number, rect: { left: number; width: number }) => {
      const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
      const stepIndex = Math.round(ratio * sliderSteps);
      const amount = updateSliderAmount(stepIndex);
      return {
        clientX,
        rectLeft: Math.round(rect.left),
        rectWidth: Math.round(rect.width),
        ratio: Number(ratio.toFixed(3)),
        stepIndex,
        amount,
      };
    };
    const startSliderDrag = (clientX: number, el: HTMLDivElement, pointerId: number) => {
      const domRect = el.getBoundingClientRect();
      const dragRect = { left: domRect.left, width: domRect.width };
      let lastLoggedStep = -1;
      const startData = updateSliderFromPointer(clientX, dragRect);
      lastLoggedStep = startData.stepIndex;
      logSliderDebug('start', { pointerId, ...startData });
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        ev.preventDefault();
        const moveData = updateSliderFromPointer(ev.clientX, dragRect);
        if (moveData.stepIndex !== lastLoggedStep) {
          lastLoggedStep = moveData.stepIndex;
          logSliderDebug('move', { pointerId, ...moveData });
        }
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const endData = updateSliderFromPointer(ev.clientX, dragRect);
        logSliderDebug(ev.type, { pointerId, ...endData });
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
    const isPreDrawBet = meta.phase === 'bet0';
    const toCall = Math.max(0, meta.currentBet - self.bet);
    const pctBetTotal = (pct: number) => {
      if (isBet) return Math.floor(pot * pct);
      const potAfterCall = pot + toCall;
      return Math.floor(self.bet + toCall + potAfterCall * pct);
    };
    const quickAmounts: { label: string; value: number }[] = (isPreDrawBet
      ? [
          { label: '2BB', value: bigBlind * 2 },
          { label: '3BB', value: bigBlind * 3 },
          { label: '4BB', value: bigBlind * 4 },
        ]
      : [
          { label: '33%',  value: pctBetTotal(0.33) },
          { label: '50%',  value: pctBetTotal(0.50) },
          { label: '75%',  value: pctBetTotal(0.75) },
          { label: '100%', value: pctBetTotal(1.00) },
        ]
    ).map(q => ({ ...q, value: Math.max(lowerBound, Math.min(maxBet, q.value)) }));

    const fs = compact ? 9 : 11;
    const padY = compact ? 3 : 4;

    return (
      <div style={{display:'flex',flexDirection:'column',gap:compact?3:5,marginBottom:compact?3:5}}>
        {/* クイック選択 */}
        <div style={{display:'flex',gap:compact?2:4}}>
          {quickAmounts.map((q,i) => (
            <button key={i} onClick={() => setNlBetAmount(q.value)} style={{
              flex:1, fontSize: fs, padding:`${padY}px 0`, borderRadius:4,
              border: clampedAmt === q.value ? '1px solid var(--gold)' : '1px solid rgba(255,255,255,0.2)',
              background: clampedAmt === q.value ? 'rgba(201,168,76,0.25)' : 'rgba(255,255,255,0.07)',
              color: clampedAmt === q.value ? 'var(--gold-bright)' : 'var(--cream-dim)',
              fontFamily:'var(--font-title)', cursor:'pointer',
            }}>{q.label}</button>
          ))}
        </div>
        {/* スライダー + 値表示 */}
        <div style={{display:'flex',alignItems:'center',gap:compact?4:6}}>
          <div
            role="slider"
            aria-valuemin={0}
            aria-valuemax={sliderSteps}
            aria-valuenow={sliderValue}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startSliderDrag(e.clientX, e.currentTarget, e.pointerId);
            }}
            style={{position:'relative',flex:1,height:compact?24:28,display:'flex',alignItems:'center',touchAction:'none',cursor:'pointer'}}
          >
            <div style={{position:'absolute',left:0,right:0,height:5,borderRadius:3,background:'rgba(255,255,255,0.22)'}} />
            <div style={{position:'absolute',left:0,width:`${(sliderValue / sliderSteps) * 100}%`,height:5,borderRadius:3,background:'var(--gold)'}} />
            <div style={{position:'absolute',left:`${(sliderValue / sliderSteps) * 100}%`,transform:'translateX(-50%)',
              width:compact?16:18,height:compact?16:18,borderRadius:'50%',background:'var(--gold)',boxShadow:'0 1px 4px rgba(0,0,0,0.45)'}} />
          </div>
          <span style={{display:'inline-flex',flexDirection:'column' as const,alignItems:'flex-end',
            fontSize:compact?11:13, fontWeight:700, color:'var(--gold-bright)',
            minWidth:compact?52:62, textAlign:'right' as const,
            lineHeight:1.05,fontFamily:'var(--font-body)'}}>
            <span>{clampedAmt.toLocaleString()}</span>
            <span style={{fontSize:compact?10:11,color:'#ffe08a',fontWeight:800}}>{formatBB(clampedAmt)}</span>
          </span>
        </div>
      </div>
    );
  };

  // NLベット時にminBet/minRaiseTotalが変わったら、入力値を初期化する
  // 自分のターン開始時と、currentBet変動時にリセット
  const _self = players.find(p => p.isSelf);
  useEffect(() => {
    if (!_self || !selfIsNL || !_self.canRaise) { setNlBetAmount(null); return; }
    const lowerBound = meta.currentBet === 0 ? (_self.minBet ?? 10) : (_self.minRaiseTotal ?? 10);
    // ターン外から入った瞬間、または下限が現在値を超えていたらリセット
    if (nlBetAmount === null || nlBetAmount < lowerBound) {
      setNlBetAmount(lowerBound);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.currentBet, meta.phase, _self?.isMyTurn, selfIsNL, _self?.canRaise, _self?.minBet, _self?.minRaiseTotal]);


  // カスタムチェックボックス（ポーカーテーマ）
  const ChkBox = ({checked, onChange}:{checked:boolean, onChange:()=>void}) => (
    <div onClick={onChange} style={{
      width:13, height:13, borderRadius:3, flexShrink:0, cursor:'pointer',
      border: checked ? '1.5px solid var(--gold)' : '1.5px solid rgba(201,168,76,0.35)',
      background: checked ? 'var(--gold)' : 'rgba(0,0,0,0.45)',
      display:'flex', alignItems:'center', justifyContent:'center',
      transition:'all 0.15s', boxShadow: checked ? '0 0 5px rgba(201,168,76,0.4)' : 'none',
    }}>
      {checked && <span style={{color:'#1a1200',fontSize:9,fontWeight:'900',lineHeight:1,marginTop:-1}}>✓</span>}
    </div>
  );

  // 退室予約チェックボックス
  const LeaveReserveBox = ({compact=false}:{compact?:boolean}) => {
    if (meta.phase === 'waiting') return null;
    const fs = compact ? 10 : 12;
    const chk = (type: 'afterHand'|'nextBB') => leaveReservation === type;
    const toggle = (type: 'afterHand'|'nextBB') =>
      handleLeaveReserve(leaveReservation === type ? 'cancel' : type);
    return (
      <div style={{display:'flex',flexDirection:'column',gap:compact?5:6,justifyContent:'center',
        padding:compact?'5px 6px':'6px 10px',
        background:'rgba(0,0,0,0.35)',border:'1px solid rgba(201,168,76,0.2)',
        borderRadius:6,flexShrink:0}}>
        <div style={{fontFamily:'var(--font-title)',fontSize:fs-1,color:'var(--gold-dim)',
          letterSpacing:'0.05em',whiteSpace:'nowrap' as const,marginBottom:1}}>退室予約</div>
        {(['afterHand','nextBB'] as const).map((type) => (
          <div key={type} style={{display:'flex',alignItems:'center',gap:5,cursor:'pointer'}}
            onClick={()=>toggle(type)}>
            <ChkBox checked={chk(type)} onChange={()=>toggle(type)}/>
            <span style={{
              fontSize:fs, color:chk(type)?'var(--gold-bright)':'var(--cream-dim)',
              fontFamily:'var(--font-body)', whiteSpace:'nowrap' as const,
              userSelect:'none',
            }}>
              {type==='afterHand'?'このハンド後':'次のBBで'}
            </span>
          </div>
        ))}
      </div>
    );
  };

  // ===== 縦長専用: 画面下部2行横並びアクションパネル =====
  // レイアウト:
  //   行1: フォールド | コール/チェック
  //   行2: レイズ     | 退室予約チェックボックス（横並び）
  const PortraitActionPanel = () => {
    const btn = (onClick:()=>void, label:string, variant:'gold'|'gray'|'red'|'outline') => {
      const variants: Record<string,React.CSSProperties> = {
        gold:    { background:'linear-gradient(135deg,var(--gold),var(--gold-dim))', color:'#1a1200', boxShadow:'0 2px 8px rgba(201,168,76,0.4)' },
        gray:    { background:'rgba(255,255,255,0.12)', color:'var(--cream)', border:'1px solid rgba(255,255,255,0.25)' },
        red:     { background:'#8b1a1a', color:'#ffd0d0' },
        outline: { background:'rgba(255,255,255,0.06)', color:'var(--cream-dim)', border:'1px solid var(--gold-dim)' },
      };
      return (
        <button onClick={(e)=>{logActionHit(label, e); onClick();}} style={{
          padding:'6px 6px', border:'none', borderRadius:7,
          height:40, minHeight:40,
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:13, fontWeight:'700', cursor:'pointer',
          fontFamily:'var(--font-title)', letterSpacing:'0.03em',
          textAlign:'center' as const, lineHeight:1.08, whiteSpace:'normal' as const,
          overflow:'hidden', textOverflow:'ellipsis', width:'100%',
          ...variants[variant],
        }}>{label}</button>
      );
    };

    // 退室予約を横コンパクト表示（レイズボタン右に並べる）
    const InlineLeave = () => {
      if (meta.phase === 'waiting') return null;
      const chk = (type: 'afterHand'|'nextBB') => leaveReservation === type;
      const toggle = (type: 'afterHand'|'nextBB') =>
        handleLeaveReserve(leaveReservation === type ? 'cancel' : type);
      return (
        <div style={{display:'flex',flexDirection:'column',justifyContent:'center',
          gap:6, padding:'6px 8px',
          background:'rgba(0,0,0,0.35)', border:'1px solid rgba(201,168,76,0.2)',
          borderRadius:7, height:'100%', boxSizing:'border-box' as const}}>
          {(['afterHand','nextBB'] as const).map((type) => (
            <div key={type} style={{display:'flex',alignItems:'center',gap:5,cursor:'pointer'}}
              onClick={()=>toggle(type)}>
              <ChkBox checked={chk(type)} onChange={()=>toggle(type)}/>
              <span style={{fontSize:10, color:chk(type)?'var(--gold-bright)':'var(--cream-dim)',
                fontFamily:'var(--font-body)', whiteSpace:'nowrap' as const, userSelect:'none' as const}}>
                {type==='afterHand'?'このハンド後':'次のBBで'}
              </span>
            </div>
          ))}
        </div>
      );
    };

    if (meta.phase === 'waiting') return (
      <div style={{textAlign:'center', fontSize:12, color:'var(--cream-dim)',
        fontStyle:'italic', padding:'8px 0', fontFamily:'var(--font-body)'}}>
        {pendingMsg ?? (players.length < 2 ? 'もう1人参加を待っています' : 'ゲームを準備中...')}
      </div>
    );

    if (isDrawPhase && isMyTurn && !myDrew) return (
      <div style={{display:'flex',flexDirection:'column',gap:5}}>
        <div style={{textAlign:'center',fontSize:11,color:'var(--cream-dim)',fontStyle:'italic',fontFamily:'var(--font-body)'}}>
          {selected.length>0 ? selected.length+'枚選択中' : '捨てるカードを選択'}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
          {btn(handleDraw, selected.length>0 ? ('🔄 '+selected.length+'枚交換') : '✋ スタンドパット', 'gold')}
          {selected.length>0
            ? btn(clearSelected,'選択解除','outline')
            : <InlineLeave />
          }
        </div>
        {selected.length>0 && <InlineLeave />}
      </div>
    );

    if (isDrawPhase && (!isMyTurn || myDrew)) return (
      <div style={{display:'flex',flexDirection:'column',gap:5}}>
        <div style={{textAlign:'center',fontSize:11,color:'var(--cream-dim)',fontStyle:'italic',fontFamily:'var(--font-body)'}}>
          {myDrew ? '他プレイヤーを待っています...' : ((curPlayer?.name??'')+'がドロー中...')}
        </div>
        <InlineLeave />
      </div>
    );

    if (isBetPhase && isMyTurn && self) return (
      <div style={{display:'flex',flexDirection:'column',gap:5}}>
        <div style={{textAlign:'center',fontSize:11,color:'var(--cream-dim)',fontFamily:'var(--font-body)'}}>
          {(self.toCall!>0 ? ('コール: '+self.toCall) : 'チェック or ベット')}
          <span style={{fontSize:9,opacity:0.65,marginLeft:6}}>{selfIsNL ? 'No Limit' : ('単位:'+self.betSize+' Bet '+raiseDisplay)}</span>
        </div>
        {/* NLモード: ベット額スライダーを表示 */}
        {selfIsNL && self.canRaise && <NLBetControl compact={false} />}
        {/* 横1行レイアウト: bet0かつFastFold部屋の場合はFoldボタンを⚡次へ/📺観戦に置き換え */}
        <div style={{display:'flex',gap:6}}>
          {!self.canCheck && (onFastFold && onFoldStay && meta.phase==='bet0'
            ? <>{btn(onFastFold,'⚡ 次へ','gold')}{btn(onFoldStay,'📺 観戦','red')}</>
            : btn(()=>handleBet('fold'),'フォールド','red')
          )}
          {self.canCheck
            ? btn(()=>handleBet('check'),'チェック','gray')
            : btn(()=>handleBet('call'),'コール('+self.toCall+')','gray')
          }
          {self.canRaise && (selfIsNL
            ? (() => {
                const sendAmt = getNLSendAmount(self);
                return btn(() => handleBet(meta.currentBet===0?'bet':'raise', sendAmt),
                  meta.currentBet===0 ? `ベット ${sendAmt.toLocaleString()}` : `レイズ ${sendAmt.toLocaleString()}`, 'gold');
              })()
            : btn(()=>handleBet(meta.currentBet===0?'bet':'raise'),
                meta.currentBet===0?('BET+'+self.betSize):('RAISE+'+self.betSize),'gold'))}
        </div>
        <InlineLeave />
      </div>
    );

    if (isBetPhase && !isMyTurn) return (
      <div style={{display:'flex',flexDirection:'column',gap:5}}>
        <div style={{textAlign:'center',fontSize:11,color:'var(--cream-dim)',fontStyle:'italic',fontFamily:'var(--font-body)'}}>
          {curPlayer ? (curPlayer.name+' がアクション中...') : '待機中...'}
        </div>
        {onFastFold && meta.phase==='bet0' && (onFoldStay
          ? <div style={{display:'flex',gap:6}}>{btn(onFastFold,'⚡ 次へ','gold')}{btn(onFoldStay,'📺 観戦フォールド','red')}</div>
          : btn(onFastFold,'⚡ FastFold','gold'))}
        <InlineLeave />
      </div>
    );

    if (meta.phase === 'showdown') return (
      <div style={{display:'flex',flexDirection:'column',gap:4,alignItems:'center'}}>
        <div style={{textAlign:'center',fontSize:12,color:'var(--cream-dim)',fontStyle:'italic',fontFamily:'var(--font-body)'}}>
          次のゲームを準備中...
          {countdown !== null && (
            <span style={{display:'block',fontFamily:'var(--font-title)',
              fontSize:22,color:'var(--gold-bright)',textAlign:'center' as const,lineHeight:1,marginTop:2,
              textShadow:'0 0 12px rgba(201,168,76,0.7)'}}>
              {countdown}
            </span>
          )}
        </div>
        {/* showdownではFastFoldボタン非表示（プリドローのみ） */}
        <InlineLeave />
      </div>
    );

    return <InlineLeave />;
  };

  // ===== アクションボタン（2×2グリッド）=====
  const ActionButtons = ({compact=false}:{compact?:boolean}) => {
    const fs  = compact ? 12 : 16;
    const py  = compact ? 8  : 13;
    const px  = compact ? 10 : 18;
    const btn = (onClick:()=>void, label:string, variant:'gold'|'gray'|'red'|'outline') => {
      const base:React.CSSProperties = {
        padding: compact ? '6px 8px' : `${Math.max(8, py - 2)}px ${px}px`, border:'none', borderRadius:7,
        height: compact ? 40 : 48,
        minHeight: compact ? 40 : 48,
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:fs, fontWeight:'700', cursor:'pointer',
        fontFamily:'var(--font-title)', letterSpacing:'0.03em',
        textAlign:'center' as const, width:'100%', lineHeight:1.08,
        whiteSpace:'normal', overflow:'hidden', textOverflow:'ellipsis',
      };
      const variants = {
        gold:    { background:'linear-gradient(135deg,var(--gold),var(--gold-dim))', color:'#1a1200', boxShadow:'0 2px 10px rgba(201,168,76,0.4)' },
        gray:    { background:'rgba(255,255,255,0.12)', color:'var(--cream)', border:'1px solid rgba(255,255,255,0.25)' },
        red:     { background:'#8b1a1a', color:'#ffd0d0' },
        outline: { background:'rgba(255,255,255,0.06)', color:'var(--cream-dim)', border:'1px solid var(--gold-dim)' },
      };
      return <button onClick={(e)=>{logActionHit(label, e); onClick();}} style={{...base,...variants[variant]}}>{label}</button>;
    };

    // 2列グリッドラッパー
    const Grid2 = ({children}:{children?:React.ReactNode}) => (
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap: compact?5:8, width:'100%'}}>
        {children}
      </div>
    );

    const infoStyle:React.CSSProperties = {
      fontFamily:'var(--font-body)', fontSize: compact?12:15,
      color:'var(--cream-dim)', fontStyle:'italic',
      textAlign:'center' as const, padding: compact?'3px 0':'5px 0',
      lineHeight:1.4, gridColumn:'1 / -1',
    };

    if (meta.phase === 'waiting') return (
      <div style={actionColStyle}>
        <div style={infoStyle}>{pendingMsg ?? (players.length < 2 ? 'もう1人参加を待っています' : 'ゲームを準備中...')}</div>
      </div>
    );

    if (isDrawPhase && isMyTurn && !myDrew) return (
      <div style={actionColStyle}>
        <div style={{...infoStyle, gridColumn:'unset'}}>
          {selected.length>0?`${selected.length}枚選択中`:'捨てるカードを選択'}
        </div>
        {btn(handleDraw, selected.length>0 ? `🔄 ${selected.length}枚交換` : '✋ スタンドパット', 'gold')}
        {selected.length>0 && btn(clearSelected,'選択解除','outline')}
      </div>
    );

    if (isDrawPhase && (!isMyTurn || myDrew)) return (
      <div style={actionColStyle}>
        <div style={infoStyle}>{myDrew?'他プレイヤーを待っています...':`${curPlayer?.name??''} がドロー中...`}</div>
      </div>
    );

    if (isBetPhase && isMyTurn && self) return (
      <div style={actionColStyle}>
        <div style={{...infoStyle, gridColumn:'unset'}}>
          {self.toCall!>0?`コール: ${self.toCall}`:'チェック or ベット'}
          <span style={{fontSize:fs-3,opacity:0.65,display:'block'}}>{selfIsNL ? 'No Limit' : `単位:${self.betSize} Bet ${raiseDisplay}`}</span>
        </div>
        {selfIsNL && self.canRaise && <NLBetControl compact={true} />}
        {!self.canCheck && (onFastFold && onFoldStay && meta.phase==='bet0'
          ? <>{btn(onFastFold,'⚡ 次へ','gold')}{btn(onFoldStay,'📺 観戦','red')}</>
          : btn(()=>handleBet('fold'),'フォールド','red')
        )}
        {self.canCheck
          ? btn(()=>handleBet('check'),'チェック','gray')
          : btn(()=>handleBet('call'),`コール (${self.toCall})`,'gray')
        }
        {self.canRaise
          ? (selfIsNL
              ? (() => {
                  const sendAmt = getNLSendAmount(self);
                  return btn(() => handleBet(meta.currentBet===0?'bet':'raise', sendAmt),
                    meta.currentBet===0 ? `ベット ${sendAmt.toLocaleString()}` : `レイズ ${sendAmt.toLocaleString()}`, 'gold');
                })()
              : btn(()=>handleBet(meta.currentBet===0?'bet':'raise'),
                  meta.currentBet===0?`ベット (+${self.betSize})`:`レイズ (+${self.betSize})`,
                  'gold'))
          : null
        }
      </div>
    );

    if (isBetPhase && !isMyTurn) return (
      <div style={actionColStyle}>
        <div style={infoStyle}>{curPlayer?`${curPlayer.name} がアクション中...`:'待機中...'}</div>
        {onFastFold && meta.phase==='bet0' && (onFoldStay
          ? <div style={{display:'flex',gap:6,width:'100%'}}>{btn(onFastFold,'⚡ 次へ','gold')}{btn(onFoldStay,'📺 観戦フォールド','red')}</div>
          : btn(onFastFold,'⚡ FastFold','gold'))}
      </div>
    );

    if (meta.phase === 'showdown') return (
      <div style={actionColStyle}>
        <div style={actionInfoStyle(compact)}>
          次のゲームを準備中...
          {countdown !== null && (
            <span style={{display:'block', fontFamily:'var(--font-title)',
              fontSize: compact ? 22 : 32, color:'var(--gold-bright)',
              textAlign:'center', lineHeight:1, marginTop:4,
              textShadow:'0 0 12px rgba(201,168,76,0.7)'}}>
              {countdown}
            </span>
          )}
        </div>
        {/* showdownではFastFoldボタン非表示（プリドローのみ） */}
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
      padding: compact?'3px 8px':'14px 24px',
      borderBottom:'1px solid var(--gold-dim)',
      background:'rgba(0,0,0,0.25)', flexShrink:0,
      ...(compact ? { height:32, minHeight:32, maxHeight:32, overflow:'hidden' } : {}),
    }}>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <img src="/icons/icon-72.png" alt="logo" style={{width:compact?24:32,height:compact?24:32,borderRadius:'50%'}} />
        {!compact && <span style={{fontFamily:'var(--font-title)',fontSize:18,color:'var(--gold)',letterSpacing:'0.07em'}}>Poker Room Pastis</span>}
        {compact && <span style={{fontFamily:'var(--font-title)',fontSize:12,color:'var(--gold)'}}>Pastis</span>}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap' as const,justifyContent:'center'}}>
        <span style={{...modBadgeSt, background:modeBg, color:modeColor, border:`1px solid ${modeBorder}`, fontSize:compact?9:11}}>
          {isMixMode(mode)
            ? `${mode==='mix3'?'Mix-3':'Mix'}→${effectiveMode==='badugi'?'Badugi':effectiveMode==='a5'?'A-5':'2-7'}`
            : MODE_LABEL[effectiveMode]}
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
      {(meta.pots&&meta.pots.length>1)?meta.pots.map((p,i)=>(
        <span key={i} style={{...potChipSt,fontSize:compact?10:13,
          color:i===0?'var(--gold-bright)':'#ffaa44',
          borderColor:i===0?'var(--gold-dim)':'rgba(255,160,60,0.4)'}}>
          🏦 {p.label} <b><PotAmount amount={p.amount} compact={compact} /></b>
        </span>
      )):(
        <span style={{...potChipSt, fontSize:compact?11:14}}>🏦 <b style={{color:'var(--gold-bright)'}}><PotAmount amount={meta.pot} compact={compact} /></b></span>
      )}
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
        <div style={{fontFamily:'var(--font-body)',fontSize:compact?10:12,color:'#88dd88',lineHeight:1,display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
          <StackDisplay chips={p.chips} compact />{p.bet>0&&<BetBadge amount={p.bet} compact />}
        </div>
        <div style={{display:'flex',gap:2,justifyContent:'center',margin:'3px 0'}}>
          {p.hand.map((code,j) => <Card key={j} code={code} size={cardSize} folded={p.folded}/>)}
        </div>
        {(isDrawPhase||isBetPhase) && dc!==null && (
          <div style={{fontSize:9,color:'#88bbff',fontStyle:'italic'}}>
            {dc===0?'✋ pat':`🔄 ${dc}枚`}
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
      <div style={{fontFamily:'var(--font-title)',fontSize:big?13:10,color:modeColor,letterSpacing:'0.12em',opacity:0.85,marginBottom:2}}>
        {MODE_LABEL[effectiveMode]}
      </div>
      <div style={{fontFamily:'var(--font-title)',fontSize:big?20:13,letterSpacing:'0.15em',
        color:isBetPhase?'var(--gold-bright)':isDrawPhase?'#88ddff':'var(--cream-dim)',
        textShadow:'0 0 12px rgba(0,0,0,0.9)',lineHeight:1.1}}>
        {PHASE_LABEL[meta.phase]}
      </div>
      {meta.pot>0 && <div style={{fontSize:big?16:11,color:'#f0d060',fontWeight:'700',marginTop:3,fontFamily:'var(--font-title)'}}>🏦 <PotAmount amount={meta.pot} compact={!big} /></div>}
      {isBetPhase && meta.currentBet>0 && <div style={{fontSize:big?12:9,color:'#ffcc44',marginTop:1,fontFamily:'var(--font-body)'}}>BET {meta.currentBet}{isNoLimitMode ? '' : ' · ' + raiseDisplay}</div>}
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
  // ■ レイアウト未確定（SSR / 初回レンダリング前）
  // ==========================================================
  // トーナメント開始通知オーバーレイ
  if (tournamentAlert) {
    return (
      <div style={{height:'100dvh',display:'flex',alignItems:'center',justifyContent:'center',
        background:'var(--felt)',fontFamily:'var(--font-body)',zIndex:9999}}>
        <div style={{background:'linear-gradient(160deg,rgba(10,51,32,0.97),rgba(5,25,15,0.99))',
          border:'1px solid var(--gold)',borderRadius:14,padding:'40px 48px',
          textAlign:'center',boxShadow:'0 8px 48px rgba(0,0,0,0.8)',maxWidth:360}}>
          <div style={{fontSize:48,marginBottom:12}}>🏆</div>
          <div style={{fontFamily:'var(--font-title)',fontSize:22,color:'var(--gold)',letterSpacing:'0.08em',marginBottom:12}}>
            トーナメント開始！
          </div>
          <div style={{color:'var(--cream-dim)',fontSize:15,lineHeight:1.7,marginBottom:20}}>
            参加登録したトーナメントが始まりました。<br/>
            <span style={{color:'var(--gold)',fontWeight:'bold',fontSize:18}}>{tournamentAlert.countdown}</span> 秒後に移動します...
          </div>
          <button
            onClick={() => router.push(`/tournament/${tournamentAlert.tournamentId}/draw`)}
            style={{fontFamily:'var(--font-title)',fontSize:13,padding:'10px 28px',
              background:'linear-gradient(135deg,var(--gold),var(--gold-dim))',
              border:'none',borderRadius:6,color:'#1a1200',fontWeight:700,cursor:'pointer',letterSpacing:'0.06em'}}
          >
            今すぐ移動
          </button>
        </div>
      </div>
    );
  }

  // ==========================================================
  // kickedメッセージオーバーレイ
  if (kickedMsg) {
    return (
      <div style={{height:'100dvh',display:'flex',alignItems:'center',justifyContent:'center',
        background:'var(--felt)',fontFamily:'var(--font-body)'}}>
        <div style={{background:'linear-gradient(160deg,rgba(22,92,56,0.9),rgba(10,51,32,0.95))',
          border:'1px solid var(--gold-dim)',borderRadius:12,padding:'32px 40px',
          textAlign:'center',boxShadow:'0 8px 40px rgba(0,0,0,0.6)',maxWidth:320}}>
          <div style={{fontFamily:'var(--font-title)',fontSize:28,color:'var(--gold)',marginBottom:12}}>退室</div>
          <div style={{color:'var(--cream-dim)',fontSize:15,lineHeight:1.6}}>{kickedMsg}</div>
        </div>
      </div>
    );
  }

  const TableNoticeOverlay = () => tableNotice ? (
    <div style={{
      position:'absolute', top:54, left:'50%', transform:'translateX(-50%)',
      zIndex:80, maxWidth:'min(86vw, 420px)', padding:'10px 16px',
      borderRadius:8, border:'1px solid rgba(201,168,76,0.75)',
      background:'rgba(5,25,15,0.94)', color:'var(--gold-bright)',
      boxShadow:'0 6px 24px rgba(0,0,0,0.5), 0 0 16px rgba(201,168,76,0.28)',
      fontFamily:'var(--font-title)', fontSize:13, lineHeight:1.45,
      textAlign:'center' as const, pointerEvents:'none' as const,
    }}>
      {tableNotice.message}
    </div>
  ) : null;

  if (layout === null) {
    return <div style={{height:'100dvh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--felt)',color:'var(--gold)',fontFamily:'var(--font-title)',fontSize:18}}>読み込み中...</div>;
  }

  // ==========================================================
  // ■ スマホ共通: 楕円テーブル（縦/横自動対応）
  // ==========================================================
  if (layout === 'portrait' || layout === 'landscape') {
    const isPortrait = layout === 'portrait';
    const others     = orderedOthers;  // 自分基準で時計回りに並べた他プレイヤー

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const NAV_H  = 32;   // compact NavBar 高さ（トーナメントと統一）
    const POT_H  = meta.phase !== 'waiting' ? 32 : 0;
    const RULE_H = 16;
    const ACT_W  = 148;  // アクションカラム幅
    // 縦長: ボタン2行(各44px)+gap+padding = 約110px（退室予約はレイズ右に横並び）
    const ACT_H  = 110;

    let TW: number, TH: number;
    if (isPortrait) {
      TW = vw - 8;
      TH = vh - NAV_H - ACT_H - 4;
    } else {
      // 横表示: ナビバー高さを引いた全高さ、幅はアクションカラム分引く
      TH = vh - NAV_H - 4;
      TW = vw - ACT_W - 4;
    }
    TW = Math.max(TW, 200); TH = Math.max(TH, 140);

    // 楕円半径（TournamentTableと統一）
    const RX = isPortrait ? TW * 0.32 : TW * 0.44;
    const RY = isPortrait ? TH * 0.36 : TH * 0.40;
    const CX = TW / 2;
    const CY = isPortrait ? TH * 0.54 : TH / 2;

    // 他プレイヤーbox幅: xs カード5枚(20px)+gap(1px)×4=104px が収まる最小値
    const OTH_BOX_W  = Math.max(138, Math.floor(Math.min(TW, TH) * 0.30));
    // 自分box幅: sm カード5枚(32px)+gap(4px)×4=176px が収まるよう広め
    const SELF_BOX_W = Math.min(Math.floor(TW * 0.60), TW - 16);
    const SELF_BOX_H = isPortrait ? Math.floor(TH * 0.24) : Math.floor(TH * 0.40);
    const OTH_BOX_H  = isPortrait ? Math.floor(TH * 0.26) : Math.floor(TH * 0.32);

    const SELF_CARD: 'sm'|'md' = 'sm';
    const OTH_CARD:  'xs'|'sm'|'md' = 'xs';

    // portrait: 上部扇状、landscape: 左右対称（TournamentTableと統一）
    const SLOTS = isPortrait
      ? [150, -144, -98, -36, 30]
      : [150, -150,  -90,  -30, 30];

    const getPosMobile = (p: Player) => {
      let ang: number;
      const topOffset = 0;
      if (p.isSelf) { ang = 90; }
      else {
        const idx = others.findIndex((o) => o.id === p.id);
        ang = SLOTS[idx] ?? (-90 + 72 * (idx + 1));
      }
      const rad = (ang * Math.PI) / 180;
      const bw  = p.isSelf ? SELF_BOX_W : OTH_BOX_W;
      const bh  = p.isSelf ? SELF_BOX_H : OTH_BOX_H;
      const rawTop = CY + RY * Math.sin(rad) - bh / 2 + topOffset;
      if (p.isSelf && isPortrait) {
        const actionSafeGap = 48;
        return {
          left: Math.max(4, Math.min(TW - bw - 4, CX - bw / 2)),
          top: Math.max(4, Math.min(TH - bh - actionSafeGap, rawTop)),
        };
      }
      return {
        left: CX + RX * Math.cos(rad) - bw / 2,
        top:  rawTop,
      };
    };

    const fs = { name: Math.max(9, Math.floor(OTH_BOX_W * 0.10)), chip: Math.max(9, Math.floor(OTH_BOX_W * 0.095)) };

    const renderMobilePlayer = (p: Player) => {
      const {left, top} = getPosMobile(p);
      const active = p.isMyTurn && !p.folded && !p.sittingOut;
      const dc = isDrawPhase ? (p.drewThisRound ? p.drawCount : null) : (lastDrawCount[p.id] ?? null);
      const bw = p.isSelf ? SELF_BOX_W : OTH_BOX_W;
      const flash = actionFlash[p.name];
      const dflash = drawFlash[p.id];
      return (
        <div key={p.id} style={{position:'absolute', left, top, width:bw, overflow:'visible', zIndex: (flash || dflash) ? 30 : p.isSelf ? 3 : 2}}>
        {/* アクションフラッシュ */}
        {flash && (
          <div key={flash.key} style={{
            position:'absolute', top:-32,
            left: p.isDealer ? 'calc(50% + 18px)' : '50%',
            transform:'translateX(-50%)',
            background: flash.label==='フォールド' ? 'rgba(139,26,26,0.92)'
              : flash.label==='チェック'  ? 'rgba(30,100,60,0.92)'
              : flash.label==='コール'    ? 'rgba(30,80,160,0.92)'
              : flash.label==='ベット'    ? 'rgba(160,120,10,0.92)'
              : 'rgba(160,60,10,0.92)', // レイズ
            color:'#fff', fontFamily:'var(--font-title)',
            fontSize:11, fontWeight:'700', padding:'3px 10px',
            borderRadius:20, whiteSpace:'nowrap' as const,
            boxShadow:'0 2px 8px rgba(0,0,0,0.5)',
            pointerEvents:'none', zIndex:10,
            animation:'actionPop 2s ease-out forwards',
          }}>{flash.label}</div>
        )}
        {/* チェンジ枚数フラッシュ（他プレイヤーのみ） */}
        {dflash && (
          <div key={dflash.key} style={{
            position:'absolute', top: flash ? -52 : -32,
            left:'50%', transform:'translateX(-50%)',
            background:'rgba(20,80,180,0.93)',
            color:'#fff', fontFamily:'var(--font-title)',
            fontSize:11, fontWeight:'700', padding:'3px 10px',
            borderRadius:20, whiteSpace:'nowrap' as const,
            boxShadow:'0 2px 8px rgba(0,0,0,0.5)',
            pointerEvents:'none', zIndex:10,
            animation:'actionPop 2.5s ease-out forwards',
          }}>{dflash.count===0 ? '✋ パット' : `🔄 ${dflash.count}枚チェンジ`}</div>
        )}
        <div style={{
          position:'relative', width: bw,
          textAlign:'center', padding:'3px 2px', borderRadius:7,
          overflow: 'hidden',
          border: active ? '1.5px solid var(--gold)' : p.isWinner ? '3px solid var(--gold-bright)' : '1px solid rgba(201,168,76,0.2)',
          boxShadow: active ? '0 0 10px rgba(201,168,76,0.5)' : p.isWinner ? '0 0 30px rgba(240,208,96,0.85),0 0 0 3px rgba(240,208,96,0.2)' : 'none',
          background: p.isSelf ? 'rgba(10,50,30,0.85)' : active ? 'rgba(201,168,76,0.07)' : 'rgba(0,0,0,0.4)',
          opacity: (p.folded && !p.sittingOut) ? 0.4 : p.sittingOut ? 0.5 : 1,
          zIndex: p.isSelf ? 3 : 2, transition:'all 0.2s',
        }}>
          <div style={{display:'flex',gap:2,justifyContent:'center',marginBottom:1,flexWrap:'wrap' as const}}>
            {p.isDealer   && <Badge bg="#c9a84c" color="#1a1200" label="BTN"/>}
            {p.isSB       && <Badge bg="#2244aa" color="#fff"    label="SB"/>}
            {p.isBB       && <Badge bg="#b85a10" color="#fff"    label="BB"/>}
            {p.folded && !p.sittingOut && <Badge bg="#444" color="#aaa" label="FOLD"/>}
            {p.sittingOut && <Badge bg="#555" color="#bbb" label="WAIT"/>}
            {p.isWinner   && <Badge bg="#f0d060" color="#1a1200" label="🏆 WIN"/>}
          </div>
          <div style={{fontFamily:'var(--font-title)',fontSize:fs.name,color:p.isSelf?'var(--gold-bright)':'var(--cream)',
            whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis',letterSpacing:'0.02em'}}>
            {p.isSelf ? `${p.name}(YOU)` : p.name}
          </div>
          <div style={{fontFamily:'var(--font-body)',fontSize:fs.chip,color:'#88dd88',lineHeight:1,display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
            <StackDisplay chips={p.chips} compact />{p.bet>0&&<BetBadge amount={p.bet} compact />}
          </div>
          {p.isMyTurn && meta.timerLimit>0 && timerSec!==null && (
            <div style={{margin:'1px 0'}}><TimerBar remaining={timerSec} limit={meta.timerLimit}/></div>
          )}
          <div style={{display:'flex',gap:isPortrait?2:2,justifyContent:'center',flexWrap:'nowrap' as const,margin:'2px 0'}}>
            <div style={{display:'flex',gap:isPortrait?2:2,justifyContent:'center',flexWrap:'nowrap' as const}}>
            {p.hand.map((code, j) => (
              <div key={j} style={{display:'flex',flexDirection:'column' as const,alignItems:'center'}}>
                <Card code={code} size={p.isSelf ? SELF_CARD : OTH_CARD}
                  selected={p.isSelf && selected.includes(j)}
                  clickable={p.isSelf && isDrawPhase && isMyTurn && !myDrew}
                  folded={p.folded}
                  onClick={() => handleCardClick(j)} />
                {p.isSelf && selected.includes(j) && (
                  <span style={{fontSize:7,color:'#e84040',fontFamily:'var(--font-title)',marginTop:1}}>捨</span>
                )}
              </div>
            ))}
            </div>
          </div>
          {(isDrawPhase||isBetPhase) && dc!==null && (
            <div style={{
              fontSize: Math.max(9, Math.floor(OTH_BOX_W * 0.11)),
              color:'#fff', fontWeight:'700', marginTop:3,
              background: p.isSelf ? 'rgba(20,80,180,0.7)' : 'rgba(40,100,200,0.55)', borderRadius:4,
              padding:'1px 4px', display:'inline-block',
            }}>
              {dc===0 ? 'pat' : `${dc}枚`}
            </div>
          )}
          {p.result && (
            <div style={{fontSize:Math.max(8,fs.name-1),color:p.isWinner?'var(--gold-bright)':'var(--cream-dim)',
              fontFamily:'var(--font-title)',fontWeight:p.isWinner?'700':'400',lineHeight:1.1}}>
              {p.result}
            </div>
          )}
        </div>
        </div>
      );
    };

    // ===== 縦表示レイアウト =====
    if (isPortrait) {
      return (
        <div style={{display:'flex',flexDirection:'column',height:'100dvh',overflow:'hidden',
        background:'var(--felt)',color:'var(--cream)',fontFamily:'var(--font-body)'}}>
          <NavBar compact />
          <TableNoticeOverlay />
          {/* テーブル（楕円 + プレイヤー）*/}
          <div style={{position:'relative',width:TW,height:TH,margin:'0 auto',flexShrink:0}}>
            {/* 楕円フェルト */}
            <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
              width:'72%',height:'72%',borderRadius:'50%',
              background:'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)',
              border:'5px solid var(--gold-dim)',boxShadow:'0 0 20px rgba(0,0,0,0.8),inset 0 0 20px rgba(0,0,0,0.4)',
              zIndex:0}} />
            {/* テーブル中央テキスト */}
            {meta.phase!=='waiting' && (
              <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',
                textAlign:'center',zIndex:1,pointerEvents:'none'}}>
                {/* ポット（テーブル中央上部）*/}
                {meta.phase!=='waiting' && (
                  <div style={{fontFamily:'var(--font-title)',fontSize:10,color:'var(--gold-bright)',
                    letterSpacing:'0.05em',marginBottom:3,
                    textShadow:'0 0 6px rgba(201,168,76,0.6)'}}>
                    🏦 <PotAmount amount={meta.pot} compact />
                    {isBetPhase && meta.currentBet>0 && <span style={{
                      marginLeft:6, padding:'1px 5px', borderRadius:3,
                      background:'rgba(201,168,76,0.3)', color:'#f5cc40',
                      fontSize:9, fontWeight:'700'
                    }}>BET {meta.currentBet}</span>}
                  </div>
                )}
                <div style={{fontFamily:'var(--font-title)',fontSize:9,color:modeColor,letterSpacing:'0.1em',opacity:0.8}}>
                  {MODE_LABEL[effectiveMode]}
                </div>
                <div style={{fontFamily:'var(--font-title)',fontSize:12,letterSpacing:'0.15em',lineHeight:1.1,
                  color:isBetPhase?'var(--gold-bright)':isDrawPhase?'#88ddff':'var(--cream-dim)',
                  textShadow:'0 0 8px rgba(0,0,0,0.9)'}}>
                  {PHASE_LABEL[meta.phase]}
                </div>
                {isBetPhase && !isNoLimitMode && <div style={{fontSize:8,color:'rgba(255,255,255,0.45)',fontFamily:'var(--font-body)'}}>Bet {raiseDisplay}</div>}
                {isDrawPhase && (
                  <div style={{display:'flex',gap:4,justifyContent:'center',marginTop:2}}>
                    {[1,2,3].map((n)=>(
                      <span key={n} style={{width:7,height:7,borderRadius:'50%',display:'inline-block',
                        background:n<=drawRound?'var(--gold-bright)':'rgba(255,255,255,0.2)',
                        boxShadow:n===drawRound?'0 0 4px var(--gold)':'none'}}/>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ディーラーボタン（スマホ）*/}
            {(()=>{
              const dp = players.find((pp)=>pp.isDealer);
              if (!dp || meta.dealerIndex<0) return null;
              const {left:pl,top:pt}=getPosMobile(dp);
              const bh2 = dp.isSelf ? SELF_BOX_H : OTH_BOX_H;
              const bw2 = dp.isSelf ? SELF_BOX_W : OTH_BOX_W;
              const dcx = pl+bw2/2; const dcy = pt+bh2/2;
              const ddx = dcx-CX; const ddy = dcy-CY;
              const dd = Math.sqrt(ddx*ddx+ddy*ddy);
              const sc = dd>0?Math.max(0,(dd-80))/dd:0;
              return <div key="m-d-btn" style={{position:'absolute',left:CX+ddx*sc-11,top:CY+ddy*sc-11,width:22,height:22,borderRadius:'50%',background:'#fff',border:'2px solid #444',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:'900',color:'#1a1a1a',boxShadow:'0 1px 4px rgba(0,0,0,0.7)',zIndex:5,pointerEvents:'none',fontFamily:'var(--font-title)'}}>D</div>;
            })()}
            {/* 全プレイヤー */}
            {players.map((p) => renderMobilePlayer(p))}
          </div>
          {/* ===== 縦長: 画面下部固定アクションパネル ===== */}
          <div style={{
            flex:1, display:'flex', flexDirection:'column', justifyContent:'flex-end',
            background:'rgba(0,0,0,0.35)', borderTop:'1px solid rgba(201,168,76,0.2)',
            padding:'6px 8px 8px', overflow:'hidden', minHeight:0,
          }}>
            {/* ルール・待機情報（上段） */}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <div style={{fontSize:9,color:'var(--gold-dim)',fontFamily:'var(--font-body)'}}>
                {effectiveMode==='badugi'?'★ Badugi: 全スート異なる低い4枚が最強'
                 :effectiveMode==='a5'?'★ A-5: A=1扱い、ストレート/フラッシュ無視'
                 :effectiveMode==='27sd'?'★ 2-7 SD: 1ドロー・ノーリミット'
                 :'★ 2-7: 低い手が強い。A最高位'}
              </div>
              {meta.pendingPlayers.length>0 && (
                <div style={{fontSize:9,color:'var(--gold-dim)',fontStyle:'italic'}}>
                  ⏳ {meta.pendingPlayers.join(', ')}
                </div>
              )}
            </div>
            {/* アクションボタン（2行横並び）+ 退室予約 */}
            <PortraitActionPanel />
          </div>
        </div>
      );
    }

    // ===== 横表示レイアウト =====
    return (
      <div style={{display:'flex',flexDirection:'column',height:'100dvh',overflow:'hidden',
        background:'var(--felt)',color:'var(--cream)',fontFamily:'var(--font-body)'}}>
        <NavBar compact />
        <TableNoticeOverlay />
        <div style={{flex:1,display:'flex',overflow:'hidden',minHeight:0}}>
          {/* テーブル: flex で残り幅を全て使う */}
          <div style={{position:'relative',flex:1,minWidth:0,overflow:'hidden'}}>
            {/* 内側コンテナ（TW×TH の絶対サイズ）*/}
            <div style={{position:'absolute',top:0,left:0,width:TW,height:TH}}>
            {/* 楕円フェルト */}
            <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
              width:'74%',height:'70%',borderRadius:'50%',
              background:'radial-gradient(ellipse at 40% 40%,#1a6b42,#0a3320)',
              border:'5px solid var(--gold-dim)',boxShadow:'0 0 20px rgba(0,0,0,0.8),inset 0 0 20px rgba(0,0,0,0.4)',
              zIndex:0}} />
            {/* テーブル中央テキスト */}
            {meta.phase!=='waiting' && (
              <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',
                textAlign:'center',zIndex:1,pointerEvents:'none'}}>
                <div style={{fontFamily:'var(--font-title)',fontSize:8,color:modeColor,letterSpacing:'0.1em',opacity:0.8}}>
                  {MODE_LABEL[effectiveMode]}
                </div>
                <div style={{fontFamily:'var(--font-title)',fontSize:12,letterSpacing:'0.15em',lineHeight:1.1,
                  color:isBetPhase?'var(--gold-bright)':isDrawPhase?'#88ddff':'var(--cream-dim)',
                  textShadow:'0 0 8px rgba(0,0,0,0.9)'}}>
                  {PHASE_LABEL[meta.phase]}
                </div>
                {isBetPhase && !isNoLimitMode && <div style={{fontSize:8,color:'rgba(255,255,255,0.45)',fontFamily:'var(--font-body)'}}>Bet {raiseDisplay}</div>}
              </div>
            )}
            {/* ポット（テーブル上部）*/}
            {meta.phase!=='waiting' && (
              <div style={{position:'absolute',top:4,left:'50%',transform:'translateX(-50%)',
                display:'flex',gap:6,zIndex:4,pointerEvents:'none'}}>
                <span style={{...potChipSt,fontSize:11}}>🏦<b style={{color:'var(--gold-bright)'}}><PotAmount amount={meta.pot} compact /></b></span>
                {isBetPhase && meta.currentBet>0 && <span style={{...potChipSt,fontSize:11}}>BET<b>{meta.currentBet}</b></span>}
              </div>
            )}
            {/* 全プレイヤー */}
            {players.map((p) => renderMobilePlayer(p))}

            {/* ディーラーD ボタン（横表示）*/}
            {players.find((pp)=>pp.isDealer) && meta.dealerIndex>=0 && (()=>{
              const dp=players.find((pp)=>pp.isDealer)!;
              const pos=getPosMobile(dp); const bh2=dp.isSelf?SELF_BOX_H:OTH_BOX_H;
              const bw2l=dp.isSelf?SELF_BOX_W:OTH_BOX_W; const dcx=pos.left+bw2l/2; const dcy=pos.top+bh2/2;
              const ddx=dcx-CX; const ddy=dcy-CY;
              const dd=Math.sqrt(ddx*ddx+ddy*ddy);
              const sc=dd>0?Math.max(0,(dd-80))/dd:0;
              return <div key="ld" style={{position:"absolute",left:CX+ddx*sc-10,top:CY+ddy*sc-10,width:20,height:20,borderRadius:"50%",background:"#fff",border:"1.5px solid #444",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:"900",color:"#1a1a1a",boxShadow:"0 1px 4px rgba(0,0,0,0.7)",zIndex:5,pointerEvents:"none",fontFamily:"var(--font-title)"}}>D</div>;
            })()}
            </div>{/* 内側コンテナ終了 */}
          </div>
          {/* アクションカラム */}
          <div style={{width:ACT_W+4,flexShrink:0,background:'rgba(0,0,0,0.3)',
            borderLeft:'1px solid rgba(201,168,76,0.15)',
            display:'flex',flexDirection:'column',justifyContent:'space-between',overflow:'hidden',padding:'6px 8px'}}>
            <div>
              {meta.pendingPlayers.length>0 && (
                <div style={{fontSize:8,color:'var(--gold-dim)',fontStyle:'italic',marginBottom:4}}>
                  ⏳ {meta.pendingPlayers.join(', ')}
                </div>
              )}
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:6,flex:1,justifyContent:'center'}}>
              <ActionButtons compact />
              <LeaveReserveBox compact />
            </div>
            <div style={{fontSize:8,color:'var(--gold-dim)',fontFamily:'var(--font-body)',textAlign:'center'}}>
              {effectiveMode==='badugi'?'★ Badugi'
               :effectiveMode==='a5'?'★ A-5 Low'
               :effectiveMode==='27sd'?'★ 2-7 SD'
               :'★ 2-7 Low'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==========================================================
  // ■ PC版レイアウト（楕円テーブル）
  // ==========================================================
  const TW=Math.min(1100,Math.max(600,window.innerWidth-280)); const TH=Math.min(760,Math.max(460,window.innerHeight-96)); const CX=TW/2; const CY=TH/2-10;
  const ACT_PANEL_W=280;
  const RX=TW*0.353; const RY=TH*0.353;
  const BW=Math.max(175,Math.floor(TW*0.21));
  const others = orderedOthers;  // 自分基準で時計回りに並べた他プレイヤー

  const getPos = (p:Player) => {
    let ang:number;
    if (p.isSelf) { ang=90; }
    else {
      const slots=[150,-150,-90,-30,30];
      const idx=others.findIndex((o)=>o.id===p.id);
      ang=slots[idx]??(-90+60*(idx+1));
    }
    const rad=(ang*Math.PI)/180;
    const cx=CX+RX*Math.cos(rad); const cy=CY+RY*Math.sin(rad);
    const bh=p.isSelf?Math.floor(TH*0.31):Math.floor(TH*0.25);
    return {left:cx-BW/2, top:cy-bh/2};
  };

  const selfPlayer = players.find((p)=>p.isSelf);

  return (
    <div style={{height:'100dvh',display:'flex',flexDirection:'column',alignItems:'center',overflow:'hidden',position:'relative',zIndex:1,fontFamily:'var(--font-body)'}}>
      <NavBar />
      <TableNoticeOverlay />
      <PendingBar />

      {/* テーブル + アクション（横並び）*/}
      <div style={{display:'flex',alignItems:'center',gap:0,width:'100%',maxWidth:TW+ACT_PANEL_W+32,padding:'0 16px',flex:1,minHeight:0}}>
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


          {/* ディーラーボタン（D の白い丸）*/}
          {(()=>{
            const btn = players.find((p)=>p.isDealer);
            if (!btn || meta.dealerIndex<0) return null;
            const pos = getPos(btn);
            const bh = btn.isSelf ? Math.floor(TH*0.31) : Math.floor(TH*0.25);
            const cx = pos.left + BW/2;
            const cy = pos.top  + bh/2;
            const dx = cx - CX; const dy = cy - CY;
            const dist = Math.sqrt(dx*dx+dy*dy);
            const scale = dist>0 ? Math.max(0,(dist-100))/dist : 0;
            const bx = CX+dx*scale; const by = CY+dy*scale;
            return <div key="d-btn" style={{position:'absolute',left:bx-14,top:by-14,width:28,height:28,borderRadius:'50%',background:'#fff',border:'2px solid #444',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'var(--font-title)',fontSize:11,fontWeight:'900',color:'#1a1a1a',boxShadow:'0 2px 6px rgba(0,0,0,0.7)',zIndex:5,pointerEvents:'none'}}>D</div>;
          })()}
          {/* プレイヤーボックス */}
          {players.map((p) => {
            const {left,top}=getPos(p);
            const flash=actionFlash[p.name];
            const dflash=drawFlash[p.id];
            return (
              <div key={p.id} style={{position:'absolute',left,top,width:BW,zIndex:(flash||dflash)?30:2,overflow:'visible'}}>
              {/* アクションフラッシュ */}
              {flash && (
                <div key={flash.key} style={{
                  position:'absolute', top:-38,
                  left: p.isDealer ? 'calc(50% + 22px)' : '50%',
                  transform:'translateX(-50%)',
                  background: flash.label==='フォールド' ? 'rgba(139,26,26,0.92)'
                    : flash.label==='チェック'  ? 'rgba(30,100,60,0.92)'
                    : flash.label==='コール'    ? 'rgba(30,80,160,0.92)'
                    : flash.label==='ベット'    ? 'rgba(160,120,10,0.92)'
                    : 'rgba(160,60,10,0.92)',
                  color:'#fff', fontFamily:'var(--font-title)',
                  fontSize:13, fontWeight:'700', padding:'4px 14px',
                  borderRadius:20, whiteSpace:'nowrap' as const,
                  boxShadow:'0 2px 10px rgba(0,0,0,0.5)',
                  pointerEvents:'none', zIndex:20,
                  animation:'actionPop 2s ease-out forwards',
                }}>{flash.label}</div>
              )}
              {/* チェンジ枚数フラッシュ（他プレイヤーのみ） */}
              {dflash && (
                <div key={dflash.key} style={{
                  position:'absolute', top: flash ? -62 : -38,
                  left:'50%', transform:'translateX(-50%)',
                  background:'rgba(20,80,180,0.93)',
                  color:'#fff', fontFamily:'var(--font-title)',
                  fontSize:13, fontWeight:'700', padding:'4px 14px',
                  borderRadius:20, whiteSpace:'nowrap' as const,
                  boxShadow:'0 2px 10px rgba(0,0,0,0.5)',
                  pointerEvents:'none', zIndex:20,
                  animation:'actionPop 2.5s ease-out forwards',
                }}>{dflash.count===0 ? '✋ パット' : `🔄 ${dflash.count}枚チェンジ`}</div>
              )}
              <div style={{
                position:'relative',textAlign:'center',padding:'8px 6px',borderRadius:11,
                border:'1px solid transparent',transition:'all 0.25s',width:BW,
                ...(p.isSelf?{background:'rgba(10,50,30,0.8)',border:'1px solid rgba(201,168,76,0.35)'}:{}),
                ...(p.isMyTurn&&!p.folded&&!p.sittingOut?{border:'1px solid var(--gold)',boxShadow:'0 0 18px rgba(201,168,76,0.5)',background:'rgba(201,168,76,0.08)'}:{}),
                ...(p.folded&&!p.sittingOut?{opacity:0.4}:{}),
                ...(p.sittingOut?{opacity:0.5,border:'1px solid rgba(255,255,255,0.1)'}:{}),
                ...(p.isWinner?{border:'3px solid var(--gold-bright)',boxShadow:'0 0 40px rgba(240,208,96,0.9),0 0 0 4px rgba(240,208,96,0.25)',background:'rgba(201,168,76,0.22)'}:{}),
              }}>
                <div style={{display:'flex',gap:4,justifyContent:'center',marginBottom:4,flexWrap:'wrap' as const}}>
                  {p.isDealer   && <Badge bg="#c9a84c" color="#1a1200" label="BTN"/>}
                  {p.isSB       && <Badge bg="#2244aa" color="#fff"    label="SB"/>}
                  {p.isBB       && <Badge bg="#b85a10" color="#fff"    label="BB"/>}
                  {p.folded&&!p.sittingOut && <Badge bg="#444" color="#aaa" label="FOLD"/>}
                  {p.sittingOut && <Badge bg="#555" color="#bbb" label="WAIT"/>}
                  {p.isWinner   && <Badge bg="#f0d060" color="#1a1200" label="🏆 WIN"/>}
                </div>
                <p style={{fontFamily:'var(--font-title)',fontSize:14,color:p.isSelf?'var(--gold-bright)':'var(--cream)',letterSpacing:'0.04em',margin:'0 0 3px',whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis'}}>
                  {p.isSelf?`${p.name} (YOU)`:p.name}
                </p>
                <div style={{display:'flex',justifyContent:'center',gap:7,marginBottom:4,flexWrap:'wrap' as const}}>
                  <StackDisplay chips={p.chips} />
                  {p.bet>0 && <BetBadge amount={p.bet} />}
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
                {(isDrawPhase||isBetPhase)&&(()=>{
                  const cnt=isDrawPhase?(p.drewThisRound?p.drawCount:null):(lastDrawCount[p.id]??null);
                  if(cnt===null) return (!p.isSelf&&isDrawPhase)?<p style={{fontSize:13,color:'#88bbff',fontStyle:'italic',marginTop:2}}>⏳ thinking...</p>:null;
                  return <p style={{fontSize:15,color: p.isSelf?'#aaccff':'#88bbff',fontWeight:'700',marginTop:3,letterSpacing:'0.02em'}}>{cnt===0?'✋ Stand pat':`🔄 ${cnt}枚`}</p>;
                })()}
                {p.result&&<p style={{fontSize:13,color:p.isWinner?'var(--gold-bright)':'var(--cream-dim)',fontFamily:'var(--font-title)',marginTop:4,letterSpacing:'0.04em',fontWeight:p.isWinner?'700':'400'}}>{p.result}</p>}
              </div>
              </div>
            );
          })}
        </div>

        {/* アクションパネル（テーブル右側縦積み）*/}
        <div style={{
          width:ACT_PANEL_W,flexShrink:0,
          background:'linear-gradient(160deg,rgba(22,92,56,0.5),rgba(10,51,32,0.7))',
          border:'1px solid var(--gold-dim)',borderRadius:12,padding:'20px 18px',
          display:'flex',flexDirection:'column',justifyContent:'center',gap:12,
          minHeight:280, marginLeft:10,
        }}>
          {/* 自分の情報 */}
          {selfPlayer && (
            <div style={{textAlign:'center',paddingBottom:10,borderBottom:'1px solid rgba(201,168,76,0.2)'}}>
              <div style={{fontFamily:'var(--font-title)',fontSize:14,color:'var(--gold-bright)',marginBottom:3}}>{selfPlayer.name} (YOU)</div>
              <div><StackDisplay chips={selfPlayer.chips} /></div>
              {selfPlayer.result && <div style={{fontFamily:'var(--font-title)',fontSize:14,color:'var(--cream-dim)',marginTop:3}}>{selfPlayer.result}</div>}
            </div>
          )}
          <ActionButtons />
          <LeaveReserveBox />
        </div>
      </div>

      <p style={{textAlign:'center',fontSize:13,color:'var(--gold-dim)',fontFamily:'var(--font-body)',marginTop:4,padding:'0 8px',flexShrink:0}}>
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
