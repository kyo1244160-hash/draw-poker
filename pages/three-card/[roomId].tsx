/**
 * pages/three-card/[roomId].tsx
 * スリーカードポーカー ゲームページ
 */

import dynamic from 'next/dynamic';

const ThreeCardGame = dynamic(() => import('../../components/ThreeCardGame'), { ssr: false });

export default function ThreeCardPage() {
  return <ThreeCardGame />;
}
