'use strict';

const crypto = require('crypto');
const sql = require('./client');

async function ensureTournamentHandHistoryTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS tournament_hand_histories (
      id            BIGSERIAL PRIMARY KEY,
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      table_id      TEXT NOT NULL,
      hand_no       INTEGER NOT NULL,
      mode          TEXT NOT NULL,
      payload       JSONB NOT NULL,
      payload_hash  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tournament_id, table_id, hand_no)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_tournament_hand_histories_tournament
    ON tournament_hand_histories (tournament_id, hand_no, table_id)
  `;
}

function payloadHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

async function saveTournamentHandHistory({ tournamentId, tableId, handNo, mode, payload }) {
  if (!tournamentId || !tableId || !handNo || !mode || !payload) return null;
  await ensureTournamentHandHistoryTable();
  const payloadJson = JSON.stringify(payload);
  const hash = payloadHash(payload);
  const [row] = await sql.unsafe(
    `INSERT INTO tournament_hand_histories (
       tournament_id, table_id, hand_no, mode, payload, payload_hash
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (tournament_id, table_id, hand_no) DO UPDATE
       SET mode = EXCLUDED.mode,
           payload = EXCLUDED.payload,
           payload_hash = EXCLUDED.payload_hash
     RETURNING id`,
    [tournamentId, tableId, handNo, mode, payloadJson, hash]
  );
  return row ?? null;
}

async function getTournamentHandHistoryRows(tournamentId) {
  await ensureTournamentHandHistoryTable();
  return sql`
    SELECT payload
    FROM tournament_hand_histories
    WHERE tournament_id = ${tournamentId}
    ORDER BY hand_no ASC, table_id ASC, id ASC
  `;
}

module.exports = {
  ensureTournamentHandHistoryTable,
  saveTournamentHandHistory,
  getTournamentHandHistoryRows,
};
