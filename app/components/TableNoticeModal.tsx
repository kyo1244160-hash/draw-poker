'use client';
// app/components/TableNoticeModal.tsx
// テーブルイベント通知モーダル — 複数通知を1つのモーダルにまとめて表示

import { useEffect, useRef } from 'react';

export type NoticeType = 'bust' | 'arrived' | 'left' | 'blindUp' | 'break';

export interface NoticeItem {
  id: number;
  type: NoticeType;
  playerName: string;
  rank?: number;
  totalPlayers?: number;
}

interface Props {
  notices: NoticeItem[];
  onClose: () => void;
  autoCloseMs?: number;
}

const CFG: Record<NoticeType, { emoji: string; color: string; label: (n: string, r?: number, t?: number) => string }> = {
  bust:    { emoji: '💀', color: '#ff8888', label: (n, r, t) => `${n} がバストしました${r && t ? `（${t}人中 ${r}位）` : ''}` },
  arrived: { emoji: '👋', color: '#88ddff', label: (n) => `${n} が別テーブルから合流しました` },
  left:    { emoji: '➡️', color: '#ffcc88', label: (n) => `${n} が別テーブルへ移動しました` },
  blindUp: { emoji: '⬆️', color: '#aaffaa', label: (n) => n },
  break:   { emoji: '☕', color: '#cc99ff', label: (n) => n },
};

export default function TableNoticeModal({ notices, onClose, autoCloseMs = 5000 }: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 通知が増えるたびにタイマーをリセット（最後の通知から5秒後に自動クローズ）
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(onClose, autoCloseMs);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [notices, onClose, autoCloseMs]);

  if (notices.length === 0) return null;

  return (
    // pointerEvents: 'none' で背後のアクションボタン操作を妨げない（非ブロッキング表示）
    <div
      style={{
        position: 'fixed', top: 44, right: 8, zIndex: 55,
        display: 'flex', flexDirection: 'column' as const,
        alignItems: 'flex-end', gap: 4,
        pointerEvents: 'none',
        animation: 'tnFadeIn 0.2s ease-out',
      }}
    >
      <div
        style={{
          background: 'linear-gradient(160deg,rgba(10,20,35,0.95),rgba(5,10,20,0.95))',
          border: '1px solid rgba(100,130,180,0.4)',
          borderRadius: 10,
          padding: '10px 14px',
          minWidth: 200,
          maxWidth: 280,
          boxShadow: '0 4px 20px rgba(0,0,0,0.7)',
          animation: 'tnSlideUp 0.25s ease-out',
          position: 'relative' as const,
          pointerEvents: 'auto',
        }}
        onClick={onClose}
      >
        {/* ヘッダー */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 8,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          paddingBottom: 6,
        }}>
          <span style={{
            fontFamily: 'var(--font-title)', fontSize: 11, fontWeight: 700,
            color: 'rgba(255,255,255,0.4)', letterSpacing: '0.06em',
          }}>
            📋 テーブル情報
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 5,
              color: 'rgba(255,255,255,0.6)',
              fontFamily: 'var(--font-title)',
              fontSize: 10,
              padding: '1px 7px',
              cursor: 'pointer',
              lineHeight: 1.6,
            }}
          >
            閉じる
          </button>
        </div>

        {/* 通知リスト */}
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
          {notices.map((n) => {
            const cfg = CFG[n.type];
            return (
              <div key={n.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                padding: '8px 12px',
              }}>
                <span style={{ fontSize: 18, lineHeight: 1.4, flexShrink: 0 }}>{cfg.emoji}</span>
                <span style={{
                  fontFamily: 'var(--font-body)', fontSize: 13,
                  color: cfg.color, lineHeight: 1.5,
                }}>
                  {cfg.label(n.playerName, n.rank, n.totalPlayers)}
                </span>
              </div>
            );
          })}
        </div>

        {/* フッター */}
        <div style={{
          marginTop: 8, textAlign: 'center' as const,
          fontFamily: 'var(--font-body)', fontSize: 10,
          color: 'rgba(255,255,255,0.2)',
        }}>
          {Math.round(autoCloseMs / 1000)}秒後に閉じます
        </div>
      </div>

      <style>{`
        @keyframes tnFadeIn  { from { opacity:0 }                          to { opacity:1 } }
        @keyframes tnSlideUp { from { transform:translateX(14px);opacity:0 } to { transform:translateX(0);opacity:1 } }
      `}</style>
    </div>
  );
}
