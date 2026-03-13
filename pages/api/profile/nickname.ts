/**
 * pages/api/profile/nickname.ts — ニックネーム設定・変更
 *
 * POST /api/profile/nickname  { nickname: string }
 *   → 201: 初回設定成功
 *   → 200: 変更成功
 *   → 400: バリデーションエラー
 *   → 401: 未ログイン
 *   → 409: ニックネーム重複
 *   → 429: 30日制限
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { getProfile, isNicknameTaken, setNicknameFirst, updateNickname } from '../../../lib/db';

// 使用可能文字: ひらがな・カタカナ・漢字・英数字・_ - .（2〜12文字）
// es5 ターゲットのため \p{L} は使わず明示的な Unicode 範囲で指定
const NICKNAME_RE = new RegExp(
  '^[a-zA-Z0-9'
  + '\u3040-\u309F'  // ひらがな
  + '\u30A0-\u30FF'  // カタカナ
  + '\u4E00-\u9FFF'  // CJK統合漢字
  + '\u3400-\u4DBF'  // CJK拡張A
  + '_\\-.]{2,12}$'
);

// サーバー側のprofanityチェック（既存モジュールを流用）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkText } = require('../../../server/profanityFilter');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.accountId) {
    return res.status(401).json({ error: '未ログインです' });
  }

  const { nickname } = req.body as { nickname?: unknown };

  // ── バリデーション ──────────────────────────────
  if (typeof nickname !== 'string') {
    return res.status(400).json({ error: 'ニックネームを入力してください' });
  }

  const trimmed = nickname.trim();

  if (!NICKNAME_RE.test(trimmed)) {
    return res.status(400).json({
      error: 'ニックネームは2〜12文字で入力してください（使用可能: 日本語・英数字・_ - .）',
    });
  }

  const profanity = checkText(trimmed);
  if (!profanity.ok) {
    return res.status(400).json({ error: profanity.reason });
  }

  // ── 重複チェック ────────────────────────────────
  const taken = await isNicknameTaken(trimmed);
  if (taken) {
    return res.status(409).json({ error: 'そのニックネームは既に使われています' });
  }

  // ── 初回設定 or 変更 ────────────────────────────
  const accountId = session.user.accountId;
  const profile   = await getProfile(accountId);

  if (!profile) {
    // 初回設定（change_count はカウントしない）
    await setNicknameFirst(accountId, trimmed);
    return res.status(201).json({ nickname: trimmed });
  }

  // 変更: 30日制限チェック
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const elapsed        = Date.now() - new Date(profile.nickname_updated_at).getTime();

  if (elapsed < THIRTY_DAYS_MS) {
    const daysLeft = Math.ceil((THIRTY_DAYS_MS - elapsed) / (24 * 60 * 60 * 1000));
    return res.status(429).json({
      error: `ニックネームは30日に1回しか変更できません（あと${daysLeft}日）`,
    });
  }

  const updated = await updateNickname(accountId, trimmed);
  return res.status(200).json({ nickname: updated.nickname });
}
