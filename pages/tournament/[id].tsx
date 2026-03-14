/**
 * pages/tournament/[id].tsx — トーナメントロビー
 *
 * 機能:
 *   - トーナメント詳細表示
 *   - 参加登録・キャンセル
 *   - 参加者一覧（リアルタイム更新）
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import Head from 'next/head';
import { socket, connectWithAuth } from '../../socket';

interface Tournament {
  id:                  string;
  name:                string;
  mode:                string;
  scheduled_start_at:  string;
  status:              string;
  starting_chips:      number;
  max_players:         number | null;
  blind_schedule_name: string | null;
  blind_levels:        unknown;
  blind_description:   string | null;
  is_test:             boolean;
}

interface Entry {
  account_id:    string;
  registered_at: string;
  nickname:      string | null;
  google_name:   string | null;
}

const MODE_LABEL: Record<string, string> = {
  '27': '2-7 Triple Draw', badugi: 'Badugi', mix: 'Mix',
};

const STATUS_LABEL: Record<string, string> = {
  registering: '参加受付中', running: '進行中', finished: '終了', cancelled: 'キャンセル',
};

export default function TournamentLobby() {
  const router               = useRouter();
  const { id }               = router.query;
  const { data: session, status } = useSession();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [entries,    setEntries]    = useState<Entry[]>([]);
  const [registered, setRegistered] = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [actionMsg,  setActionMsg]  = useState('');
  const [busy,       setBusy]       = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);

  // ===== データ取得 =====
  const fetchData = useCallback(async () => {
    if (!id) return;
    try {
      const res  = await fetch(`/api/tournament/${id}/entry`);
      if (res.status === 401) { setLoading(false); return; }
      const data = await res.json();
      setTournament(data.tournament);
      setEntries(data.entries ?? []);
      setRegistered(data.registered ?? false);

      // すでに running なら即座に draw ページへ遷移（開始通知を受け取れなかった場合の対策）
      if (data.tournament?.status === 'running' && data.registered) {
        router.replace(`/tournament/${id}/draw`);
        return;
      }
    } catch {
      setActionMsg('データの取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (status === 'loading' || !id) return;
    fetchData();
    // 30秒ごとに自動更新
    const timer = setInterval(fetchData, 30000);
    return () => clearInterval(timer);
  }, [id, status, fetchData]);

  // ===== Socket.IO：トーナメント開始通知を受け取りdrawページへ遷移 =====
  useEffect(() => {
    if (!id || typeof id !== 'string') return;

    const onTournamentStarting = ({ tournamentId, tableId }: { tournamentId: string; tableId: string }) => {
      if (tournamentId !== id) return;
      // 自分が参加登録しているトーナメントが開始 → ゲーム画面へ
      router.push(`/tournament/${tournamentId}/draw`);
    };

    socket.on('t:tournamentStarting', onTournamentStarting);

    // 未接続なら接続する
    if (!socket.connected) connectWithAuth();

    return () => {
      socket.off('t:tournamentStarting', onTournamentStarting);
    };
  }, [id]);

  // ===== 参加登録 =====
  const handleRegister = async () => {
    if (!session) { router.push('/'); return; }
    setBusy(true); setActionMsg('');
    const res  = await fetch(`/api/tournament/${id}/entry`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { setActionMsg(data.error); setBusy(false); return; }
    setEntries(data.entries);
    setRegistered(true);
    setActionMsg('✅ 参加登録しました');
    setBusy(false);
  };

  // ===== キャンセル =====
  const handleCancel = () => setShowCancelModal(true);

  const handleCancelConfirm = async () => {
    setShowCancelModal(false);
    setBusy(true); setActionMsg('');
    const res  = await fetch(`/api/tournament/${id}/entry`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { setActionMsg(data.error); setBusy(false); return; }
    setEntries(data.entries);
    setRegistered(false);
    setActionMsg('登録をキャンセルしました');
    setBusy(false);
  };

  // ===== ローディング =====
  if (loading) {
    return <div style={S.loading}>読み込み中...</div>;
  }

  if (!tournament) {
    return (
      <div style={S.loading}>
        <p>トーナメントが見つかりません</p>
        <button style={S.backBtn} onClick={() => router.push('/')}>← ロビーへ戻る</button>
      </div>
    );
  }

  const isRegistering = tournament.status === 'registering';
  const isFull        = tournament.max_players !== null && entries.length >= tournament.max_players;
  const canRegister   = isRegistering && !registered && !isFull && !!session?.user?.accountId;
  const canCancel     = isRegistering && registered;

  return (
    <>
      <Head><title>{tournament.name} — Poker Room Pastis</title></Head>
      <div style={S.page}>
        {/* ヘッダー */}
        <header style={S.header}>
          <button style={S.backBtn} onClick={() => router.push('/')}>← ロビーへ</button>
          {tournament.is_test && <span style={S.testBadge}>テスト</span>}
        </header>

        <div style={S.container}>
          {/* トーナメント情報 */}
          <section style={S.card}>
            <div style={S.titleRow}>
              <h1 style={S.title}>{tournament.name}</h1>
              <span style={statusStyle(tournament.status)}>{STATUS_LABEL[tournament.status] ?? tournament.status}</span>
            </div>

            <div style={S.infoGrid}>
              <InfoItem label="ゲームモード"  value={MODE_LABEL[tournament.mode] ?? tournament.mode} />
              <InfoItem label="開始日時"      value={new Date(tournament.scheduled_start_at).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} />
              <InfoItem label="開始チップ"    value={`${tournament.starting_chips.toLocaleString()} chips`} />
              <InfoItem label="参加人数"      value={tournament.max_players ? `${entries.length} / ${tournament.max_players}人` : `${entries.length}人（無制限）`} />
              {tournament.blind_schedule_name && (
                <InfoItem label="ブラインド" value={tournament.blind_schedule_name} />
              )}
            </div>

            {/* 参加ボタン */}
            <div style={S.actionRow}>
              {!session?.user?.accountId && isRegistering && (
                <p style={S.loginNote}>参加登録にはログインが必要です</p>
              )}
              {canRegister && (
                <button style={S.registerBtn} onClick={handleRegister} disabled={busy}>
                  {busy ? '処理中...' : '参加登録する'}
                </button>
              )}
              {canCancel && (
                <button style={S.cancelBtn} onClick={handleCancel} disabled={busy}>
                  {busy ? '処理中...' : '登録をキャンセル'}
                </button>
              )}
              {registered && !isRegistering && (
                <p style={{ color: 'var(--gold)', fontFamily: 'var(--font-title)', fontSize: 14 }}>✅ 参加登録済み</p>
              )}
              {isFull && !registered && isRegistering && (
                <p style={{ color: '#ee8888', fontFamily: 'var(--font-title)', fontSize: 14 }}>定員に達しました</p>
              )}
              {actionMsg && (
                <p style={{ color: actionMsg.startsWith('✅') ? '#88ee88' : '#ee8888', fontSize: 14, margin: 0 }}>{actionMsg}</p>
              )}
            </div>
          </section>

          {/* 参加者一覧 */}
          <section style={S.card}>
            <h2 style={S.sectionTitle}>
              参加者一覧
              <span style={S.entryCount}>{entries.length}{tournament.max_players ? ` / ${tournament.max_players}` : ''}人</span>
            </h2>
            {entries.length === 0 ? (
              <p style={{ color: 'var(--cream-dim)', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>まだ参加者がいません</p>
            ) : (
              <div style={S.entryGrid}>
                {entries.map((e, i) => (
                  <div key={e.account_id} style={{ ...S.entryCard, ...(e.account_id === session?.user?.accountId ? S.entryCardSelf : {}) }}>
                    <span style={S.entryRank}>#{i + 1}</span>
                    <span style={S.entryName}>{e.nickname ?? e.google_name ?? '名無し'}</span>
                    {e.account_id === session?.user?.accountId && (
                      <span style={S.youBadge}>YOU</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
      {/* ===== キャンセル確認モーダル ===== */}
      {showCancelModal && (
        <div style={S.overlay} onClick={() => setShowCancelModal(false)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalSuit}>♠</div>
            <h2 style={S.modalTitle}>参加登録のキャンセル</h2>
            <p style={S.modalBody}>
              <strong style={{ color: 'var(--gold)' }}>{tournament.name}</strong> への<br />
              参加登録をキャンセルしますか？
            </p>
            <div style={S.modalButtons}>
              <button style={S.modalCancelBtn} onClick={() => setShowCancelModal(false)}>
                戻る
              </button>
              <button style={S.modalConfirmBtn} onClick={handleCancelConfirm}>
                キャンセルする
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontFamily: 'var(--font-title)', fontSize: 10, color: 'var(--gold-dim)', letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--cream)' }}>{value}</span>
    </div>
  );
}

function statusStyle(s: string): React.CSSProperties {
  const color = { registering: '#88bbee', running: '#88ee88', finished: '#aaa', cancelled: '#ee8888' }[s] ?? '#aaa';
  return { fontFamily: 'var(--font-title)', fontSize: 11, letterSpacing: '0.06em', color, border: `1px solid ${color}`, borderRadius: 4, padding: '3px 10px' };
}

const S: Record<string, React.CSSProperties> = {
  page:         { minHeight: '100vh', background: 'var(--felt)', padding: '0 0 60px' },
  loading:      { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--cream-dim)', fontFamily: 'var(--font-title)', fontSize: 18, gap: 16 },
  header:       { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 32px', borderBottom: '1px solid var(--gold-dim)' },
  backBtn:      { background: 'transparent', border: '1px solid var(--gold-dim)', color: 'var(--cream-dim)', borderRadius: 5, padding: '6px 14px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-title)' },
  testBadge:    { fontFamily: 'var(--font-title)', fontSize: 10, color: '#e8a020', border: '1px solid #a06010', borderRadius: 3, padding: '2px 8px' },
  container:    { maxWidth: 800, margin: '0 auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 20 },
  card:         { background: 'linear-gradient(160deg, rgba(22,92,56,0.6), rgba(10,51,32,0.8))', border: '1px solid var(--gold-dim)', borderRadius: 12, padding: '24px 28px', boxShadow: '0 4px 24px rgba(0,0,0,0.4)' },
  titleRow:     { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20, flexWrap: 'wrap' },
  title:        { fontFamily: 'var(--font-title)', fontSize: 22, color: 'var(--gold)', letterSpacing: '0.06em', margin: 0, flex: 1 },
  infoGrid:     { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '16px 24px', marginBottom: 24 },
  actionRow:    { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
  loginNote:    { fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--cream-dim)', margin: 0 },
  registerBtn:  { background: 'linear-gradient(135deg, var(--gold), var(--gold-dim))', border: 'none', borderRadius: 6, color: '#1a1200', fontSize: 14, fontWeight: 700, padding: '10px 28px', cursor: 'pointer', fontFamily: 'var(--font-title)', letterSpacing: '0.06em' },
  cancelBtn:    { background: 'transparent', border: '1px solid #ee8888', color: '#ee8888', borderRadius: 6, fontSize: 13, padding: '9px 20px', cursor: 'pointer', fontFamily: 'var(--font-title)' },
  sectionTitle: { fontFamily: 'var(--font-title)', fontSize: 14, color: 'var(--gold)', letterSpacing: '0.08em', margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 10 },
  entryCount:   { fontFamily: 'var(--font-body)', fontSize: 16, color: 'var(--cream-dim)', fontWeight: 'normal' },
  entryGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 },
  entryCard:    { background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(201,168,76,0.15)', borderRadius: 6, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 },
  entryCardSelf:{ border: '1px solid var(--gold)', background: 'rgba(201,168,76,0.08)' },
  entryRank:    { fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold-dim)', minWidth: 24 },
  entryName:    { fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--cream)', flex: 1 },
  youBadge:     { fontFamily: 'var(--font-title)', fontSize: 9, color: 'var(--gold)', border: '1px solid var(--gold)', borderRadius: 3, padding: '1px 5px', letterSpacing: '0.06em' },
  overlay:      { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' },
  modal:        { background: 'linear-gradient(160deg, #0e4a28, #061e10)', border: '1px solid var(--gold)', borderRadius: 14, padding: '36px 40px', maxWidth: 380, width: '90%', textAlign: 'center', boxShadow: '0 8px 48px rgba(0,0,0,0.8), inset 0 1px 0 rgba(201,168,76,0.2)' },
  modalSuit:    { fontSize: 36, color: 'var(--gold-dim)', marginBottom: 12, lineHeight: 1 },
  modalTitle:   { fontFamily: 'var(--font-title)', fontSize: 18, color: 'var(--gold)', letterSpacing: '0.08em', margin: '0 0 16px' },
  modalBody:    { fontFamily: 'var(--font-body)', fontSize: 16, color: 'var(--cream)', lineHeight: 1.7, margin: '0 0 28px' },
  modalButtons: { display: 'flex', gap: 12, justifyContent: 'center' },
  modalCancelBtn:  { background: 'transparent', border: '1px solid var(--gold-dim)', color: 'var(--cream-dim)', borderRadius: 6, padding: '10px 24px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-title)', letterSpacing: '0.06em' },
  modalConfirmBtn: { background: 'linear-gradient(135deg, #8b2020, #5a1010)', border: '1px solid #cc4444', color: '#ffcccc', borderRadius: 6, padding: '10px 24px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-title)', letterSpacing: '0.06em', fontWeight: 700 },
};
