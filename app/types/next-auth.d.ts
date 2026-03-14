// app/types/next-auth.d.ts
// next-auth の Session / JWT 型に accountId を追加する型拡張

import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      name?:      string | null;
      email?:     string | null;
      image?:     string | null;
      accountId?: string;
      nickname?:  string;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    accountId?: string;
  }
}
