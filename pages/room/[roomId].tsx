/**
 * pages/room/[roomId].tsx — ルームページ
 *
 * URL: /room/[roomId]?name=[プレイヤー名]
 *
 * ゲームタイプの振り分け:
 *   roomId に "badugi" → BadugiRoom (mode='badugi')
 *   roomId に "mix"    → PokerTable (mode='mix')
 *   それ以外           → DrawPokerRoom (mode='27')
 */

import { useRouter } from 'next/router';
import PokerTable  from '../../components/PokerTable';
import DefaultRoom from '../../components/DefaultRoom';

export default function RoomPage() {
  const router           = useRouter();
  const { roomId, name } = router.query;

  if (!roomId || typeof roomId !== 'string' || !name || typeof name !== 'string') {
    return <div style={{ color: '#fff', padding: '2rem', textAlign: 'center' }}>読み込み中...</div>;
  }

  // ゲームモードを判定
  const mode = roomId.includes('badugi') ? 'badugi'
             : roomId.includes('mix')    ? 'mix'
             : '27';

  // 全ゲームタイプを PokerTable で統一処理
  return <PokerTable roomId={roomId} name={name} mode={mode as '27'|'badugi'|'mix'} />;
}
