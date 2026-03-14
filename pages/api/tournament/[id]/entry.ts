/**
 * pages/api/tournament/[id]/entry.ts — 参加登録・キャンセル API
 *
 * GET    /api/tournament/[id]/entry  → 参加状況確認
 * POST   /api/tournament/[id]/entry  → 参加登録
 * DELETE /api/tournament/[id]/entry  → キャンセル
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../auth/[...nextauth]';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tournamentDb = require('../../../../server/db/tournament');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.accountId) {
    return res.status(401).json({ error: '未ログインです' });
  }

  const tournamentId = req.query.id as string;
  const accountId    = session.user.accountId;

  try {
    // GET: 参加状況確認
    if (req.method === 'GET') {
      const [registered, entries, tournament] = await Promise.all([
        tournamentDb.isRegistered(tournamentId, accountId),
        tournamentDb.getEntries(tournamentId),
        tournamentDb.getTournament(tournamentId),
      ]);
      return res.status(200).json({ registered, entries, tournament });
    }

    // POST: 参加登録
    if (req.method === 'POST') {
      await tournamentDb.registerEntry(tournamentId, accountId);
      const entries = await tournamentDb.getEntries(tournamentId);
      return res.status(200).json({ ok: true, entries });
    }

    // DELETE: キャンセル
    if (req.method === 'DELETE') {
      const row = await tournamentDb.cancelEntry(tournamentId, accountId);
      if (!row) return res.status(404).json({ error: '登録が見つかりません' });
      const entries = await tournamentDb.getEntries(tournamentId);
      return res.status(200).json({ ok: true, entries });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'エラーが発生しました';
    return res.status(400).json({ error: message });
  }
}
