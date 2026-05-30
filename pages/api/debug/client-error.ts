/**
 * pages/api/debug/client-error.ts
 * クライアントサイドのエラーをサーバーログに記録するエンドポイント
 * GameErrorBoundary と window.onerror から POST される
 *
 * Render ダッシュボール Logs で [CLIENT-ERROR] を検索して確認
 */

import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      label     = 'unknown',
      message   = '',
      stack     = '',
      component = '',
      url       = '',
      ua        = '',
      ts        = new Date().toISOString(),
      extra     = {},
    } = req.body ?? {};

    // Render ダッシュボールで検索しやすいプレフィックス
    console.error(`[CLIENT-ERROR] ========================================`);
    console.error(`[CLIENT-ERROR] label     : ${label}`);
    console.error(`[CLIENT-ERROR] ts        : ${ts}`);
    console.error(`[CLIENT-ERROR] message   : ${message}`);
    console.error(`[CLIENT-ERROR] url       : ${url}`);
    console.error(`[CLIENT-ERROR] ua        : ${ua}`);
    if (Object.keys(extra).length > 0) {
      console.error(`[CLIENT-ERROR] extra     :`, JSON.stringify(extra));
    }
    console.error(`[CLIENT-ERROR] --- Stack ---`);
    // stack が長いので10行ずつ出力
    const stackLines = String(stack).split('\n');
    stackLines.slice(0, 20).forEach(line => console.error(`[CLIENT-ERROR]   ${line}`));
    if (stackLines.length > 20) {
      console.error(`[CLIENT-ERROR]   ... (${stackLines.length - 20} more lines)`);
    }
    if (component) {
      console.error(`[CLIENT-ERROR] --- Component Stack ---`);
      String(component).split('\n').slice(0, 10).forEach(line =>
        console.error(`[CLIENT-ERROR]   ${line}`)
      );
    }
    console.error(`[CLIENT-ERROR] ========================================`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[CLIENT-ERROR] Failed to log client error:', err);
    return res.status(500).json({ error: 'Failed to log' });
  }
}
