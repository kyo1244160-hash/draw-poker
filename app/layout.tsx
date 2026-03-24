// app/layout.tsx
import type { Metadata } from 'next';
import './globals.css';
import Keepalive from './Keepalive';

export const metadata: Metadata = {
  title: 'Poker Room Pastis',
  description: 'マルチプレイヤードローポーカー',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet" />
      </head>
      <body>
        <Keepalive /> {/* Render スリープ防止: App Router 全ページで有効 */}
        {children}
      </body>
    </html>
  );
}
