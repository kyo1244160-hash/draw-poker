/**
 * pages/api/ring/stats.ts
 * GET /api/ring/stats
 * → { summary: { net, hands }, byMode: [{mode, net, hands}] }
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';

const ringDb = require('../../../server/db/ring');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.accountId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [summary, byMode] = await Promise.all([
      ringDb.getRingSummary(session.user.accountId),
      ringDb.getRingStatsByMode(session.user.accountId),
    ]);
    return res.status(200).json({ summary, byMode });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
}
