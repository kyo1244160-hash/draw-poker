/**
 * server/db/points.js — ポイント集計 DB 操作
 *
 * ポイント配分（案A: シンプル固定制）
 *   1位: 100pt / 2位: 60pt / 3位: 40pt / 4位: 25pt / 5位: 15pt / 6位以下: 0pt
 */

const sql = require('./client');

// 順位 → ポイントの対応表
const POINT_TABLE = [100, 60, 40, 25, 15];

/**
 * 順位からポイントを計算する
 * @param {number} rank 1始まり
 */
function calcPoints(rank) {
  return POINT_TABLE[rank - 1] ?? 0;
}

/**
 * トーナメント結果を一括登録してポイントを付与する。
 * すでに結果が登録済みのトーナメントは拒否する。
 *
 * @param {string} tournamentId
 * @param {{ accountId: string, finalRank: number, finalChips: number, handsPlayed?: number }[]} results
 */
async function recordTournamentResults(tournamentId, results) {
  // 二重登録防止
  const existing = await sql`
    SELECT 1 FROM tournament_results WHERE tournament_id = ${tournamentId} LIMIT 1
  `;
  if (existing.length > 0) {
    throw new Error('このトーナメントの結果はすでに登録されています');
  }

  // トランザクションで一括処理
  await sql.begin(async (tx) => {
    // 1. tournament_results に挿入
    for (const r of results) {
      const points = calcPoints(r.finalRank);
      await tx`
        INSERT INTO tournament_results
          (tournament_id, account_id, final_rank, final_chips, hands_played)
        VALUES
          (${tournamentId}, ${r.accountId}, ${r.finalRank}, ${r.finalChips}, ${r.handsPlayed ?? 0})
      `;

      // 2. points テーブルを upsert（累計加算）
      if (points > 0) {
        await tx`
          INSERT INTO points (account_id, total_points, updated_at)
          VALUES (${r.accountId}, ${points}, NOW())
          ON CONFLICT (account_id) DO UPDATE
            SET total_points = points.total_points + ${points},
                updated_at   = NOW()
        `;

        // 3. point_history に記録
        await tx`
          INSERT INTO point_history (account_id, points, reason)
          VALUES (
            ${r.accountId},
            ${points},
            ${`トーナメント: ${tournamentId} / ${r.finalRank}位`}
          )
        `;
      }
    }

    // 4. トーナメントのステータスを finished に更新
    await tx`
      UPDATE tournaments
      SET status = 'finished'
      WHERE id = ${tournamentId}
    `;
  });
}

/**
 * トーナメント結果一覧を取得する
 */
async function getTournamentResults(tournamentId) {
  return sql`
    SELECT
      tr.final_rank,
      tr.final_chips,
      tr.hands_played,
      tr.created_at,
      p.nickname,
      a.google_name,
      tr.account_id
    FROM tournament_results tr
    JOIN accounts  a ON a.id = tr.account_id
    LEFT JOIN profiles p ON p.account_id = tr.account_id
    WHERE tr.tournament_id = ${tournamentId}
    ORDER BY tr.final_rank ASC
  `;
}

/**
 * ポイントランキング上位N件を取得する
 */
async function getPointsRanking({ limit = 20 } = {}) {
  return sql`
    SELECT
      pt.account_id,
      pt.total_points,
      pt.updated_at,
      p.nickname,
      a.google_name,
      COUNT(tr.id)::int AS tournament_count
    FROM points pt
    JOIN accounts  a  ON a.id  = pt.account_id
    LEFT JOIN profiles        p  ON p.account_id  = pt.account_id
    LEFT JOIN tournament_results tr ON tr.account_id = pt.account_id
    GROUP BY pt.account_id, pt.total_points, pt.updated_at, p.nickname, a.google_name
    ORDER BY pt.total_points DESC
    LIMIT ${limit}
  `;
}

module.exports = {
  calcPoints,
  recordTournamentResults,
  getTournamentResults,
  getPointsRanking,
  POINT_TABLE,
};
