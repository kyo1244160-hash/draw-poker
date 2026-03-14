/**
 * pages/admin/index.tsx — 管理画面
 *
 * タブ構成:
 *   - ユーザー管理
 *   - トーナメント管理
 */

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../api/auth/[...nextauth]';

// ===== 型定義 =====
interface User {
  id: string;
  email: string;
  google_name: string | null;
  created_at: string;
  nickname: string | null;
  change_count: number | null;
  total_points: number | null;
}

interface Tournament {
  id: string;
  name: string;
  mode: string;
  scheduled_start_at: string;
  status: string;
  starting_chips: number;
  max_players: number | null;
  blind_schedule_name: string | null;
  entry_count: number;
  is_test: boolean;
}

interface TournamentResult {
  accountId:  string;
  finalRank:  number;
  finalChips: number;
}

interface BlindSchedule {
  id: string;
  name: string;
  description: string | null;
}

type Tab = 'users' | 'tournaments' | 'bots';

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [tab,           setTab]           = useState<Tab>('users');
  const [users,         setUsers]         = useState<User[]>([]);
  const [tournaments,   setTournaments]   = useState<Tournament[]>([]);
  const [schedules,     setSchedules]     = useState<BlindSchedule[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');

  // トーナメント作成フォーム
  const [form, setForm] = useState({
    name:             '',
    mode:             '27',
    scheduledStartAt: '',
    startingChips:    5000,
    maxPlayers:       '',
    blindScheduleId:  '',
    isTest:           false,
  });
  // 結果登録
  const [resultTournamentId, setResultTournamentId] = useState('');
  const [resultRows, setResultRows]   = useState<TournamentResult[]>([
    { accountId: '', finalRank: 1, finalChips: 0 },
  ]);
  const [resultMsg,  setResultMsg]    = useState('');
  const [submitting, setSubmitting]   = useState(false);

  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState('');

  // ボット管理
  interface BotInfo { id: number; roomId: string; name: string; connected: boolean; isFastFold?: boolean; }
  const [bots,        setBots]       = useState<BotInfo[]>([]);
  const [ffBots,      setFfBots]     = useState<BotInfo[]>([]);
  const [botRoomId,   setBotRoomId]  = useState('27-room-1');
  const [botCount,    setBotCount]   = useState(1);
  const [botMsg,      setBotMsg]     = useState('');

  // FastFoldボット
  const [ffPoolId,    setFfPoolId]   = useState('zoom-27');
  const [ffCount,     setFfCount]    = useState(1);
  const [ffMsg,       setFfMsg]      = useState('');

  // adminMonitor API用：Bearer tokenを自動付与するfetch
  const authFetch = async (url: string, opts: RequestInit = {}) => {
    const tokenRes = await fetch('/api/auth/socket-token');
    if (!tokenRes.ok) throw new Error('トークン取得失敗');
    const { token } = await tokenRes.json();
    return fetch(url, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers ?? {}),
      },
    });
  };

  const fetchBots = () => {
    authFetch('/api/admin/monitor/bots')
      .then((r) => r.json())
      .then((d) => { setBots(d.bots ?? []); setFfBots(d.fastFoldBots ?? []); })
      .catch(() => {});
  };

  const handleAddBot = async () => {
    setBotMsg('');
    try {
      const res = await authFetch('/api/admin/monitor/bots', {
        method: 'POST',
        body: JSON.stringify({ roomId: botRoomId, count: botCount }),
      });
      const d = await res.json();
      if (res.ok) { setBotMsg(`✅ ボット ${d.added.length}体 追加`); fetchBots(); }
      else setBotMsg(`❌ ${d.error}`);
    } catch { setBotMsg('❌ 認証エラー'); }
  };

  const handleAddFfBot = async () => {
    setFfMsg('');
    try {
      const res = await authFetch('/api/admin/monitor/fastfold-bots', {
        method: 'POST',
        body: JSON.stringify({ poolId: ffPoolId, count: ffCount }),
      });
      const d = await res.json();
      if (res.ok) { setFfMsg(`✅ FastFoldボット ${d.added.length}体 追加`); fetchBots(); }
      else setFfMsg(`❌ ${d.error}`);
    } catch { setFfMsg('❌ 認証エラー'); }
  };

  const handleRemoveFfBots = async (poolId: string) => {
    await authFetch('/api/admin/monitor/fastfold-bots', {
      method: 'DELETE',
      body: JSON.stringify({ poolId }),
    });
    fetchBots();
  };

  const handleRemoveBot = async (botId: number) => {
    await authFetch(`/api/admin/monitor/bots/${botId}`, { method: 'DELETE' });
    fetchBots();
  };

  const handleRemoveAllBots = async (roomId: string) => {
    await authFetch('/api/admin/monitor/bots', {
      method: 'DELETE',
      body: JSON.stringify({ roomId }),
    });
    fetchBots();
  };

  // リングボット名編集
  const [editingBotId, setEditingBotId] = useState<number | null>(null);
  const [editingBotName, setEditingBotName] = useState('');
  const handleRenameBot = async (botId: number) => {
    if (!editingBotName.trim()) return;
    await authFetch(`/api/admin/monitor/bots/${botId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: editingBotName.trim() }),
    });
    setEditingBotId(null);
    fetchBots();
  };

  // ボットタブ選択時にリストを更新
  useEffect(() => { if (tab === 'bots') fetchBots(); }, [tab]);

  // トーナメントBOT管理
  interface TBotTable { tableId: string; playerCount: number; bots: { id: string; name: string; chips: number; tableId: string }[]; }
  const [tBotPanel,     setTBotPanel]    = useState<string | null>(null); // 展開中のtournamentId
  const [tBotTables,    setTBotTables]   = useState<TBotTable[]>([]);
  const [tBotCount,     setTBotCount]    = useState(1);
  const [tBotTableId,   setTBotTableId]  = useState(''); // ''=全テーブル
  const [tBotMsg,       setTBotMsg]      = useState('');

  const fetchTBots = async (tournamentId: string) => {
    try {
      const res = await authFetch(`/api/admin/monitor/tournament-bots/${tournamentId}`);
      const d = await res.json();
      setTBotTables(d.tables ?? []);
    } catch { setTBotTables([]); }
  };

  const toggleTBotPanel = (tournamentId: string) => {
    if (tBotPanel === tournamentId) { setTBotPanel(null); return; }
    setTBotPanel(tournamentId);
    setTBotMsg('');
    setTBotTableId('');
    fetchTBots(tournamentId);
  };

  const handleAddTBot = async (tournamentId: string) => {
    setTBotMsg('');
    const body: Record<string, unknown> = { count: tBotCount };
    if (tBotTableId) body.tableId = tBotTableId;
    try {
      const res = await authFetch(`/api/admin/monitor/tournament-bots/${tournamentId}/add`, {
        method: 'POST', body: JSON.stringify(body),
      });
      const d = await res.json();
      if (res.ok) { setTBotMsg(`✅ BOT ${d.added.length}体 追加`); fetchTBots(tournamentId); }
      else setTBotMsg(`❌ ${d.error}`);
    } catch { setTBotMsg('❌ エラー'); }
  };

  const handleRemoveTBot = async (tournamentId: string, tableId: string, botId?: string) => {
    const body: Record<string, unknown> = { tableId };
    if (botId) body.botId = botId;
    await authFetch(`/api/admin/monitor/tournament-bots/${tournamentId}/remove`, {
      method: 'DELETE', body: JSON.stringify(body),
    });
    fetchTBots(tournamentId);
  };

  // トーナメントBOT名編集
  const [editingTBotId, setEditingTBotId] = useState<string | null>(null);
  const [editingTBotName, setEditingTBotName] = useState('');
  const handleRenameTBot = async (tournamentId: string, tableId: string, botId: string) => {
    if (!editingTBotName.trim()) return;
    await authFetch(`/api/admin/monitor/tournament-bots/${tournamentId}/rename`, {
      method: 'PATCH',
      body: JSON.stringify({ tableId, botId, name: editingTBotName.trim() }),
    });
    setEditingTBotId(null);
    fetchTBots(tournamentId);
  };

  // トーナメント削除
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const handleDeleteTournament = async (tournamentId: string) => {
    setDeleting(true);
    try {
      const res = await fetch('/api/admin/tournaments', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId }),
      });
      const d = await res.json();
      if (res.ok) {
        setTournaments((prev) => prev.filter((t) => t.id !== tournamentId));
      } else {
        alert(`削除エラー: ${d.error}`);
      }
    } catch {
      alert('通信エラーが発生しました');
    } finally {
      setDeleting(false);
      setDeleteConfirmId(null);
    }
  };

  // ===== 権限チェック =====
  useEffect(() => {
    if (status === 'loading') return;
    if (status === 'unauthenticated') { router.replace('/'); return; }
    // 管理者かチェック
    fetch('/api/admin/users')
      .then((r) => { if (r.status === 403) router.replace('/'); })
      .catch(() => router.replace('/'));
  }, [status]);

  // ===== データ取得 =====
  useEffect(() => {
    if (status !== 'authenticated') return;
    Promise.all([
      fetch('/api/admin/users').then((r) => r.json()),
      fetch('/api/admin/tournaments').then((r) => r.json()),
      fetch('/api/admin/tournaments?type=schedules').then((r) => r.json()),
    ]).then(([u, t, s]) => {
      setUsers(u.users ?? []);
      setTournaments(t.tournaments ?? []);
      setSchedules(s.schedules ?? []);
      setLoading(false);
    }).catch(() => setError('データの取得に失敗しました'));
  }, [status]);

  // ===== トーナメント作成 =====
  const handleCreate = async () => {
    if (!form.name.trim() || !form.scheduledStartAt) {
      setCreateMsg('名前と開始日時は必須です');
      return;
    }
    setCreating(true);
    setCreateMsg('');
    try {
      const res = await fetch('/api/admin/tournaments', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:             form.name.trim(),
          mode:             form.mode,
          scheduledStartAt: new Date(form.scheduledStartAt).toISOString(),
          startingChips:    Number(form.startingChips),
          maxPlayers:       form.maxPlayers ? Number(form.maxPlayers) : undefined,
          blindScheduleId:  form.blindScheduleId || undefined,
          isTest:           form.isTest,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateMsg(data.error ?? '作成失敗'); return; }
      setTournaments((prev) => [data.tournament, ...prev]);
      setCreateMsg('✅ トーナメントを作成しました');
      setForm({ name: '', mode: '27', scheduledStartAt: '', startingChips: 5000, maxPlayers: '', blindScheduleId: '', isTest: false });
    } catch {
      setCreateMsg('通信エラーが発生しました');
    } finally {
      setCreating(false);
    }
  };

  // ===== ステータス変更 =====
  const handleStatusChange = async (tournamentId: string, status: string) => {
    const res = await fetch('/api/admin/tournaments', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId, status }),
    });
    if (res.ok) {
      setTournaments((prev) => prev.map((t) => t.id === tournamentId ? { ...t, status } : t));
    }
  };

  // トーナメントをサーバーメモリ上で開始（DBがrunning/registering→メモリにロード）
  const [startingId, setStartingId] = useState<string | null>(null);
  const [startMsg,   setStartMsg]   = useState<Record<string, string>>({});
  const handleStart = async (tournamentId: string) => {
    setStartingId(tournamentId);
    setStartMsg((prev) => ({ ...prev, [tournamentId]: '' }));
    try {
      const res = await authFetch(`/api/admin/monitor/tournaments/${tournamentId}/start`, { method: 'POST' });
      const d = await res.json();
      if (res.ok) {
        setStartMsg((prev) => ({ ...prev, [tournamentId]: `✅ 開始 (${d.tableCount}テーブル/${d.playerCount}人)` }));
        setTournaments((prev) => prev.map((t) => t.id === tournamentId ? { ...t, status: 'running' } : t));
      } else {
        const msg: Record<string, string> = {
          ALREADY_RUNNING: '既にメモリ上で稼働中です',
          INVALID_STATUS:  `ステータスが不正です (${d.status})`,
          NOT_ENOUGH_PLAYERS: `参加者が不足しています (${d.count}人。自分1人で参加登録してから開始できます)`,
          START_FAILED:    'テーブル作成に失敗しました',
        };
        setStartMsg((prev) => ({ ...prev, [tournamentId]: `❌ ${msg[d.error] ?? d.error}` }));
      }
    } catch {
      setStartMsg((prev) => ({ ...prev, [tournamentId]: '❌ 通信エラー' }));
    } finally {
      setStartingId(null);
    }
  };

  const handleSubmitResults = async () => {
    if (!resultTournamentId) { setResultMsg('トーナメントを選択してください'); return; }
    const validRows = resultRows.filter((r) => r.accountId.trim());
    if (validRows.length === 0) { setResultMsg('参加者を入力してください'); return; }
    setSubmitting(true); setResultMsg('');
    try {
      const res = await fetch('/api/admin/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId: resultTournamentId, results: validRows }),
      });
      const data = await res.json();
      if (!res.ok) { setResultMsg(data.error ?? '登録失敗'); return; }
      setResultMsg('✅ 結果を登録しポイントを付与しました');
      setTournaments((prev) => prev.map((t) => t.id === resultTournamentId ? { ...t, status: 'finished' } : t));
      setResultRows([{ accountId: '', finalRank: 1, finalChips: 0 }]);
    } catch { setResultMsg('通信エラー'); }
    finally { setSubmitting(false); }
  };

  const statusLabel = (s: string) => ({ registering: '受付中', running: '進行中', finished: '終了', cancelled: 'キャンセル' }[s] ?? s);
  const statusColor = (s: string) => ({ registering: '#88bbee', running: '#88ee88', finished: '#aaa', cancelled: '#ee8888' }[s] ?? '#aaa');
  const modeLabel   = (m: string) => ({ '27': '2-7 Triple Draw', badugi: 'Badugi', mix: 'Mix' }[m] ?? m);

  if (loading) return <div style={S.loading}>読み込み中...</div>;
  if (error)   return <div style={S.loading}>{error}</div>;

  return (
    <>
      <Head><title>管理画面 — Poker Room Pastis</title></Head>
      <div style={S.page}>
        {/* ヘッダー */}
        <header style={S.header}>
          <h1 style={S.headerTitle}>⚙ 管理画面</h1>
          <span style={S.adminBadge}>♠ {session?.user?.nickname}</span>
          <button style={S.backBtn} onClick={() => router.push('/')}>← ロビーへ</button>
        </header>

        {/* タブ */}
        <div style={S.tabs}>
          {(['users', 'tournaments', 'bots'] as Tab[]).map((t) => (
            <button key={t} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }} onClick={() => setTab(t)}>
              {t === 'users' ? `👥 ユーザー (${users.length})`
                : t === 'tournaments' ? `🏆 トーナメント (${tournaments.length})`
                : `🤖 ボット (${bots.length})`}
            </button>
          ))}
        </div>

        {/* ===== ユーザー管理 ===== */}
        {tab === 'users' && (
          <div style={S.section}>
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['ニックネーム', 'Google名', 'メール', 'ポイント', '変更回数', '登録日'].map((h) => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={S.tr}>
                    <td style={S.td}>{u.nickname ?? <span style={{ color: '#888' }}>未設定</span>}</td>
                    <td style={S.td}>{u.google_name ?? '-'}</td>
                    <td style={{ ...S.td, fontSize: 12, color: 'var(--cream-dim)' }}>{u.email}</td>
                    <td style={{ ...S.td, textAlign: 'center' }}>{u.total_points ?? 0}</td>
                    <td style={{ ...S.td, textAlign: 'center' }}>{u.change_count ?? 0}</td>
                    <td style={{ ...S.td, fontSize: 12, color: 'var(--cream-dim)' }}>
                      {new Date(u.created_at).toLocaleDateString('ja-JP')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* ===== トーナメント管理 ===== */}
        {tab === 'tournaments' && (
          <div style={S.section}>
            {/* 作成フォーム */}
            <div style={S.card}>
              <h2 style={S.cardTitle}>＋ トーナメント作成</h2>
              <div style={S.formGrid}>
                <label style={S.label}>
                  名前 *
                  <input style={S.input} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="例: 第1回 Pastisカップ" />
                </label>
                <label style={S.label}>
                  ゲームモード
                  <select style={S.input} value={form.mode} onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}>
                    <option value="27">2-7 Triple Draw</option>
                    <option value="badugi">Badugi</option>
                    <option value="mix">Mix</option>
                  </select>
                </label>
                <label style={S.label}>
                  開始日時 *
                  <input style={S.input} type="datetime-local" value={form.scheduledStartAt} onChange={(e) => setForm((f) => ({ ...f, scheduledStartAt: e.target.value }))} />
                </label>
                <label style={S.label}>
                  開始チップ
                  <input style={S.input} type="number" value={form.startingChips} min={100} max={1000000} onChange={(e) => setForm((f) => ({ ...f, startingChips: Number(e.target.value) }))} />
                </label>
                <label style={S.label}>
                  最大人数（空白=無制限）
                  <input style={S.input} type="number" value={form.maxPlayers} min={2} max={100} onChange={(e) => setForm((f) => ({ ...f, maxPlayers: e.target.value }))} placeholder="例: 16" />
                </label>
                <label style={S.label}>
                  ブラインドスケジュール
                  <select style={S.input} value={form.blindScheduleId} onChange={(e) => setForm((f) => ({ ...f, blindScheduleId: e.target.value }))}>
                    <option value="">なし</option>
                    {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label style={{ ...S.label, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={form.isTest} onChange={(e) => setForm((f) => ({ ...f, isTest: e.target.checked }))} />
                  テスト用トーナメント
                </label>
              </div>
              {createMsg && <p style={{ color: createMsg.startsWith('✅') ? '#88ee88' : '#ee8888', fontSize: 14, marginTop: 8 }}>{createMsg}</p>}
              <button style={S.createBtn} onClick={handleCreate} disabled={creating}>
                {creating ? '作成中...' : '作成する'}
              </button>
            </div>

            {/* 結果登録フォーム */}
            <div style={S.card}>
              <h2 style={S.cardTitle}>🏅 結果登録・ポイント付与</h2>
              <p style={{ color: 'var(--cream-dim)', fontSize: 13, margin: 0 }}>
                ポイント配分: 1位 100pt / 2位 60pt / 3位 40pt / 4位 25pt / 5位 15pt / 6位以下 0pt
              </p>
              <label style={S.label}>
                対象トーナメント
                <select style={S.input} value={resultTournamentId} onChange={(e) => setResultTournamentId(e.target.value)}>
                  <option value="">選択してください</option>
                  {tournaments.filter((t) => t.status !== 'finished' && t.status !== 'cancelled').map((t) => (
                    <option key={t.id} value={t.id}>{t.name}（{statusLabel(t.status)}）</option>
                  ))}
                </select>
              </label>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 100px', gap: 6, fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold-dim)', letterSpacing: '0.06em' }}>
                  <span>順位</span><span>account_id</span><span>最終Chip</span>
                </div>
                {resultRows.map((row, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 100px 30px', gap: 6, alignItems: 'center' }}>
                    <input style={S.input} type="number" min={1} value={row.finalRank}
                      onChange={(e) => setResultRows((prev) => prev.map((r, j) => j === i ? { ...r, finalRank: Number(e.target.value) } : r))} />
                    <input style={S.input} value={row.accountId} placeholder="account_id"
                      onChange={(e) => setResultRows((prev) => prev.map((r, j) => j === i ? { ...r, accountId: e.target.value } : r))} />
                    <input style={S.input} type="number" min={0} value={row.finalChips}
                      onChange={(e) => setResultRows((prev) => prev.map((r, j) => j === i ? { ...r, finalChips: Number(e.target.value) } : r))} />
                    <button style={{ background: 'transparent', border: '1px solid #555', borderRadius: 4, color: '#aaa', cursor: 'pointer', fontSize: 16 }}
                      onClick={() => setResultRows((prev) => prev.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
                <button style={{ ...S.createBtn, background: 'rgba(201,168,76,0.15)', color: 'var(--gold)', border: '1px solid var(--gold-dim)', fontSize: 12, padding: '6px 14px' }}
                  onClick={() => setResultRows((prev) => [...prev, { accountId: '', finalRank: prev.length + 1, finalChips: 0 }])}>
                  ＋ 行を追加
                </button>
              </div>
              {resultMsg && <p style={{ color: resultMsg.startsWith('✅') ? '#88ee88' : '#ee8888', fontSize: 13, margin: 0 }}>{resultMsg}</p>}
              <button style={S.createBtn} onClick={handleSubmitResults} disabled={submitting}>
                {submitting ? '登録中...' : 'ポイントを付与する'}
              </button>
            </div>

            {/* 一覧 */}
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['名前', 'モード', '開始日時', 'ステータス', '参加者', 'チップ', 'テスト', '操作'].map((h) => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tournaments.map((t) => (
                  <>
                  <tr key={t.id} style={S.tr}>
                    <td style={S.td}>{t.name}</td>
                    <td style={S.td}>{modeLabel(t.mode)}</td>
                    <td style={{ ...S.td, fontSize: 12 }}>{new Date(t.scheduled_start_at).toLocaleString('ja-JP')}</td>
                    <td style={S.td}>
                      <span style={{ ...S.badge, color: statusColor(t.status) }}>{statusLabel(t.status)}</span>
                    </td>
                    <td style={{ ...S.td, textAlign: 'center' }}>{t.entry_count} {t.max_players ? `/ ${t.max_players}` : ''}</td>
                    <td style={{ ...S.td, textAlign: 'right' }}>{t.starting_chips.toLocaleString()}</td>
                    <td style={{ ...S.td, textAlign: 'center' }}>{t.is_test ? '✓' : ''}</td>
                    <td style={S.td}>
                      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <select
                            style={{ ...S.input, padding: '4px 8px', fontSize: 12 }}
                            value={t.status}
                            onChange={(e) => handleStatusChange(t.id, e.target.value)}
                          >
                            <option value="registering">受付中</option>
                            <option value="running">進行中</option>
                            <option value="finished">終了</option>
                            <option value="cancelled">キャンセル</option>
                          </select>
                          {(t.status === 'registering' || t.status === 'running') && (
                            <button
                              style={{ fontSize: 11, background: 'rgba(80,180,80,0.2)', border: '1px solid #4a4', color: '#8f8', borderRadius: 4, padding: '3px 8px', cursor: startingId === t.id ? 'wait' : 'pointer', whiteSpace: 'nowrap' as const }}
                              onClick={() => handleStart(t.id)}
                              disabled={startingId === t.id}
                            >{startingId === t.id ? '起動中...' : '▶ 開始'}</button>
                          )}
                          {t.status === 'running' && (
                            <button
                              style={{ fontSize: 11, background: tBotPanel === t.id ? 'rgba(201,168,76,0.3)' : 'rgba(201,168,76,0.1)', border: '1px solid var(--gold-dim)', color: 'var(--gold)', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                              onClick={() => toggleTBotPanel(t.id)}
                            >🤖 BOT{tBotPanel === t.id ? ' ▲' : ' ▼'}</button>
                          )}
                          {t.status !== 'running' && (
                            <button
                              style={{ fontSize: 11, background: 'rgba(139,26,26,0.4)', border: '1px solid rgba(204,34,34,0.5)', color: '#ffaaaa', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                              onClick={() => setDeleteConfirmId(t.id)}
                            >🗑 削除</button>
                          )}
                        </div>
                        {startMsg[t.id] && (
                          <span style={{ fontSize: 11, color: startMsg[t.id].startsWith('✅') ? '#6f6' : '#f88' }}>
                            {startMsg[t.id]}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {tBotPanel === t.id && (
                    <tr key={`${t.id}-bot`}>
                      <td colSpan={8} style={{ padding: '12px 20px', background: 'rgba(0,0,0,0.35)', borderBottom: '1px solid var(--gold-dim)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                          {/* BOT追加フォーム */}
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const }}>
                            <span style={{ fontFamily: 'var(--font-title)', fontSize: 12, color: 'var(--gold)', letterSpacing: '0.06em' }}>BOT追加:</span>
                            <select
                              style={{ ...S.input, padding: '4px 8px', fontSize: 12, minWidth: 160 }}
                              value={tBotTableId}
                              onChange={(e) => setTBotTableId(e.target.value)}
                            >
                              <option value="">全テーブル</option>
                              {tBotTables.map(tb => (
                                <option key={tb.tableId} value={tb.tableId}>
                                  {tb.tableId.slice(-8)} ({tb.playerCount}人)
                                </option>
                              ))}
                            </select>
                            <input
                              type="number" min={1} max={30}
                              style={{ ...S.input, padding: '4px 8px', fontSize: 12, width: 64 }}
                              value={tBotCount}
                              onChange={(e) => setTBotCount(Number(e.target.value))}
                            />
                            <span style={{ fontSize: 12, color: 'var(--cream-dim)' }}>体</span>
                            <button
                              style={{ ...S.createBtn, padding: '5px 14px', fontSize: 12 }}
                              onClick={() => handleAddTBot(t.id)}
                            >追加</button>
                            <button
                              style={{ fontSize: 11, background: 'transparent', border: '1px solid var(--gold-dim)', color: 'var(--cream-dim)', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}
                              onClick={() => fetchTBots(t.id)}
                            >🔄</button>
                            {tBotMsg && <span style={{ fontSize: 12, color: tBotMsg.startsWith('✅') ? '#6f6' : '#f88' }}>{tBotMsg}</span>}
                          </div>
                          {/* テーブル別BOT一覧 */}
                          {tBotTables.map(tb => (
                            <div key={tb.tableId} style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: '8px 12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                                <span style={{ fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold-dim)' }}>
                                  テーブル: {tb.tableId.slice(-8)} — {tb.playerCount}人在席 / BOT {tb.bots.length}体
                                </span>
                                {tb.bots.length > 0 && (
                                  <button
                                    style={{ fontSize: 10, background: 'transparent', border: '1px solid #f66', color: '#f88', borderRadius: 3, padding: '2px 6px', cursor: 'pointer' }}
                                    onClick={() => handleRemoveTBot(t.id, tb.tableId)}
                                  >全BOT削除</button>
                                )}
                              </div>
                              {tb.bots.length === 0 ? (
                                <span style={{ fontSize: 12, color: '#666' }}>BOTなし</span>
                              ) : (
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                                  {tb.bots.map(bot => (
                                    <span key={bot.id} style={{ fontSize: 12, background: 'rgba(201,168,76,0.1)', border: '1px solid var(--gold-dim)', borderRadius: 4, padding: '4px 8px', color: 'var(--cream)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                      {editingTBotId === bot.id ? (
                                        <>
                                          <input
                                            autoFocus
                                            style={{ ...S.input, padding: '2px 6px', fontSize: 12, width: 110 }}
                                            value={editingTBotName}
                                            onChange={(e) => setEditingTBotName(e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') handleRenameTBot(t.id, tb.tableId, bot.id);
                                              if (e.key === 'Escape') setEditingTBotId(null);
                                            }}
                                          />
                                          <button style={{ background: 'rgba(201,168,76,0.2)', border: '1px solid var(--gold-dim)', color: 'var(--gold)', borderRadius: 3, padding: '1px 5px', cursor: 'pointer', fontSize: 12 }} onClick={() => handleRenameTBot(t.id, tb.tableId, bot.id)}>✓</button>
                                          <button style={{ background: 'transparent', border: '1px solid #555', color: '#aaa', borderRadius: 3, padding: '1px 5px', cursor: 'pointer', fontSize: 12 }} onClick={() => setEditingTBotId(null)}>✗</button>
                                        </>
                                      ) : (
                                        <>
                                          <span
                                            style={{ cursor: 'pointer' }}
                                            onDoubleClick={() => { setEditingTBotId(bot.id); setEditingTBotName(bot.name); }}
                                            title="ダブルクリックで名前を編集"
                                          >🤖 {bot.name} ({bot.chips.toLocaleString()}chips) <span style={{ fontSize: 10, color: '#888' }}>✎</span></span>
                                          <button
                                            style={{ background: 'transparent', border: 'none', color: '#f88', cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}
                                            onClick={() => handleRemoveTBot(t.id, tb.tableId, bot.id)}
                                          >×</button>
                                        </>
                                      )}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                  </>
                ))}
                {tournaments.length === 0 && (
                  <tr><td colSpan={8} style={{ ...S.td, textAlign: 'center', color: '#888' }}>トーナメントがありません</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        )}
        {/* ===== ボット管理 ===== */}
        {tab === 'bots' && (
          <div style={S.section}>
            {/* ボット追加フォーム */}
            <div style={S.card}>
              <p style={S.cardTitle}>🤖 リングボット追加</p>
              <div style={S.formGrid}>
                <label style={S.label}>
                  部屋ID
                  <select
                    style={S.input}
                    value={botRoomId}
                    onChange={(e) => setBotRoomId(e.target.value)}
                  >
                    <optgroup label="2-7 Triple Draw">
                      <option value="27-room-1">2-7 ROOM 1</option>
                      <option value="27-room-2">2-7 ROOM 2</option>
                      <option value="27-room-3">2-7 ROOM 3</option>
                    </optgroup>
                    <optgroup label="Badugi">
                      <option value="badugi-room-1">Badugi ROOM 1</option>
                      <option value="badugi-room-2">Badugi ROOM 2</option>
                      <option value="badugi-room-3">Badugi ROOM 3</option>
                    </optgroup>
                    <optgroup label="Mix">
                      <option value="mix-room-1">Mix ROOM 1</option>
                      <option value="mix-room-2">Mix ROOM 2</option>
                      <option value="mix-room-3">Mix ROOM 3</option>
                    </optgroup>
                  </select>
                </label>
                <label style={S.label}>
                  台数 (1〜6)
                  <input
                    type="number" min={1} max={6} style={S.input}
                    value={botCount}
                    onChange={(e) => setBotCount(Number(e.target.value))}
                  />
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button style={S.createBtn} onClick={handleAddBot}>追加</button>
                <button style={{ ...S.createBtn, background: 'rgba(201,168,76,0.15)', color: 'var(--gold)' }} onClick={fetchBots}>🔄 更新</button>
                {botMsg && <span style={{ fontSize: 13, color: botMsg.startsWith('✅') ? '#6f6' : '#f88' }}>{botMsg}</span>}
              </div>
            </div>

            {/* 稼働中ボット一覧 */}
            <div style={S.card}>
              <p style={S.cardTitle}>稼働中ボット</p>
              {bots.length === 0 ? (
                <p style={{ color: 'var(--cream-dim)', fontSize: 14 }}>稼働中のボットはありません</p>
              ) : (
                <>
                  {/* 部屋ごとにグループ表示 */}
                  {Array.from(new Set(bots.map(b => b.roomId))).map(roomId => (
                    <div key={roomId} style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                        <span style={{ fontFamily: 'var(--font-title)', fontSize: 13, color: 'var(--gold)' }}>
                          📍 {roomId} ({bots.filter(b => b.roomId === roomId).length}体)
                        </span>
                        <button
                          style={{ fontSize: 11, background: 'transparent', border: '1px solid #f66', color: '#f88', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
                          onClick={() => handleRemoveAllBots(roomId)}
                        >全削除</button>
                      </div>
                      <table style={{ ...S.table, fontSize: 13 }}>
                        <thead>
                          <tr>
                            {['ID', '名前', '状態', '操作'].map(h => <th key={h} style={S.th}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {bots.filter(b => b.roomId === roomId).map(bot => (
                            <tr key={bot.id} style={S.tr}>
                              <td style={S.td}>#{bot.id}</td>
                              <td style={S.td}>
                                {editingBotId === bot.id ? (
                                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                    <input
                                      autoFocus
                                      style={{ ...S.input, padding: '3px 6px', fontSize: 13, width: 120 }}
                                      value={editingBotName}
                                      onChange={(e) => setEditingBotName(e.target.value)}
                                      onKeyDown={(e) => { if (e.key === 'Enter') handleRenameBot(bot.id); if (e.key === 'Escape') setEditingBotId(null); }}
                                    />
                                    <button style={{ fontSize: 11, background: 'rgba(201,168,76,0.2)', border: '1px solid var(--gold-dim)', color: 'var(--gold)', borderRadius: 3, padding: '2px 6px', cursor: 'pointer' }} onClick={() => handleRenameBot(bot.id)}>✓</button>
                                    <button style={{ fontSize: 11, background: 'transparent', border: '1px solid #555', color: '#aaa', borderRadius: 3, padding: '2px 6px', cursor: 'pointer' }} onClick={() => setEditingBotId(null)}>✗</button>
                                  </div>
                                ) : (
                                  <span style={{ cursor: 'pointer' }} onDoubleClick={() => { setEditingBotId(bot.id); setEditingBotName(bot.name); }} title="ダブルクリックで編集">
                                    {bot.name} <span style={{ fontSize: 10, color: '#666' }}>✎</span>
                                  </span>
                                )}
                              </td>
                              <td style={S.td}>
                                <span style={{ color: bot.connected ? '#6f6' : '#f88', fontSize: 12 }}>
                                  {bot.connected ? '● 接続中' : '○ 切断'}
                                </span>
                              </td>
                              <td style={S.td}>
                                <button
                                  style={{ fontSize: 11, background: 'transparent', border: '1px solid #f66', color: '#f88', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
                                  onClick={() => handleRemoveBot(bot.id)}
                                >削除</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* FastFoldボット追加フォーム */}
            <div style={S.card}>
              <p style={S.cardTitle}>⚡ FastFoldボット追加</p>
              <div style={S.formGrid}>
                <label style={S.label}>
                  プール
                  <select style={S.input} value={ffPoolId} onChange={(e) => setFfPoolId(e.target.value)}>
                    <option value="zoom-27">FastFold 2-7</option>
                    <option value="zoom-badugi">FastFold Badugi</option>
                    <option value="zoom-mix">FastFold Mix</option>
                  </select>
                </label>
                <label style={S.label}>
                  台数 (1〜6)
                  <input type="number" min={1} max={6} style={S.input} value={ffCount} onChange={(e) => setFfCount(Number(e.target.value))} />
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button style={S.createBtn} onClick={handleAddFfBot}>追加</button>
                {ffMsg && <span style={{ fontSize: 13, color: ffMsg.startsWith('✅') ? '#6f6' : '#f88' }}>{ffMsg}</span>}
              </div>
            </div>

            {/* FastFold稼働中ボット一覧 */}
            {ffBots.length > 0 && (
              <div style={S.card}>
                <p style={S.cardTitle}>⚡ FastFold稼働中ボット</p>
                {Array.from(new Set(ffBots.map(b => b.roomId))).map(poolId => (
                  <div key={poolId} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                      <span style={{ fontFamily: 'var(--font-title)', fontSize: 13, color: 'var(--gold)' }}>
                        ⚡ {poolId} ({ffBots.filter(b => b.roomId === poolId).length}体)
                      </span>
                      <button
                        style={{ fontSize: 11, background: 'transparent', border: '1px solid #f66', color: '#f88', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
                        onClick={() => handleRemoveFfBots(poolId)}
                      >全削除</button>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                      {ffBots.filter(b => b.roomId === poolId).map(bot => (
                        <span key={bot.id} style={{ fontSize: 12, background: 'rgba(80,180,80,0.1)', border: '1px solid #4a4', borderRadius: 4, padding: '3px 10px', color: 'var(--cream)' }}>
                          ⚡ {bot.name}
                          <span style={{ color: bot.connected ? '#6f6' : '#f88', marginLeft: 6 }}>
                            {bot.connected ? '●' : '○'}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===== トーナメント削除確認モーダル ===== */}
      {deleteConfirmId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }}
          onClick={() => setDeleteConfirmId(null)}>
          <div style={{ background: 'linear-gradient(160deg,#0e1a0e,#061006)', border: '1px solid var(--gold-dim)', borderRadius: 14, padding: '36px 40px', maxWidth: 400, width: '90%', textAlign: 'center', boxShadow: '0 8px 48px rgba(0,0,0,0.8)' }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🗑</div>
            <h2 style={{ fontFamily: 'var(--font-title)', fontSize: 18, color: 'var(--gold)', letterSpacing: '0.08em', margin: '0 0 16px' }}>
              トーナメントを削除
            </h2>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--cream)', lineHeight: 1.7, margin: '0 0 8px' }}>
              <strong style={{ color: 'var(--gold)' }}>{tournaments.find(t => t.id === deleteConfirmId)?.name}</strong> を削除しますか？
            </p>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: '#ee8888', margin: '0 0 28px' }}>
              参加登録・結果データもすべて削除されます。この操作は取り消せません。
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                style={{ background: 'transparent', border: '1px solid var(--gold-dim)', color: 'var(--cream-dim)', borderRadius: 6, padding: '10px 24px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-title)' }}
                onClick={() => setDeleteConfirmId(null)}
              >キャンセル</button>
              <button
                style={{ background: 'linear-gradient(135deg,#8b1a1a,#5a1010)', border: '1px solid #cc4444', color: '#ffcccc', borderRadius: 6, padding: '10px 24px', fontSize: 13, cursor: deleting ? 'wait' : 'pointer', fontFamily: 'var(--font-title)', fontWeight: 700 }}
                onClick={() => handleDeleteTournament(deleteConfirmId)}
                disabled={deleting}
              >{deleting ? '削除中...' : '削除する'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:       { minHeight: '100vh', padding: '0 0 60px', background: 'var(--felt)' },
  loading:    { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cream-dim)', fontFamily: 'var(--font-title)', fontSize: 18 },
  header:     { display: 'flex', alignItems: 'center', gap: 16, padding: '20px 32px', borderBottom: '1px solid var(--gold-dim)', background: 'rgba(0,0,0,0.3)' },
  headerTitle:{ fontFamily: 'var(--font-title)', fontSize: 22, color: 'var(--gold)', letterSpacing: '0.1em', margin: 0, flex: 1 },
  adminBadge: { fontFamily: 'var(--font-title)', fontSize: 14, color: 'var(--gold)', letterSpacing: '0.08em' },
  backBtn:    { background: 'transparent', border: '1px solid var(--gold-dim)', color: 'var(--cream-dim)', borderRadius: 5, padding: '6px 14px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-title)' },
  tabs:       { display: 'flex', gap: 0, borderBottom: '1px solid var(--gold-dim)', padding: '0 32px', marginTop: 8 },
  tab:        { background: 'transparent', border: 'none', borderBottom: '3px solid transparent', color: 'var(--cream-dim)', fontFamily: 'var(--font-title)', fontSize: 14, letterSpacing: '0.06em', padding: '12px 24px', cursor: 'pointer' },
  tabActive:  { color: 'var(--gold)', borderBottomColor: 'var(--gold)' },
  section:    { padding: '24px 32px', display: 'flex', flexDirection: 'column' as const, gap: 24 },
  card:       { background: 'rgba(0,0,0,0.25)', border: '1px solid var(--gold-dim)', borderRadius: 10, padding: '20px 24px', display: 'flex', flexDirection: 'column' as const, gap: 12 },
  cardTitle:  { fontFamily: 'var(--font-title)', fontSize: 15, color: 'var(--gold)', letterSpacing: '0.08em', margin: 0 },
  formGrid:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 },
  label:      { display: 'flex', flexDirection: 'column' as const, gap: 4, fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold-dim)', letterSpacing: '0.06em' },
  input:      { background: 'rgba(0,0,0,0.4)', border: '1px solid var(--gold-dim)', borderRadius: 5, color: 'var(--cream)', fontSize: 14, padding: '8px 10px', fontFamily: 'var(--font-body)', outline: 'none' },
  createBtn:  { background: 'linear-gradient(135deg, var(--gold), var(--gold-dim))', border: 'none', borderRadius: 6, color: '#1a1200', fontSize: 14, fontWeight: 700, padding: '10px 24px', cursor: 'pointer', fontFamily: 'var(--font-title)', alignSelf: 'flex-start' as const },
  table:      { width: '100%', borderCollapse: 'collapse' as const, fontFamily: 'var(--font-body)', fontSize: 15 },
  th:         { textAlign: 'left' as const, padding: '10px 14px', borderBottom: '1px solid var(--gold-dim)', fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold)', letterSpacing: '0.08em', whiteSpace: 'nowrap' as const },
  tr:         { borderBottom: '1px solid rgba(201,168,76,0.1)' },
  td:         { padding: '10px 14px', color: 'var(--cream)', verticalAlign: 'middle' as const },
  badge:      { fontFamily: 'var(--font-title)', fontSize: 11, letterSpacing: '0.06em' },
};

// ===== サーバーサイドアクセス制御 =====
// getServerSideProps で管理者以外をトップページにリダイレクト
// クライアント側チェックより先に動作するため、HTMLすら返さない

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminDb = require('../../server/db/admin');

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);

  // 未ログイン → トップへ
  if (!session?.user?.accountId) {
    return { redirect: { destination: '/', permanent: false } };
  }

  // 管理者以外 → トップへ
  const isAdmin = await adminDb.isAdmin(session.user.accountId).catch(() => false);
  if (!isAdmin) {
    return { redirect: { destination: '/', permanent: false } };
  }

  return { props: {} };
};
