/**
 * lib/useKeepalive.ts — Render スリープ防止 keepalive フック
 *
 * - INTERVAL_MS ごとに /api/health へ fetch を発行
 * - バックグラウンドタブ中は ping を停止し、復帰時に即1回送信
 * - ネットワークエラーは握りつぶす（ゲームに影響させない）
 */
import { useEffect } from 'react';

const INTERVAL_MS = 12 * 60 * 1000; // 12分（Render の15分スリープより短く）

export function useKeepalive() {
  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const ping = () => {
      fetch('/api/health').catch(() => {});
    };

    const schedule = () => {
      timerId = setTimeout(() => {
        if (!document.hidden) ping(); // バックグラウンドタブでは送らない
        schedule();
      }, INTERVAL_MS);
    };

    // タブが再びアクティブになったら即 ping（長時間バックグラウンド後の復帰対策）
    const handleVisibility = () => {
      if (!document.hidden) ping();
    };

    ping(); // マウント直後に1回送信
    schedule();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (timerId) clearTimeout(timerId);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);
}
