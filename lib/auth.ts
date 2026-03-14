/**
 * lib/auth.ts — 認証・認可ヘルパー
 *
 * withAdminAuth: 管理者専用 API Route に必ずかけるラッパー。
 * 未ログイン → 401、非管理者 → 403 を返す。
 */

import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../pages/api/auth/[...nextauth]';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminDb = require('../server/db/admin');

/**
 * 管理者専用ハンドラーラッパー。
 * 使い方: export default withAdminAuth(handler)
 */
export function withAdminAuth(handler: NextApiHandler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const session = await getServerSession(req, res, authOptions);

    if (!session?.user?.accountId) {
      return res.status(401).json({ error: '未ログインです' });
    }

    const isAdmin = await adminDb.isAdmin(session.user.accountId);
    if (!isAdmin) {
      return res.status(403).json({ error: '管理者権限が必要です' });
    }

    return handler(req, res);
  };
}
