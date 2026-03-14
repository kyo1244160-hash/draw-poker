/**
 * pages/api/admin/results.ts — トーナメント結果登録 API（管理者専用）
 *
 * POST /api/admin/results
 *   { tournamentId, results: [{ accountId, finalRank, finalChips, handsPlayed? }] }
 *   → 200: 登録成功
 *
 * GET /api/admin/results?tournamentId=xxx
 *   → { results: [...] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAdminAuth } from '../../../lib/auth';
import { recordTournamentResults, getTournamentResults, calcPoints } from '../../../lib/db';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // GET: 結果取得
  if (req.method === 'GET') {
    const { tournamentId } = req.query;
    if (!tournamentId || typeof tournamentId !== 'string') {
      return res.status(400).json({ error: 'tournamentId は必須です' });
    }
    const results = await getTournamentResults(tournamentId);
    return res.status(200).json({ results });
  }

  // POST: 結果登録
  if (req.method === 'POST') {
    const { tournamentId, results } = req.body as {
      tournamentId?: string;
      results?: { accountId: string; finalRank: number; finalChips: number; handsPlayed?: number }[];
    };

    if (!tournamentId || !Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: 'tournamentId と results は必須です' });
    }

    // バリデーション
    for (const r of results) {
      if (!r.accountId || typeof r.finalRank !== 'number' || r.finalRank < 1) {
        return res.status(400).json({ error: 'results の各要素に accountId と finalRank（1以上）が必要です' });
      }
    }

    // 重複順位チェック
    const ranks = results.map((r) => r.finalRank);
    if (new Set(ranks).size !== ranks.length) {
      return res.status(400).json({ error: '順位が重複しています' });
    }

    try {
      await recordTournamentResults(tournamentId, results);

      // レスポンスにポイント付与情報を含める
      const summary = results.map((r) => ({
        accountId:  r.accountId,
        finalRank:  r.finalRank,
        finalChips: r.finalChips,
        points:     calcPoints(r.finalRank),
      }));
      return res.status(200).json({ ok: true, summary });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '登録に失敗しました';
      return res.status(409).json({ error: message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withAdminAuth(handler);
