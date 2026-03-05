/**
 * Card.tsx — カード描画コンポーネント（4色デッキ対応）
 *
 * 4色デッキ:
 *   ♠ スペード  → 黒（濃紺）
 *   ♥ ハート   → 赤
 *   ♦ ダイヤ   → 青
 *   ♣ クラブ   → 緑
 *
 * 表示:
 *   左上: ランク文字（数字1つ）
 *   中央: スートマーク（大）
 *   裏面: 青グラデーション + ダイヤ柄
 *
 * サイズプリセット:
 *   sm  38×56px  他プレイヤー用
 *   md  52×76px  中間
 *   lg  66×96px  自分用（大）
 */

import React from 'react';

// ===== 4色デッキのスートシンボルと色 =====
const SUIT_SYMBOL: Record<string, string> = {
  S: '♠', H: '♥', D: '♦', C: '♣',
};

/** 4色デッキ: ♠黒 ♥赤 ♦青 ♣緑 */
const SUIT_COLOR: Record<string, string> = {
  S: '#1a1a2e', // 黒（濃紺）
  H: '#cc1111', // 赤
  D: '#1155cc', // 青
  C: '#228833', // 緑
};

/** 表示用ランク文字 */
const RANK_LABEL: Record<string, string> = {
  T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A',
};

/** サイズプリセット */
const SIZE_PRESET = {
  xs: { w: 26, h: 38, fontSize: 11, suitSize:  8, suitMult: 1.2 },
  sm: { w: 32, h: 48, fontSize: 11, suitSize:  9, suitMult: 1.3 },
  md: { w: 52, h: 76, fontSize: 17, suitSize: 15, suitMult: 2.5 },
  lg: { w: 66, h: 96, fontSize: 21, suitSize: 19, suitMult: 2.5 },
} as const;

type CardSize = 'xs' | 'sm' | 'md' | 'lg';

interface CardProps {
  code:      string;
  size?:     CardSize;
  selected?: boolean;
  clickable?:boolean;
  folded?:   boolean;
  onClick?:  () => void;
}

function parseCard(code: string): { rank: string; suit: string } | null {
  if (!code || code === '??' || code.length < 2) return null;
  const rank = code.slice(0, -1);
  const suit = code.slice(-1);
  if (!SUIT_SYMBOL[suit]) return null;
  return { rank, suit };
}

const Card: React.FC<CardProps> = ({
  code, size = 'md', selected = false, clickable = false, folded = false, onClick,
}) => {
  const dim    = SIZE_PRESET[size];
  const parsed = parseCard(code);
  const isBack = !parsed;
  const color  = parsed ? SUIT_COLOR[parsed.suit]  : '#fff';
  const symbol = parsed ? SUIT_SYMBOL[parsed.suit] : '';
  const rank   = parsed ? (RANK_LABEL[parsed.rank] ?? parsed.rank) : '';

  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{
        position:   'relative',
        width:      dim.w,
        height:     dim.h,
        flexShrink: 0,
        borderRadius: 5,
        background: isBack
          ? 'linear-gradient(135deg, #1a4a8a 0%, #0d2d5c 50%, #1a4a8a 100%)'
          : '#fffdf6',
        border: selected
          ? '2.5px solid #e84040'
          : '1.5px solid rgba(0,0,0,0.22)',
        boxShadow: selected
          ? '0 0 14px rgba(232,64,64,0.65), 0 3px 8px rgba(0,0,0,0.5)'
          : '0 2px 8px rgba(0,0,0,0.45)',
        cursor:     clickable ? 'pointer' : 'default',
        opacity:    folded ? 0.35 : 1,
        transform:  selected ? 'translateY(-14px)' : 'none',
        transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.1s',
        userSelect: 'none',
      }}
    >
      {isBack ? (
        /* 裏面 */
        <div style={{
          position: 'absolute', inset: 4, borderRadius: 3,
          border: '1.5px solid rgba(255,255,255,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ fontSize: dim.fontSize * 1.3, color: 'rgba(255,255,255,0.3)', lineHeight: 1 }}>♦</span>
        </div>
      ) : (
        /* 表面 */
        (size === 'xs' || size === 'sm') ? (
          /* xs/sm: ランク＋スートを縦積み中央表示 */
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 2,
          }}>
            <span style={{
              fontSize: dim.fontSize, fontWeight: '900', color,
              fontFamily: 'Georgia, "Times New Roman", serif', lineHeight: 1,
            }}>{rank}</span>
            <span style={{ fontSize: dim.suitSize * dim.suitMult, color, lineHeight: 1 }}>{symbol}</span>
          </div>
        ) : (
          /* md/lg: 左上にランク、中央に大きなスート */
          <>
            <div style={{ position: 'absolute', top: 3, left: 5, lineHeight: 1 }}>
              <span style={{
                fontSize: dim.fontSize, fontWeight: '900', color,
                fontFamily: 'Georgia, "Times New Roman", serif', lineHeight: 1,
              }}>{rank}</span>
            </div>
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontSize: dim.suitSize * dim.suitMult, color, lineHeight: 1 }}>{symbol}</span>
            </div>
          </>
        )
      )}
    </div>
  );
};

export default Card;
