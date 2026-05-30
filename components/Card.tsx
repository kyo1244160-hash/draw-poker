/**
 * Card.tsx — カード描画コンポーネント（4色デッキ対応）
 *
 * デザイン（v2: BEAST+ 対応で全面刷新）:
 *   4色デッキ:
 *     ♠ スペード  → 黒（濃紺）
 *     ♥ ハート   → 赤
 *     ♦ ダイヤ   → 青
 *     ♣ クラブ   → 緑
 *   レイアウト:
 *     左上・右下: スートマークのみ（数字なし、右下は180°回転）
 *     中央:       ランク数字を大きく表示（スートマークなし）
 *     裏面:       青グラデーション + ダイヤ柄
 *
 * スタッド用追加プロパティ:
 *   isDown … true なら自分のダウンカード（金色の破線枠で区別）
 *
 * サイズプリセット:
 *   xs  26×38px  スタッド他プレイヤー重ねスロット等
 *   sm  32×48px  ドロー他プレイヤー用
 *   md  44×64px  スタッド他プレイヤーのアップカード用
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

/** サイズプリセット
 *  rankSize  … 中央のランク数字サイズ
 *  cornerSize… 角のスートマークサイズ
 */
const SIZE_PRESET = {
  xs: { w: 26, h: 38, rankSize: 17, cornerSize:  8 },
  sm: { w: 32, h: 48, rankSize: 21, cornerSize: 10 },
  md: { w: 44, h: 64, rankSize: 28, cornerSize: 12 },
  lg: { w: 66, h: 96, rankSize: 40, cornerSize: 15 },
} as const;

type CardSize = 'xs' | 'sm' | 'md' | 'lg';

interface CardProps {
  code:      string;
  size?:     CardSize;
  selected?: boolean;
  clickable?:boolean;
  folded?:   boolean;
  isDown?:   boolean;   // スタッド: 自分のダウンカード（破線枠）
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
  code, size = 'md', selected = false, clickable = false,
  folded = false, isDown = false, onClick,
}) => {
  const dim    = SIZE_PRESET[size];
  const parsed = parseCard(code);
  const isBack = !parsed;
  const color  = parsed ? SUIT_COLOR[parsed.suit]  : '#fff';
  const symbol = parsed ? SUIT_SYMBOL[parsed.suit] : '';
  const rank   = parsed ? (RANK_LABEL[parsed.rank] ?? parsed.rank) : '';

  // ボーダー決定（優先順位: 選択 > ダウンカード破線 > 通常）
  const border = selected
    ? '2.5px solid #e84040'
    : (isDown && !isBack)
      ? '2px dashed #c9a84c'
      : '1.5px solid rgba(0,0,0,0.22)';

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
        border,
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
          <span style={{ fontSize: dim.rankSize * 0.55, color: 'rgba(255,255,255,0.3)', lineHeight: 1 }}>♦</span>
        </div>
      ) : (
        /* 表面: 角マークのみ + 中央に大きなランク数字 */
        <>
          {/* 左上スートマーク */}
          <div style={{ position: 'absolute', top: 3, left: 4, lineHeight: 1 }}>
            <span style={{ fontSize: dim.cornerSize, color, lineHeight: 1 }}>{symbol}</span>
          </div>
          {/* 右下スートマーク（180°回転） */}
          <div style={{ position: 'absolute', bottom: 3, right: 4, lineHeight: 1, transform: 'rotate(180deg)' }}>
            <span style={{ fontSize: dim.cornerSize, color, lineHeight: 1 }}>{symbol}</span>
          </div>
          {/* 中央ランク数字 */}
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{
              fontSize: dim.rankSize, fontWeight: '900', color,
              fontFamily: 'Georgia, "Times New Roman", serif', lineHeight: 1,
            }}>{rank}</span>
          </div>
        </>
      )}
    </div>
  );
};

export default Card;
