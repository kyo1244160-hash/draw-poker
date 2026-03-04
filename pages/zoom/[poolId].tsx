/**
 * pages/zoom/[poolId].tsx — FastFold（Zoom）テーブルページ
 *
 * URL: /zoom/[poolId]?name=[プレイヤー名]
 */

import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';

const ZoomTable = dynamic(() => import('../../components/ZoomTable'), { ssr: false });

export default function ZoomPage() {
  const router             = useRouter();
  const { poolId, name }   = router.query;

  if (!poolId || typeof poolId !== 'string' || !name || typeof name !== 'string') {
    return <div style={{ color: '#fff', padding: '2rem', textAlign: 'center' }}>読み込み中...</div>;
  }

  const mode = poolId.includes('badugi') ? 'badugi'
             : poolId.includes('mix')    ? 'mix'
             : '27';

  return <ZoomTable poolId={poolId} name={name} mode={mode as '27' | 'badugi' | 'mix'} />;
}
