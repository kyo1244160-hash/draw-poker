/**
 * pages/api/tournament/[id]/tables.ts
 * GET /api/tournament/[id]/tables
 * → { tables: [{ tableId, players: [{name, chips, isSelf}] }] }
 *
 * サーバーメモリから読むだけ（DBには保存しない）
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../auth/[...nextauth]';

const tournamentManager = require('../../../../server/tournament/tournamentManager');
const { getRoom } = require('../../../../server/poker/gameManager');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const session = await getServerSession(req, res, authOptions);
  const accountId = session?.user?.accountId ?? null;

  const { id: tournamentId } = req.query as { id: string };
  if (!tournamentId) return res.status(400).json({ error: 'tournamentId required' });

  const t = tournamentManager.getTournament(tournamentId);
  if (!t) return res.status(404).json({ error: 'tournament not found' });

  const tables = t.tableIds.map((tableId: string) => {
    const room = getRoom(tableId);   // 読み取り専用（解体済みテーブルで誤生成しない）
    if (!room) return { tableId, players: [] };

    const players = [...room.players, ...room.pendingPlayers].map((p: {
      name: string; chips: number; accountId: string | null; sittingOut?: boolean;
    }) => ({
      name:       p.name,
      chips:      p.chips,
      isSelf:     accountId ? p.accountId === accountId : false,
      sittingOut: p.sittingOut ?? false,
    }));

    return { tableId, players };
  });

  return res.status(200).json({ tables });
}
