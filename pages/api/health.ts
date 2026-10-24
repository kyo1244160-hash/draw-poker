/**
 * pages/api/health.ts — ヘルスチェックエンドポイント
 * Render.com のヘルスチェックに使用します。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
const { getHealthStatus } = require('../../server/security/healthStatus');
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const health = getHealthStatus();
  res.status(health.ok ? 200 : 503).json(health);
}
