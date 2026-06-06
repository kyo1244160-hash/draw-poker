/**
 * pages/api/ranking.ts — ポイントランキング公開 API
 *
 * GET /api/ranking?limit=20
 *   → { ranking: [...], pointTable: [100, 60, 40, 25, 15] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getPointsRanking, POINT_TABLE } from '../../lib/db';

function parseLimit(value: unknown, fallback: number, max: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const limit   = parseLimit(req.query.limit, 20, 100);
  const ranking = await getPointsRanking({ limit });

  return res.status(200).json({ ranking, pointTable: POINT_TABLE });
}
