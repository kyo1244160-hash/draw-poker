/**
 * pages/api/profile/points.ts
 * GET /api/profile/points
 * → { points: number }
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { getUserPoints } from '../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.accountId) return res.status(401).json({ error: 'Unauthorized' });

  const points = await getUserPoints(session.user.accountId);
  return res.status(200).json({ points });
}
