/**
 * Room.tsx — ロビー画面
 *
 * 機能:
 *   - 部屋一覧の表示（2-7 / Badugi を色分け）
 *   - 部屋内の参加者一覧
 *   - 名前入力と入室
 *
 * デザイン: Poker Room Pastis ブランド
 *   - グリーンフェルト背景
 *   - ゴールドのアクセント
 *   - Cinzel / Crimson Text フォント
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { socket } from '../socket';

// ===== 型定義 =====
interface RoomInfo {
  id:    string;
  label: string;
  mode:  '27' | 'badugi';
  count: number;
}

export default function Room() {
  const router = useRouter();

  const [rooms,       setRooms]       = useState<RoomInfo[]>([]);
  const [selected,    setSelected]    = useState<string | null>(null);
  const [roomPlayers, setRoomPlayers] = useState<string[]>([]);
  const [name,        setName]        = useState('');
  const [error,       setError]       = useState('');

  // ===== Socket.IO 接続 =====
  useEffect(() => {
    socket.connect();
    socket.on('connect',     () => {});
    socket.on('roomList',    (list: RoomInfo[]) => setRooms(list));
    socket.on('lobbyUpdate', (players: string[]) => setRoomPlayers(players));
    return () => {
      socket.off('roomList');
      socket.off('lobbyUpdate');
      socket.off('connect');
    };
  }, []);

  // ===== ハンドラ =====
  const handleSelect = (id: string) => {
    setSelected(id);
    setError('');
    socket.emit('getRoomPlayers', id);
  };

  const handleJoin = () => {
    if (!name.trim())  { setError('名前を入力してください');  return; }
    if (!selected)     { setError('部屋を選択してください'); return; }
    socket.emit('joinRoom', { roomId: selected, name: name.trim() });
    router.push(`/room/${selected}?name=${encodeURIComponent(name.trim())}`);
  };

  const selectedRoom = rooms.find((r) => r.id === selected);

  // ===== レンダリング =====
  return (
    <div style={S.page}>

      {/* ===== ヘッダー / ロゴ ===== */}
      <header style={S.hero}>
        {/* SVG ロゴ */}
        <div style={S.logoWrap}>
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Poker Room Pastis logo">
            {/* 外円 */}
            <circle cx="32" cy="32" r="30" stroke="#c9a84c" strokeWidth="2" fill="#0a3320"/>
            {/* 内円 */}
            <circle cx="32" cy="32" r="24" stroke="#c9a84c" strokeWidth="1" strokeDasharray="3 3" fill="none"/>
            {/* ♠ */}
            <text x="13" y="28" fontSize="14" fill="#f0d060" fontFamily="serif" textAnchor="middle">♠</text>
            {/* ♥ */}
            <text x="51" y="28" fontSize="14" fill="#cc3333" fontFamily="serif" textAnchor="middle">♥</text>
            {/* ♣ */}
            <text x="13" y="48" fontSize="14" fill="#f0d060" fontFamily="serif" textAnchor="middle">♣</text>
            {/* ♦ */}
            <text x="51" y="48" fontSize="14" fill="#cc3333" fontFamily="serif" textAnchor="middle">♦</text>
            {/* 中央 P */}
            <text x="32" y="40" fontSize="20" fontWeight="bold" fill="#c9a84c" fontFamily="serif" textAnchor="middle">P</text>
          </svg>
        </div>

        <div style={S.heroDivider} />
        <h1 style={S.heroTitle}>Poker Room Pastis</h1>
        <p style={S.heroSub}>SELECT A ROOM TO JOIN</p>
        <div style={S.heroDivider} />
      </header>

      {/* ===== メインレイアウト ===== */}
      <div style={S.layout}>

        {/* 左パネル: 部屋一覧 */}
        <section style={S.panel}>
          <h2 style={S.panelTitle}>
            <span style={S.titleLine} />ROOMS<span style={S.titleLine} />
          </h2>

          {/* 凡例 */}
          <div style={S.legend}>
            <span style={{ ...S.legendDot, background: '#4488cc' }} />
            <span style={S.legendText}>2-7 Triple Draw</span>
            <span style={{ ...S.legendDot, background: '#cc7744', marginLeft: 12 }} />
            <span style={S.legendText}>Badugi</span>
          </div>

          <div style={S.roomGrid}>
            {rooms.map((r) => (
              <button
                key={r.id}
                onClick={() => handleSelect(r.id)}
                style={{
                  ...S.roomCard,
                  ...(selected === r.id ? S.roomCardActive : {}),
                  borderLeftColor: r.mode === 'badugi' ? '#cc7744' : '#4488cc',
                }}
              >
                <div>
                  {/* ゲームタイプバッジ */}
                  <span style={{
                    ...S.modeBadge,
                    background: r.mode === 'badugi' ? 'rgba(204,119,68,0.2)' : 'rgba(68,136,204,0.2)',
                    color:      r.mode === 'badugi' ? '#cc9966'              : '#88bbee',
                  }}>
                    {r.mode === 'badugi' ? 'Badugi' : '2-7 Triple Draw'}
                  </span>
                  <div style={S.roomId}>{r.label}</div>
                </div>
                <span style={S.roomCount}>👤 {r.count}</span>
              </button>
            ))}
            {rooms.length === 0 && <p style={S.emptyMsg}>接続中...</p>}
          </div>
        </section>

        {/* 右パネル: 入室フォーム */}
        <section style={S.panel}>
          <h2 style={S.panelTitle}>
            <span style={S.titleLine} />
            {selectedRoom ? selectedRoom.label.toUpperCase() : 'SELECT ROOM'}
            <span style={S.titleLine} />
          </h2>

          {selectedRoom ? (
            <>
              {/* ゲーム説明 */}
              <div style={S.ruleBox}>
                {selectedRoom.mode === 'badugi' ? (
                  <>
                    <p style={S.ruleTitle}>Badugi ルール</p>
                    <p style={S.ruleText}>4枚の手札 × 3回ドロー。スートが全て異なる低い手が最強。</p>
                  </>
                ) : (
                  <>
                    <p style={S.ruleTitle}>2-7 Triple Draw ルール</p>
                    <p style={S.ruleText}>5枚の手札 × 3回ドロー。低い手が強い。フラッシュ・ストレートは弱い手。</p>
                  </>
                )}
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
                      <span style={S.playerName}>{p}</span>
                    </div>
                  ))
                }
              </div>

              {/* 名前入力 & 入室ボタン */}
              <div style={S.formArea}>
                <label style={S.inputLabel}>YOUR NAME</label>
                <input
                  type="text"
                  maxLength={12}
                  placeholder="名前を入力..."
                  value={name}
                  onChange={(e) => { setName(e.target.value); setError(''); }}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                  style={S.input}
                />
                {error && <p style={S.errorMsg}>{error}</p>}
                <button onClick={handleJoin} style={S.joinBtn}>
                  入室する →
                </button>
              </div>
            </>
          ) : (
            <div style={S.placeholder}>
              <p style={{ fontSize: '52px', marginBottom: 12 }}>🃏</p>
              <p style={{ color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', fontSize: 18 }}>
                左の部屋を選択してください
              </p>
            </div>
          )}
        </section>
      </div>

      {/* フッター */}
      <footer style={S.footer}>
        <span style={S.suitRow}>♠ ♥ ♦ ♣</span>
      </footer>
    </div>
  );
}

