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
  updateTournamentStatus, listBlindSchedules,
} from '../../../lib/db';
import { randomUUID } from 'crypto';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ブラインドスケジュール一覧
  if (req.method === 'GET' && req.query.type === 'schedules') {
    const schedules = await listBlindSchedules();
    return res.status(200).json({ schedules });
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
      startingChips, maxPlayers, blindScheduleId, isTest,
    } = req.body as {
      name?: string; mode?: string; scheduledStartAt?: string;
      startingChips?: number; maxPlayers?: number;
      blindScheduleId?: string; isTest?: boolean;
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

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withAdminAuth(handler);
