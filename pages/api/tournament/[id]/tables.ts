/**
 * pages/api/tournament/[id]/tables.ts
 * GET /api/tournament/[id]/tables
 * → { tables: [{ tableId, players: [{name, chips, isSelf, sittingOut}] }] }
 *
 * webpack バンドル境界問題への対応:
 *   pages/api は Next.js の webpack でバンドルされるため、
 *   server/ の require は Express サーバーとは別インスタンスになる。
 *   entry.ts の __pastisLateRegClosed と同じ手法で
 *   global.__pastisTournaments / global.__pastisRooms 経由でアクセスする。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../auth/[...nextauth]';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const session = await getServerSession(req, res, authOptions);
  const accountId = session?.user?.accountId ?? null;

  const { id: tournamentId } = req.query as { id: string };
  if (!tournamentId) return res.status(400).json({ error: 'tournamentId required' });

  // global 経由でサーバーインスタンスのメモリにアクセス
  const g = global as Record<string, unknown>;
  const tournamentsMap = g.__pastisTournaments as Map<string, { tableIds: string[] }> | undefined;
  const roomsMap       = g.__pastisRooms as Map<string, {
    players:        { name: string; chips: number; accountId: string | null; sittingOut?: boolean }[];
    pendingPlayers: { name: string; chips: number; accountId: string | null; sittingOut?: boolean }[];
  }> | undefined;
  // スタッド進行中のテーブルは、最新チップが studRooms 側にある。
  // ドロー側 rooms のチップは syncToGameManager（ハンド終了時）まで古いままなので、
  // スタッド中は studRooms を優先してチップを引く。
  const studRoomsMap = g.__pastisStudRooms as Map<string, {
    phase: string;
    players: { name: string; chips: number; accountId: string | null; sittingOut?: boolean }[];
  }> | undefined;

  if (!tournamentsMap) {
    // サーバー起動直後など、まだ global が設定されていない場合
    return res.status(503).json({ error: 'Server not ready' });
  }

  const t = tournamentsMap.get(tournamentId);
  if (!t) return res.status(404).json({ error: 'tournament not found' });

  const tables = t.tableIds.map((tableId: string) => {
    const room = roomsMap?.get(tableId);
    if (!room) return { tableId, players: [] };

    // スタッドルームが進行中なら、そのチップを accountId/name で引けるよう索引化
    const studRoom = studRoomsMap?.get(tableId);
    const studActive = !!studRoom && studRoom.phase && studRoom.phase !== 'waiting';
    const studChipByKey = new Map<string, number>();
    if (studActive && studRoom) {
      for (const sp of studRoom.players) {
        if (sp.accountId) studChipByKey.set(`acc:${sp.accountId}`, sp.chips);
        if (sp.name)      studChipByKey.set(`name:${sp.name}`, sp.chips);
      }
    }

    const allPlayers = [
      ...(room.players        ?? []),
      ...(room.pendingPlayers ?? []),
    ];

    const players = allPlayers.map((p) => {
      // スタッド進行中は studRooms の最新チップを優先
      let chips = p.chips;
      if (studActive) {
        const byAcc  = p.accountId ? studChipByKey.get(`acc:${p.accountId}`) : undefined;
        const byName = studChipByKey.get(`name:${p.name}`);
        if (byAcc !== undefined) chips = byAcc;
        else if (byName !== undefined) chips = byName;
      }
      return {
        name:       p.name,
        chips,
        isSelf:     accountId ? p.accountId === accountId : false,
        sittingOut: p.sittingOut ?? false,
      };
    });

    return { tableId, players };
  });

  return res.status(200).json({ tables });
}
