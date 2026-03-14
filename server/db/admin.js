/**
 * server/db/admin.js — 管理者用 DB 操作
 */

const sql = require('./client');

/** account_id が admins テーブルに存在するか確認 */
async function isAdmin(accountId) {
  const [row] = await sql`
    SELECT 1 FROM admins WHERE account_id = ${accountId} LIMIT 1
  `;
  return !!row;
}

/** ユーザー一覧（accounts + profiles 結合） */
async function listUsers({ limit = 50, offset = 0 } = {}) {
  return sql`
    SELECT
      a.id,
      a.email,
      a.google_name,
      a.created_at,
      p.nickname,
      p.change_count,
      p.nickname_updated_at,
      pt.total_points
    FROM accounts a
    LEFT JOIN profiles   p  ON p.account_id  = a.id
    LEFT JOIN points     pt ON pt.account_id = a.id
    ORDER BY a.created_at DESC
    LIMIT  ${limit}
    OFFSET ${offset}
  `;
}

/** トーナメント一覧 */
async function listTournaments({ limit = 20, offset = 0 } = {}) {
  return sql`
    SELECT
      t.*,
      bs.name AS blind_schedule_name,
      COUNT(DISTINCT tr.id)::int AS entry_count
    FROM tournaments t
    LEFT JOIN blind_schedules   bs ON bs.id = t.blind_schedule_id
    LEFT JOIN tournament_results tr ON tr.tournament_id = t.id
    GROUP BY t.id, bs.name
    ORDER BY t.scheduled_start_at DESC
    LIMIT  ${limit}
    OFFSET ${offset}
  `;
}

/** トーナメント作成 */
async function createTournament({
  id,
  name,
  mode,
  scheduledStartAt,
  startingChips,
  maxPlayers,
  blindScheduleId,
  isTest,
  createdBy,
}) {
  const [row] = await sql`
    INSERT INTO tournaments (
      id, name, mode, scheduled_start_at, status,
      starting_chips, max_players, blind_schedule_id,
      is_test, created_by
    ) VALUES (
      ${id}, ${name}, ${mode}, ${scheduledStartAt}, 'registering',
      ${startingChips}, ${maxPlayers ?? null}, ${blindScheduleId ?? null},
      ${isTest ?? false}, ${createdBy}
    )
    RETURNING *
  `;
  return row;
}

/** トーナメントのステータス変更 */
async function updateTournamentStatus(tournamentId, status) {
  const [row] = await sql`
    UPDATE tournaments
    SET status = ${status}
    WHERE id = ${tournamentId}
    RETURNING id, status
  `;
  return row ?? null;
}

/** ブラインドスケジュール一覧 */
async function listBlindSchedules() {
  return sql`
    SELECT id, name, description, levels
    FROM blind_schedules
    ORDER BY created_at ASC
  `;
}

/** ニックネーム強制変更（管理者用） */
async function forceChangeNickname(accountId, nickname) {
  const [row] = await sql`
    UPDATE profiles
    SET nickname = ${nickname}, nickname_updated_at = NOW()
    WHERE account_id = ${accountId}
    RETURNING account_id, nickname
  `;
  return row ?? null;
}

module.exports = {
  isAdmin,
  listUsers,
  listTournaments,
  createTournament,
  updateTournamentStatus,
  listBlindSchedules,
  forceChangeNickname,
};
