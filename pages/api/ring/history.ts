/**
 * pages/api/ring/history.ts
 * GET /api/ring/history?limit=1000
 * → { history: [{hand_seq, net, cumulative, mode, played_at}] }
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';

const ringDb = require('../../../server/db/ring');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.accountId) return res.status(401).json({ error: 'Unauthorized' });

  const limit = Math.min(Number(req.query.limit ?? 1000), 5000);

  try {
    const history = await ringDb.getRingHistory(session.user.accountId, limit);
    return res.status(200).json({ history });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
}
