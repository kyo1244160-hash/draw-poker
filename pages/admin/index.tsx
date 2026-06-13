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
  is_sit_and_go: boolean;
  min_players: number;
}

interface TournamentResult {
  accountId:  string;
  finalRank:  number;
  finalChips: number;
}

interface BlindScheduleLevel {
  level: number | null;
  sb: number;
  bb: number;
  smallBet: number;
  bigBet: number;
  durationMinutes: number;
  isBreak?: boolean;
  breakLabel?: string;
}

interface BlindSchedule {
  id: string;
  name: string;
  description: string | null;
  levels: BlindScheduleLevel[];
  lateLevelCutoff: number;
  isBuiltin?: boolean;  // JS定義の組み込みスケジュール（test等）は削除不可
}

type Tab = 'users' | 'tournaments' | 'bots' | 'blinds' | 'loadtest';

interface LoadTestRun {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  config: {
    targetUrl: string;
    mode: 'connect' | 'spectate' | 'tournament-player';
    count: number;
    tableId?: string;
    tournamentId?: string;
    rampMs: number;
    durationSec: number;
  };
  metrics: {
    connected: number;
    connectFailed: number;
    disconnected: number;
    active: number;
    sockets: number;
    gameStateReceived: number;
    tournamentRegistered?: number;
    tableJoins?: number;
    tableTransfers?: number;
    actionsSent?: number;
    drawActionsSent?: number;
    betActionsSent?: number;
    actionErrors?: number;
    avgLatencyMs: number | null;
    maxLatencyMs: number | null;
    errors: number;
    uptimeMs: number;
  };
  recentLogs: LoadTestLog[];
}

interface LoadTestLog {
  ts: string;
  runId: string;
  type: string;
  [key: string]: unknown;
}