// ===== スタイル =====
const S: Record<string, React.CSSProperties> = {
  page:         { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 20px 40px', position: 'relative', zIndex: 1 },
  hero:         { textAlign: 'center', padding: '40px 0 28px', width: '100%', maxWidth: 1100 },
  logoWrap:     { display: 'flex', justifyContent: 'center', marginBottom: 10 },
  heroDivider:  { height: 1, background: 'linear-gradient(90deg, transparent, var(--gold), transparent)', margin: '10px auto', width: 400 },
  heroTitle:    { fontFamily: 'var(--font-title)', fontSize: 'clamp(28px, 4vw, 52px)', color: 'var(--gold-bright)', letterSpacing: '0.1em', textShadow: '0 0 28px rgba(201,168,76,0.35), 2px 2px 0 rgba(0,0,0,0.8)', margin: '8px 0 4px' },
  heroSub:      { fontFamily: 'var(--font-title)', fontSize: 13, letterSpacing: '0.45em', color: 'var(--cream-dim)', marginTop: 4 },
  layout:       { display: 'flex', gap: 24, width: '100%', maxWidth: 1100, alignItems: 'flex-start', flexWrap: 'wrap' as const },
  panel:        { flex: 1, minWidth: 320, background: 'linear-gradient(160deg, rgba(22,92,56,0.6), rgba(10,51,32,0.8))', border: '1px solid var(--gold-dim)', borderRadius: 12, padding: '28px 32px', boxShadow: 'var(--shadow), var(--inset)' },
  panelTitle:   { fontFamily: 'var(--font-title)', fontSize: 13, letterSpacing: '0.4em', color: 'var(--gold)', textAlign: 'center', display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
  titleLine:    { flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, var(--gold-dim))' },
  legend:       { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--cream-dim)' },
  legendDot:    { display: 'inline-block', width: 10, height: 10, borderRadius: '50%' },
  legendText:   {},
  roomGrid:     { display: 'flex', flexDirection: 'column' as const, gap: 10 },
  roomCard:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--gold-dim)', borderLeft: '4px solid transparent', borderRadius: 8, cursor: 'pointer', color: 'var(--cream)', transition: 'all 0.2s', width: '100%', textAlign: 'left' as const },
  roomCardActive: { background: 'rgba(201,168,76,0.14)', borderColor: 'var(--gold)', boxShadow: '0 0 14px rgba(201,168,76,0.25)' },
  modeBadge:    { display: 'inline-block', fontSize: 10, fontFamily: 'var(--font-title)', padding: '2px 7px', borderRadius: 3, marginBottom: 4, letterSpacing: '0.05em' },
  roomId:       { fontFamily: 'var(--font-title)', fontSize: 15, letterSpacing: '0.06em', color: 'var(--cream)' },
  roomCount:    { fontFamily: 'var(--font-body)', fontSize: 17, color: 'var(--cream-dim)' },
  ruleBox:      { background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(201,168,76,0.15)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 },
  ruleTitle:    { fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold)', letterSpacing: '0.08em', marginBottom: 6 },
  ruleText:     { fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--cream-dim)', lineHeight: 1.5, marginBottom: 3 },
  playerList:   { marginBottom: 20, minHeight: 70 },
  listLabel:    { fontFamily: 'var(--font-title)', fontSize: 11, letterSpacing: '0.3em', color: 'var(--gold-dim)', marginBottom: 10 },
  playerRow:    { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid rgba(201,168,76,0.1)' },
  playerDot:    { color: 'var(--gold)', fontSize: 15 },
  playerName:   { fontFamily: 'var(--font-body)', fontSize: 19, color: 'var(--cream)' },
  emptyMsg:     { fontFamily: 'var(--font-body)', color: 'var(--cream-dim)', fontSize: 16, fontStyle: 'italic' },
  formArea:     { display: 'flex', flexDirection: 'column' as const, gap: 10 },
  inputLabel:   { fontFamily: 'var(--font-title)', fontSize: 11, letterSpacing: '0.3em', color: 'var(--gold-dim)' },
  input:        { padding: '14px 18px', fontSize: 19, fontFamily: 'var(--font-body)', background: 'rgba(0,0,0,0.35)', border: '1px solid var(--gold-dim)', borderRadius: 7, color: 'var(--cream)', outline: 'none', width: '100%' },
  errorMsg:     { color: '#ff7777', fontFamily: 'var(--font-body)', fontSize: 15, fontStyle: 'italic' },
  joinBtn:      { padding: '14px 26px', background: 'linear-gradient(135deg, var(--gold), var(--gold-dim))', border: 'none', borderRadius: 7, color: '#1a1200', fontSize: 16, fontWeight: '700', cursor: 'pointer', letterSpacing: '0.08em', boxShadow: '0 4px 16px rgba(201,168,76,0.4)', alignSelf: 'flex-start' },
  placeholder:  { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', height: 220 },
  footer:       { marginTop: 44, textAlign: 'center' },
  suitRow:      { fontFamily: 'var(--font-body)', fontSize: 26, color: 'var(--gold-dim)', letterSpacing: 20 },
};
