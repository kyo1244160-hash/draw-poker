import '../styles/globals.css';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { SessionProvider, useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { socket, connectWithAuth } from '../socket';
import { useKeepalive } from '../lib/useKeepalive'; // ← 追加

/** どのページにいても参加済みトーナメントの開始通知を受け取り自動遷移する */
function TournamentStartWatcher() {
  const { data: session } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!session?.user?.accountId) return;

    // すでにdraw/spectateページにいる場合はここでの遷移は不要
    const onTournamentStarting = async ({ tournamentId }: { tournamentId: string; tableId: string }) => {
      const currentPath = window.location.pathname;
      if (currentPath.includes('/draw') || currentPath.includes('/spectate')) return;

      // 自分が登録済みかつ脱落していないか確認
      try {
        const res = await fetch(`/api/tournament/${tournamentId}/entry`);
        if (!res.ok) return;
        const data = await res.json();
        // isEliminated=true の場合は draw ページへ遷移しない（観戦ボタンで手動移動）
        if (data.registered && !data.isEliminated) {
          router.push(`/tournament/${tournamentId}/draw`);
        }
      } catch {
        // 取得失敗は無視
      }
    };

    socket.on('t:tournamentStarting', onTournamentStarting);
    if (!socket.connected) connectWithAuth();

    return () => { socket.off('t:tournamentStarting', onTournamentStarting); };
  }, [session?.user?.accountId, router]);

  return null;
}

/** Render スリープ防止 keepalive（全ページで有効） */
function Keepalive() {
  useKeepalive();
  return null;
}

export default function App({ Component, pageProps: { session, ...pageProps } }: AppProps) {
  return (
    <SessionProvider session={session}>
      <Head>
        {/* スマホでのズーム防止 + viewport-fit=cover でノッチ対応 */}
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
      </Head>
      <TournamentStartWatcher />
      <Keepalive /> {/* ← 追加 */}
      <Component {...pageProps} />
    </SessionProvider>
  );
}
