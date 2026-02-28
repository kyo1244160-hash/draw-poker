/**
 * BadugiRoom.tsx — Badugi ゲーム画面
 *
 * PokerTable コンポーネントを mode='badugi' で呼び出すラッパーです。
 * Badugi の特徴:
 *   - 手札4枚（2-7 は5枚）
 *   - スートが全て異なる低い手が最強（バドゥギ）
 *   - 有効枚数（4枚 > 3枚 > 2枚 > 1枚）が多いほど強い
 */
import React from 'react';
import PokerTable from './PokerTable';

interface Props {
  roomId: string;
  name:   string;
}

const BadugiRoom: React.FC<Props> = ({ roomId, name }) => (
  <PokerTable roomId={roomId} name={name} mode="badugi" />
);

export default BadugiRoom;
