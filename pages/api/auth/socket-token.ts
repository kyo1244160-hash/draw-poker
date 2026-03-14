/**
 * pages/api/auth/socket-token.ts — Socket.IO 認証用トークン発行
 *
 * NextAuth の生 JWT を返す。Socket.IO の handshake.auth.token として使用する。
 * GET /api/auth/socket-token
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getToken } from 'next-auth/jwt';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET!,
    raw: true,          // 生の JWT 文字列を返す
  });

  if (!raw) {
    return res.status(401).json({ error: '未ログインです' });
  }

  // トークンの有効期限は NextAuth の session.maxAge（24h）と同じ
  res.status(200).json({ token: raw });
}
