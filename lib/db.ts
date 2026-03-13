/**
 * lib/db.ts — API Route から DB 操作を呼び出すためのラッパー
 *
 * Next.js の API Route（pages/api/）は Edge Runtime ではなく
 * Node.js Runtime で動作するため、postgres パッケージを直接使用できる。
 * ただし server/ ディレクトリは Next.js のモジュール解決から
 * 切り離したいため、このファイル経由でアクセスする。
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const accountsDb = require('../server/db/accounts');

export const upsertAccount: (params: {
  id: string;
  email: string;
  googleName?: string;
}) => Promise<{ id: string; email: string }> = accountsDb.upsertAccount;

export const getNickname: (accountId: string) => Promise<string | null>
  = accountsDb.getNickname;

export const isNicknameTaken: (nickname: string) => Promise<boolean>
  = accountsDb.isNicknameTaken;

export const setNicknameFirst: (accountId: string, nickname: string) => Promise<void>
  = accountsDb.setNicknameFirst;

export const updateNickname: (accountId: string, nickname: string) => Promise<{
  nickname: string;
  change_count: number;
  nickname_updated_at: Date;
}> = accountsDb.updateNickname;

export const getProfile: (accountId: string) => Promise<{
  account_id: string;
  nickname: string;
  nickname_updated_at: Date;
  change_count: number;
} | null> = accountsDb.getProfile;
