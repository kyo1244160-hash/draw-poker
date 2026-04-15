'use client';
// app/components/EliminatedOverlay.tsx
// 脱落時のオーバーレイ

interface Props {
  rank: number;
  totalPlayers: number;
  onClose: () => void;
  onShare?: () => void;
  shareMsg?: 'copied' | 'error' | null;
}

const POINT_TABLE: Record<number, number> = {
  1: 100, 2: 60, 3: 40, 4: 25, 5: 15,
};

function ordinal(n: number) {
  return `${n}位`;
}

export default function EliminatedOverlay({ rank, totalPlayers, onClose, onShare, shareMsg }: Props) {
  const points = POINT_TABLE[rank] ?? 0;
  // rank=0 はフォールバック検出（t:eliminated 未受信）の場合
  const rankUnknown = rank === 0;
  const isTop3 = !rankUnknown && rank <= 3;
  const emoji  = rankUnknown ? '💀' : rank === 1 ? '🏆' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '💀';

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/80 z-50 backdrop-blur-sm">
      <div className={[
        'bg-gray-900 rounded-2xl p-8 border-2 text-center max-w-sm w-full mx-4 shadow-2xl',
        isTop3 ? 'border-yellow-500' : 'border-gray-600',
      ].join(' ')}>
        {/* アイコン */}
        <div className="text-6xl mb-4">{emoji}</div>

        {/* 順位 */}
        <h2 className={[
          'text-3xl font-bold mb-1',
          isTop3 ? 'text-yellow-400' : 'text-white',
        ].join(' ')}>
          {rankUnknown ? '脱落' : ordinal(rank)}
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          {rankUnknown ? '集計中...' : `${totalPlayers}人中`}
        </p>

        {/* ポイント */}
        <div className={[
          'rounded-xl px-6 py-3 mb-6 inline-block',
          points > 0 ? 'bg-yellow-900/60 border border-yellow-600' : 'bg-gray-800',
        ].join(' ')}>
          <p className="text-xs text-gray-400 mb-0.5">獲得ポイント</p>
          <p className={`text-2xl font-bold ${points > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>
            {points > 0 ? `+${points} pt` : '0 pt'}
          </p>
        </div>

        {/* メッセージ */}
        <p className="text-gray-400 text-sm mb-6">
          {rank === 1
            ? '優勝おめでとうございます！'
            : isTop3
            ? 'お疲れさまでした！素晴らしい戦いでした。'
            : 'お疲れさまでした！また挑戦してください。'}
        </p>

        {/* シェアボタン */}
        {onShare && (
          <button
            onClick={onShare}
            className="w-full py-3 mb-3 rounded-lg font-semibold transition-colors bg-black hover:bg-gray-900 border border-gray-600 text-white flex items-center justify-center gap-2"
          >
            <span className="font-bold">𝕏</span>
            <span>結果をコピーして投稿</span>
          </button>
        )}
        {shareMsg === 'copied' && (
          <p className="text-green-400 text-xs mb-3 text-center">
            ✅ 画像をコピーしました！X の投稿画面で貼り付けてください
          </p>
        )}
        {shareMsg === 'error' && (
          <p className="text-yellow-400 text-xs mb-3 text-center">
            ⚠️ クリップボードコピー非対応です（ブラウザの制限）
          </p>
        )}
        {/* ボタン */}
        <button
          onClick={onClose}
          className="w-full py-3 bg-blue-700 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors"
        >
          結果を見る
        </button>
      </div>
    </div>
  );
}
