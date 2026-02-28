/**
 * pages/room/[roomId].tsx — ルームページ
 *
 * URL パターン: /room/[roomId]?name=[プレイヤー名]
 *
 * ゲームタイプの振り分け:
 *   roomId に "badugi" が含まれる → BadugiRoom
 *   それ以外 → DrawPokerRoom (2-7 Triple Draw)
 *
 * 部屋番号の命名規則:
 *   奇数番号: 27-room-1, 27-room-3, ...   → 2-7 Triple Draw
 *   偶数番号: badugi-room-2, badugi-room-4, ... → Badugi
 */

import { useRouter } from 'next/router';
import DrawPokerRoom from '../../components/DrawPokerRoom';
import BadugiRoom    from '../../components/BadugiRoom';
import DefaultRoom   from '../../components/DefaultRoom';

export default function RoomPage() {
  const router             = useRouter();
  const { roomId, name }   = router.query;

  // クエリパラメータの読み込み待ち
  if (!roomId || typeof roomId !== 'string' || !name || typeof name !== 'string') {
    return (
      <div style={{ color: '#fff', fontFamily: 'serif', padding: '2rem', textAlign: 'center' }}>
        読み込み中...
      </div>
    );
  }

  // Badugi ルーム（部屋IDに "badugi" を含む）
  if (roomId.includes('badugi')) {
    return <BadugiRoom roomId={roomId} name={name} />;
  }

  // 2-7 Triple Draw ルーム（部屋IDに "27" を含む）
  if (roomId.includes('27')) {
    return <DrawPokerRoom roomId={roomId} name={name} />;
  }

  // その他のルーム（フォールバック）
  return <DefaultRoom roomId={roomId} name={name} />;
}
