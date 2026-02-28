/**
 * PokerTable.tsx — ゲームテーブル共通コンポーネント
 *
 * 2-7 Triple Draw と Badugi で共有するゲーム画面UIです。
 * ゲームロジックの違い（手札枚数・役判定）はサーバー側で処理し、
 * このコンポーネントは表示に特化しています。
 *
 * 主な機能:
 *   - テーブル上のプレイヤー配置（楕円状）
 *   - カードの表示と選択
 *   - ドロー / ベットアクションUI
 *   - タイマーバー
 *   - ポジションバッジ（BTN / SB / BB）
 *   - 交換枚数の他プレイヤーへの通知
 */

import React, { useEffect, useState } from 'react';
import { socket } from '../socket';
import Card from './Card';
import TimerBar from './TimerBar';

// ===== 型定義 =====

/** サーバーから受け取るプレイヤー情報 */
interface Player {
  id:           string;
  name:         string;
  chips:        number;
  bet:          number;
  folded:       boolean;
  hand:         string[];
  isSelf:       boolean;
  isMyTurn:     boolean;
  drewThisRound: boolean;
  drawCount:    number | null;
  result?:      string;
  isWinner?:    boolean;
  isDealer:     boolean;
  isSB:         boolean;
  isBB:         boolean;
  // 自分だけに送られる情報
  toCall?:      number;
  canCheck?:    boolean;
  canRaise?:    boolean;
  betSize?:     number;
  timerRemaining?: number;
}

/** ゲームのメタ情報 */
interface Meta {
  phase:           string;
  mode:            '27' | 'badugi';
  pot:             number;
  currentBet:      number;
  betSize:         number;
  raiseCount:      number;
  dealerIndex:     number;
  timerRemaining:  number | null;
  timerLimit:      number;
}

interface PokerTableProps {
  /** 部屋ID */
  roomId: string;
  /** 自分の名前 */
  name: string;
  /** ゲームモード */
  mode: '27' | 'badugi';
}

// ===== フェーズ表示名 =====
const PHASE_LABEL: Record<string, string> = {
  waiting:  'WAITING',
  draw1:    'DRAW  I',   bet1: 'BET  I',
  draw2:    'DRAW  II',  bet2: 'BET  II',
  draw3:    'DRAW  III', bet3: 'BET  III',
  showdown: 'SHOWDOWN',
};

// ===== メインコンポーネント =====

