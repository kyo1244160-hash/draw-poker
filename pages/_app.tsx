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

    const onTournamentStarting = async ({ tournamentId }: { tournamentId: string; tableId: string }) => {
      const currentPath = window.location.pathname;
      // drawページ: 既にゲーム中なので不要
      if (currentPath.includes('/draw')) return;
      // spectateページ: 「観戦中のトーナメント」と「自分が参加登録しているトーナメント」が
      // 異なる場合、ここで検知して遷移する（spectate側のリスナーはparams.idでフィルタするため）
      // 観戦中のURLが /tournament/A/spectate で、開始したのがBトーナメントの場合のみ遷移
      if (currentPath.includes('/spectate')) {
        // 観戦中のトーナメントIDをURLから取得
        const spectateMatch = currentPath.match(/\/tournament\/([^/]+)\/spectate/);
        const spectatingId = spectateMatch?.[1];
        // 開始したトーナメントが自分が観戦中のものと同じなら spectate側で処理済み
        if (spectatingId === tournamentId) return;
        // 別トーナメントが開始 → 参加登録確認してから遷移
      }

      // 自分が登録済みかつ脱落していないか確認
      try {
        const res = await fetch(`/api/tournament/${tournamentId}/entry`);
        if (!res.ok) return;
        const data = await res.json();
        // isEliminated: サーバーメモリ参照が失敗した場合のフォールバックとして
        // 進行中トーナメントで結果エントリ(myEntry)が存在すれば脱落済みとみなす
        const isEliminated =
          (data.isEliminated === true) ||
          (data.tournament?.status === 'running' && !!data.myEntry);
        if (data.registered && !isEliminated) {
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
