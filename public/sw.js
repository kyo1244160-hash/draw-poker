/**
 * sw.js — Service Worker (PWA)
 *
 * キャッシュ戦略:
 *   - ナビゲーションリクエスト: Network First（常に最新を取得）
 *   - 静的アセット（JS/CSS/画像）: Cache First（高速表示）
 *   - Socket.IO: キャッシュなし（リアルタイム通信）
 */

const CACHE_NAME = 'pastis-v1';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// インストール: 静的アセットをキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// フェッチ: Socket.IO はスルー、他はキャッシュ戦略
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Socket.IO / API はキャッシュしない
  if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api/')) return;

  // HTML ナビゲーション: Network First
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/'))
    );
    return;
  }

  // 静的アセット: Cache First
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
