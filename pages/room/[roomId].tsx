import { useRouter } from 'next/router';
import DrawPokerRoom from '../../components/DrawPokerRoom';
import DefaultRoom from '../../components/DefaultRoom';

export default function RoomPage() {
  const router = useRouter();
  const { roomId, name } = router.query;

  if (!roomId || typeof roomId !== 'string' || !name || typeof name !== 'string') {
    return <p>読み込み中...</p>;
  }

  // room1 と room2 だけドローポーカーを表示
  if (roomId === 'room1' || roomId === 'room2') {
    return <DrawPokerRoom roomId={roomId} name={name} />;
  }

  // それ以外のルームはデフォルト画面へ
  return <DefaultRoom roomId={roomId} name={name} />;
}
