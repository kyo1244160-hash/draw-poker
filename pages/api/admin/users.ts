/**
 * pages/api/admin/users.ts — ユーザー管理 API
 *
 * GET  /api/admin/users               ユーザー一覧
 * POST /api/admin/users/nickname      ニックネーム強制変更
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAdminAuth } from '../../../lib/auth';
import { listUsers, forceChangeNickname } from '../../../lib/db';

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

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withAdminAuth(handler);
