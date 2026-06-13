/**
 * pages/api/admin/users.ts — ユーザー管理 API
 *
 * GET  /api/admin/users               ユーザー一覧
 * POST /api/admin/users/nickname      ニックネーム強制変更
 * DELETE /api/admin/users             ユーザー削除
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { withAdminAuth } from '../../../lib/auth';
import { authOptions } from '../auth/[...nextauth]';
import { listUsers, forceChangeNickname, deleteUsers } from '../../../lib/db';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // GET: ユーザー一覧
  if (req.method === 'GET') {
    const limit  = Math.min(Number(req.query.limit  ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const { users, total } = await listUsers({ limit, offset });
    return res.status(200).json({ users, total });
  }

  // POST: ニックネーム強制変更
  if (req.method === 'POST') {
    const { accountId, nickname } = req.body as { accountId?: string; nickname?: string };
    if (!accountId || !nickname?.trim()) {
      return res.status(400).json({ error: 'accountId と nickname は必須です' });
    }
    const row = await forceChangeNickname(accountId, nickname.trim());
    if (!row) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    return res.status(200).json({ nickname: row.nickname });
  }

  // DELETE: 選択ユーザー削除
  if (req.method === 'DELETE') {
    const { accountIds } = req.body as { accountIds?: unknown };
    const ids = Array.isArray(accountIds)
      ? [...new Set(accountIds.filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim()))]
      : [];
    if (ids.length === 0) {
      return res.status(400).json({ error: '削除するユーザーを選択してください' });
    }
    if (ids.length > 100) {
      return res.status(400).json({ error: '一度に削除できるユーザーは100人までです' });
    }

    const session = await getServerSession(req, res, authOptions);
    const selfId = session?.user?.accountId;
    if (selfId && ids.includes(selfId)) {
      return res.status(400).json({ error: '自分自身は削除できません' });
    }

    try {
      const result = await deleteUsers(ids);
      return res.status(200).json({ deletedIds: result.deletedIds, deletedCount: result.deletedIds.length });
    } catch (e: unknown) {
      const err = e as { code?: string; accountIds?: string[]; message?: string };
      if (err.code === 'ACTIVE_TOURNAMENT_USER') {
        return res.status(409).json({
          error: '進行中トーナメントの参加者は削除できません',
          accountIds: err.accountIds ?? [],
        });
      }
      return res.status(500).json({ error: err.message ?? 'ユーザー削除に失敗しました' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withAdminAuth(handler);
