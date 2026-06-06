/**
 * pages/api/auth/socket-token.ts — Socket.IO 認証用トークン発行
 *
 * Socket.IO の handshake.auth.token として使用する短命トークンを発行する。
 * GET /api/auth/socket-token
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getToken } from 'next-auth/jwt';
import { createHmac } from 'crypto';

function signSocketPayload(payload: string) {
  return createHmac('sha256', process.env.NEXTAUTH_SECRET!).update(payload).digest('base64url');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET!,
  });

  if (!token?.accountId || typeof token.accountId !== 'string') {
    return res.status(401).json({ error: '未ログインです' });
  }

  const payload = Buffer.from(JSON.stringify({
    accountId: token.accountId,
    exp: Math.floor(Date.now() / 1000) + 120,
  })).toString('base64url');
  const sig = signSocketPayload(payload);

  res.status(200).json({ token: `socket:${payload}.${sig}` });
}
