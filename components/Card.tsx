/**
 * Card.tsx — カード描画コンポーネント（画像ファイル不要）
 *
 * マーク1つ + 数字1つのシンプルなデザイン。
 * HTML/CSS のみで描画するため /public/cards/ は不要です。
 *
 * 対応フォーマット:
 *   - 通常カード: "AS" (Aスペード), "TC" (10クラブ), "2H" (2ハート) など
 *   - 裏面: "??"
 *
 * サイズプリセット:
 *   sm  44×64px  (他プレイヤー用)
 *   md  58×84px  (中間)
 *   lg  72×104px (自プレイヤー用)
 */

import React from 'react';

// ===== 定数 =====

/** スートのシンボル */
const SUIT_SYMBOL: Record<string, string> = {
  S: '♠', H: '♥', D: '♦', C: '♣',
};

/** スートの色（赤 / 黒） */
const SUIT_COLOR: Record<string, string> = {
  S: '#1a1a2e', // 黒（濃紺）
  H: '#cc1111', // 赤
  D: '#cc1111', // 赤
  C: '#1a1a2e', // 黒（濃紺）
};

/** 表示用ランク文字（T → 10 に変換） */
const RANK_LABEL: Record<string, string> = {
  T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A',
};

/** サイズプリセット */
const SIZE_PRESET = {
  sm: { w: 44,  h: 64,  fontSize: 15, suitSize: 13 },
  md: { w: 58,  h: 84,  fontSize: 19, suitSize: 17 },
  lg: { w: 72,  h: 104, fontSize: 23, suitSize: 20 },
} as const;

// ===== カードコード解析 =====

/**
 * カードコードをランクとスートに分解する
 * @example parseCard("AS") → { rank: "A", suit: "S" }
 * @example parseCard("10C") → { rank: "T", suit: "C" }  ※ T 表記を使うこと
 */
function parseCard(code: string): { rank: string; suit: string } | null {
  if (!code || code === '??' || code.length < 2) return null;
  const rank = code.slice(0, -1); // 最後の文字以外がランク
  const suit = code.slice(-1);    // 最後の文字がスート
  if (!SUIT_SYMBOL[suit]) return null;
  return { rank, suit };
}

// ===== コンポーネント =====

type CardSize = 'sm' | 'md' | 'lg';

interface CardProps {
  /** カードコード ("AS", "TC", "??", など) */
  code: string;
  /** サイズプリセット */
  size?: CardSize;
  /** 選択状態（捨てるカードとして選択中） */
  selected?: boolean;
  /** クリック可能かどうか */
  clickable?: boolean;
  /** フォールド中（半透明表示） */
  folded?: boolean;
  /** クリックハンドラ */
  onClick?: () => void;
}

/**
 * ポーカーカードを HTML/CSS で描画するコンポーネント。
 *
 * 表面: 左上に「ランク + スート」、中央に大きなスートマーク
 * 裏面: 青いグラデーション + ダイヤ柄
 */
const Card: React.FC<CardProps> = ({
  code,
  size    = 'md',
  selected  = false,
  clickable = false,
  folded    = false,
  onClick,
}) => {
  const dim     = SIZE_PRESET[size];
  const parsed  = parseCard(code);
  const isBack  = !parsed; // 裏面（"??" など）

  const color   = parsed ? SUIT_COLOR[parsed.suit]  : '#fff';
  const symbol  = parsed ? SUIT_SYMBOL[parsed.suit] : '';
  const rankStr = parsed ? (RANK_LABEL[parsed.rank] ?? parsed.rank) : '';

  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{
        /* ===== ボックスサイズ ===== */
        position:   'relative',
        width:      dim.w,
        height:     dim.h,
        flexShrink: 0,

        /* ===== カード外観 ===== */
        borderRadius: 6,
        background: isBack
          // 裏面: 青いグラデーション
          ? 'linear-gradient(135deg, #1a4a8a 0%, #0d2d5c 50%, #1a4a8a 100%)'
          // 表面: クリーム白
          : '#fffdf6',
        border: selected
          ? '2.5px solid #e84040'
          : '1.5px solid rgba(0,0,0,0.22)',
        boxShadow: selected
          ? '0 0 14px rgba(232,64,64,0.65), 0 3px 10px rgba(0,0,0,0.5)'
          : '0 3px 10px rgba(0,0,0,0.45)',

        /* ===== 状態に応じた演出 ===== */
        cursor:    clickable ? 'pointer' : 'default',
        opacity:   folded ? 0.35 : 1,
        // 選択中は上に浮き上がる
        transform: selected ? 'translateY(-14px)' : 'none',
        transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.1s',

        /* ===== レイアウト ===== */
        display:        'flex',
        flexDirection:  'column',
        justifyContent: 'space-between',
        padding:        '4px 5px',
        userSelect:     'none',
      }}
    >
      {isBack ? (
        // ===== 裏面デザイン =====
        <div style={{
          position:   'absolute',
          inset:      4,
          borderRadius: 4,
          border:     '1.5px solid rgba(255,255,255,0.25)',
          display:    'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          {/* 裏面の薄いダイヤマーク */}
          <span style={{
            fontSize:  dim.fontSize * 1.4,
            color:     'rgba(255,255,255,0.3)',
            lineHeight: 1,
          }}>♦</span>
        </div>
      ) : (
        // ===== 表面デザイン（左上にランク、中央に大きなスート）=====
        <>
          {/* ---- 左上: ランク ---- */}
          <div style={{
            position:  'absolute',
            top:       4,
            left:      6,
            lineHeight: 1,
            zIndex:    1,
          }}>
            <span style={{
              fontSize:   dim.fontSize,
              fontWeight: '900',
              color,
              fontFamily: 'Georgia, "Times New Roman", serif',
              lineHeight: 1,
            }}>
              {rankStr}
            </span>
          </div>

          {/* ---- 中央: スートマーク（大・鮮明）---- */}
          <div style={{
            position:       'absolute',
            inset:          0,
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
          }}>
            <span style={{
              fontSize:   dim.suitSize * 2.4,
              color,
              lineHeight: 1,
              userSelect: 'none',
            }}>
              {symbol}
            </span>
          </div>
        </>
      )}
    </div>
  );
};

export default Card;
