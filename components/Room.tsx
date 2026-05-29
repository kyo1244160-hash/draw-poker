/**
 * Room.tsx — ロビー画面
 *
 * 機能:
 *   - 部屋一覧（固定部屋 + ユーザー作成部屋）
 *   - Google ログイン / ニックネーム設定
 *   - パスワード付き部屋への入室
 *   - 各部屋の参加者一覧
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import { socket, connectWithAuth } from '../socket';
import UserMenu from './UserMenu';
import NicknameSetup from './NicknameSetup';
import LoginPromptModal from './LoginPromptModal';
import MyPageModal from './MyPageModal';
import { modeLabelFull, modeLabelShort, modeColor, modeBg, modeBorder, modeLeftBorder } from '../lib/modeLabels';

// ===== 型定義 =====
interface RoomInfo {
  id:          string;
  label:       string;
  mode:        '27' | 'badugi' | 'mix' | 'a5' | '27sd' | 'mix3' | '3card';
  count:       number;
  hasPassword: boolean;
  isUserRoom:  boolean;
  isZoom:      boolean;
  isThreeCard?: boolean;
  maxPlayers?: number;
  phase?:      string;
}

interface TournamentInfo {
  id:                  string;
  name:                string;
  mode:                string;
  scheduled_start_at:  string;
  status:              string;
  starting_chips:      number;
  max_players:         number | null;
  blind_schedule_name: string | null;
  entry_count:         number;
  is_test:             boolean;
}

// 管理者のみ表示するリンク（非管理者には何も表示しない）
function AdminLink({ accountId }: { accountId: string }) {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch('/api/admin/users')
      .then((r) => { if (r.ok) setIsAdmin(true); })
      .catch(() => {});
  }, [accountId]);
  if (!isAdmin) return null;
  return (
    <a href="/admin" style={S2.adminLink}>⚙ 管理</a>
  );
}

export default function Room() {
  const router = useRouter();
  const { data: session, status } = useSession();

  const [rooms,         setRooms]         = useState<RoomInfo[]>([]);
  const [selected,      setSelected]      = useState<string | null>(null);
  const [roomPlayers,   setRoomPlayers]   = useState<string[]>([]);
  const [password,      setPassword]      = useState('');
  const [error,         setError]         = useState('');
  const [fullRoomId,    setFullRoomId]    = useState<string | null>(null);
  const [showCreate,    setShowCreate]    = useState(false);
  const [newLabel,      setNewLabel]      = useState('');
  const [newMode,       setNewMode]       = useState<'27'|'badugi'|'mix'>('27');
  const [newPassword,   setNewPassword]   = useState('');
  const [createError,   setCreateError]   = useState('');
  const [showJoinPanel, setShowJoinPanel] = useState(false);
  // モーダル表示制御
  const [showLoginPrompt,   setShowLoginPrompt]   = useState(false);
  const [showNicknameSetup, setShowNicknameSetup] = useState(false);
  const [showMyPage,        setShowMyPage]        = useState(false);
  const [socketError,       setSocketError]       = useState('');
  const [tournaments, setTournaments] = useState<TournamentInfo[]>([]);
  const [joining,     setJoining]     = useState(false);  // 入室待機中フラグ

  // ===== Socket.IO =====
  useEffect(() => {
    const onConnect = () => {
      setSocketError('');
      socket.emit('getRoomList');
    };
    const onConnectError = (err: Error) => {
      if (err.message === 'NICKNAME_REQUIRED') {
        setShowNicknameSetup(true);
      } else {
        setSocketError(err.message);
      }
    };
    socket.on('connect',       onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('roomList',    (list: RoomInfo[]) => setRooms(list));
    socket.on('lobbyUpdate', (players: string[]) => setRoomPlayers(players));
    socket.on('roomCreated', ({ roomId }: { roomId: string }) => {
      setSelected(roomId);
      setShowCreate(false);
      setNewLabel(''); setNewMode('27'); setNewPassword('');
      socket.emit('getRoomPlayers', roomId);
    });
    socket.on('joinError', ({ message, fullRoomId: fid }: { message: string; fullRoomId?: string }) => {
      setError(message);
      setFullRoomId(fid ?? null);
      setJoining(false);  // 入室失敗 → ボタンを戻す
    });

    if (socket.connected) {
      socket.emit('getRoomList');
    } else {
      connectWithAuth();
    }

    return () => {
      socket.off('connect',       onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('roomList'); socket.off('lobbyUpdate');
      socket.off('roomCreated'); socket.off('joinError');
    };
  }, []);

  // トーナメント一覧取得
  useEffect(() => {
    fetch('/api/tournaments')
      .then((r) => r.ok ? r.json() : { tournaments: [] })
      .then((data) => setTournaments(data.tournaments ?? []))
      .catch(() => {});
  }, []);

  // ロビーアクセス時: 未ログインならモーダルを表示
  useEffect(() => {
    if (status === 'unauthenticated') {
      setShowLoginPrompt(true);
    }
  }, [status]);

  // ===== ハンドラ =====
  const handleSelect = (id: string) => {
    setSelected(id); setError(''); setPassword(''); setFullRoomId(null);
    socket.emit('getRoomPlayers', id);
    setShowJoinPanel(true);
  };

  const handleJoin = () => {
    // 未ログイン
    if (status !== 'authenticated') {
      setShowLoginPrompt(true);
      return;
    }
    // ニックネーム未設定
    if (!session?.user?.nickname) {
      setShowNicknameSetup(true);
      return;
    }
    if (!selected) { setError('部屋を選択してください'); return; }
    const room = rooms.find((r) => r.id === selected);
    if (room?.hasPassword && !password.trim()) { setError('パスワードを入力してください'); return; }

    const nickname = session.user.nickname;
    if (room?.isZoom) {
      router.push(`/zoom/${encodeURIComponent(selected)}?name=${encodeURIComponent(nickname)}`);
      return;
    }

    // joinRoom 送信 → gameState を受け取ってからページ遷移
    // （即遷移するとjoinErrorがPokerTable側で受け取れないため）
    setJoining(true);
    setError('');
    setFullRoomId(null);

    const targetRoomId = selected;
    const onFirstGameState = () => {
      router.push(`/room/${encodeURIComponent(targetRoomId)}?name=${encodeURIComponent(nickname)}`);
    };
    // joinError が来たら gameState リスナーをキャンセルして joining を解除
    const onJoinFail = () => {
      socket.off('gameState', onFirstGameState);
      setJoining(false);
    };
    socket.once('gameState', onFirstGameState);
    socket.once('joinError', onJoinFail);

    socket.emit('joinRoom', { roomId: targetRoomId, password: password.trim() || undefined });
  };

  const handleCreate = () => {
    if (!newLabel.trim()) { setCreateError('部屋名を入力してください'); return; }
    socket.emit('createRoom', { label: newLabel.trim(), mode: newMode, password: newPassword.trim() || null });
    setCreateError('');
  };

  const selectedRoom = rooms.find((r) => r.id === selected);

  const statusLabel = (s: string) => ({ registering: '受付中', running: '進行中', finished: '終了', cancelled: 'キャンセル' }[s] ?? s);

  const modeLabel = modeLabelFull;
  // modeColor, modeBg, modeBorder, modeLeftBorder は lib/modeLabels.ts から import 済み

  return (
    <div style={S.page}>
      {/* ログイン促進モーダル */}
      {showLoginPrompt && (
        <LoginPromptModal onClose={() => setShowLoginPrompt(false)} />
      )}

      {/* マイページモーダル */}
      {showMyPage && (
        <MyPageModal onClose={() => setShowMyPage(false)} />
      )}

      {/* ニックネーム設定モーダル */}
      {showNicknameSetup && (
        <NicknameSetup
          onComplete={(nickname) => {
            setShowNicknameSetup(false);
            // 設定完了後にそのまま入室
            if (selected) {
              const room = rooms.find((r) => r.id === selected);
              if (room?.isZoom) {
                router.push(`/zoom/${encodeURIComponent(selected)}?name=${encodeURIComponent(nickname)}`);
              } else {
                socket.emit('joinRoom', { roomId: selected, password: password.trim() || undefined });
                router.push(`/room/${encodeURIComponent(selected)}?name=${encodeURIComponent(nickname)}`);
              }
            }
          }}
        />
      )}

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
        {/* ログイン状態 */}
        <div style={S.userMenuWrap}>
          <UserMenu onNicknameNeeded={() => setShowNicknameSetup(true)} />
          {session?.user?.accountId && (
            <>
              <button
                onClick={() => setShowMyPage(true)}
                style={S2.myPageBtn}
              >
                MY PAGE
              </button>
              <AdminLink accountId={session.user.accountId} />
            </>
          )}
        </div>
      </header>

      {/* ===== トーナメント一覧 ===== */}
      {tournaments.length > 0 && (
        <section style={S.tournamentSection}>
          <h2 style={S.panelTitle}><span style={S.titleLine}/>TOURNAMENTS<span style={S.titleLine}/></h2>
          <div style={S.tournamentGrid}>
            {tournaments.map((t) => (
              <div key={t.id} style={{ ...S.tournamentCard, cursor: 'pointer' }} onClick={() => router.push(`/tournament/${t.id}`)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ ...S.modeBadge, background: 'rgba(201,168,76,0.15)', color: 'var(--gold)', border: '1px solid var(--gold-dim)' }}>
                    {modeLabelShort(t.mode)}
                  </span>
                  <span style={statusBadge(t.status)}>{statusLabel(t.status)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={S.tournamentName}>{t.name}</div>
                  {t.is_test && <span style={S.testBadge}>テスト</span>}
                </div>
                <div style={S.tournamentMeta}>
                  <span>📅 {new Date(t.scheduled_start_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  <span>🎰 {t.starting_chips.toLocaleString()} chips</span>
                  {t.max_players && <span>👤 {t.entry_count} / {t.max_players}</span>}
                  {t.blind_schedule_name && <span>⏱ {t.blind_schedule_name}</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ===== PC: 2カラム / スマホ: 1カラム ===== */}
      <div style={S.layout}>
        {/* 部屋リストパネル */}
        <section style={{ ...S.panel, ...(showJoinPanel ? { display: 'none' } : {}) }} className="room-list-panel">
          <div style={S.panelHeader}>
            <h2 style={S.panelTitle}><span style={S.titleLine}/>ROOMS<span style={S.titleLine}/></h2>
          </div>

          <div style={S.legend}>
            {[['27','2-7'],['badugi','Badugi'],['mix','Mix']].map(([m,l]) => (
              <span key={m} style={S.legendItem}>
                <span style={{ ...S.legendDot, background: modeColor(m) }} />{l}
              </span>
            ))}
            <span style={S.legendItem}>
              <span style={{ ...S.legendDot, background: '#88ee66' }} />⚡ FastFold
            </span>
          </div>

          <div style={S.roomGrid}>
            {rooms.filter(r => !r.isThreeCard).map((r) => (
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
                    {r.isZoom      && <span style={S.zoomBadge}>⚡ FastFold</span>}
                  </div>
                  <div style={S.roomLabel}>{r.label}</div>
                </div>
                <span style={S.roomCount}>👤 {r.count}</span>
              </button>
            ))}
            {rooms.filter(r => !r.isThreeCard).length === 0 && !socketError && <p style={S.emptyMsg}>接続中...</p>}
            {rooms.filter(r => !r.isThreeCard).length === 0 && socketError && (
              <div>
                <p style={{ ...S.emptyMsg, color: '#ee8888' }}>接続エラー: {socketError}</p>
                <button
                  style={{ marginTop: 8, fontSize: 13, color: 'var(--gold)', background: 'transparent',
                    border: '1px solid var(--gold-dim)', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}
                  onClick={() => { setSocketError(''); connectWithAuth(); }}>
                  再接続
                </button>
              </div>
            )}
          </div>

          {/* ===== スリーカードポーカー ===== */}
          <h2 style={{ ...S.panelTitle, marginTop: 20 }}>
            <span style={S.titleLine}/>THREE CARD POKER<span style={S.titleLine}/>
          </h2>
          <div style={S.roomGrid}>
            {rooms.filter(r => r.isThreeCard).map((r) => {
              const isFull = r.count >= (r.maxPlayers ?? 6);
              return (
                <button key={r.id}
                  onClick={() => !isFull && router.push(`/three-card/${r.id}`)}
                  disabled={isFull}
                  style={{ ...S.roomCard, borderLeftColor: '#cc66aa',
                    opacity: isFull ? 0.5 : 1, cursor: isFull ? 'not-allowed' : 'pointer' }}>
                  <div style={{ textAlign: 'left' as const }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <span style={{ ...S.modeBadge, background: 'rgba(180,80,140,0.2)',
                        color: '#dd88cc', border: '1px solid rgba(180,80,140,0.4)' }}>
                        3-CARD
                      </span>
                      {isFull && <span style={{ fontSize: 10, color: '#cc6666' }}>満員</span>}
                    </div>
                    <div style={S.roomLabel}>{r.label}</div>
                  </div>
                  <span style={S.roomCount}>👤 {r.count}/{r.maxPlayers ?? 6}</span>
                </button>
              );
            })}
            {rooms.filter(r => r.isThreeCard).length === 0 && (
              <p style={S.emptyMsg}>接続中...</p>
            )}
          </div>
        </section>

        {/* 入室パネル */}
        <section style={{ ...S.panel }} className="join-panel-wrapper">
          <div className="back-btn-row" style={{ display: 'none', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <button onClick={() => setShowJoinPanel(false)} style={S.createToggleBtn}>← 戻る</button>
            <h2 style={{ ...S.panelTitle, flex: 1, margin: 0 }}>
              <span style={S.titleLine}/>
              {selectedRoom ? selectedRoom.label.toUpperCase() : 'SELECT ROOM'}
              <span style={S.titleLine}/>
            </h2>
          </div>
          <h2 style={S.panelTitle} className="join-panel-title">
            <span style={S.titleLine}/>
            {selectedRoom ? selectedRoom.label.toUpperCase() : 'SELECT ROOM'}
            <span style={S.titleLine}/>
          </h2>

          {selectedRoom ? (
            <>
              <div style={S.ruleBox}>
                <p style={S.ruleTitle}>{modeLabel(selectedRoom.mode)}</p>
                {selectedRoom.isZoom && <p style={{ ...S.ruleText, color: '#aadd88' }}>⚡ FastFold: フォールドした瞬間に次のテーブルへ移動。</p>}
                {selectedRoom.mode === 'badugi' && <p style={S.ruleText}>4枚の手札 × 3回ドロー。スートが全て異なる低い手が最強。</p>}
                {selectedRoom.mode === '27'     && <p style={S.ruleText}>5枚の手札 × 3回ドロー。低い手が強い。フラッシュ・ストレートは弱い。</p>}
                {selectedRoom.mode === 'mix'    && <p style={S.ruleText}>BTNが1周するごとに 2-7 と Badugi を交互に切替。</p>}
                <p style={S.ruleText}>開始チップ: 100BB（毎ゲームリセット）</p>
              </div>

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

              <div style={S.formArea}>
                {/* ログイン状態に応じたフォーム */}
                {status === 'unauthenticated' && (
                  <div style={S.loginPrompt}>
                    <p style={S.loginPromptText}>入室するには Google ログインが必要です</p>
                  </div>
                )}
                {status === 'authenticated' && !session?.user?.nickname && (
                  <div style={S.loginPrompt}>
                    <p style={S.loginPromptText}>ニックネームを設定してから入室できます</p>
                    <button style={S.setupPromptBtn} onClick={() => setShowNicknameSetup(true)}>
                      ニックネームを設定 →
                    </button>
                  </div>
                )}
                {status === 'authenticated' && session?.user?.nickname && (
                  <div style={S.nicknameDisplay}>
                    <span style={S.inputLabel}>NAME</span>
                    <span style={S.nicknameText}>{session.user.nickname}</span>
                  </div>
                )}
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
                {error && (
                  <div>
                    <p style={S.errorMsg}>{error}</p>
                    {/* 満員エラー時：同モードの空き部屋をクリッカブルに表示 */}
                    {fullRoomId && (() => {
                      const fullRoom = rooms.find(r => r.id === fullRoomId);
                      const MAX = 6;
                      const available = rooms.filter(r =>
                        r.mode === fullRoom?.mode &&
                        r.id !== fullRoomId &&
                        !r.isZoom &&
                        r.count < MAX
                      );
                      return available.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginTop: 8 }}>
                          <span style={{ fontSize: 12, color: 'var(--cream-dim)', alignSelf: 'center' }}>空き部屋:</span>
                          {available.slice(0, 3).map(r => (
                            <button
                              key={r.id}
                              style={{ fontSize: 12, background: 'rgba(201,168,76,0.15)', border: '1px solid var(--gold-dim)', color: 'var(--gold)', borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}
                              onClick={() => handleSelect(r.id)}
                            >
                              {r.label} ({r.count}/{MAX})
                            </button>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>
                )}
                <button onClick={handleJoin} style={{ ...S.joinBtn, opacity: joining ? 0.6 : 1, cursor: joining ? 'wait' : 'pointer' }}
                  disabled={joining}>
                  {joining ? '入室中...' : '入室する →'}
                </button>
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

      <style>{`
        @media (max-width: 767px) {
          .room-list-panel {
            display: ${showJoinPanel ? 'none' : 'block'} !important;
            width: 100%;
          }
          .join-panel-wrapper {
            display: ${showJoinPanel ? 'block' : 'none'} !important;
            width: 100%;
          }
          .back-btn-row {
            display: ${showJoinPanel ? 'flex' : 'none'} !important;
          }
          .join-panel-title {
            display: none !important;
          }
        }
        @media (min-width: 768px) {
          .room-list-panel { display: block !important; flex: 1; min-width: 320px; }
          .join-panel-wrapper { display: block !important; flex: 1; min-width: 320px; }
          .back-btn-row { display: none !important; }
          .join-panel-title { display: flex !important; margin-bottom: 16px; }
        }
      `}</style>
    </div>
  );
}

function statusBadge(s: string): React.CSSProperties {
  const color = { registering: '#88bbee', running: '#88ee88', finished: '#aaa', cancelled: '#ee8888' }[s] ?? '#aaa';
  return { fontFamily: 'var(--font-title)', fontSize: 10, letterSpacing: '0.06em', color, border: `1px solid ${color}`, borderRadius: 3, padding: '2px 6px' };
}

const S2: Record<string, React.CSSProperties> = {
  myPageBtn: {
    fontFamily:    'var(--font-title)',
    fontSize:      11,
    letterSpacing: '0.08em',
    color:         'var(--gold)',
    background:    'rgba(201,168,76,0.12)',
    border:        '1px solid var(--gold-dim)',
    borderRadius:  4,
    padding:       '4px 10px',
    cursor:        'pointer',
    marginLeft:    8,
  },
  adminLink: {
    fontFamily:    'var(--font-title)',
    fontSize:      11,
    letterSpacing: '0.08em',
    color:         'var(--gold-dim)',
    textDecoration:'none',
    border:        '1px solid var(--gold-dim)',
    borderRadius:  4,
    padding:       '4px 10px',
    opacity:       0.7,
    marginLeft:    8,
  },
};

const S: Record<string, React.CSSProperties> = {
  page:            { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 20px 40px', position: 'relative', zIndex: 1 },
  hero:            { textAlign: 'center', padding: '36px 0 24px', width: '100%', maxWidth: 1100 },
  logoWrap:        { display: 'flex', justifyContent: 'center', marginBottom: 10 },
  heroDivider:     { height: 1, background: 'linear-gradient(90deg, transparent, var(--gold), transparent)', margin: '10px auto', width: 400 },
  heroTitle:       { fontFamily: 'var(--font-title)', fontSize: 'clamp(26px, 4vw, 50px)', color: 'var(--gold-bright)', letterSpacing: '0.1em', textShadow: '0 0 28px rgba(201,168,76,0.35), 2px 2px 0 rgba(0,0,0,0.8)', margin: '6px 0' },
  userMenuWrap:    { display: 'flex', justifyContent: 'center', marginTop: 16 },
  layout:          { display: 'flex', gap: 24, width: '100%', maxWidth: 1100, alignItems: 'flex-start', flexWrap: 'wrap' as const },
  panel:           { flex: 1, minWidth: 320, background: 'linear-gradient(160deg, rgba(22,92,56,0.6), rgba(10,51,32,0.8))', border: '1px solid var(--gold-dim)', borderRadius: 12, padding: '24px 28px', boxShadow: 'var(--shadow), var(--inset)', overflowY: 'auto' as const, maxHeight: '75vh' },
  panelHeader:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  panelTitle:      { fontFamily: 'var(--font-title)', fontSize: 13, letterSpacing: '0.4em', color: 'var(--gold)', textAlign: 'center', display: 'flex', alignItems: 'center', gap: 10, margin: 0 },
  titleLine:       { flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, var(--gold-dim))' },
  createToggleBtn: { fontFamily: 'var(--font-title)', fontSize: 10, letterSpacing: '0.06em', padding: '6px 12px', background: 'rgba(201,168,76,0.15)', border: '1px solid var(--gold-dim)', borderRadius: 5, color: 'var(--gold)', cursor: 'pointer' },
  legend:          { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' as const },
  legendItem:      { display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--cream-dim)' },
  legendDot:       { display: 'inline-block', width: 9, height: 9, borderRadius: '50%', flexShrink: 0 },
  roomGrid:        { display: 'flex', flexDirection: 'column' as const, gap: 9 },
  roomCard:        { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--gold-dim)', borderLeft: '4px solid transparent', borderRadius: 8, cursor: 'pointer', color: 'var(--cream)', transition: 'all 0.2s', width: '100%' },
  roomCardActive:  { background: 'rgba(201,168,76,0.14)', borderColor: 'var(--gold)', boxShadow: '0 0 12px rgba(201,168,76,0.22)' },
  modeBadge:       { display: 'inline-block', fontSize: 10, fontFamily: 'var(--font-title)', padding: '2px 6px', borderRadius: 3, letterSpacing: '0.04em' },
  lockIcon:        { fontSize: 12 },
  userRoomBadge:   { fontSize: 9, fontFamily: 'var(--font-title)', padding: '2px 5px', borderRadius: 3, background: 'rgba(255,255,255,0.1)', color: 'var(--cream-dim)', border: '1px solid rgba(255,255,255,0.15)' },
  zoomBadge:       { fontSize: 9, fontFamily: 'var(--font-title)', padding: '2px 6px', borderRadius: 3, background: 'rgba(100,220,80,0.18)', color: '#88ee66', border: '1px solid rgba(100,220,80,0.4)', letterSpacing: '0.04em' },
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
  tournamentSection: { width: '100%', maxWidth: 1100, marginBottom: 20, background: 'linear-gradient(160deg, rgba(22,92,56,0.6), rgba(10,51,32,0.8))', border: '1px solid var(--gold-dim)', borderRadius: 12, padding: '20px 28px', boxShadow: 'var(--shadow)' },
  tournamentGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginTop: 14 },
  tournamentCard:    { background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '14px 16px' },
  tournamentName:    { fontFamily: 'var(--font-title)', fontSize: 15, color: 'var(--cream)', letterSpacing: '0.04em', marginBottom: 8 },
  testBadge:         { fontFamily: 'var(--font-title)', fontSize: 9, letterSpacing: '0.06em', color: '#e8a020', border: '1px solid #a06010', borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' as const },
  tournamentMeta:    { display: 'flex', flexWrap: 'wrap' as const, gap: '4px 16px', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--cream-dim)' },
  footer:          { marginTop: 40, textAlign: 'center' },
  suitRow:         { fontFamily: 'var(--font-body)', fontSize: 24, color: 'var(--gold-dim)', letterSpacing: 18 },
  loginPrompt:     { background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', display: 'flex', flexDirection: 'column' as const, gap: 8, alignItems: 'flex-start' },
  loginPromptText: { color: 'var(--cream-dim)', fontSize: 14, fontFamily: 'var(--font-body)', margin: 0 },
  setupPromptBtn:  { background: 'rgba(201,168,76,0.2)', border: '1px solid var(--gold-dim)', borderRadius: 5, color: 'var(--gold)', fontSize: 13, cursor: 'pointer', padding: '6px 12px', fontFamily: 'var(--font-title)' },
  nicknameDisplay: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' },
  nicknameText:    { color: 'var(--cream)', fontSize: 20, fontFamily: 'var(--font-body)', fontWeight: 600 },
};
