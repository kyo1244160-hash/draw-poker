/**
 * server/db/ring.js — リングゲーム損益 DB 操作
 *
 * テーブル: ring_hand_results
 *   id          SERIAL PRIMARY KEY
 *   account_id  TEXT NOT NULL
 *   room_id     TEXT NOT NULL
 *   mode        TEXT NOT NULL        -- '27' | 'badugi' | 'mix' | ...
 *   hand_num    INTEGER NOT NULL     -- room.handCount
 *   net         INTEGER NOT NULL     -- そのハンドの損益チップ
 *   chips_after INTEGER NOT NULL     -- ハンド終了直後のチップ（トップアップ前）
 *   played_at   TIMESTAMPTZ DEFAULT NOW()
 *
 * UNIQUE (room_id, account_id, hand_num) — 二重記録防止
 */

const sql = require('./client');

/**
 * ring_hand_results テーブルを作成する（存在しない場合のみ）
 * server/index.js の起動時マイグレーションから呼ぶ
 */
async function ensureRingTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS ring_hand_results (
      id          SERIAL PRIMARY KEY,
      account_id  TEXT NOT NULL,
      room_id     TEXT NOT NULL,
      mode        TEXT NOT NULL,
      hand_num    INTEGER NOT NULL,
      net         INTEGER NOT NULL,
      chips_after INTEGER NOT NULL,
      played_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (room_id, account_id, hand_num)
    )
  `;
  // インデックス（stats クエリの高速化）
  await sql`
    CREATE INDEX IF NOT EXISTS ring_hand_results_account_idx
      ON ring_hand_results (account_id, played_at DESC)
  `;
}

/**
 * 1ハンド分の損益を複数プレイヤー分まとめて記録する。
 *
 * @param {Array<{accountId: string, roomId: string, mode: string, handNum: number, net: number, chipsAfter: number}>} records
 */
async function recordHandResults(records) {
  if (!records || records.length === 0) return;
  // ON CONFLICT DO NOTHING で二重記録を安全に無視する
  for (const r of records) {
    await sql`
      INSERT INTO ring_hand_results
        (account_id, room_id, mode, hand_num, net, chips_after)
      VALUES
        (${r.accountId}, ${r.roomId}, ${r.mode}, ${r.handNum}, ${r.net}, ${r.chipsAfter})
      ON CONFLICT (room_id, account_id, hand_num) DO NOTHING
    `;
  }
}

/**
 * モード別の通算成績を返す
 *
 * @param {string} accountId
 * @returns {Promise<{mode: string, net: number, hands: number}[]>}
 */
async function getRingStatsByMode(accountId) {
  return sql`
    SELECT
      mode,
      SUM(net)::int   AS net,
      COUNT(*)::int   AS hands
    FROM ring_hand_results
    WHERE account_id = ${accountId}
    GROUP BY mode
    ORDER BY hands DESC
  `;
}

/**
 * 直近 N ハンドの時系列データを返す（グラフ用）
 * 累積損益を計算して返す
 *
 * @param {string} accountId
 * @param {number} limit  最大件数（デフォルト 1000）
 * @returns {Promise<{hand_seq: number, net: number, cumulative: number, mode: string, played_at: string}[]>}
 */
async function getRingHistory(accountId, limit = 1000) {
  const rows = await sql`
    SELECT
      ROW_NUMBER() OVER (ORDER BY played_at ASC, id ASC)::int AS hand_seq,
      net,
      mode,
      played_at
    FROM ring_hand_results
    WHERE account_id = ${accountId}
    ORDER BY played_at DESC, id DESC
    LIMIT ${limit}
  `;
  // DESC で取得 → 古い順に並び替えて累積計算
  const sorted = [...rows].reverse();
  let cumulative = 0;
  return sorted.map((row, i) => {
    cumulative += row.net;
    return {
      hand_seq:   i + 1,
      net:        row.net,
      cumulative,
      mode:       row.mode,
      played_at:  row.played_at,
    };
  });
}

/**
 * 通算サマリー（全モード合計）
 *
 * @param {string} accountId
 * @returns {Promise<{net: number, hands: number}>}
 */
async function getRingSummary(accountId) {
  const [row] = await sql`
    SELECT
      COALESCE(SUM(net),0)::int   AS net,
      COUNT(*)::int               AS hands
    FROM ring_hand_results
    WHERE account_id = ${accountId}
  `;
  return row ?? { net: 0, hands: 0 };
}

module.exports = {
  ensureRingTable,
  recordHandResults,
  getRingStatsByMode,
  getRingHistory,
  getRingSummary,
};
