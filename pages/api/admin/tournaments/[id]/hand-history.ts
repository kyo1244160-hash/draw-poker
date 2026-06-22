import type { NextApiRequest, NextApiResponse } from 'next';
import { withAdminAuth } from '../../../../../lib/auth';

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80) || 'tournament';
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) return res.status(400).json({ error: 'id が必要です' });

  const { getTournament } = require('../../../../../server/db/tournament');
  const { getTournamentHandHistoryRows } = require('../../../../../server/db/handHistory');

  const tournament = await getTournament(id);
  if (!tournament) return res.status(404).json({ error: 'トーナメントが見つかりません' });
  if (tournament.status !== 'finished') {
    return res.status(409).json({ error: 'HAND_HISTORY_AVAILABLE_AFTER_FINISH' });
  }

  const rows = await getTournamentHandHistoryRows(id);
  const body = rows.map((row: { payload: unknown }) => JSON.stringify(row.payload)).join('\n') + (rows.length > 0 ? '\n' : '');
  const filename = `${sanitizeFilenamePart(tournament.name ?? id)}-${id}-hand-history.jsonl`;

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.status(200).send(body);
}

export default withAdminAuth(handler);