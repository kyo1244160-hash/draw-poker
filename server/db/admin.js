/**
 * server/db/admin.js — 管理者用 DB 操作
 */

const sql = require('./client');
const { SCHEDULES } = require('../tournament/blindSchedule');

/** account_id が admins テーブルに存在するか確認 */
async function isAdmin(accountId) {
  const [row] = await sql`
    SELECT 1 FROM admins WHERE account_id = ${accountId} LIMIT 1
  `;
  return !!row;
}

/** ユーザー一覧（accounts + profiles 結合） */
async function listUsers({ limit = 50, offset = 0 } = {}) {
  const rows = await sql`
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
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM accounts`;
  return { users: rows, total: count };
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
  lateRegMinutes,
  createdBy,
  isSitAndGo,
  minPlayers,
}) {
  // JSのみ定義されているスケジュール（test/test1min/test2min等）はFK違反になるため
  // tournament INSERT前にblind_schedulesへUPSERTして存在を保証する
  if (blindScheduleId && SCHEDULES[blindScheduleId]) {
    const s = SCHEDULES[blindScheduleId];
    await sql`
      INSERT INTO blind_schedules (id, name, description, levels)
      VALUES (
        ${s.id}, ${s.name}, ${s.description ?? ''},
        ${JSON.stringify(s.levels)}::jsonb
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

  const [row] = await sql`
    INSERT INTO tournaments (
      id, name, mode, scheduled_start_at, status,
      starting_chips, max_players, blind_schedule_id,
      is_test, late_reg_minutes, created_by,
      is_sit_and_go, min_players
    ) VALUES (
      ${id}, ${name}, ${mode}, ${scheduledStartAt}, 'registering',
      ${startingChips}, ${maxPlayers ?? null}, ${blindScheduleId ?? null},
      ${isTest ?? false}, ${lateRegMinutes ?? 0}, ${createdBy},
      ${isSitAndGo ?? false}, ${minPlayers ?? 3}
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

/** ブラインドスケジュール一覧（DBに加えJSのSCHEDULESもマージ） */
async function listBlindSchedules() {
  const dbRows = await sql`
    SELECT id, name, description, levels::text AS levels_raw, late_level_cutoff
    FROM blind_schedules
    ORDER BY created_at ASC
  `;
  const dbIds = new Set(dbRows.map(r => r.id));

  const safeParseArray = (raw) => {
    if (!raw) return [];
    try {
      let parsed = JSON.parse(raw);
      // 二重エンコード対策: parsed が文字列なら再パース
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };

  const parsed = dbRows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    levels: safeParseArray(r.levels_raw),
    lateLevelCutoff: r.late_level_cutoff ?? 0,
  }));

  // JSで定義済みのスケジュール（DB未登録分を補完）
  // isBuiltin フラグで UI 側が「組み込みスケジュール」と判別できるようにする
  const jsRows = Object.values(SCHEDULES)
    .filter(s => !dbIds.has(s.id))
    .map(s => ({ id: s.id, name: s.name, description: s.description ?? '', levels: s.levels, lateLevelCutoff: s.lateLevelCutoff ?? 0, isBuiltin: true }));

  return [...parsed, ...jsRows];
}

/** ブラインドスケジュール新規作成 */
async function createBlindSchedule({ name, description, levels, lateLevelCutoff }) {
  const id = require('crypto').randomUUID();
  const levelsJson = JSON.stringify(levels);
  const cutoff = lateLevelCutoff ?? 0;
  const rows = await sql.unsafe(
    `INSERT INTO blind_schedules (id, name, description, levels, late_level_cutoff)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, name, description, levels::text AS levels_raw, late_level_cutoff`,
    [id, name, description ?? '', levelsJson, cutoff]
  );
  const row = rows[0];
  if (!row) return null;
  let lvls; try { lvls = JSON.parse(row.levels_raw); if (typeof lvls === 'string') lvls = JSON.parse(lvls); } catch { lvls = []; }
  return { id: row.id, name: row.name, description: row.description, levels: Array.isArray(lvls) ? lvls : [], lateLevelCutoff: row.late_level_cutoff ?? 0 };
}

/** ブラインドスケジュール更新
 * UPSERT で実装: JS定義の組み込みスケジュール（test等）も初回編集時にDBへ永続化される
 */
async function updateBlindSchedule(id, { name, description, levels, lateLevelCutoff }) {
  const levelsJson = JSON.stringify(levels);
  const cutoff = lateLevelCutoff ?? 0;
  const rows = await sql.unsafe(
    `INSERT INTO blind_schedules (id, name, description, levels, late_level_cutoff)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           description = EXCLUDED.description,
           levels = EXCLUDED.levels,
           late_level_cutoff = EXCLUDED.late_level_cutoff
     RETURNING id, name, description, levels::text AS levels_raw, late_level_cutoff`,
    [id, name, description ?? '', levelsJson, cutoff]
  );
  const row = rows[0];
  if (!row) return null;
  let lvls; try { lvls = JSON.parse(row.levels_raw); if (typeof lvls === 'string') lvls = JSON.parse(lvls); } catch { lvls = []; }
  return { id: row.id, name: row.name, description: row.description, levels: Array.isArray(lvls) ? lvls : [], lateLevelCutoff: row.late_level_cutoff ?? 0 };
}

/** ブラインドスケジュール削除
 * JS定義の組み込みスケジュール（SCHEDULES に存在する id）は削除不可
 */
async function deleteBlindSchedule(id) {
  // 組み込みスケジュールは削除不可（削除してもJS定義が残るため混乱を招く）
  if (SCHEDULES[id]) {
    const err = new Error('組み込みスケジュールは削除できません。カスタムスケジュールのみ削除可能です。');
    err.code = 'BUILTIN_SCHEDULE';
    throw err;
  }
  const [row] = await sql`
    DELETE FROM blind_schedules WHERE id = ${id} RETURNING id
  `;
  return row ?? null;
}


/**
 * schema.sql で ON DELETE CASCADE のため
 * tournament_entries / tournament_results も連鎖削除される
 * running 中は削除不可（呼び出し側でガードすること）
 */
async function deleteTournament(tournamentId) {
  const [row] = await sql`
    DELETE FROM tournaments
    WHERE id = ${tournamentId}
    RETURNING id
  `;
  return row ?? null;
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
  deleteTournament,
  listBlindSchedules,
  createBlindSchedule,
  updateBlindSchedule,
  deleteBlindSchedule,
  forceChangeNickname,
};
