/**
 * Room.tsx — ロビー画面
 *
 * 機能:
 *   - 部屋一覧（固定部屋 + ユーザー作成部屋）
 *   - 部屋作成（ゲームタイプ・パスワード設定）
 *   - パスワード付き部屋への入室
 *   - 各部屋の参加者一覧
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { socket } from '../socket';

// ===== 型定義 =====
interface RoomInfo {
  id:          string;
  label:       string;
  mode:        '27' | 'badugi' | 'mix';
  count:       number;
  hasPassword: boolean;
  isUserRoom:  boolean;
}

export default function Room() {
  const router = useRouter();
  const [rooms,        setRooms]        = useState<RoomInfo[]>([]);
  const [selected,     setSelected]     = useState<string | null>(null);
  const [roomPlayers,  setRoomPlayers]  = useState<string[]>([]);
  const [name,         setName]         = useState('');
  const [password,     setPassword]     = useState(''); // 入室用パスワード
  const [error,        setError]        = useState('');
  const [showCreate,   setShowCreate]   = useState(false);
  // 部屋作成フォーム
  const [newLabel,     setNewLabel]     = useState('');
  const [newMode,      setNewMode]      = useState<'27'|'badugi'|'mix'>('27');
  const [newPassword,  setNewPassword]  = useState('');
  const [createError,  setCreateError]  = useState('');

  // ===== Socket.IO =====
  useEffect(() => {
    socket.connect();
    socket.on('roomList',    (list: RoomInfo[]) => setRooms(list));
    socket.on('lobbyUpdate', (players: string[]) => setRoomPlayers(players));
    socket.on('roomCreated', ({ roomId }: { roomId: string }) => {
      // 作成後すぐにその部屋を選択
      setSelected(roomId);
      setShowCreate(false);
      setNewLabel(''); setNewMode('27'); setNewPassword('');
      socket.emit('getRoomPlayers', roomId);
    });
    socket.on('joinError', ({ message }: { message: string }) => {
      setError(message);
    });
    socket.emit('getRoomList');
    return () => {
      socket.off('roomList'); socket.off('lobbyUpdate');
      socket.off('roomCreated'); socket.off('joinError');
    };
  }, []);

  // ===== ハンドラ =====
  const handleSelect = (id: string) => {
    setSelected(id); setError(''); setPassword('');
    socket.emit('getRoomPlayers', id);
  };

  const handleJoin = () => {
    if (!name.trim())  { setError('名前を入力してください');  return; }
    if (!selected)     { setError('部屋を選択してください'); return; }
    const room = rooms.find((r) => r.id === selected);
    if (room?.hasPassword && !password.trim()) { setError('パスワードを入力してください'); return; }
    socket.emit('joinRoom', { roomId: selected, name: name.trim(), password: password.trim() || undefined });
    router.push(`/room/${encodeURIComponent(selected)}?name=${encodeURIComponent(name.trim())}`);
  };

  const handleCreate = () => {
    if (!newLabel.trim()) { setCreateError('部屋名を入力してください'); return; }
    socket.emit('createRoom', { label: newLabel.trim(), mode: newMode, password: newPassword.trim() || null });
    setCreateError('');
  };

  const selectedRoom = rooms.find((r) => r.id === selected);

  // モードの表示色
  const modeColor = (mode: string) =>
    mode === 'badugi' ? '#cc9966' : mode === 'mix' ? '#aa88dd' : '#88bbee';
  const modeBg = (mode: string) =>
    mode === 'badugi' ? 'rgba(204,119,68,0.2)' : mode === 'mix' ? 'rgba(170,136,221,0.2)' : 'rgba(68,136,204,0.2)';
  const modeBorder = (mode: string) =>
    mode === 'badugi' ? 'rgba(204,119,68,0.4)' : mode === 'mix' ? 'rgba(170,136,221,0.4)' : 'rgba(68,136,204,0.4)';
  const modeLabel = (mode: string) =>
    mode === 'badugi' ? 'Badugi' : mode === 'mix' ? 'Mix (2-7↔Badugi)' : '2-7 Triple Draw';
  const modeLeftBorder = (mode: string) =>
    mode === 'badugi' ? '#cc7744' : mode === 'mix' ? '#aa88dd' : '#4488cc';

  return (
    <div style={S.page}>
      {/* ===== ヘッダー ===== */}
      <header style={S.hero}>
        <div style={S.logoWrap}>
          <img
            src="/icons/icon-192.png"
            alt="Poker Room Pastis"
            style={{ width: 100, height: 100, borderRadius: '50%', boxShadow: '0 0 24px rgba(201,168,76,0.5)' }}
          />
        </div>
        <div style={S.heroDivider} />
        <h1 style={S.heroTitle}>Poker Room Pastis</h1>
        <div style={S.heroDivider} />
      </header>

      <div style={S.layout}>
        {/* ===== 左パネル: 部屋一覧 ===== */}
        <section style={S.panel}>
          <div style={S.panelHeader}>
            <h2 style={S.panelTitle}><span style={S.titleLine}/>ROOMS<span style={S.titleLine}/></h2>

          </div>

          {/* 部屋作成フォーム */}
          {showCreate && (
            <div style={S.createForm}>
              <p style={S.createTitle}>新しい部屋を作成</p>
              <input
                type="text" maxLength={30} placeholder="部屋名（例: My Room）"
                value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
                style={S.createInput}
              />
              <div style={S.modeSelect}>
                {(['27','badugi','mix'] as const).map((m) => (
                  <button key={m} onClick={() => setNewMode(m)} style={{
                    ...S.modeBtn,
                    background: newMode === m ? modeBg(m) : 'rgba(0,0,0,0.2)',
                    color:      newMode === m ? modeColor(m) : 'var(--cream-dim)',
                    border:     `1px solid ${newMode === m ? modeBorder(m) : 'rgba(255,255,255,0.1)'}`,
                  }}>
                    {modeLabel(m)}
                  </button>
                ))}
              </div>
              <input
                type="password" maxLength={20} placeholder="パスワード（任意）"
                value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                style={S.createInput}
              />
              {createError && <p style={S.errorMsg}>{createError}</p>}
              <button onClick={handleCreate} style={S.joinBtn}>作成する</button>
            </div>
          )}

          {/* 凡例 */}
          <div style={S.legend}>
            {[['27','2-7'],['badugi','Badugi'],['mix','Mix']].map(([m,l]) => (
              <span key={m} style={S.legendItem}>
                <span style={{ ...S.legendDot, background: modeColor(m) }} />{l}
              </span>
            ))}
          </div>

          {/* 部屋リスト */}
          <div style={S.roomGrid}>
            {rooms.map((r) => (
              <button key={r.id} onClick={() => handleSelect(r.id)} style={{
                ...S.roomCard,
                ...(selected === r.id ? S.roomCardActive : {}),
                borderLeftColor: modeLeftBorder(r.mode),
              }}>
                <div style={{ textAlign: 'left' as const }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ ...S.modeBadge, background: modeBg(r.mode), color: modeColor(r.mode), border: `1px solid ${modeBorder(r.mode)}` }}>
                      {modeLabel(r.mode)}
                    </span>
                    {r.hasPassword && <span style={S.lockIcon}>🔒</span>}
                    {r.isUserRoom  && <span style={S.userRoomBadge}>カスタム</span>}
                  </div>
                  <div style={S.roomLabel}>{r.label}</div>
                </div>
                <span style={S.roomCount}>👤 {r.count}</span>
              </button>
            ))}
            {rooms.length === 0 && <p style={S.emptyMsg}>接続中...</p>}
          </div>
        </section>

        {/* ===== 右パネル: 入室フォーム ===== */}
        <section style={S.panel}>
          <h2 style={S.panelTitle}>
            <span style={S.titleLine}/>
            {selectedRoom ? selectedRoom.label.toUpperCase() : 'SELECT ROOM'}
            <span style={S.titleLine}/>
          </h2>

          {selectedRoom ? (
            <>
              {/* ゲーム説明 */}
              <div style={S.ruleBox}>
                <p style={S.ruleTitle}>{modeLabel(selectedRoom.mode)}</p>
                {selectedRoom.mode === 'badugi' && <p style={S.ruleText}>4枚の手札 × 3回ドロー。スートが全て異なる低い手が最強。</p>}
                {selectedRoom.mode === '27'     && <p style={S.ruleText}>5枚の手札 × 3回ドロー。低い手が強い。フラッシュ・ストレートは弱い。</p>}
                {selectedRoom.mode === 'mix'    && <p style={S.ruleText}>BTNが1周するごとに 2-7 と Badugi を交互に切替。</p>}
                <p style={S.ruleText}>開始チップ: 100BB（毎ゲームリセット）</p>
              </div>

              {/* 参加者一覧 */}
              <div style={S.playerList}>
                <p style={S.listLabel}>現在の参加者</p>
                {roomPlayers.length === 0
                  ? <p style={S.emptyMsg}>まだ誰もいません</p>
                  : roomPlayers.map((p, i) => (
                    <div key={i} style={S.playerRow}>
                      <span style={S.playerDot}>♠</span>
                      <span style={S.playerNameText}>{p}</span>
                    </div>
                  ))
                }
              </div>

              {/* 入室フォーム */}
              <div style={S.formArea}>
                <label style={S.inputLabel}>YOUR NAME</label>
                <input type="text" maxLength={12} placeholder="名前を入力..."
                  value={name} onChange={(e) => { setName(e.target.value); setError(''); }}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                  style={S.input}
                />
                {selectedRoom.hasPassword && (
                  <>
                    <label style={{ ...S.inputLabel, marginTop: 8 }}>PASSWORD</label>
                    <input type="password" maxLength={20} placeholder="パスワードを入力..."
                      value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }}
                      onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                      style={S.input}
                    />
                  </>
                )}
                {error && <p style={S.errorMsg}>{error}</p>}
                <button onClick={handleJoin} style={S.joinBtn}>入室する →</button>
              </div>
            </>
          ) : (
            <div style={S.placeholder}>
              <p style={{ fontSize: 48, marginBottom: 12 }}>🃏</p>
              <p style={{ color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', fontSize: 18 }}>
                左の部屋を選択してください
              </p>
            </div>
          )}
        </section>
      </div>

      <footer style={S.footer}><span style={S.suitRow}>♠ ♥ ♦ ♣</span></footer>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:            { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 20px 40px', position: 'relative', zIndex: 1 },
  hero:            { textAlign: 'center', padding: '36px 0 24px', width: '100%', maxWidth: 1100 },
  logoWrap:        { display: 'flex', justifyContent: 'center', marginBottom: 10 },
  heroDivider:     { height: 1, background: 'linear-gradient(90deg, transparent, var(--gold), transparent)', margin: '10px auto', width: 400 },
  heroTitle:       { fontFamily: 'var(--font-title)', fontSize: 'clamp(26px, 4vw, 50px)', color: 'var(--gold-bright)', letterSpacing: '0.1em', textShadow: '0 0 28px rgba(201,168,76,0.35), 2px 2px 0 rgba(0,0,0,0.8)', margin: '6px 0' },
  layout:          { display: 'flex', gap: 24, width: '100%', maxWidth: 1100, alignItems: 'flex-start', flexWrap: 'wrap' as const },
  panel:           { flex: 1, minWidth: 320, background: 'linear-gradient(160deg, rgba(22,92,56,0.6), rgba(10,51,32,0.8))', border: '1px solid var(--gold-dim)', borderRadius: 12, padding: '24px 28px', boxShadow: 'var(--shadow), var(--inset)', overflowY: 'auto' as const, maxHeight: '75vh' },
  panelHeader:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  panelTitle:      { fontFamily: 'var(--font-title)', fontSize: 13, letterSpacing: '0.4em', color: 'var(--gold)', textAlign: 'center', display: 'flex', alignItems: 'center', gap: 10, margin: 0 },
  titleLine:       { flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, var(--gold-dim))' },
  createToggleBtn: { fontFamily: 'var(--font-title)', fontSize: 10, letterSpacing: '0.06em', padding: '6px 12px', background: 'rgba(201,168,76,0.15)', border: '1px solid var(--gold-dim)', borderRadius: 5, color: 'var(--gold)', cursor: 'pointer' },
  createForm:      { background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '16px', marginBottom: 16, display: 'flex', flexDirection: 'column' as const, gap: 8 },
  createTitle:     { fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold)', letterSpacing: '0.2em', margin: 0 },
  createInput:     { padding: '10px 14px', fontSize: 15, fontFamily: 'var(--font-body)', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--gold-dim)', borderRadius: 6, color: 'var(--cream)', outline: 'none', width: '100%', boxSizing: 'border-box' as const },
  modeSelect:      { display: 'flex', gap: 6, flexWrap: 'wrap' as const },
  modeBtn:         { flex: 1, padding: '7px 6px', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-title)', letterSpacing: '0.04em', transition: 'all 0.15s' },
  legend:          { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' as const },
  legendItem:      { display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--cream-dim)' },
  legendDot:       { display: 'inline-block', width: 9, height: 9, borderRadius: '50%', flexShrink: 0 },
  roomGrid:        { display: 'flex', flexDirection: 'column' as const, gap: 9 },
  roomCard:        { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--gold-dim)', borderLeft: '4px solid transparent', borderRadius: 8, cursor: 'pointer', color: 'var(--cream)', transition: 'all 0.2s', width: '100%' },
  roomCardActive:  { background: 'rgba(201,168,76,0.14)', borderColor: 'var(--gold)', boxShadow: '0 0 12px rgba(201,168,76,0.22)' },
  modeBadge:       { display: 'inline-block', fontSize: 10, fontFamily: 'var(--font-title)', padding: '2px 6px', borderRadius: 3, letterSpacing: '0.04em' },
  lockIcon:        { fontSize: 12 },
  userRoomBadge:   { fontSize: 9, fontFamily: 'var(--font-title)', padding: '2px 5px', borderRadius: 3, background: 'rgba(255,255,255,0.1)', color: 'var(--cream-dim)', border: '1px solid rgba(255,255,255,0.15)' },
  roomLabel:       { fontFamily: 'var(--font-title)', fontSize: 14, letterSpacing: '0.06em', color: 'var(--cream)' },
  roomCount:       { fontFamily: 'var(--font-body)', fontSize: 17, color: 'var(--cream-dim)', flexShrink: 0 },
  ruleBox:         { background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(201,168,76,0.15)', borderRadius: 8, padding: '8px 14px', marginBottom: 10 },
  ruleTitle:       { fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold)', letterSpacing: '0.08em', marginBottom: 5 },
  ruleText:        { fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--cream-dim)', lineHeight: 1.5, marginBottom: 2 },
  playerList:      { marginBottom: 10, minHeight: 40 },
  listLabel:       { fontFamily: 'var(--font-title)', fontSize: 11, letterSpacing: '0.3em', color: 'var(--gold-dim)', marginBottom: 8 },
  playerRow:       { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(201,168,76,0.1)' },
  playerDot:       { color: 'var(--gold)', fontSize: 14 },
  playerNameText:  { fontFamily: 'var(--font-body)', fontSize: 17, color: 'var(--cream)' },
  emptyMsg:        { fontFamily: 'var(--font-body)', color: 'var(--cream-dim)', fontSize: 15, fontStyle: 'italic' },
  formArea:        { display: 'flex', flexDirection: 'column' as const, gap: 9 },
  inputLabel:      { fontFamily: 'var(--font-title)', fontSize: 11, letterSpacing: '0.3em', color: 'var(--gold-dim)' },
  input:           { padding: '13px 16px', fontSize: 18, fontFamily: 'var(--font-body)', background: 'rgba(0,0,0,0.35)', border: '1px solid var(--gold-dim)', borderRadius: 7, color: 'var(--cream)', outline: 'none', width: '100%', boxSizing: 'border-box' as const },
  errorMsg:        { color: '#ff7777', fontFamily: 'var(--font-body)', fontSize: 14, fontStyle: 'italic' },
  joinBtn:         { padding: '13px 24px', background: 'linear-gradient(135deg, var(--gold), var(--gold-dim))', border: 'none', borderRadius: 7, color: '#1a1200', fontSize: 15, fontWeight: '700', cursor: 'pointer', letterSpacing: '0.08em', boxShadow: '0 4px 14px rgba(201,168,76,0.38)', alignSelf: 'flex-start' },
  placeholder:     { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', height: 200 },
  footer:          { marginTop: 40, textAlign: 'center' },
  suitRow:         { fontFamily: 'var(--font-body)', fontSize: 24, color: 'var(--gold-dim)', letterSpacing: 18 },
};
