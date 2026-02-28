// ✅ こうなってる？
export default function DefaultRoom({ roomId, name }: { roomId: string; name: string }) {
  return (
    <div style={{ padding: '2rem' }}>
      <h2>🚪 {roomId} ルームへようこそ！</h2>
      <p>{name} さん、このルームではまだゲームが準備されていません。</p>
    </div>
  );
}
