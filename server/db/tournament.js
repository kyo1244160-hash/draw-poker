/**
 * server/db/tournament.js — トーナメント参加登録 DB 操作
 */

const sql = require('./client');

/**
 * トーナメント詳細（参加者一覧付き）を取得する
 */
async function getTournament(tournamentId) {
  const [row] = await sql`
    SELECT
      t.*,
      bs.name             AS blind_schedule_name,
      bs.levels           AS blind_levels,
      bs.late_level_cutoff AS blind_late_level_cutoff,
      t.late_reg_minutes,
      bs.description      AS blind_description
    FROM tournaments    t
    LEFT JOIN blind_schedules bs ON bs.id = t.blind_schedule_id
    WHERE t.id = ${tournamentId}
  `;
  return row ?? null;
}

/**
 * 参加者一覧（キャンセル済みを除く）
 */
async function getEntries(tournamentId) {
  return sql`
    SELECT
      e.account_id,
      e.registered_at,
      p.nickname,
      a.google_name
    FROM tournament_entries e
    JOIN accounts  a ON a.id = e.account_id
    LEFT JOIN profiles p ON p.account_id = e.account_id
    WHERE e.tournament_id = ${tournamentId}
      AND e.cancelled_at IS NULL
    ORDER BY e.registered_at ASC
  `;
}

/**
 * 参加登録する。
 * すでに登録済みの場合 → 再登録（cancelled_at をクリア）
 * 満員の場合 → エラー
 */
async function registerEntry(tournamentId, accountId) {
  // トーナメント取得
  const tournament = await getTournament(tournamentId);
  if (!tournament) throw new Error('トーナメントが見つかりません');
  // BOTアカウント(bot_で始まるID)は running状態でも参加可能（テスト用）
  const isBot = typeof accountId === 'string' && accountId.startsWith('bot_');
  if (!isBot) {
    if (tournament.status === 'registering') {
      // 受付中: OK
    } else if (tournament.status === 'running') {
      // 進行中: レイトレジスト期間中なら許可
      // メモリ上のtournamentManagerからlateRegOpenフラグを確認する
      try {
        const tm = require('../tournament/tournamentManager');
        const memTournament = tm.getTournament(tournamentId);
        if (!memTournament) {
          // メモリにない（サーバー再起動直後等）
          // 時間ベース（late_reg_minutes > 0）: 経過時間で判断
          // レベルベース（late_reg_minutes = 0）: メモリがなくても終了を検証できないため許可
          if (tournament.late_reg_minutes && tournament.late_reg_minutes > 0) {
            // 時間ベース: 開始からの経過時間がlate_reg_minutes未満なら許可
            const startedAt = new Date(tournament.scheduled_start_at).getTime();
            const elapsedMin = (Date.now() - startedAt) / 60000;
            if (elapsedMin > tournament.late_reg_minutes) {
              throw new Error('レイトレジスト受付期間が終了しています');
            }
          }
          // レベルベース（late_reg_minutes=0）の場合は許可して続行
        } else if (!memTournament.lateRegOpen) {
          throw new Error('レイトレジスト受付期間が終了しています');
        }
        // lateRegOpen=true: OK（レイトレジスト期間中）
      } catch (tmErr) {
        if (tmErr.message.includes('レイトレジスト') || tmErr.message.includes('参加受付')) throw tmErr;
        // その他の例外（require失敗等）→ late_reg_minutes>0なら許可
        if (!tournament.late_reg_minutes || tournament.late_reg_minutes <= 0) {
          throw new Error('現在参加受付中ではありません');
        }
      }
    } else {
      throw new Error('現在参加受付中ではありません');
    }
  }

  // 満員チェック
  if (tournament.max_players) {
    const [{ cnt }] = await sql`
      SELECT COUNT(*)::int AS cnt
      FROM tournament_entries
      WHERE tournament_id = ${tournamentId}
        AND cancelled_at IS NULL
    `;
    if (cnt >= tournament.max_players) throw new Error('定員に達しました');
  }

  // upsert（キャンセル済みなら再登録）
  const [row] = await sql`
    INSERT INTO tournament_entries (tournament_id, account_id)
    VALUES (${tournamentId}, ${accountId})
    ON CONFLICT (tournament_id, account_id) DO UPDATE
      SET cancelled_at = NULL,
          registered_at = NOW()
    RETURNING *
  `;
  return row;
}

/**
 * 参加キャンセルする
 */
async function cancelEntry(tournamentId, accountId) {
  const tournament = await getTournament(tournamentId);
  if (!tournament) throw new Error('トーナメントが見つかりません');
  if (tournament.status !== 'registering') throw new Error('受付中のトーナメントのみキャンセルできます');

  const [row] = await sql`
    UPDATE tournament_entries
    SET cancelled_at = NOW()
    WHERE tournament_id = ${tournamentId}
      AND account_id    = ${accountId}
      AND cancelled_at IS NULL
    RETURNING *
  `;
  return row ?? null;
}

/**
 * 指定ユーザーが登録済みか確認
 */
async function isRegistered(tournamentId, accountId) {
  const [row] = await sql`
    SELECT 1 FROM tournament_entries
    WHERE tournament_id = ${tournamentId}
      AND account_id    = ${accountId}
      AND cancelled_at IS NULL
    LIMIT 1
  `;
  return !!row;
}

module.exports = {
  getTournament,
  getEntries,
  registerEntry,
  cancelEntry,
  isRegistered,
};
