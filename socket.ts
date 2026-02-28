/**
 * socket.ts
 * クライアント用 Socket.IO インスタンスの初期化
 *
 * アプリ全体でこの1つのインスタンスを使い回す（シングルトン）
 * Room.tsx / DrawPokerRoom.tsx の両方がここをインポートする
 */

import io from 'socket.io-client';

// サーバーと同じオリジン・同じパス (/socket.io) に接続
// autoConnect: false にして、各コンポーネントで明示的に connect() を呼ぶ
export const socket = io({
  path: '/socket.io',
  transports: ['websocket'],
  autoConnect: false,
});
