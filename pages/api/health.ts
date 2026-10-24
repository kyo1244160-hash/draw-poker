/**
 * pages/api/health.ts — ヘルスチェックエンドポイント
 * Render.com のヘルスチェックに使用します。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
const { isSupportedNode } = require('../../server/security/runtimeVersion');
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const runtimeSupported = isSupportedNode();
  res.status(runtimeSupported ? 200 : 503).json({
    status: runtimeSupported ? 'ok' : 'runtime_unsupported',
    service: 'Poker Room Pastis',
    revision: process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? null,
    runtimeSupported,
  });
}
