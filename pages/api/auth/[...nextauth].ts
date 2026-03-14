/**
 * pages/api/auth/[...nextauth].ts — NextAuth.js 設定
 */

import NextAuth, { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { upsertAccount, getNickname } from '../../../lib/db';

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId:     process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],

  session: {
    strategy: 'jwt',
    maxAge:   24 * 60 * 60,
  },

  callbacks: {
    async signIn({ user }) {
      console.log('[NextAuth] signIn 開始 - user.id:', user.id, 'email:', user.email);
      try {
        await upsertAccount({
          id:         user.id,
          email:      user.email!,
          googleName: user.name ?? undefined,
        });
        console.log('[NextAuth] signIn 成功 - upsertAccount OK');
        return true;
      } catch (err) {
        console.error('[NextAuth] ❌ signIn エラー:', err);
        return false;
      }
    },

    async jwt({ token, user }) {
      if (user) {
        token.accountId = user.id;
        console.log('[NextAuth] jwt - accountId set:', user.id);
      }
      return token;
    },

    async session({ session, token }) {
      const accountId = token.accountId as string | undefined;
      console.log('[NextAuth] session callback - accountId:', accountId);
      if (accountId) {
        session.user.accountId = accountId;
        try {
          session.user.nickname = await getNickname(accountId) ?? undefined;
          console.log('[NextAuth] session - nickname:', session.user.nickname ?? '(未設定)');
        } catch (err) {
          console.error('[NextAuth] ❌ getNickname エラー:', err);
        }
      }
      return session;
    },
  },

  pages: {
    error: '/',
  },
};

export default NextAuth(authOptions);
