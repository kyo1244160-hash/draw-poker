/**
 * pages/api/tournaments.ts — トーナメント公開 API
 *
 * GET /api/tournaments
 *   テスト用・キャンセル済みを除いたトーナメント一覧を返す。
 *   認証不要。
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { listTournaments } from '../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const all = await listTournaments({ limit: 50 });
    const public_ = all.filter((t) => t.status !== 'cancelled');
    return res.status(200).json({ tournaments: public_ });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/tournaments] ❌ エラー:', msg);
    return res.status(500).json({ error: msg, tournaments: [] });
  }
}
