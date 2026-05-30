/**
 * pages/api/debug/client-error.ts
 * クライアントサイドのエラーをサーバーログに記録するエンドポイント
 * GameErrorBoundary と window.onerror から POST される
 *
 * Render ダッシュボール Logs で [CLIENT-ERROR] を検索して確認
 *
 * セキュリティ: 無認証エンドポイントのため、IP単位のレートリミットと
 * ペイロードサイズ制限でログ溢れ（DoS）を防止する。
 */

import type { NextApiRequest, NextApiResponse } from 'next';

// IP単位のレートリミット（メモリ内・プロセス再起動でリセット）
// 本番で複数インスタンスの場合は各インスタンスごとに独立だが、
// 1インスタンスあたりのログ溢れは防げる。
const RATE_WINDOW_MS = 10_000; // 10秒
const RATE_MAX = 5;            // 10秒あたり最大5件/IP
const _hits = new Map<string, number[]>();

// メモリリーク防止: 古いエントリを定期削除
let _lastSweep = Date.now();
function _sweep(now: number) {
  if (now - _lastSweep < 60_000) return;
  _lastSweep = now;
  for (const [ip, times] of _hits.entries()) {
    const recent = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) _hits.delete(ip);
    else _hits.set(ip, recent);
  }
}

function _rateLimited(ip: string): boolean {
  const now = Date.now();
  _sweep(now);
  const times = (_hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_MAX) return true;
  times.push(now);
  _hits.set(ip, times);
  return false;
}

// 文字列を安全な長さに切り詰める
function _truncate(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : String(v ?? '');
  return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // クライアントIPを取得（プロキシ経由を考慮）
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]?.trim()) || req.socket.remoteAddress || 'unknown';

  if (_rateLimited(ip)) {
    // ログには記録しない（溢れ防止）。429 を返すのみ。
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const body = req.body ?? {};
    // ペイロードサイズ制限（各フィールド上限を設けてログ溢れを防止）
    const label     = _truncate(body.label, 100);
    const message   = _truncate(body.message, 500);
    const stack     = _truncate(body.stack, 4000);
    const component = _truncate(body.component, 2000);
    const url       = _truncate(body.url, 300);
    const ua        = _truncate(body.ua, 300);
    const ts        = _truncate(body.ts || new Date().toISOString(), 40);
    const extra     = body.extra && typeof body.extra === 'object' ? body.extra : {};

    console.error(`[CLIENT-ERROR] ========================================`);
    console.error(`[CLIENT-ERROR] label     : ${label}`);
    console.error(`[CLIENT-ERROR] ts        : ${ts}`);
    console.error(`[CLIENT-ERROR] ip        : ${ip}`);
    console.error(`[CLIENT-ERROR] message   : ${message}`);
    console.error(`[CLIENT-ERROR] url       : ${url}`);
    console.error(`[CLIENT-ERROR] ua        : ${ua}`);
    const extraKeys = Object.keys(extra);
    if (extraKeys.length > 0) {
      console.error(`[CLIENT-ERROR] extra     :`, _truncate(JSON.stringify(extra), 1000));
    }
    console.error(`[CLIENT-ERROR] --- Stack ---`);
    stack.split('\n').slice(0, 20).forEach((line) => console.error(`[CLIENT-ERROR]   ${line}`));
    if (component) {
      console.error(`[CLIENT-ERROR] --- Component Stack ---`);
      component.split('\n').slice(0, 10).forEach((line) => console.error(`[CLIENT-ERROR]   ${line}`));
    }
    console.error(`[CLIENT-ERROR] ========================================`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[CLIENT-ERROR] Failed to log client error:', err);
    return res.status(500).json({ error: 'Failed to log' });
  }
}
