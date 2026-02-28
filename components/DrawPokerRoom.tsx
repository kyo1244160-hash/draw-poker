/**
 * DrawPokerRoom.tsx — 2-7 Triple Draw ゲーム画面
 *
 * PokerTable コンポーネントを mode='27' で呼び出すラッパーです。
 * ゲームロジックは PokerTable と server/poker/gameManager.js が担当します。
 */
import React from 'react';
import PokerTable from './PokerTable';

interface Props {
  roomId: string;
  name:   string;
}

const DrawPokerRoom: React.FC<Props> = ({ roomId, name }) => (
  <PokerTable roomId={roomId} name={name} mode="27" />
);

export default DrawPokerRoom;
