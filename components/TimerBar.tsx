/**
 * TimerBar.tsx — 制限時間バー
 *
 * 残り時間を視覚的に表示するプログレスバーです。
 * 残り時間が少なくなると色が赤くなります。
 *
 * Props:
 *   remaining  現在の残り秒数
 *   limit      制限時間の総秒数
 */

import React from 'react';

interface TimerBarProps {
  /** 残り秒数 */
  remaining: number;
  /** 制限時間の総秒数 */
  limit: number;
}

const TimerBar: React.FC<TimerBarProps> = ({ remaining, limit }) => {
  if (!limit || limit <= 0) return null;

  const pct = Math.max(0, Math.min(100, (remaining / limit) * 100));

  // 残り時間に応じて色を変える（緑 → 黄 → 赤）
  const barColor =
    pct > 50 ? '#44cc66'  // 緑（余裕あり）
    : pct > 25 ? '#ccaa00' // 黄（注意）
    : '#cc3322';            // 赤（残り少ない）

  return (
    <div style={{
      width:        '100%',
      height:       5,
      background:   'rgba(255,255,255,0.1)',
      borderRadius: 3,
      overflow:     'hidden',
      margin:       '4px 0',
    }}>
      <div style={{
        height:       '100%',
        width:        `${pct}%`,
        background:   barColor,
        borderRadius: 3,
        transition:   'width 0.9s linear, background 0.5s',
        boxShadow:    pct < 25 ? `0 0 6px ${barColor}` : 'none',
      }} />
    </div>
  );
};

export default TimerBar;
