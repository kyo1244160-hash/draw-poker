/**
 * pages/api/profile/me.ts — 自分のプロフィール取得
 *
 * GET /api/profile/me
 *   → { accountId, nickname, canChangeNickname, daysUntilChange }
 *
 * ニックネーム未設定の場合は nickname: null を返す。
 * 未ログインの場合は 401 を返す。
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { getProfile } from '../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.accountId) {
    return res.status(401).json({ error: '未ログインです' });
  }

  const profile = await getProfile(session.user.accountId);

  if (!profile) {
    // ニックネーム未設定
    return res.status(200).json({
      accountId:          session.user.accountId,
      nickname:           null,
      canChangeNickname:  true,
      daysUntilChange:    0,
    });
  }

  // 30日制限チェック
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const lastChanged    = new Date(profile.nickname_updated_at).getTime();
  const elapsed        = Date.now() - lastChanged;
  const canChange      = profile.change_count === 0 || elapsed >= THIRTY_DAYS_MS;
  const daysUntilChange = canChange
    ? 0
    : Math.ceil((THIRTY_DAYS_MS - elapsed) / (24 * 60 * 60 * 1000));

  return res.status(200).json({
    accountId:         session.user.accountId,
    nickname:          profile.nickname,
    canChangeNickname: canChange,
    daysUntilChange,
  });
}
