'use client';
// app/Keepalive.tsx
// App Router 用 Render スリープ防止 keepalive
// layout.tsx（Server Component）から呼び出す用の Client Component

import { useEffect } from 'react';

const INTERVAL_MS = 12 * 60 * 1000; // 12分（Render の15分スリープより短く）

export default function Keepalive() {
  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const ping = () => {
      fetch('/api/health').catch(() => {});
    };

    const schedule = () => {
      timerId = setTimeout(() => {
        if (!document.hidden) ping();
        schedule();
      }, INTERVAL_MS);
    };

    // タブが再びアクティブになったら即 ping
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

  return null;
}
