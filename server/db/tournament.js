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
        // 脱落済みプレイヤーの再入室を拒否
        if (memTournament && memTournament.eliminationOrder?.includes(accountId)) {
          throw new Error('すでにトーナメントから脱落しています');
        }
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

  // 重複参加チェック（BOT は除外）
  // 現在 registering または running 状態の他のトーナメントに、
  // キャンセルしていない・脱落していないエントリーがある場合は登録不可
  if (!isBot) {
    const activeEntries = await sql`
      SELECT e.tournament_id
      FROM tournament_entries e
      JOIN tournaments t ON t.id = e.tournament_id
      WHERE e.account_id    = ${accountId}
        AND e.tournament_id != ${tournamentId}
        AND e.cancelled_at  IS NULL
        AND t.status        IN ('registering', 'running')
    `;
    // メモリ上で脱落済みかチェック（running 中で脱落している場合は OK）
    const activeTournamentIds = activeEntries
      .map(r => r.tournament_id)
      .filter(tid => {
        try {
          const tm = require('../tournament/tournamentManager');
          const memT = tm.getTournament(tid);
          // メモリにない（サーバー再起動直後またはトーナメント終了済み）
          // → finished の場合はブロック不要なので false を返す
          if (!memT) {
            // DB の status を再確認（finished なら問題なし）
            // 非同期にできないので楽観的に「終了済み = 参加可能」とみなす
            return false;
          }
          // 脱落済みなら参加中とみなさない
          if (memT.eliminationOrder?.includes(accountId)) {
            if (process.env.NODE_ENV !== 'production') {
              console.log(`[duplicate-check] ${accountId} is eliminated in ${tid.slice(-8)} → allow`);
            }
            return false;
          }
          return true;
        } catch {
          // require 失敗等 → 楽観的に許可
          return false;
        }
      });
    if (activeTournamentIds.length > 0) {
      throw new Error('すでに別のトーナメントに参加中です。終了または脱落後に参加できます。');
    }
  }

  // 満員チェック + upsert をアトミックに実行
  // SELECT COUNT → INSERT の間に別リクエストが割り込んで定員オーバーになるのを防ぐ
  if (tournament.max_players) {
    // 満員の場合は INSERT をスキップして null を返すサブクエリ方式
    const [row] = await sql`
      INSERT INTO tournament_entries (tournament_id, account_id)
      SELECT ${tournamentId}, ${accountId}
      WHERE (
        SELECT COUNT(*)::int
        FROM tournament_entries
        WHERE tournament_id = ${tournamentId}
          AND cancelled_at IS NULL
      ) < ${tournament.max_players}
      ON CONFLICT (tournament_id, account_id) DO UPDATE
        SET cancelled_at  = NULL,
            registered_at = NOW()
      RETURNING *
    `;
    if (!row) throw new Error('定員に達しました');
    return row;
  }

  // max_players 無制限の場合は従来通り upsert
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
