import dynamic from 'next/dynamic';

// SSRを無効化してRoomコンポーネントを読み込む
const Room = dynamic(() => import('../components/Room'), { ssr: false });

export default function Home() {
  return <Room />;
}
