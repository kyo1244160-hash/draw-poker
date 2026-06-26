/**
 * pages/api/tournament/[id]/tables.ts
 * GET /api/tournament/[id]/tables
 * → { remainingPlayers, averageStack, tables: [{ tableId, tableNo, players: [{seat, name, chips, isSelf, sittingOut}] }] }
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
  const tournamentsMap = g.__pastisTournaments as Map<string, {
    tableIds: string[];
    totalPlayers?: number;
    startingChips?: number;
    eliminationOrder?: string[];
    status?: string;
  }> | undefined;
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
  const boardRoomsMap = g.__pastisBoardRooms as Map<string, {
    phase: string;
    players: { name: string; chips: number; accountId: string | null; sittingOut?: boolean }[];
  }> | undefined;

  if (!tournamentsMap) {
    // サーバー起動直後など、まだ global が設定されていない場合
    return res.status(503).json({ error: 'Server not ready' });
  }

  const t = tournamentsMap.get(tournamentId);
  if (!t) return res.status(404).json({ error: 'tournament not found' });

  let remainingPlayers = 0;
  let liveChipTotal = 0;

  const tables = t.tableIds.map((tableId: string, tableIndex: number) => {
    const room = roomsMap?.get(tableId);
    if (!room) return { tableId, tableNo: tableIndex + 1, playerCount: 0, players: [] };

    // スタッド/ボード進行中なら、その専用エンジン側の最新チップを accountId/name で引けるよう索引化
    const studRoom = studRoomsMap?.get(tableId);
    const boardRoom = boardRoomsMap?.get(tableId);
    const studActive = !!studRoom && studRoom.phase && studRoom.phase !== 'waiting';
    const boardActive = !!boardRoom && boardRoom.phase && boardRoom.phase !== 'waiting';
    const activeEngineRoom = studActive ? studRoom : boardActive ? boardRoom : null;
    const engineChipByKey = new Map<string, number>();
    if (activeEngineRoom) {
      for (const ep of activeEngineRoom.players) {
        if (ep.accountId) engineChipByKey.set(`acc:${ep.accountId}`, ep.chips);
        if (ep.name)      engineChipByKey.set(`name:${ep.name}`, ep.chips);
      }
    }
    const allPlayers = [
      ...(room.players        ?? []).map((p, seat) => ({ ...p, _seat: seat })),
      ...(room.pendingPlayers ?? []).map((p, idx) => ({ ...p, _seat: (room.players?.length ?? 0) + idx })),
    ];

    const players = allPlayers.map((p) => {
      // スタッド/ボード進行中は専用エンジン側の最新チップを優先
      let chips = p.chips;
      const byAcc  = p.accountId ? engineChipByKey.get(`acc:${p.accountId}`) : undefined;
      const byName = engineChipByKey.get(`name:${p.name}`);
      if (byAcc !== undefined) chips = byAcc;
      else if (byName !== undefined) chips = byName;

      const normalizedChips = Number.isFinite(Number(chips)) ? Number(chips) : 0;
      if (normalizedChips > 0) {
        remainingPlayers += 1;
        liveChipTotal += normalizedChips;
      }
      return {
        seat:       p._seat,
        name:       p.name,
        chips:      normalizedChips,
        isSelf:     accountId ? p.accountId === accountId : false,
        sittingOut: p.sittingOut ?? false,
      };
    });

    return { tableId, tableNo: tableIndex + 1, playerCount: players.length, players };
  });

  const totalPlayers = Math.max(Number(t.totalPlayers ?? 0), remainingPlayers + (t.eliminationOrder?.length ?? 0));
  const totalChipsByConfig = totalPlayers > 0 && Number(t.startingChips ?? 0) > 0
    ? totalPlayers * Number(t.startingChips)
    : liveChipTotal;
  const averageStack = remainingPlayers > 0 ? Math.floor(totalChipsByConfig / remainingPlayers) : 0;

  return res.status(200).json({ tournamentId, remainingPlayers, averageStack, tables });
}
