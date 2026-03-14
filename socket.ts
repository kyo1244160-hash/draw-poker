/**
 * socket.ts
 * クライアント用 Socket.IO インスタンスの初期化
 *
 * アプリ全体でこの1つのインスタンスを使い回す（シングルトン）
 * Room.tsx から connectWithAuth() を呼んで認証付きで接続する。
 */

import io from 'socket.io-client';

export const socket = io({
  path:        '/socket.io',
  transports:  ['websocket'],
  autoConnect: false,
});

/**
 * NextAuth セッショントークンを取得して Socket.IO に渡してから接続する。
 * トークン取得に失敗した場合もゲストとして接続を試みる。
 */
export async function connectWithAuth(): Promise<boolean> {
  if (socket.connected) return true;
  try {
    const res = await fetch('/api/auth/socket-token');
    if (res.ok) {
      const { token } = await res.json();
      socket.auth = { token };
    }
  } catch { /* トークンなしでゲスト接続 */ }
  socket.connect();
  return true;
}