interface LoadTestStatus {
  enabled: boolean;
  maxBots: number;
  runs: LoadTestRun[];
}

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [tab,           setTab]           = useState<Tab>('users');
  const [users,         setUsers]         = useState<User[]>([]);
  const [usersTotal,    setUsersTotal]    = useState(0);   // 全件数（タブ表示用）
  const [userPage,      setUserPage]      = useState(0);   // 現在のページ（0始まり）
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [deletingUsers, setDeletingUsers] = useState(false);
  const [userMsg, setUserMsg] = useState('');
  const USER_PAGE_SIZE = 50;
  const [tournaments,   setTournaments]   = useState<Tournament[]>([]);
  const [schedules,     setSchedules]     = useState<BlindSchedule[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');

  // ブラインド設定タブ
  const [blindSchedules,    setBlindSchedules]    = useState<BlindSchedule[]>([]);
  const [blindsLoading,     setBlindsLoading]     = useState(false);
  const [editingSchedule,   setEditingSchedule]   = useState<BlindSchedule | null>(null);
  const [blindMsg,          setBlindMsg]          = useState('');
  const defaultLevel = (): BlindScheduleLevel => ({ level: 1, sb: 5, bb: 10, smallBet: 10, bigBet: 20, durationMinutes: 15 });
  const [newSchedule, setNewSchedule] = useState<{ name: string; description: string | null; levels: BlindScheduleLevel[]; lateLevelCutoff: number }>({
    name: '', description: '', levels: [defaultLevel()], lateLevelCutoff: 0,
  });

  // トーナメント作成フォーム
  const [form, setForm] = useState({
    name:             '',
    mode:             '27',
    scheduledStartAt: '',
    startingChips:    5000,
    maxPlayers:       '',
    blindScheduleId:  '',
    isTest:           false,
    lateRegMinutes:   0,
    isSitAndGo:       false,
    minPlayers:       3,
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

  // 結果表示
  interface ResultRow { rank: number; chips: number; hands: number; nickname: string; accountId: string; }
  const [resultViewId,   setResultViewId]   = useState<string | null>(null);
  const [resultViewData, setResultViewData] = useState<ResultRow[]>([]);
  const [resultViewName, setResultViewName] = useState('');
  const [resultViewLoading, setResultViewLoading] = useState(false);

  const handleViewResults = async (tournamentId: string, name: string) => {
    if (resultViewId === tournamentId) { setResultViewId(null); return; }
    setResultViewId(tournamentId);
    setResultViewName(name);
    setResultViewData([]);
    setResultViewLoading(true);
    try {
      const res = await fetch(`/api/admin/tournaments?type=results&id=${tournamentId}`);
      const d = await res.json();
      setResultViewData(d.results ?? []);
    } catch { setResultViewData([]); }
    finally { setResultViewLoading(false); }
  };

  // ボット管理
  interface BotInfo { id: number; roomId: string; name: string; connected: boolean; isFastFold?: boolean; }
  interface ThreeCardBotInfo { id: string; roomId: string; name: string; points: number; phase: string; }
  const [bots,        setBots]       = useState<BotInfo[]>([]);
  const [ffBots,      setFfBots]     = useState<BotInfo[]>([]);
  const [tcBots,      setTcBots]     = useState<ThreeCardBotInfo[]>([]);
  const [botRoomId,   setBotRoomId]  = useState('27-room-1');
  const [botCount,    setBotCount]   = useState(1);
  const [botMsg,      setBotMsg]     = useState('');

  // FastFoldボット
  const [ffPoolId,    setFfPoolId]   = useState('zoom-27');
  const [ffCount,     setFfCount]    = useState(1);
  const [ffMsg,       setFfMsg]      = useState('');
  const [tcRoomId,    setTcRoomId]   = useState('3card-room-1');
  const [tcCount,     setTcCount]    = useState(1);
  const [tcPoints,    setTcPoints]   = useState(5000);
  const [tcMsg,       setTcMsg]      = useState('');

  // 負荷テスト（一時Socket.IOクライアント。実参加モードでは専用Botアカウントで参加）
  const [loadStatus, setLoadStatus] = useState<LoadTestStatus | null>(null);
  const [loadForm, setLoadForm] = useState({
    targetUrl: '',
    mode: 'spectate' as 'connect' | 'spectate' | 'tournament-player',
    count: 10,
    rampMs: 200,
    durationSec: 300,
    tableId: '',
    tournamentId: '',
  });
  const [loadSelectedRunId, setLoadSelectedRunId] = useState('');
  const [loadLogs, setLoadLogs] = useState<LoadTestLog[]>([]);
  const [loadExport, setLoadExport] = useState<{ jsonl: string; markdown: string } | null>(null);
  const [loadMsg, setLoadMsg] = useState('');

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

  const fetchUsersPage = async (page = userPage) => {
    const res = await fetch(`/api/admin/users?offset=${page * USER_PAGE_SIZE}&limit=${USER_PAGE_SIZE}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? 'ユーザー一覧の取得に失敗しました');
    setUsers(d.users ?? []);
    setUsersTotal(d.total ?? d.users?.length ?? 0);
    setSelectedUserIds([]);
  };

  const fetchLoadStatus = async () => {
    try {
      const res = await authFetch('/api/admin/monitor/loadtest/status');
      const d = await res.json();
      setLoadStatus(d);
      const firstRun = d.runs?.[0]?.id ?? '';
      setLoadSelectedRunId((prev) => prev || firstRun);
      return d as LoadTestStatus;
    } catch {
      setLoadMsg('負荷テスト状態の取得に失敗しました');
      return null;
    }
  };

  const fetchLoadLogs = async (runId = loadSelectedRunId) => {
    if (!runId) return;
    try {
      const res = await authFetch(`/api/admin/monitor/loadtest/logs/${runId}?limit=500`);
      const d = await res.json();
      setLoadLogs(d.logs ?? []);
    } catch {
      setLoadLogs([]);
    }
  };

  const handleStartLoadTest = async () => {
    setLoadMsg('');
    setLoadExport(null);
    try {
      const res = await authFetch('/api/admin/monitor/loadtest/start', {
        method: 'POST',
        body: JSON.stringify(loadForm),
      });
      const d = await res.json();
      if (!res.ok) {
        setLoadMsg(d.error === 'LOAD_TEST_DISABLED'
          ? 'LOAD_TEST_ENABLED=true を設定すると開始できます'
          : d.error === 'TOURNAMENT_TARGET_REQUIRED'
            ? 'トーナメント実参加には tournamentId が必要です'
          : `開始失敗: ${d.error ?? 'unknown'}`);
        return;
      }
      setLoadMsg(`開始: ${d.run.id}`);
      setLoadSelectedRunId(d.run.id);
      await fetchLoadStatus();
      await fetchLoadLogs(d.run.id);
    } catch {
      setLoadMsg('開始リクエストに失敗しました');
    }
  };

  const handleStopLoadTest = async (runId = loadSelectedRunId) => {
    if (!runId) return;
    await authFetch('/api/admin/monitor/loadtest/stop', {
      method: 'POST',
      body: JSON.stringify({ runId }),
    });
    await fetchLoadStatus();
    await fetchLoadLogs(runId);
  };

  const handleStopAllLoadTests = async () => {
    await authFetch('/api/admin/monitor/loadtest/stop-all', { method: 'POST', body: JSON.stringify({}) });
    await fetchLoadStatus();
    if (loadSelectedRunId) await fetchLoadLogs(loadSelectedRunId);
  };

  const handleExportLoadTest = async (runId = loadSelectedRunId) => {
    if (!runId) return;
    try {
      const res = await authFetch(`/api/admin/monitor/loadtest/export/${runId}`);
      const d = await res.json();
      setLoadExport({ jsonl: d.jsonl ?? '', markdown: d.markdown ?? '' });
    } catch {
      setLoadMsg('エクスポート取得に失敗しました');
    }
  };

  const fetchBots = () => {
    authFetch('/api/admin/monitor/bots')
      .then((r) => r.json())
      .then((d) => { setBots(d.bots ?? []); setFfBots(d.fastFoldBots ?? []); setTcBots(d.threeCardBots ?? []); })
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

  const handleAddTcBot = async () => {
    setTcMsg('');
    try {
      const res = await authFetch('/api/admin/monitor/three-card-bots', {
        method: 'POST',
        body: JSON.stringify({ roomId: tcRoomId, count: tcCount, points: tcPoints }),
      });
      const d = await res.json();
      if (res.ok) { setTcMsg(`✅ 3CP BOT ${d.added.length}体 追加`); fetchBots(); }
      else setTcMsg(`❌ ${d.error}`);
    } catch { setTcMsg('❌ 認証エラー'); }
  };

  const handleRemoveTcBots = async (roomId: string, botId?: string) => {
    await authFetch('/api/admin/monitor/three-card-bots', {
      method: 'DELETE',
      body: JSON.stringify({ roomId, botId }),
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

  useEffect(() => {
    if (tab !== 'loadtest') return;
    fetchLoadStatus().then((d) => {
      const runId = loadSelectedRunId || d?.runs?.[0]?.id || '';
      if (runId) fetchLoadLogs(runId);
    });
    const timer = setInterval(() => {
      fetchLoadStatus().then((d) => {
        const runId = loadSelectedRunId || d?.runs?.[0]?.id || '';
        if (runId) fetchLoadLogs(runId);
      });
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, loadSelectedRunId]);

  const fetchBlindSchedules = async () => {
    setBlindsLoading(true);
    try {
      const r = await fetch('/api/admin/tournaments?type=schedules');
      const d = await r.json();
      // levelsはDBからunknown/objectで返るためBlindScheduleLevel[]にキャスト
      const parsed = (d.schedules ?? []).map((s: BlindSchedule) => ({
        ...s,
        levels: Array.isArray(s.levels) ? s.levels as BlindScheduleLevel[] : [],
        lateLevelCutoff: s.lateLevelCutoff ?? 0,
      }));
      setBlindSchedules(parsed);
    } catch { setBlindSchedules([]); }
    finally { setBlindsLoading(false); }
  };
  useEffect(() => { if (tab === 'blinds') fetchBlindSchedules(); }, [tab]);

  const handleSaveSchedule = async (sched: { id?: string; name: string; description: string | null; levels: BlindScheduleLevel[]; lateLevelCutoff: number }) => {
    setBlindMsg('');
    try {
      const method = sched.id ? 'PUT' : 'POST';
      const url = sched.id
        ? `/api/admin/tournaments?type=schedules&id=${sched.id}`
        : '/api/admin/tournaments?type=schedules';
      const r = await authFetch(url, {
        method,
        body: JSON.stringify({ name: sched.name, description: sched.description, levels: sched.levels, lateLevelCutoff: sched.lateLevelCutoff ?? 0 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'エラー');
      setBlindMsg(sched.id ? '✅ 更新しました' : '✅ 作成しました');
      setEditingSchedule(null);
      setNewSchedule({ name: '', description: '', levels: [defaultLevel()], lateLevelCutoff: 0 });
      fetchBlindSchedules();
    } catch (e: unknown) {
      setBlindMsg('❌ ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    setDeletingBlind(true);
    try {
      const r = await authFetch(`/api/admin/tournaments?type=schedules&id=${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? '削除失敗');
      setBlindMsg('✅ 削除しました');
      setDeleteBlindConfirmId(null);
      fetchBlindSchedules();
    } catch (e: unknown) {
      setBlindMsg('❌ ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDeletingBlind(false);
    }
  };

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

  const handlePreAddBot = async (tournamentId: string) => {
    setTBotMsg('');
    try {
      const res = await authFetch(`/api/admin/monitor/tournament-bots/${tournamentId}/pre-add`, {
        method: 'POST', body: JSON.stringify({ count: tBotCount }),
      });
      const d = await res.json();
      if (res.ok) {
        setTBotMsg(`✅ BOT ${d.added.length}体 事前予約 → 合計 ${d.totalBots}体（開始時に配置）`);
        // SNG: BOT 追加によってトーナメントが即起動する場合があるため
        // トーナメント一覧を再取得して status を更新する
        fetch('/api/admin/tournaments').then(r => r.json()).then(t => {
          setTournaments(t.tournaments ?? []);
        }).catch(() => {});
      } else if (d.error === 'ALREADY_RUNNING') {
        // SNG が既に起動済み → /add エンドポイントで追加し直す
        setTBotMsg('');
        const res2 = await authFetch(`/api/admin/monitor/tournament-bots/${tournamentId}/add`, {
          method: 'POST', body: JSON.stringify({ count: tBotCount }),
        });
        const d2 = await res2.json();
        if (res2.ok) {
          setTBotMsg(`✅ BOT ${d2.added.length}体 追加（トーナメント進行中）`);
          fetchTBots(tournamentId);
          // 一覧も更新
          fetch('/api/admin/tournaments').then(r => r.json()).then(t => {
            setTournaments(t.tournaments ?? []);
          }).catch(() => {});
        } else {
          setTBotMsg(`❌ ${d2.error}`);
        }
      } else {
        setTBotMsg(`❌ ${d.error}: ${d.hint ?? ''}`);
      }
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
  const [deleteBlindConfirmId, setDeleteBlindConfirmId] = useState<string | null>(null);
  const [deletingBlind, setDeletingBlind] = useState(false);
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
      setUsersTotal(u.total ?? u.users?.length ?? 0);
      setSelectedUserIds([]);
      setTournaments(t.tournaments ?? []);
      setSchedules(s.schedules ?? []);
      setLoading(false);
    }).catch(() => setError('データの取得に失敗しました'));
  }, [status]);

  const toggleUserSelection = (accountId: string, checked: boolean) => {
    setSelectedUserIds((prev) => checked
      ? [...new Set([...prev, accountId])]
      : prev.filter((id) => id !== accountId));
  };

  const toggleVisibleUsers = (checked: boolean) => {
    setSelectedUserIds(checked ? users.map((u) => u.id) : []);
  };

  const handleDeleteSelectedUsers = async () => {
    if (selectedUserIds.length === 0) return;
    const ok = window.confirm(`選択した ${selectedUserIds.length} 人のユーザーを削除します。この操作は取り消せません。`);
    if (!ok) return;

    setDeletingUsers(true);
    setUserMsg('');
    try {
      const res = await fetch('/api/admin/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds: selectedUserIds }),
      });
      const d = await res.json();
      if (!res.ok) {
        setUserMsg(`削除エラー: ${d.error ?? 'unknown'}`);
        return;
      }

      const deletedCount = d.deletedCount ?? d.deletedIds?.length ?? selectedUserIds.length;
      const remainingTotal = Math.max(0, usersTotal - deletedCount);
      const nextPage = userPage > 0 && userPage * USER_PAGE_SIZE >= remainingTotal ? userPage - 1 : userPage;
      setUserPage(nextPage);
      await fetchUsersPage(nextPage);
      setUserMsg(`${deletedCount} 人のユーザーを削除しました`);
    } catch {
      setUserMsg('通信エラーが発生しました');
    } finally {
      setDeletingUsers(false);
    }
  };

  // ===== トーナメント作成 =====
  const handleCreate = async () => {
    if (!form.name.trim() || (!form.isSitAndGo && !form.scheduledStartAt)) {
      setCreateMsg('名前と開始日時は必須です（Sit & Go の場合は開始日時不要）');
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
          scheduledStartAt: form.isSitAndGo ? undefined : new Date(form.scheduledStartAt).toISOString(),
          startingChips:    Number(form.startingChips),
          maxPlayers:       form.maxPlayers ? Number(form.maxPlayers) : undefined,
          blindScheduleId:  form.blindScheduleId || undefined,
          isTest:           form.isTest,
          lateRegMinutes:   form.lateRegMinutes,
          isSitAndGo:       form.isSitAndGo,
          minPlayers:       form.isSitAndGo ? form.minPlayers : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateMsg(data.error ?? '作成失敗'); return; }
      setTournaments((prev) => [data.tournament, ...prev]);
      setCreateMsg('✅ トーナメントを作成しました');
      setForm({ name: '', mode: '27', scheduledStartAt: '', startingChips: 5000, maxPlayers: '', blindScheduleId: '', isTest: false, lateRegMinutes: 0, isSitAndGo: false, minPlayers: 3 });
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
  const modeLabel   = (m: string) => ({
    '27': '2-7 Triple Draw',
    badugi: 'Badugi',
    mix: 'Mix',
    a5: 'A-5 Triple Draw',
    '27sd': '2-7 Single Draw (NL)',
    mix3: 'Mix-3 (2-7/Badugi/A-5)',
    'beast+': 'BEAST+',
    horse: 'HORSE',
    stud_mix: 'Stud Mix',
    stud_s: '7 Card Stud',
    stud_e: 'Stud Hi/Lo',
    razz: 'Razz',
  }[m] ?? m);

  if (loading) return <div style={S.loading}>読み込み中...</div>;
  if (error)   return <div style={S.loading}>{error}</div>;

  const allVisibleUsersSelected = users.length > 0 && users.every((u) => selectedUserIds.includes(u.id));
  const selectedUserCount = selectedUserIds.length;

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
          {(['users', 'tournaments', 'bots', 'blinds', 'loadtest'] as Tab[]).map((t) => (
            <button key={t} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }} onClick={() => setTab(t)}>
              {t === 'users' ? `👥 ユーザー (${usersTotal})`
                : t === 'tournaments' ? `🏆 トーナメント (${tournaments.length})`
                : t === 'bots' ? `🤖 ボット (${bots.length})`
                : t === 'blinds' ? `🎚 ブラインド設定`
                : `📈 負荷テスト`}
            </button>
          ))}
        </div>

        {/* ===== ユーザー管理 ===== */}
        {tab === 'users' && (
          <div style={S.section}>
            {/* ページネーション上部 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--cream-dim)' }}>
                {userPage * USER_PAGE_SIZE + 1}〜{Math.min((userPage + 1) * USER_PAGE_SIZE, usersTotal)} 件 / 全 {usersTotal} 件
              </span>
              <button
                style={{
                  ...S.createBtn,
                  background: 'linear-gradient(135deg,#8b1a1a,#5a1010)',
                  border: '1px solid #cc4444',
                  color: '#ffcccc',
                  padding: '4px 14px',
                  fontSize: 12,
                  opacity: selectedUserCount === 0 || deletingUsers ? 0.45 : 1,
                }}
                disabled={selectedUserCount === 0 || deletingUsers}
                onClick={handleDeleteSelectedUsers}
              >
                {deletingUsers ? '削除中...' : `選択ユーザー削除 (${selectedUserCount})`}
              </button>
              {userMsg && (
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: userMsg.startsWith('削除エラー') || userMsg.startsWith('通信') ? '#ff9999' : '#88ee88' }}>
                  {userMsg}
                </span>
              )}
              <button
                style={{ ...S.createBtn, padding: '4px 12px', fontSize: 12, opacity: userPage === 0 ? 0.4 : 1 }}
                disabled={userPage === 0}
                onClick={async () => {
                  const newPage = userPage - 1;
                  setUserPage(newPage);
                  await fetchUsersPage(newPage);
                }}
              >← 前へ</button>
              <button
                style={{ ...S.createBtn, padding: '4px 12px', fontSize: 12, opacity: (userPage + 1) * USER_PAGE_SIZE >= usersTotal ? 0.4 : 1 }}
                disabled={(userPage + 1) * USER_PAGE_SIZE >= usersTotal}
                onClick={async () => {
                  const newPage = userPage + 1;
                  setUserPage(newPage);
                  await fetchUsersPage(newPage);
                }}
              >次へ →</button>
            </div>
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={allVisibleUsersSelected}
                        onChange={(e) => toggleVisibleUsers(e.target.checked)}
                      />
                      ニックネーム
                    </label>
                  </th>
                  {['Google名', 'メール', 'ポイント', '変更回数', '登録日'].map((h) => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={S.tr}>
                    <td style={S.td}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selectedUserIds.includes(u.id)}
                          onChange={(e) => toggleUserSelection(u.id, e.target.checked)}
                        />
                        <span>{u.nickname ?? <span style={{ color: '#888' }}>未設定</span>}</span>
                      </label>
                    </td>
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
                    <option value="mix">Mix (2-7 / Badugi)</option>
                    <option value="a5">A-5 Triple Draw</option>
                    <option value="27sd">2-7 Single Draw (NL)</option>
                    <option value="mix3">Mix-3 (2-7 / Badugi / A-5)</option>
                    <option value="beast+">BEAST+ (B/E/A/S/T/Razz)</option>
                    <option value="horse">HORSE (Hold'em / Omaha8 / Razz / Stud / Stud8)</option>
                    <option value="stud_mix">Stud Mix (7Stud / Hi-Lo / Razz)</option>
                    <option value="stud_s">7 Card Stud</option>
                    <option value="stud_e">Stud Hi/Lo</option>
                    <option value="razz">Razz</option>
                  </select>
                </label>
                {/* 27SD（ノーリミット）使用時の注意書き */}
                {form.mode === '27sd' && (
                  <div style={{
                    padding: '8px 10px',
                    background: 'rgba(100,80,200,0.12)',
                    border: '1px solid rgba(150,130,240,0.35)',
                    borderRadius: 4,
                    fontSize: 12,
                    color: '#c8bfee',
                    fontFamily: 'var(--font-body)',
                    lineHeight: 1.5,
                  }}>
                    ⚠️ <strong>2-7 Single Draw はノーリミット制です。</strong><br />
                    ブラインドスケジュールの <code>SBet</code>/<code>BBet</code>（リミットベット額）は使用されません。<br />
                    各プレイヤーは BB 以上 〜 スタック全額 の範囲で自由にベット/レイズできます。
                  </div>
                )}
                {/* Sit & Go チェックボックス */}
                <label style={{ ...S.label, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={form.isSitAndGo} onChange={(e) => setForm((f) => ({ ...f, isSitAndGo: e.target.checked }))} />
                  🎰 Sit & Go（人数が集まったら即開始）
                </label>

                {/* SNG: 最小人数 / 通常: 開始日時 */}
                {form.isSitAndGo ? (
                  <label style={S.label}>
                    最小参加人数（この人数で即開始）
                    <input style={S.input} type="number" value={form.minPlayers} min={3} max={100} onChange={(e) => setForm((f) => ({ ...f, minPlayers: Number(e.target.value) }))} />
                  </label>
                ) : (
                  <label style={S.label}>
                    開始日時 *
                    <input style={S.input} type="datetime-local" value={form.scheduledStartAt} onChange={(e) => setForm((f) => ({ ...f, scheduledStartAt: e.target.value }))} />
                  </label>
                )}

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
                <label style={S.label}>
                  レイトレジスト時間（分）
                  <span style={{ color: 'var(--cream-dim)', fontSize: 10, marginLeft: 4, fontWeight: 'normal' }}>※0 = ブラインドレベルで管理</span>
                  <input style={S.input} type="number" value={form.lateRegMinutes} min={0} max={120}
                    placeholder="0（無効）"
                    onChange={(e) => setForm((f) => ({ ...f, lateRegMinutes: Number(e.target.value) }))} />
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
                    <td style={{ ...S.td, textAlign: 'center' }}>
                      {t.entry_count} {t.max_players ? `/ ${t.max_players}` : ''}
                      {t.is_sit_and_go && <span style={{ marginLeft: 4, fontSize: 10, color: '#c088ff', border: '1px solid #6644aa', borderRadius: 4, padding: '1px 4px' }}>SNG</span>}
                    </td>
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
                            <option value="running" disabled={t.status !== 'running'}>進行中</option>
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
                          {(t.status === 'running' || t.status === 'registering') && (
                            <button
                              style={{ fontSize: 11, background: tBotPanel === t.id ? 'rgba(201,168,76,0.3)' : 'rgba(201,168,76,0.1)', border: '1px solid var(--gold-dim)', color: 'var(--gold)', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                              onClick={() => toggleTBotPanel(t.id)}
                            >🤖 BOT{tBotPanel === t.id ? ' ▲' : ' ▼'}</button>
                          )}
                          {t.status === 'finished' && (
                            <button
                              style={{ fontSize: 11, background: resultViewId === t.id ? 'rgba(80,180,80,0.3)' : 'rgba(80,180,80,0.1)', border: '1px solid #4a4', color: '#8f8', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                              onClick={() => handleViewResults(t.id, t.name)}
                            >📊 結果{resultViewId === t.id ? ' ▲' : ' ▼'}</button>
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
                  {resultViewId === t.id && (
                    <tr key={`${t.id}-result`}>
                      <td colSpan={8} style={{ padding: '16px 20px', background: 'rgba(0,20,0,0.4)', borderBottom: '1px solid var(--gold-dim)' }}>
                        <div style={{ fontFamily: 'var(--font-title)', fontSize: 13, color: 'var(--gold)', marginBottom: 10 }}>
                          📊 {resultViewName} — 結果
                        </div>
                        {resultViewLoading ? (
                          <p style={{ color: 'var(--cream-dim)', fontSize: 13 }}>読み込み中...</p>
                        ) : resultViewData.length === 0 ? (
                          <p style={{ color: 'var(--cream-dim)', fontSize: 13 }}>結果データがありません</p>
                        ) : (
                          <div style={{ overflowX: 'auto' }}>
                            <table style={{ ...S.table, fontSize: 13, minWidth: 480 }}>
                              <thead>
                                <tr>
                                  {['順位', 'ニックネーム', '最終チップ', 'ハンド数'].map(h => (
                                    <th key={h} style={{ ...S.th, fontSize: 11 }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {resultViewData.map((r) => (
                                  <tr key={r.accountId} style={S.tr}>
                                    <td style={{ ...S.td, textAlign: 'center' as const, fontFamily: 'var(--font-title)', color: r.rank === 1 ? 'var(--gold)' : r.rank <= 3 ? 'var(--gold-dim)' : 'var(--cream)' }}>
                                      {r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `${r.rank}位`}
                                    </td>
                                    <td style={S.td}>{r.nickname}</td>
                                    <td style={{ ...S.td, textAlign: 'right' as const }}>{r.chips.toLocaleString()}</td>
                                    <td style={{ ...S.td, textAlign: 'center' as const }}>{r.hands}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
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
                              type="number" min={1} max={500}
                              style={{ ...S.input, padding: '4px 8px', fontSize: 12, width: 80 }}
                              value={tBotCount}
                              onChange={(e) => setTBotCount(Number(e.target.value))}
                            />
                            <span style={{ fontSize: 12, color: 'var(--cream-dim)' }}>体</span>
                            {t.status === 'running'
                              ? <button
                                  style={{ ...S.createBtn, padding: '5px 14px', fontSize: 12 }}
                                  onClick={() => handleAddTBot(t.id)}
                                >追加</button>
                              : <button
                                  style={{ ...S.createBtn, padding: '5px 14px', fontSize: 12, background: 'rgba(80,140,200,0.3)', borderColor: '#4af' }}
                                  onClick={() => handlePreAddBot(t.id)}
                                  title="開始前にBOTを事前登録します（開始時にテーブルに配置されます）"
                                >予約追加</button>
                            }
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
                  台数 (1〜20)
                  <input
                    type="number" min={1} max={20} style={S.input}
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
                  台数 (1〜20)
                  <input type="number" min={1} max={20} style={S.input} value={ffCount} onChange={(e) => setFfCount(Number(e.target.value))} />
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button style={S.createBtn} onClick={handleAddFfBot}>追加</button>
                {ffMsg && <span style={{ fontSize: 13, color: ffMsg.startsWith('✅') ? '#6f6' : '#f88' }}>{ffMsg}</span>}
              </div>
            </div>

            {/* FastFold稼働中ボット一覧 */}
            <div style={S.card}>
              <p style={S.cardTitle}>3 Card Poker BOT</p>
              <div style={S.formGrid}>
                <label style={S.label}>
                  Room
                  <select style={S.input} value={tcRoomId} onChange={(e) => setTcRoomId(e.target.value)}>
                    <option value="3card-room-1">3CARD ROOM 1</option>
                    <option value="3card-room-2">3CARD ROOM 2</option>
                    <option value="3card-room-3">3CARD ROOM 3</option>
                  </select>
                </label>
                <label style={S.label}>
                  Count
                  <input
                    type="number"
                    min={1}
                    max={6}
                    style={S.input}
                    value={tcCount}
                    onChange={(e) => setTcCount(Number(e.target.value))}
                  />
                </label>
                <label style={S.label}>
                  Points
                  <input
                    type="number"
                    min={1}
                    step={100}
                    style={S.input}
                    value={tcPoints}
                    onChange={(e) => setTcPoints(Number(e.target.value))}
                  />
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
                <button style={S.createBtn} onClick={handleAddTcBot}>Add 3CP BOT</button>
                {tcBots.some(b => b.roomId === tcRoomId) && (
                  <button
                    style={{ ...S.createBtn, background: 'rgba(160,40,40,0.2)', color: '#f88' }}
                    onClick={() => handleRemoveTcBots(tcRoomId)}
                  >
                    Remove room BOTs
                  </button>
                )}
                {tcMsg && <span style={{ fontSize: 13, color: tcMsg.startsWith('✅') ? '#6f6' : '#f88' }}>{tcMsg}</span>}
              </div>
              {tcBots.length > 0 && (
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
                  {Array.from(new Set(tcBots.map(b => b.roomId))).map(roomId => (
                    <div key={roomId}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                        <span style={{ fontFamily: 'var(--font-title)', fontSize: 13, color: 'var(--gold)' }}>
                          {roomId} ({tcBots.filter(b => b.roomId === roomId).length})
                        </span>
                        <button
                          style={{ fontSize: 11, background: 'transparent', border: '1px solid #f66', color: '#f88', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
                          onClick={() => handleRemoveTcBots(roomId)}
                        >
                          Remove all
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                        {tcBots.filter(b => b.roomId === roomId).map(bot => (
                          <span key={bot.id} style={{ fontSize: 12, background: 'rgba(80,180,80,0.1)', border: '1px solid #4a4', borderRadius: 4, padding: '3px 10px', color: 'var(--cream)' }}>
                            {bot.name} / {bot.points} pt / {bot.phase}
                            <button
                              style={{ marginLeft: 8, fontSize: 11, background: 'transparent', border: 'none', color: '#f88', cursor: 'pointer' }}
                              onClick={() => handleRemoveTcBots(roomId, bot.id)}
                            >
                              x
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

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

        {/* ===== ブラインド設定 ===== */}
        {tab === 'loadtest' && (
          <div style={S.section}>
            <div style={S.card}>
              <h2 style={S.cardTitle}>負荷テスト</h2>
              <div style={{ fontSize: 12, color: 'var(--cream-dim)', fontFamily: 'var(--font-body)', lineHeight: 1.6, marginBottom: 12 }}>
                一時的な Socket.IO クライアントを起動します。接続のみ/観戦に加えて、テスト用Botアカウントでトーナメントへ実参加して自動プレイできます。
                開始にはサーバー環境変数 <code>LOAD_TEST_ENABLED=true</code> が必要です。
              </div>

              <div style={S.formGrid}>
                <label style={S.label}>
                  対象URL
                  <input style={S.input} value={loadForm.targetUrl} onChange={(e) => setLoadForm(f => ({ ...f, targetUrl: e.target.value }))} placeholder="空なら現在の管理画面ホスト" />
                </label>
                <label style={S.label}>
                  モード
                  <select style={S.input} value={loadForm.mode} onChange={(e) => setLoadForm(f => ({ ...f, mode: e.target.value as 'connect' | 'spectate' | 'tournament-player' }))}>
                    <option value="spectate">観戦</option>
                    <option value="connect">接続のみ</option>
                    <option value="tournament-player">トーナメント実参加</option>
                  </select>
                </label>
                <label style={S.label}>
                  接続数 / 参加Bot数
                  <input style={S.input} type="number" min={1} max={loadStatus?.maxBots ?? 50} value={loadForm.count} onChange={(e) => setLoadForm(f => ({ ...f, count: Number(e.target.value) }))} />
                </label>
                <label style={S.label}>
                  接続間隔(ms)
                  <input style={S.input} type="number" min={0} max={10000} value={loadForm.rampMs} onChange={(e) => setLoadForm(f => ({ ...f, rampMs: Number(e.target.value) }))} />
                </label>
                <label style={S.label}>
                  継続秒数
                  <input style={S.input} type="number" min={5} max={1800} value={loadForm.durationSec} onChange={(e) => setLoadForm(f => ({ ...f, durationSec: Number(e.target.value) }))} />
                </label>
                <label style={S.label}>
                  tableId（観戦時）
                  <input style={S.input} value={loadForm.tableId} onChange={(e) => setLoadForm(f => ({ ...f, tableId: e.target.value }))} placeholder="例: tournament-table-..." />
                </label>
                <label style={S.label}>
                  tournamentId（観戦/実参加時）
                  <input style={S.input} value={loadForm.tournamentId} onChange={(e) => setLoadForm(f => ({ ...f, tournamentId: e.target.value }))} placeholder="tableId未指定時に使用" />
                </label>
              </div>
              {loadForm.mode === 'tournament-player' && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#ffcc88', fontFamily: 'var(--font-body)', lineHeight: 1.6 }}>
                  実参加モードは tournamentId 必須です。BotはDBへ参加登録され、通常プレイヤーとして fold/check/call/bet/raise/draw を送信します。本番トーナメントでは使わず、テスト用トーナメントで実行してください。
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                <button style={S.createBtn} onClick={handleStartLoadTest}>開始</button>
                <button style={{ ...S.createBtn, background: '#8b1a1a' }} onClick={() => handleStopLoadTest()}>選択Run停止</button>
                <button style={{ ...S.createBtn, background: '#5a2020' }} onClick={handleStopAllLoadTests}>全停止</button>
                <button style={S.createBtn} onClick={() => fetchLoadStatus()}>更新</button>
                <button style={S.createBtn} onClick={() => handleExportLoadTest()}>Codex用出力</button>
              </div>

              {loadMsg && <div style={{ marginTop: 10, color: loadMsg.includes('失敗') || loadMsg.includes('設定') ? '#ff9999' : '#88dd88', fontSize: 13 }}>{loadMsg}</div>}
              <div style={{ marginTop: 10, fontSize: 12, color: loadStatus?.enabled ? '#88dd88' : '#ffcc88', fontFamily: 'var(--font-body)' }}>
                状態: {loadStatus?.enabled ? '有効' : '無効'} / 最大 {loadStatus?.maxBots ?? '-'} 接続
              </div>
            </div>

            <div style={S.card}>
              <h2 style={S.cardTitle}>実行中/履歴</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <select style={{ ...S.input, maxWidth: 420 }} value={loadSelectedRunId} onChange={(e) => { setLoadSelectedRunId(e.target.value); fetchLoadLogs(e.target.value); setLoadExport(null); }}>
                  <option value="">Runを選択</option>
                  {(loadStatus?.runs ?? []).map(run => (
                    <option key={run.id} value={run.id}>{run.id} / {run.status} / {run.config.mode} / {run.config.count}</option>
                  ))}
                </select>
              </div>

              {(loadStatus?.runs ?? []).filter(r => !loadSelectedRunId || r.id === loadSelectedRunId).slice(0, 1).map(run => (
                <div key={run.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 8, marginBottom: 12 }}>
                  {[
                    ['active', run.metrics.active],
                    ['connected', run.metrics.connected],
                    ['failed', run.metrics.connectFailed],
                    ['disconnect', run.metrics.disconnected],
                    ['gameState', run.metrics.gameStateReceived],
                    ['registered', run.metrics.tournamentRegistered ?? 0],
                    ['tables', run.metrics.tableJoins ?? 0],
                    ['actions', run.metrics.actionsSent ?? 0],
                    ['actErr', run.metrics.actionErrors ?? 0],
                    ['avg ms', run.metrics.avgLatencyMs ?? '-'],
                    ['max ms', run.metrics.maxLatencyMs ?? '-'],
                    ['errors', run.metrics.errors],
                  ].map(([k, v]) => (
                    <div key={String(k)} style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(201,168,76,0.18)', borderRadius: 6, padding: '8px 10px' }}>
                      <div style={{ color: 'var(--gold-dim)', fontSize: 11, fontFamily: 'var(--font-title)' }}>{k}</div>
                      <div style={{ color: 'var(--cream)', fontSize: 18, fontWeight: 700 }}>{String(v)}</div>
                    </div>
                  ))}
                </div>
              ))}

              <textarea
                readOnly
                style={{ ...S.input, minHeight: 260, fontFamily: 'Consolas, monospace', fontSize: 11, whiteSpace: 'pre' }}
                value={loadLogs.map(l => JSON.stringify(l)).join('\n')}
              />
            </div>

            {loadExport && (
              <div style={S.card}>
                <h2 style={S.cardTitle}>Codex解析用出力</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <label style={S.label}>
                    Markdown Summary
                    <textarea readOnly style={{ ...S.input, minHeight: 260, fontFamily: 'Consolas, monospace', fontSize: 11 }} value={loadExport.markdown} />
                  </label>
                  <label style={S.label}>
                    Raw JSONL
                    <textarea readOnly style={{ ...S.input, minHeight: 260, fontFamily: 'Consolas, monospace', fontSize: 11 }} value={loadExport.jsonl} />
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'blinds' && (
          <div style={S.section}>
            {blindMsg && (
              <div style={{ padding: '10px 16px', background: blindMsg.startsWith('✅') ? 'rgba(60,180,60,0.15)' : 'rgba(180,60,60,0.15)', border: `1px solid ${blindMsg.startsWith('✅') ? '#6f6' : '#f88'}`, borderRadius: 6, color: blindMsg.startsWith('✅') ? '#6f6' : '#f88', fontFamily: 'var(--font-title)', fontSize: 13 }}>
                {blindMsg}
              </div>
            )}

            {/* 既存スケジュール一覧 */}
            <div style={S.card}>
              <p style={S.cardTitle}>📋 ブラインドスケジュール一覧</p>
              {blindsLoading ? (
                <p style={{ color: 'var(--cream-dim)', fontSize: 13 }}>読み込み中...</p>
              ) : blindSchedules.length === 0 ? (
                <p style={{ color: 'var(--cream-dim)', fontSize: 13 }}>スケジュールがありません</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                  {blindSchedules.map(s => (
                    <div key={s.id} style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--gold-dim)', borderRadius: 8, padding: '16px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                        <span style={{ fontFamily: 'var(--font-title)', fontSize: 15, color: 'var(--gold)', flex: 1 }}>{s.name}</span>
                        <button style={{ fontSize: 12, background: 'rgba(100,160,255,0.1)', border: '1px solid #4af', color: '#9cf', borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}
                          onClick={() => setEditingSchedule(editingSchedule?.id === s.id ? null : s)}>
                          {editingSchedule?.id === s.id ? '閉じる' : '✏️ 編集'}
                        </button>
                        <button
                          style={{ fontSize: 12, background: s.isBuiltin ? 'rgba(100,100,100,0.1)' : 'rgba(200,60,60,0.1)', border: `1px solid ${s.isBuiltin ? '#555' : '#f66'}`, color: s.isBuiltin ? '#666' : '#f99', borderRadius: 4, padding: '3px 10px', cursor: s.isBuiltin ? 'not-allowed' : 'pointer' }}
                          onClick={() => !s.isBuiltin && setDeleteBlindConfirmId(s.id)}
                          title={s.isBuiltin ? '組み込みスケジュールは削除できません' : '削除'}>
                          🗑 削除{s.isBuiltin ? ' (不可)' : ''}
                        </button>
                      </div>
                      {s.description && <p style={{ fontSize: 12, color: 'var(--cream-dim)', margin: '0 0 8px' }}>{s.description}</p>}
                      <BlindLevelsTable levels={s.levels ?? []} />
                      {editingSchedule?.id === s.id && (
                        <BlindScheduleEditor
                          value={editingSchedule!}
                          onChange={(v) => setEditingSchedule(v as BlindSchedule)}
                          onSave={() => handleSaveSchedule(editingSchedule!)}
                          onCancel={() => setEditingSchedule(null)}
                          isEdit
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 新規スケジュール作成 */}
            <div style={S.card}>
              <p style={S.cardTitle}>➕ 新しいスケジュールを作成</p>
              <BlindScheduleEditor
                value={newSchedule}
                onChange={setNewSchedule}
                onSave={() => handleSaveSchedule(newSchedule)}
                onCancel={() => setNewSchedule({ name: '', description: '', levels: [defaultLevel()], lateLevelCutoff: 0 })}
                isEdit={false}
              />
            </div>
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

      {/* ===== ブラインドスケジュール削除確認モーダル ===== */}
      {deleteBlindConfirmId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }}
          onClick={() => setDeleteBlindConfirmId(null)}>
          <div style={{ background: 'linear-gradient(160deg,#0e1a0e,#061006)', border: '1px solid var(--gold-dim)', borderRadius: 14, padding: '36px 40px', maxWidth: 400, width: '90%', textAlign: 'center', boxShadow: '0 8px 48px rgba(0,0,0,0.8)' }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🗑</div>
            <h2 style={{ fontFamily: 'var(--font-title)', fontSize: 18, color: 'var(--gold)', letterSpacing: '0.08em', margin: '0 0 16px' }}>
              ブラインドスケジュールを削除
            </h2>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--cream)', lineHeight: 1.7, margin: '0 0 8px' }}>
              <strong style={{ color: 'var(--gold)' }}>{blindSchedules.find(s => s.id === deleteBlindConfirmId)?.name}</strong> を削除しますか？
            </p>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: '#ee8888', margin: '0 0 28px' }}>
              このスケジュールを使用しているトーナメントには影響しません。この操作は取り消せません。
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                style={{ background: 'transparent', border: '1px solid var(--gold-dim)', color: 'var(--cream-dim)', borderRadius: 6, padding: '10px 24px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-title)' }}
                onClick={() => setDeleteBlindConfirmId(null)}
              >キャンセル</button>
              <button
                style={{ background: 'linear-gradient(135deg,#8b1a1a,#5a1010)', border: '1px solid #cc4444', color: '#ffcccc', borderRadius: 6, padding: '10px 24px', fontSize: 13, cursor: deletingBlind ? 'wait' : 'pointer', fontFamily: 'var(--font-title)', fontWeight: 700 }}
                onClick={() => handleDeleteSchedule(deleteBlindConfirmId)}
                disabled={deletingBlind}
              >{deletingBlind ? '削除中...' : '削除する'}</button>
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

// ===== ブラインド設定サブコンポーネント =====

function BlindLevelsTable({ levels }: { levels: BlindScheduleLevel[] }) {
  if (!levels || levels.length === 0) return null;
  return (
    <div style={{ overflowX: 'auto' as const, marginTop: 4 }}>
      <table style={{ borderCollapse: 'collapse' as const, fontSize: 12, width: '100%' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(201,168,76,0.3)' }}>
            {['Lv', 'SB', 'BB', 'SBet', 'BBet', '分', ''].map(h => (
              <th key={h} style={{ padding: '4px 10px', fontFamily: 'var(--font-title)', color: 'var(--gold)', textAlign: 'center' as const, fontSize: 11 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {levels.map((lv, i) => (
            <tr key={i} style={{ background: lv.isBreak ? 'rgba(80,120,200,0.08)' : undefined, borderBottom: '1px solid rgba(201,168,76,0.08)' }}>
              <td style={{ padding: '3px 10px', color: lv.isBreak ? '#88aaff' : 'var(--gold)', textAlign: 'center' as const }}>{lv.isBreak ? '休憩' : `L${lv.level}`}</td>
              <td style={{ padding: '3px 10px', color: 'var(--cream)', textAlign: 'right' as const }}>{lv.isBreak ? '—' : lv.sb}</td>
              <td style={{ padding: '3px 10px', color: 'var(--cream)', textAlign: 'right' as const }}>{lv.isBreak ? '—' : lv.bb}</td>
              <td style={{ padding: '3px 10px', color: 'var(--cream)', textAlign: 'right' as const }}>{lv.isBreak ? '—' : lv.smallBet}</td>
              <td style={{ padding: '3px 10px', color: 'var(--cream)', textAlign: 'right' as const }}>{lv.isBreak ? '—' : lv.bigBet}</td>
              <td style={{ padding: '3px 10px', color: lv.durationMinutes === 0 ? 'var(--cream-dim)' : 'var(--cream)', textAlign: 'center' as const }}>{lv.durationMinutes === 0 ? '∞' : lv.isBreak ? `${lv.durationMinutes}m` : lv.durationMinutes}</td>
              <td style={{ padding: '3px 10px', color: '#88aaff', fontSize: 11 }}>{lv.isBreak ? (lv.breakLabel ?? 'Break') : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ScheduleEditValue { id?: string; name: string; description: string | null; levels: BlindScheduleLevel[]; lateLevelCutoff: number }
function BlindScheduleEditor({ value, onChange, onSave, onCancel, isEdit }: {
  value: ScheduleEditValue;
  onChange: (v: ScheduleEditValue) => void;
  onSave: () => void;
  onCancel: () => void;
  isEdit: boolean;
}) {
  const inp: React.CSSProperties = { background: 'rgba(0,0,0,0.4)', border: '1px solid var(--gold-dim)', borderRadius: 4, color: 'var(--cream)', fontSize: 13, padding: '6px 8px', fontFamily: 'var(--font-body)', outline: 'none', width: '100%', boxSizing: 'border-box' as const };
  const numInp: React.CSSProperties = { ...inp, width: 70, textAlign: 'right' as const };

  const updateLevel = (i: number, key: keyof BlindScheduleLevel, val: number | boolean | string | null) => {
    const levels = value.levels.map((lv, idx) => idx === i ? { ...lv, [key]: val } : lv);
    onChange({ ...value, levels });
  };

  const addLevel = (isBreak = false) => {
    const last = value.levels.filter(l => !l.isBreak).pop();
    const nextLv = (last?.level ?? 0) + 1;
    const newLv: BlindScheduleLevel = isBreak
      ? { level: null, sb: 0, bb: 0, smallBet: 0, bigBet: 0, durationMinutes: 15, isBreak: true, breakLabel: 'Break' }
      : { level: nextLv, sb: (last?.bb ?? 0) * 2 || 10, bb: (last?.bb ?? 0) * 4 || 20, smallBet: (last?.bigBet ?? 0) * 2 || 20, bigBet: (last?.bigBet ?? 0) * 4 || 40, durationMinutes: 15 };
    onChange({ ...value, levels: [...value.levels, newLv] });
  };

  const removeLevel = (i: number) => onChange({ ...value, levels: value.levels.filter((_, idx) => idx !== i) });
  const moveLevel = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.levels.length) return;
    const levels = [...value.levels];
    [levels[i], levels[j]] = [levels[j], levels[i]];
    onChange({ ...value, levels });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12, marginTop: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold-dim)' }}>
          スケジュール名
          <input style={inp} value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} placeholder="例: スタンダード20分" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold-dim)' }}>
          説明
          <input style={inp} value={value.description ?? ''} onChange={e => onChange({ ...value, description: e.target.value })} placeholder="例: 20分ごとブラインドアップ" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, fontFamily: 'var(--font-title)', fontSize: 11, color: 'var(--gold-dim)' }}>
          レイトレジスト終了レベル
          <span style={{ color: 'var(--cream-dim)', fontSize: 10, fontWeight: 'normal' }}>※時間ベース管理の場合は無効 / 0 = 開始直後に終了</span>
          <input style={{ ...numInp, width: '100%', textAlign: 'left' as const }} type="number" min={0} value={value.lateLevelCutoff ?? 0}
            onChange={e => onChange({ ...value, lateLevelCutoff: Number(e.target.value) })} />
        </label>
      </div>

      <div style={{ overflowX: 'auto' as const }}>
        <table style={{ borderCollapse: 'collapse' as const, fontSize: 12, width: '100%', minWidth: 600 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(201,168,76,0.3)' }}>
              {['', 'Lv', 'SB', 'BB', 'SmallBet', 'BigBet', '分', '休憩', 'ラベル', ''].map((h, i) => (
                <th key={i} style={{ padding: '4px 6px', fontFamily: 'var(--font-title)', color: 'var(--gold)', fontSize: 11, whiteSpace: 'nowrap' as const }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.levels.map((lv, i) => (
              <tr key={i} style={{ borderBottom: '1px solid rgba(201,168,76,0.08)', background: lv.isBreak ? 'rgba(80,120,200,0.06)' : undefined }}>
                <td style={{ padding: '3px 4px', whiteSpace: 'nowrap' as const }}>
                  <button style={{ background: 'none', border: 'none', color: 'var(--cream-dim)', cursor: 'pointer', padding: '0 2px', fontSize: 12 }} onClick={() => moveLevel(i, -1)}>▲</button>
                  <button style={{ background: 'none', border: 'none', color: 'var(--cream-dim)', cursor: 'pointer', padding: '0 2px', fontSize: 12 }} onClick={() => moveLevel(i, 1)}>▼</button>
                </td>
                <td style={{ padding: '3px 4px' }}>
                  {lv.isBreak ? <span style={{ color: '#88aaff', fontSize: 11 }}>休憩</span>
                    : <input style={{ ...numInp, width: 40 }} type="number" value={lv.level ?? ''} onChange={e => updateLevel(i, 'level', e.target.value === '' ? null : Number(e.target.value))} />}
                </td>
                {(['sb','bb','smallBet','bigBet'] as const).map(k => (
                  <td key={k} style={{ padding: '3px 4px' }}>
                    {lv.isBreak ? <span style={{ color: 'var(--cream-dim)' }}>—</span>
                      : <input style={numInp} type="number" value={lv[k]} onChange={e => updateLevel(i, k, Number(e.target.value))} />}
                  </td>
                ))}
                <td style={{ padding: '3px 4px' }}>
                  <input style={numInp} type="number" value={lv.durationMinutes} onChange={e => updateLevel(i, 'durationMinutes', Number(e.target.value))} />
                </td>
                <td style={{ padding: '3px 4px', textAlign: 'center' as const }}>
                  <input type="checkbox" checked={!!lv.isBreak} onChange={e => updateLevel(i, 'isBreak', e.target.checked)} />
                </td>
                <td style={{ padding: '3px 4px' }}>
                  {lv.isBreak && <input style={{ ...inp, width: 90 }} value={lv.breakLabel ?? ''} onChange={e => updateLevel(i, 'breakLabel', e.target.value)} placeholder="Break" />}
                </td>
                <td style={{ padding: '3px 4px' }}>
                  <button style={{ background: 'none', border: 'none', color: '#f88', cursor: 'pointer', fontSize: 14 }} onClick={() => removeLevel(i)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
        <button style={{ fontSize: 12, background: 'rgba(60,180,60,0.12)', border: '1px solid #6a6', color: '#8f8', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }} onClick={() => addLevel(false)}>
          ＋ レベル追加
        </button>
        <button style={{ fontSize: 12, background: 'rgba(80,120,200,0.12)', border: '1px solid #66a', color: '#aaf', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }} onClick={() => addLevel(true)}>
          ＋ 休憩追加
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button style={{ background: 'linear-gradient(135deg, var(--gold), var(--gold-dim))', border: 'none', borderRadius: 6, color: '#1a1200', fontSize: 13, fontWeight: 700, padding: '8px 20px', cursor: 'pointer', fontFamily: 'var(--font-title)' }}
          onClick={onSave}>
          {isEdit ? '💾 更新' : '✅ 作成'}
        </button>
        <button style={{ background: 'transparent', border: '1px solid var(--gold-dim)', color: 'var(--cream-dim)', borderRadius: 6, padding: '8px 16px', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-title)' }}
          onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

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
