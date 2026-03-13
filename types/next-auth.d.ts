/**
 * types/next-auth.d.ts — NextAuth の型拡張
 *
 * session.user.accountId / session.user.nickname を
 * TypeScript で型安全に使えるようにする。
 */

import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      accountId?: string;
      nickname?:  string;
      name?:      string | null;
      email?:     string | null;
      image?:     string | null;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    accountId?: string;
  }
}
