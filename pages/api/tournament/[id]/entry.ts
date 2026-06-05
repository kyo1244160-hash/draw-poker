/**
 * pages/api/tournament/[id]/entry.ts — 参加登録・キャンセル API
 *
 * GET    /api/tournament/[id]/entry  → 参加状況確認
 * POST   /api/tournament/[id]/entry  → 参加登録
 * DELETE /api/tournament/[id]/entry  → キャンセル
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../auth/[...nextauth]';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tournamentDb = require('../../../../server/db/tournament');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.accountId) {
    return res.status(401).json({ error: '未ログインです' });
  }

  const tournamentId = req.query.id as string;
  const accountId    = session.user.accountId;

  try {
    // GET: 参加状況確認
    if (req.method === 'GET') {
      const { getTournamentResults } = require('../../../../server/db/points');
      const [registered, entries, tournament, resultsRaw] = await Promise.all([
        tournamentDb.isRegistered(tournamentId, accountId),
        tournamentDb.getEntries(tournamentId),
        tournamentDb.getTournament(tournamentId),
        getTournamentResults(tournamentId).catch(() => []),
      ]);
      // 結果データを整形
      const rankings = (resultsRaw ?? []).map((r: {account_id: string; final_rank: number; final_chips: number; nickname?: string; google_name?: string; points?: number}) => ({
        accountId: r.account_id,
        nickname:  r.nickname ?? r.google_name ?? r.account_id.slice(0, 8),
        rank:      r.final_rank,
        chips:     r.final_chips,
        points:    r.points,
      }));
      const myEntry = rankings.find((r: {accountId: string}) => r.accountId === accountId) ?? null;

      // メモリ上のlateRegOpen状態・脱落状態をtournamentオブジェクトに付与
      let lateRegOpen: boolean | null = null;
      let isEliminated = false;
      if (tournament?.status === 'running') {
        try {
          const tm = require('../../../../server/tournament/tournamentManager');
          const memT = tm.getTournament(tournamentId);
          if (memT) {
            lateRegOpen = memT.lateRegOpen ?? false;
            isEliminated = memT.eliminationOrder?.includes(accountId) ?? false;
          }
        } catch { /* 取得できない場合は null のまま */ }
        if (tournament.late_reg_closed_at) {
          lateRegOpen = false;
        }
        // webpack バンドル境界で require が別インスタンスになる場合の補完:
        // global.__pastisLateRegClosed を Express サーバーが書き込み、ここで読む
        if (lateRegOpen === null || lateRegOpen === true) {
          const g = global as Record<string, unknown>;
          const closed = g.__pastisLateRegClosed as Set<string> | undefined;
          if (closed?.has(tournamentId)) {
            lateRegOpen = false; // グローバル経由で終了を確認
          }
        }
        const isFutureScheduledSng =
          !!tournament.is_sit_and_go &&
          new Date(tournament.scheduled_start_at).getTime() > Date.now();

        // それでも null の場合の判定:
        // 1. 時間ベース（late_reg_minutes > 0）: scheduled_start_at からの経過時間で計算
        // 2. レベルベース（late_reg_minutes = 0）: DB の締切永続化状態で判断
        // 3. SNG（scheduled_start_at = 2099年）: DB/global に closed がなければ開放中
        const lateLevelCutoff = Number(tournament.blind_late_level_cutoff ?? 0);
        if (lateRegOpen === null && isFutureScheduledSng) {
          lateRegOpen = true;
        } else if (lateRegOpen === null && tournament.late_reg_minutes && tournament.late_reg_minutes > 0) {
          const startedAt = new Date(tournament.scheduled_start_at).getTime();
          if (startedAt < Date.now()) {
            // 通常トーナメント（scheduled_start_at が過去）: 経過時間で判断
            const elapsedMin = (Date.now() - startedAt) / 60000;
            lateRegOpen = elapsedMin <= tournament.late_reg_minutes;
          } else {
            // SNG以外でここに来るのは異常な running+未来日時だが、時間ベースとしては未経過なので開放扱い。
            lateRegOpen = true;
          }
        } else if (lateRegOpen === null && lateLevelCutoff > 0 && !tournament.late_reg_closed_at) {
          // tournamentManager はレベル到達時に late_reg_closed_at を永続化する。
          // API 側でメモリ上の tournamentManager が見えない場合は DB の締切状態を権威情報にする。
          lateRegOpen = true;
        }
        if (lateRegOpen === null) {
          lateRegOpen = false;
        }
      }
      const tournamentWithLateReg = tournament
        ? { ...tournament, late_reg_open: lateRegOpen }
        : tournament;

      return res.status(200).json({ registered, entries, tournament: tournamentWithLateReg, rankings, myEntry, isEliminated });
    }

    // POST: 参加登録
    if (req.method === 'POST') {
      await tournamentDb.registerEntry(tournamentId, accountId);
      const entries = await tournamentDb.getEntries(tournamentId);

      // Sit & Go: 最小人数に達したら自動起動チェック（fire & forget）
      try {
        const tm = require('../../../../server/tournament/tournamentManager');
        // キャンセル競合調査用: 登録時刻とエントリー数をログ（開発環境のみ）
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[SNG-debug][POST] tournamentId=${tournamentId} accountId=${accountId} entries=${entries.length} time=${new Date().toISOString()}`);
        }
        tm.triggerSitAndGoCheck(tournamentId).catch(() => {});
      } catch { /* サーバー環境以外（テスト等）では無視 */ }

      return res.status(200).json({ ok: true, entries });
    }

    // DELETE: キャンセル
    if (req.method === 'DELETE') {
      // キャンセル競合調査用（開発環境のみ）
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[SNG-debug][DELETE] tournamentId=${tournamentId} accountId=${accountId} time=${new Date().toISOString()}`);
      }
      const row = await tournamentDb.cancelEntry(tournamentId, accountId);
      if (!row) return res.status(404).json({ error: '登録が見つかりません' });
      const entries = await tournamentDb.getEntries(tournamentId);
      return res.status(200).json({ ok: true, entries });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'エラーが発生しました';
    return res.status(400).json({ error: message });
  }
}
