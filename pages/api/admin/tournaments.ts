/**
 * pages/api/admin/tournaments.ts — トーナメント管理 API
 *
 * GET    /api/admin/tournaments              トーナメント一覧
 * POST   /api/admin/tournaments              トーナメント作成
 * PATCH  /api/admin/tournaments              ステータス変更
 * GET    /api/admin/tournaments?type=schedules  ブラインドスケジュール一覧
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { withAdminAuth } from '../../../lib/auth';
import {
  listTournaments, createTournament,
  updateTournamentStatus, deleteTournament, listBlindSchedules,
  createBlindSchedule, updateBlindSchedule, deleteBlindSchedule,
} from '../../../lib/db';
import { randomUUID } from 'crypto';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ブラインドスケジュール CRUD
  if (req.query.type === 'schedules') {
    if (req.method === 'GET') {
      const schedules = await listBlindSchedules();
      return res.status(200).json({ schedules });
    }
    if (req.method === 'POST') {
      const { name, description, levels, lateLevelCutoff } = req.body as { name?: string; description?: string; levels?: unknown; lateLevelCutoff?: number };
      if (!name?.trim() || !Array.isArray(levels) || levels.length === 0)
        return res.status(400).json({ error: 'name と levels は必須です' });
      const row = await createBlindSchedule({ name: name.trim(), description, levels, lateLevelCutoff: lateLevelCutoff ?? 0 });
      return res.status(200).json({ schedule: row });
    }
    if (req.method === 'PUT') {
      const id = req.query.id as string;
      if (!id) return res.status(400).json({ error: 'id が必要です' });
      const { name, description, levels, lateLevelCutoff } = req.body as { name?: string; description?: string; levels?: unknown; lateLevelCutoff?: number };
      if (!name?.trim() || !Array.isArray(levels) || levels.length === 0)
        return res.status(400).json({ error: 'name と levels は必須です' });
      try {
        const row = await updateBlindSchedule(id, { name: name.trim(), description, levels, lateLevelCutoff: lateLevelCutoff ?? 0 });
        if (!row) return res.status(404).json({ error: 'スケジュールが見つかりません' });
        return res.status(200).json({ schedule: row });
      } catch (e: unknown) {
        const err = e as { message?: string };
        return res.status(500).json({ error: err.message ?? '更新に失敗しました' });
      }
    }
    if (req.method === 'DELETE') {
      const id = req.query.id as string;
      if (!id) return res.status(400).json({ error: 'id が必要です' });
      try {
        const row = await deleteBlindSchedule(id);
        if (!row) return res.status(404).json({ error: 'スケジュールが見つかりません' });
        return res.status(200).json({ ok: true });
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string };
        if (err.code === 'BUILTIN_SCHEDULE') {
          return res.status(400).json({ error: err.message ?? '組み込みスケジュールは削除できません' });
        }
        throw e;
      }
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // GET: トーナメント一覧
  if (req.method === 'GET') {
    const limit  = Math.min(Number(req.query.limit  ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const tournaments = await listTournaments({ limit, offset });
    return res.status(200).json({ tournaments });
  }

  // POST: トーナメント作成
  if (req.method === 'POST') {
    const session = await getServerSession(req, res, authOptions);
    const {
      name, mode, scheduledStartAt,
      startingChips, maxPlayers, blindScheduleId, isTest, lateRegMinutes,
    } = req.body as {
      name?: string; mode?: string; scheduledStartAt?: string;
      startingChips?: number; maxPlayers?: number;
      blindScheduleId?: string; isTest?: boolean; lateRegMinutes?: number;
    };

    if (!name?.trim() || !mode || !scheduledStartAt || !startingChips) {
      return res.status(400).json({ error: 'name / mode / scheduledStartAt / startingChips は必須です' });
    }

    const VALID_MODES = ['27', 'badugi', 'mix'];
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode は ${VALID_MODES.join(' / ')} のいずれかです` });
    }

    if (startingChips < 100 || startingChips > 1_000_000) {
      return res.status(400).json({ error: 'startingChips は 100〜1,000,000 の範囲で設定してください' });
    }

    const tournament = await createTournament({
      id:               randomUUID(),
      name:             name.trim(),
      mode,
      scheduledStartAt: new Date(scheduledStartAt),
      startingChips,
      maxPlayers,
      blindScheduleId,
      isTest:           isTest ?? false,
      lateRegMinutes:   lateRegMinutes ?? 0,
      createdBy:        session!.user!.accountId!,
    });
    return res.status(201).json({ tournament });
  }

  // PATCH: ステータス変更
  if (req.method === 'PATCH') {
    const { tournamentId, status } = req.body as { tournamentId?: string; status?: string };
    const VALID_STATUSES = ['registering', 'running', 'finished', 'cancelled'];
    if (!tournamentId || !status) {
      return res.status(400).json({ error: 'tournamentId と status は必須です' });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status は ${VALID_STATUSES.join(' / ')} のいずれかです` });
    }
    const row = await updateTournamentStatus(tournamentId, status);
    if (!row) return res.status(404).json({ error: 'トーナメントが見つかりません' });
    return res.status(200).json({ id: row.id, status: row.status });
  }

  // DELETE: トーナメント削除
  if (req.method === 'DELETE') {
    const { tournamentId } = req.body as { tournamentId?: string };
    if (!tournamentId) {
      return res.status(400).json({ error: 'tournamentId は必須です' });
    }
    // running 中は削除不可
    const [target] = await listTournaments({ limit: 1, offset: 0 }).then(
      (rows) => rows.filter((r) => r.id === tournamentId)
    );
    if (!target) return res.status(404).json({ error: 'トーナメントが見つかりません' });
    if (target.status === 'running') {
      return res.status(400).json({ error: '進行中のトーナメントは削除できません。先にキャンセルまたは終了してください。' });
    }
    const deleted = await deleteTournament(tournamentId);
    if (!deleted) return res.status(404).json({ error: '削除に失敗しました' });
    return res.status(200).json({ ok: true, id: deleted.id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withAdminAuth(handler);
