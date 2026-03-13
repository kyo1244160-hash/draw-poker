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
      try {
        await upsertAccount({
          id:         user.id,
          email:      user.email!,
          googleName: user.name ?? undefined,
        });
        return true;
      } catch (err) {
        console.error('[NextAuth] signIn error:', err);
        return false;
      }
    },

    async jwt({ token, user }) {
      if (user) {
        token.accountId = user.id;
      }
      return token;
    },

    async session({ session, token }) {
      const accountId = token.accountId as string | undefined;
      if (accountId) {
        session.user.accountId = accountId;
        session.user.nickname  = await getNickname(accountId) ?? undefined;
      }
      return session;
    },
  },

  pages: {
    error: '/',
  },
};

export default NextAuth(authOptions);
