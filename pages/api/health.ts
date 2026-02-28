/**
 * pages/api/health.ts — ヘルスチェックエンドポイント
 * Render.com のヘルスチェックに使用します。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ status: 'ok', service: 'Poker Room Pastis' });
}
