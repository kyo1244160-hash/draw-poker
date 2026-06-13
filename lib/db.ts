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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminDb = require('../server/db/admin');

export const isAdmin: (accountId: string) => Promise<boolean>
  = adminDb.isAdmin;

export const listUsers: (opts?: { limit?: number; offset?: number }) => Promise<{
  users: {
    id: string; email: string; google_name: string | null;
    created_at: Date; nickname: string | null; change_count: number | null;
    nickname_updated_at: Date | null; total_points: number | null;
  }[];
  total: number;
}> = adminDb.listUsers;

export const listTournaments: (opts?: { limit?: number; offset?: number }) => Promise<{
  id: string; name: string; mode: string; scheduled_start_at: Date;
  status: string; starting_chips: number; max_players: number | null;
  blind_schedule_name: string | null; entry_count: number;
  is_test: boolean; created_by: string;
  is_sit_and_go: boolean; min_players: number;
}[]> = adminDb.listTournaments;

export const createTournament: (params: {
  id: string; name: string; mode: string; scheduledStartAt: Date;
  startingChips: number; maxPlayers?: number; blindScheduleId?: string;
  isTest?: boolean; lateRegMinutes?: number; createdBy: string;
  isSitAndGo?: boolean; minPlayers?: number;
}) => Promise<Record<string, unknown>> = adminDb.createTournament;

export const updateTournamentStatus: (
  tournamentId: string, status: string
) => Promise<{ id: string; status: string } | null> = adminDb.updateTournamentStatus;

export const deleteTournament: (
  tournamentId: string
) => Promise<{ id: string } | null> = adminDb.deleteTournament;

export const listBlindSchedules: () => Promise<{
  id: string; name: string; description: string | null; levels: unknown;
}[]> = adminDb.listBlindSchedules;

export const createBlindSchedule: (opts: { name: string; description?: string; levels: unknown; lateLevelCutoff?: number }) => Promise<{ id: string; name: string; lateLevelCutoff: number }> = adminDb.createBlindSchedule;
export const updateBlindSchedule: (id: string, opts: { name: string; description?: string; levels: unknown; lateLevelCutoff?: number }) => Promise<{ id: string; name: string; lateLevelCutoff: number } | null> = adminDb.updateBlindSchedule;
export const deleteBlindSchedule: (id: string) => Promise<{ id: string } | null> = adminDb.deleteBlindSchedule;

export const forceChangeNickname: (
  accountId: string, nickname: string
) => Promise<{ account_id: string; nickname: string } | null> = adminDb.forceChangeNickname;

export const deleteUsers: (
  accountIds: string[]
) => Promise<{ deletedIds: string[] }> = adminDb.deleteUsers;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pointsDb = require('../server/db/points');

export const POINT_TABLE: number[] = pointsDb.POINT_TABLE;

export const calcPoints: (rank: number) => number
  = pointsDb.calcPoints;

export const recordTournamentResults: (
  tournamentId: string,
  results: {
    accountId: string;
    finalRank: number;
    finalChips: number;
    handsPlayed?: number;
  }[]
) => Promise<void> = pointsDb.recordTournamentResults;

export const getTournamentResults: (tournamentId: string) => Promise<{
  final_rank: number;
  final_chips: number;
  hands_played: number;
  created_at: Date;
  nickname: string | null;
  google_name: string | null;
  account_id: string;
}[]> = pointsDb.getTournamentResults;

export const getPointsRanking: (opts?: { limit?: number }) => Promise<{
  account_id: string;
  total_points: number;
  updated_at: Date;
  nickname: string | null;
  google_name: string | null;
  tournament_count: number;
}[]> = pointsDb.getPointsRanking;

export const getUserPoints: (accountId: string) => Promise<number>
  = pointsDb.getUserPoints;

export const applyThreeCardResult: (accountId: string, net: number) => Promise<void>
  = pointsDb.applyThreeCardResult;
