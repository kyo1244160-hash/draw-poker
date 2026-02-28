/**
 * Room.tsx — ロビー画面
 * デザイン: カジノ高級感 × レトロポーカー
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { socket } from '../socket';

type RoomInfo = { id: string; count: number };

export default function Room() {
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [roomPlayers, setRoomPlayers] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    socket.connect();
    socket.on('connect', () => {});
    socket.on('roomList', (list: RoomInfo[]) => setRooms(list));
    socket.on('lobbyUpdate', (players: string[]) => setRoomPlayers(players));
    return () => { socket.off('roomList'); socket.off('lobbyUpdate'); socket.off('connect'); };
  }, []);

  const handleSelect = (id: string) => {
    setSelected(id); setError('');
    socket.emit('getRoomPlayers', id);
  };

  const handleJoin = () => {
    if (!name.trim()) { setError('名前を入力してください'); return; }
    if (!selected) { setError('部屋を選択してください'); return; }
    socket.emit('joinRoom', { roomId: selected, name: name.trim() });
    router.push(`/room/${selected}?name=${encodeURIComponent(name.trim())}`);
  };

  return (
    <div style={S.page}>
      {/* 装飾ヘッダー */}
      <header style={S.hero}>
        <div style={S.heroDivider} />
        <h1 style={S.heroTitle}>2-7 Triple Draw</h1>
        <p style={S.heroSub}>POKER ROOM</p>
        <div style={S.heroDivider} />
      </header>

      <div style={S.layout}>
        {/* 左: 部屋一覧 */}
        <section style={S.panel}>
          <h2 style={S.panelTitle}>
            <span style={S.titleLine} />
            ROOMS
            <span style={S.titleLine} />
          </h2>
          <div style={S.roomGrid}>
            {rooms.map((r) => (
              <button
                key={r.id}
                onClick={() => handleSelect(r.id)}
                style={{
                  ...S.roomCard,
                  ...(selected === r.id ? S.roomCardActive : {}),
                }}
              >
                <span style={S.roomId}>{r.id.toUpperCase()}</span>
                <span style={S.roomCount}>
                  <span style={{ fontSize: '18px' }}>👤</span> {r.count}
                </span>
              </button>
            ))}
            {rooms.length === 0 && <p style={S.emptyMsg}>接続中...</p>}
          </div>
        </section>

        {/* 右: 入室フォーム */}
        <section style={S.panel}>
          <h2 style={S.panelTitle}>
            <span style={S.titleLine} />
            {selected ? selected.toUpperCase() : 'SELECT ROOM'}
            <span style={S.titleLine} />
          </h2>

          {selected ? (
            <>
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

              {/* 名前入力 & 入室 */}
              <div style={S.formArea}>
                <label style={S.inputLabel}>YOUR NAME</label>
                <input
                  type="text" maxLength={12}
                  placeholder="名前を入力..."
                  value={name}
                  onChange={(e) => { setName(e.target.value); setError(''); }}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                  style={S.input}
                />
                {error && <p style={S.errorMsg}>{error}</p>}
                <button onClick={handleJoin} style={S.joinBtn}>
                  入室する　→
                </button>
              </div>
            </>
          ) : (
            <div style={S.placeholder}>
              <p style={{ fontSize: '48px', marginBottom: '12px' }}>🃏</p>
              <p style={{ color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', fontSize: '18px' }}>
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

const S: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 20px 40px', position: 'relative', zIndex: 1 },
  hero: { textAlign: 'center', padding: '56px 0 36px', width: '100%', maxWidth: '1100px' },
  heroDivider: { height: '1px', background: 'linear-gradient(90deg, transparent, var(--gold), transparent)', margin: '12px auto', width: '400px' },
  heroTitle: { fontFamily: 'var(--font-title)', fontSize: 'clamp(40px, 5vw, 68px)', color: 'var(--gold-bright)', letterSpacing: '0.12em', textShadow: '0 0 30px rgba(201,168,76,0.4), 2px 2px 0 rgba(0,0,0,0.8)', margin: '10px 0 6px' },
  heroSub: { fontFamily: 'var(--font-title)', fontSize: '16px', letterSpacing: '0.5em', color: 'var(--cream-dim)', marginTop: '6px' },
  layout: { display: 'flex', gap: '28px', width: '100%', maxWidth: '1100px', alignItems: 'flex-start', flexWrap: 'wrap' as const },
  panel: { flex: 1, minWidth: '340px', background: 'linear-gradient(160deg, rgba(22,92,56,0.6), rgba(10,51,32,0.8))', border: '1px solid var(--gold-dim)', borderRadius: '14px', padding: '36px', boxShadow: 'var(--shadow), var(--inset)' },
  panelTitle: { fontFamily: 'var(--font-title)', fontSize: '15px', letterSpacing: '0.4em', color: 'var(--gold)', textAlign: 'center', display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '28px' },
  titleLine: { flex: 1, height: '1px', background: 'linear-gradient(90deg, transparent, var(--gold-dim))' },
  roomGrid: { display: 'flex', flexDirection: 'column' as const, gap: '12px' },
  roomCard: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--gold-dim)', borderRadius: '10px', cursor: 'pointer', color: 'var(--cream)', transition: 'all 0.2s', width: '100%', textAlign: 'left' as const },
  roomCardActive: { background: 'rgba(201,168,76,0.15)', borderColor: 'var(--gold)', boxShadow: '0 0 18px rgba(201,168,76,0.3)' },
  roomId: { fontFamily: 'var(--font-title)', fontSize: '18px', letterSpacing: '0.1em', color: 'var(--cream)' },
  roomCount: { fontFamily: 'var(--font-body)', fontSize: '20px', color: 'var(--cream-dim)', display: 'flex', alignItems: 'center', gap: '8px' },
  playerList: { marginBottom: '24px', minHeight: '90px' },
  listLabel: { fontFamily: 'var(--font-title)', fontSize: '12px', letterSpacing: '0.3em', color: 'var(--gold-dim)', marginBottom: '12px' },
  playerRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: '1px solid rgba(201,168,76,0.1)' },
  playerDot: { color: 'var(--gold)', fontSize: '18px' },
  playerName: { fontFamily: 'var(--font-body)', fontSize: '21px', color: 'var(--cream)' },
  emptyMsg: { fontFamily: 'var(--font-body)', color: 'var(--cream-dim)', fontSize: '18px', fontStyle: 'italic' },
  formArea: { display: 'flex', flexDirection: 'column' as const, gap: '12px' },
  inputLabel: { fontFamily: 'var(--font-title)', fontSize: '12px', letterSpacing: '0.3em', color: 'var(--gold-dim)' },
  input: { padding: '16px 20px', fontSize: '20px', fontFamily: 'var(--font-body)', background: 'rgba(0,0,0,0.35)', border: '1px solid var(--gold-dim)', borderRadius: '8px', color: 'var(--cream)', outline: 'none', transition: 'border-color 0.2s', width: '100%' },
  errorMsg: { color: '#ff7777', fontFamily: 'var(--font-body)', fontSize: '17px', fontStyle: 'italic' },
  joinBtn: { padding: '16px 30px', background: 'linear-gradient(135deg, var(--gold), var(--gold-dim))', border: 'none', borderRadius: '8px', color: '#1a1200', fontSize: '17px', fontWeight: '700', cursor: 'pointer', letterSpacing: '0.1em', boxShadow: '0 4px 18px rgba(201,168,76,0.4)', alignSelf: 'flex-start' },
  placeholder: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', height: '220px' },
  footer: { marginTop: '48px', textAlign: 'center' },
  suitRow: { fontFamily: 'var(--font-body)', fontSize: '28px', color: 'var(--gold-dim)', letterSpacing: '22px' },
};