const PokerTable: React.FC<PokerTableProps> = ({ roomId, name, mode }) => {
  const [players, setPlayers] = useState<Player[]>([]);
  const [meta,    setMeta]    = useState<Meta>({
    phase: 'waiting', mode, pot: 0, currentBet: 0,
    betSize: 10, raiseCount: 0, dealerIndex: -1,
    timerRemaining: null, timerLimit: 0,
  });
  const [selected,  setSelected]  = useState<number[]>([]);
  const [myDrew,    setMyDrew]    = useState(false);
  const [timerSec,  setTimerSec]  = useState<number | null>(null);
  // 各プレイヤーの最後のドロー枚数を保持（ベットフェーズ中も表示するため）
  const [lastDrawCount, setLastDrawCount] = useState<Record<string, number | null>>({});

  // ===== Socket.IO イベント =====
  useEffect(() => {
    /** 接続後に joinRoom を送信 */
    const onConnect = () => socket.emit('joinRoom', { roomId, name });

    /** ゲーム状態の更新 */
    const onGameState = ({ players: pl, meta: m }: { players: Player[]; meta: Meta }) => {
      setPlayers(pl);
      setMeta(m);
      const self = pl.find((p) => p.isSelf);
      if (self) setMyDrew(self.drewThisRound);
      // drawCount が null でないプレイヤーは最後のドロー枚数として記録
      // ベットフェーズに入っても表示し続けるために保持する
      setLastDrawCount((prev) => {
        const next = { ...prev };
        for (const p of pl) {
          if (p.drawCount !== null) next[p.id] = p.drawCount;
        }
        return next;
      });
    };

    /** ゲーム開始 → 選択状態・ドロー枚数をリセット */
    const onGameStarted = () => {
      setSelected([]);
      setMyDrew(false);
      setLastDrawCount({}); // 新ゲームで枚数表示をリセット
    };

    /** タイマー更新（1秒ごと）*/
    const onTimerUpdate = ({ remaining }: { remaining: number; limit: number }) => {
      setTimerSec(remaining);
    };

    socket.on('connect',     onConnect);
    socket.on('gameState',   onGameState);
    socket.on('gameStarted', onGameStarted);
    socket.on('timerUpdate', onTimerUpdate);
    socket.on('showdown',    () => {});

    if (socket.connected) socket.emit('joinRoom', { roomId, name });
    else socket.connect();

    return () => {
      socket.off('connect',     onConnect);
      socket.off('gameState',   onGameState);
      socket.off('gameStarted', onGameStarted);
      socket.off('timerUpdate', onTimerUpdate);
      socket.off('showdown');
    };
  }, [roomId, name]);

  // ===== 状態の計算 =====
  const self        = players.find((p) => p.isSelf);
  const isDrawPhase = meta.phase.startsWith('draw');
  const isBetPhase  = meta.phase.startsWith('bet');
  const isMyTurn    = self?.isMyTurn ?? false;
  const drawRound   = ['draw1', 'draw2', 'draw3'].indexOf(meta.phase) + 1; // 1,2,3 or 0
  const curPlayer   = players.find((p) => p.isMyTurn);

  // ===== アクションハンドラ =====
  const handleCardClick = (j: number) => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    setSelected((prev) =>
      prev.includes(j) ? prev.filter((i) => i !== j) : [...prev, j]
    );
  };

  const handleDraw = () => {
    if (!isDrawPhase || !isMyTurn || myDrew) return;
    socket.emit('drawCards', { roomId, indices: selected });
    setMyDrew(true);
    setSelected([]);
  };

  const handleBet = (action: string) => {
    socket.emit('betAction', { roomId, action });
  };

  // ===== テーブルレイアウト定数 =====
  const TW  = 1100; // テーブル幅
  const TH  = 820;  // テーブル高さ
  const CX  = TW / 2;        // 中心X
  const CY  = TH / 2 - 10;   // 中心Y（少し上寄り）
  const RX  = 400;  // 楕円の横半径
  const RY  = 285;  // 楕円の縦半径
  const BW  = 260;  // プレイヤーボックス幅

  const others = players.filter((p) => !p.isSelf);

  /**
   * プレイヤーボックスの左上座標を計算する
   * - 自分 (isSelf) は常に真下（90度）
   * - 他プレイヤーは残りの5スロットに均等配置
   */
  const getPos = (p: Player): { left: number; top: number } => {
    let ang: number;
    if (p.isSelf) {
      ang = 90; // 真下
    } else {
      // 90度（真下）を避けた5スロット
      const slots = [-90, -30, 30, 150, 210];
      const idx   = others.findIndex((o) => o.id === p.id);
      ang = slots[idx] ?? (-90 + 60 * (idx + 1));
    }
    const rad = (ang * Math.PI) / 180;
    const cx  = CX + RX * Math.cos(rad);
    const cy  = CY + RY * Math.sin(rad);
    const bh  = p.isSelf ? 250 : 200; // 自分は大きく
    return { left: cx - BW / 2, top: cy - bh / 2 };
  };

  // ===== レンダリング =====
  return (
    <div style={S.page}>

      {/* ===== ナビゲーションバー ===== */}
      <nav style={S.nav}>
        {/* ロゴ + サイト名 */}
        <div style={S.navLeft}>
          <svg width="28" height="28" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="32" cy="32" r="30" stroke="#c9a84c" strokeWidth="2" fill="#0a3320"/>
            <text x="13" y="28" fontSize="14" fill="#f0d060" fontFamily="serif" textAnchor="middle">♠</text>
            <text x="51" y="28" fontSize="14" fill="#cc3333" fontFamily="serif" textAnchor="middle">♥</text>
            <text x="13" y="48" fontSize="14" fill="#f0d060" fontFamily="serif" textAnchor="middle">♣</text>
            <text x="51" y="48" fontSize="14" fill="#cc3333" fontFamily="serif" textAnchor="middle">♦</text>
            <text x="32" y="40" fontSize="20" fontWeight="bold" fill="#c9a84c" fontFamily="serif" textAnchor="middle">P</text>
          </svg>
          <span style={S.navLogo}>Poker Room Pastis</span>
        </div>

        {/* フェーズ + ドローインジケーター */}
        <div style={S.navCenter}>
          {/* ゲームモードバッジ */}
          <span style={{
            ...S.modeBadge,
            background: mode === 'badugi' ? 'rgba(204,119,68,0.2)' : 'rgba(68,136,204,0.2)',
            color:      mode === 'badugi' ? '#cc9966' : '#88bbee',
            border:     `1px solid ${mode === 'badugi' ? 'rgba(204,119,68,0.4)' : 'rgba(68,136,204,0.4)'}`,
          }}>
            {mode === 'badugi' ? 'Badugi' : '2-7 Triple Draw'}
          </span>

          <span style={S.phaseTag}>{PHASE_LABEL[meta.phase] ?? meta.phase}</span>

          {/* ドロー進捗ドット（draw フェーズのみ）*/}
          {isDrawPhase && (
            <span style={S.dots}>
              {[1, 2, 3].map((n) => (
                <span key={n} style={{
                  ...S.dot,
                  background:  n <= drawRound ? 'var(--gold-bright)' : 'rgba(255,255,255,0.15)',
                  boxShadow:   n === drawRound ? '0 0 8px var(--gold)' : 'none',
                }} />
              ))}
            </span>
          )}
        </div>

        <span style={S.navRoom}>{roomId.toUpperCase()}</span>
      </nav>

      {/* ===== ポット情報バー ===== */}
      {meta.phase !== 'waiting' && (
        <div style={S.potBar}>
          <div style={S.potChip}>
            <span>🏦</span>
            <span style={S.potAmt}>
              POT&nbsp;&nbsp;
              <b style={{ color: 'var(--gold-bright)', fontSize: 20 }}>{meta.pot}</b>
            </span>
          </div>
          {isBetPhase && meta.currentBet > 0 && (
            <div style={S.potChip}>
              <span style={S.potAmt}>
                CURRENT BET&nbsp;&nbsp;
                <b style={{ color: 'var(--cream)', fontSize: 18 }}>{meta.currentBet}</b>
              </span>
            </div>
          )}
        </div>
      )}

      {/* ===== テーブル（楕円フェルト + プレイヤーボックス）===== */}
      <div style={{ ...S.tableWrap, width: TW, height: TH }}>
        {/* フェルト楕円（外枠）*/}
        <div style={S.felt} />
        {/* フェルト楕円（内枠ライン）*/}
        <div style={S.feltInner} />

        {/* プレイヤーボックス */}
        {players.map((p) => {
          const { left, top } = getPos(p);
          const cardSize = p.isSelf ? 'lg' : 'sm'; // 自分は大きく

          return (
            <div key={p.id} style={{
              ...S.pBox, left, top, width: BW,
              ...(p.isSelf              ? S.pBoxSelf   : {}),
              ...(p.isMyTurn && !p.folded ? S.pBoxActive : {}),
              ...(p.folded              ? S.pBoxFolded : {}),
              ...(p.isWinner            ? S.pBoxWinner : {}),
            }}>

              {/* ---- ポジションバッジ ---- */}
              <div style={S.badgeRow}>
                {p.isDealer && <span style={{ ...S.badge, background: 'var(--gold)',         color: '#1a1200' }}>BTN</span>}
                {p.isSB     && <span style={{ ...S.badge, background: 'var(--chip-blue)',    color: '#fff'    }}>SB</span>}
                {p.isBB     && <span style={{ ...S.badge, background: 'var(--chip-orange)',  color: '#fff'    }}>BB</span>}
                {p.folded   && <span style={{ ...S.badge, background: '#444',               color: '#aaa'    }}>FOLD</span>}
                {p.isWinner && <span style={{ ...S.badge, background: 'var(--gold-bright)', color: '#1a1200' }}>WIN 👑</span>}
              </div>

              {/* ---- 名前 ---- */}
              <p style={{ ...S.pName, ...(p.isSelf ? { color: 'var(--gold-bright)' } : {}) }}>
                {p.isSelf ? `${p.name} (YOU)` : p.name}
              </p>

              {/* ---- チップ & ベット額 ---- */}
              <div style={S.chipRow}>
                <span style={S.chipAmt}>💵 {p.chips}</span>
                {p.bet > 0 && <span style={S.betAmt}>BET {p.bet}</span>}
              </div>

              {/* ---- 自分のターン: タイマーバー ---- */}
              {p.isMyTurn && meta.timerLimit > 0 && timerSec !== null && (
                <TimerBar remaining={timerSec} limit={meta.timerLimit} />
              )}

              {/* ---- 手札 ---- */}
              <div style={{ ...S.hand, gap: p.isSelf ? 7 : 4 }}>
                {p.hand.map((code, j) => (
                  <Card
                    key={j}
                    code={code}
                    size={cardSize}
                    selected={p.isSelf && selected.includes(j)}
                    clickable={p.isSelf && isDrawPhase && isMyTurn && !myDrew}
                    folded={p.folded}
                    onClick={() => handleCardClick(j)}
                  />
                ))}
              </div>

              {/* ---- 他プレイヤーのドロー枚数通知 ---- */}
              {/* ドローフェーズ中 + 直後のベットフェーズでも表示 */}
              {!p.isSelf && (isDrawPhase || isBetPhase) && (() => {
                const count = isDrawPhase
                  ? (p.drewThisRound ? p.drawCount : null) // ドロー中は済んだ人だけ表示
                  : lastDrawCount[p.id] ?? null;            // ベット中は最後の枚数を表示
                if (count === null) {
                  // ドロー中・未完了
                  if (!isDrawPhase) return null;
                  return <p style={S.drawInfo}>⏳ thinking...</p>;
                }
                return (
                  <p style={S.drawInfo}>
                    {count === 0 ? '✋ Stand pat' : `🔄 ${count} cards`}
                  </p>
                );
              })()}

              {/* ---- 役名 ---- */}
              {p.result && (
                <p style={{
                  ...S.result,
                  ...(p.isWinner ? { color: 'var(--gold-bright)', fontWeight: '700' } : {}),
                }}>
                  {p.result}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* ===== アクションパネル ===== */}
      <div style={S.actionPanel}>

        {/* ---- 待機中（ゲーム未開始: 自動開始を待つ）---- */}
        {meta.phase === 'waiting' && (
          <div style={S.waitBox}>
            <span style={S.waitDot} />
            <span style={S.waitText}>
              {players.length < 2
                ? 'もう1人参加するとゲームが自動で始まります...'
                : 'ゲームを開始しています...'}
            </span>
          </div>
        )}

        {/* ---- ドローフェーズ（自分のターン）---- */}
        {isDrawPhase && isMyTurn && !myDrew && (
          <div style={S.actionBox}>
            <p style={S.actionHint}>
              {selected.length > 0
                ? `${selected.length}枚を選択中 — もう一度タップで解除`
                : '捨てるカードをタップして選択（0枚 = スタンドパット）'}
            </p>
            <div style={S.btnRow}>
              <button onClick={handleDraw} style={S.btnGold}>
                {selected.length > 0
                  ? `🔄 ${selected.length}枚ドロー`
                  : '✋ Stand Pat（交換なし）'}
              </button>
              {selected.length > 0 && (
                <button onClick={() => setSelected([])} style={S.btnOutline}>
                  選択解除
                </button>
              )}
            </div>
          </div>
        )}

        {/* ---- ドローフェーズ（待機中）---- */}
        {isDrawPhase && (!isMyTurn || myDrew) && (
          <div style={S.waitBox}>
            <span style={S.waitDot} />
            <span style={S.waitText}>
              {myDrew
                ? '他のプレイヤーを待っています...'
                : curPlayer ? `${curPlayer.name} がドロー中...` : '待機中...'}
            </span>
          </div>
        )}

        {/* ---- ベットフェーズ（自分のターン）---- */}
        {isBetPhase && isMyTurn && self && (
          <div style={S.actionBox}>
            <p style={S.actionHint}>
              {self.toCall! > 0
                ? `コールに必要: ${self.toCall}　ベット単位: ${self.betSize}`
                : `チェックまたはベット可能　ベット単位: ${self.betSize}`}
            </p>
            <div style={S.btnRow}>
              <button onClick={() => handleBet('fold')}  style={S.btnRed}>
                フォールド
              </button>
              {self.canCheck
                ? <button onClick={() => handleBet('check')} style={S.btnGray}>
                    チェック
                  </button>
                : <button onClick={() => handleBet('call')}  style={S.btnGray}>
                    コール ({self.toCall})
                  </button>
              }
              {self.canRaise && (
                <button
                  onClick={() => handleBet(meta.currentBet === 0 ? 'bet' : 'raise')}
                  style={S.btnGold}
                >
                  {meta.currentBet === 0
                    ? `ベット (${self.betSize})`
                    : `レイズ (+${self.betSize})`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ---- ベットフェーズ（待機中）---- */}
        {isBetPhase && !isMyTurn && (
          <div style={S.waitBox}>
            <span style={S.waitDot} />
            <span style={S.waitText}>
              {curPlayer ? `${curPlayer.name} がアクション中...` : '待機中...'}
            </span>
          </div>
        )}

        {/* ---- ショーダウン後 ---- */}
        {meta.phase === 'showdown' && (
          <div style={S.actionBox}>
            <button
              onClick={() => socket.emit('startGame', { roomId })}
              style={S.btnGold}
            >
              🔁 もう一度プレイ（チップ100BBにリセット）
            </button>
          </div>
        )}
      </div>

      {/* ===== ルール説明フッター ===== */}
      <p style={S.ruleNote}>
        {mode === 'badugi'
          ? '★ Badugi: スートが全て異なる低い4枚が最強。同枚数なら最大カードが低い方が強い。'
          : '★ 2-7 Lowball: 低い手が強い。フラッシュ・ストレートは弱い手。A は常に最高位。'}
      </p>
    </div>
  );
};

// ===== スタイル =====
const S: Record<string, React.CSSProperties> = {
  page:       { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: 24, position: 'relative', zIndex: 1, fontFamily: 'var(--font-body)' },
  nav:        { width: '100%', maxWidth: 1140, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 32px 12px', borderBottom: '1px solid var(--gold-dim)' },
  navLeft:    { display: 'flex', alignItems: 'center', gap: 10 },
  navLogo:    { fontFamily: 'var(--font-title)', fontSize: 20, color: 'var(--gold)', letterSpacing: '0.08em' },
  navCenter:  { display: 'flex', alignItems: 'center', gap: 12 },
  modeBadge:  { fontFamily: 'var(--font-title)', fontSize: 11, padding: '4px 10px', borderRadius: 4, letterSpacing: '0.06em' },
  phaseTag:   { fontFamily: 'var(--font-title)', fontSize: 15, letterSpacing: '0.3em', color: 'var(--gold-bright)', background: 'rgba(201,168,76,0.12)', border: '1px solid var(--gold-dim)', borderRadius: 4, padding: '5px 16px' },
  dots:       { display: 'flex', gap: 8, alignItems: 'center' },
  dot:        { display: 'inline-block', width: 12, height: 12, borderRadius: '50%', transition: 'all 0.3s' },
  navRoom:    { fontFamily: 'var(--font-title)', fontSize: 14, color: 'var(--cream-dim)', letterSpacing: '0.18em' },
  potBar:     { display: 'flex', gap: 24, alignItems: 'center', padding: '8px 0 4px', justifyContent: 'center' },
  potChip:    { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--gold-dim)', borderRadius: 20, padding: '6px 20px' },
  potAmt:     { fontFamily: 'var(--font-title)', fontSize: 14, color: 'var(--cream-dim)', letterSpacing: '0.05em' },
  tableWrap:  { position: 'relative', margin: '2px auto' },
  felt:       { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '70%', height: '62%', borderRadius: '50%', background: 'radial-gradient(ellipse at 40% 40%, #1a6b42, #0a3320)', border: '8px solid var(--gold-dim)', boxShadow: '0 0 40px rgba(0,0,0,0.8), inset 0 0 30px rgba(0,0,0,0.4)', zIndex: 0 },
  feltInner:  { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 'calc(70% - 20px)', height: 'calc(62% - 20px)', borderRadius: '50%', border: '1px solid rgba(201,168,76,0.25)', zIndex: 0 },
  pBox:       { position: 'absolute', zIndex: 1, textAlign: 'center', padding: '10px 8px', borderRadius: 12, border: '1px solid transparent', transition: 'all 0.25s' },
  pBoxSelf:   { background: 'rgba(10,50,30,0.75)', border: '1px solid rgba(201,168,76,0.3)' },
  pBoxActive: { border: '1px solid var(--gold)', boxShadow: '0 0 20px rgba(201,168,76,0.5)', background: 'rgba(201,168,76,0.08)' },
  pBoxFolded: { opacity: 0.45 },
  pBoxWinner: { border: '1px solid var(--gold-bright)', boxShadow: '0 0 24px rgba(240,208,96,0.6)', background: 'rgba(201,168,76,0.12)' },
  badgeRow:   { display: 'flex', gap: 4, justifyContent: 'center', marginBottom: 4, flexWrap: 'wrap' as const },
  badge:      { fontSize: 11, fontFamily: 'var(--font-title)', padding: '2px 7px', borderRadius: 3, letterSpacing: '0.05em' },
  pName:      { fontFamily: 'var(--font-title)', fontSize: 13, color: 'var(--cream)', letterSpacing: '0.05em', margin: '0 0 3px', whiteSpace: 'nowrap' as const },
  chipRow:    { display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' as const },
  chipAmt:    { fontFamily: 'var(--font-body)', fontSize: 15, color: '#88dd88' },
  betAmt:     { fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--gold)', background: 'rgba(201,168,76,0.15)', borderRadius: 3, padding: '0 5px' },
  hand:       { display: 'flex', justifyContent: 'center', flexWrap: 'nowrap' as const, margin: '5px 0' },
  drawInfo:   { fontSize: 13, color: '#88bbff', fontFamily: 'var(--font-body)', marginTop: 3, fontStyle: 'italic' },
  result:     { fontSize: 13, color: 'var(--cream-dim)', fontFamily: 'var(--font-title)', marginTop: 4, letterSpacing: '0.04em' },
  actionPanel:{ width: '100%', maxWidth: 1100, display: 'flex', justifyContent: 'center', padding: '6px 16px 0' },
  actionBox:  { background: 'linear-gradient(160deg, rgba(22,92,56,0.5), rgba(10,51,32,0.7))', border: '1px solid var(--gold-dim)', borderRadius: 12, padding: '18px 32px', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 12, minWidth: 420 },
  actionHint: { fontFamily: 'var(--font-body)', fontSize: 18, color: 'var(--cream-dim)', fontStyle: 'italic', textAlign: 'center' as const },
  btnRow:     { display: 'flex', gap: 12, flexWrap: 'wrap' as const, justifyContent: 'center' },
  btnGold:    { padding: '13px 30px', background: 'linear-gradient(135deg, var(--gold), var(--gold-dim))', border: 'none', borderRadius: 7, color: '#1a1200', fontSize: 15, fontWeight: '700', cursor: 'pointer', letterSpacing: '0.06em', boxShadow: '0 3px 14px rgba(201,168,76,0.4)' },
  btnGray:    { padding: '13px 26px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 7, color: 'var(--cream)', fontSize: 15, cursor: 'pointer' },
  btnRed:     { padding: '13px 24px', background: 'var(--red)', border: 'none', borderRadius: 7, color: '#ffd0d0', fontSize: 15, cursor: 'pointer' },
  btnOutline: { padding: '13px 22px', background: 'transparent', border: '1px solid var(--gold-dim)', borderRadius: 7, color: 'var(--cream-dim)', fontSize: 14, cursor: 'pointer' },
  waitBox:    { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 26px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10 },
  waitDot:    { display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: 'var(--gold)', opacity: 0.7 },
  waitText:   { fontFamily: 'var(--font-body)', fontSize: 18, color: 'var(--cream-dim)', fontStyle: 'italic' },
  ruleNote:   { textAlign: 'center' as const, fontSize: 13, color: 'var(--gold-dim)', fontFamily: 'var(--font-body)', marginTop: 14, letterSpacing: '0.02em' },
};

export default PokerTable;
