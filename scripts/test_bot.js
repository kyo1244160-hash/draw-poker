/**
 * test_bot.js — BOTモデル単体テストスクリプト
 *
 * 使い方:
 *   node scripts/test_bot.js
 *
 * サーバーを起動せずにモデルの判断を直接確認できます。
 * DRAW-PROB（各カードの捨て確率）も表示します。
 *
 * 配置先: draw/scripts/test_bot.js
 */

'use strict';

const path = require('path');

// ============================================================
// 依存モジュール（draw/ ルートから実行すること）
// ============================================================
const { buildInfoState } = require(path.join(__dirname, '../server/poker/botInfoState'));
const { predictBetAction, predictDraw, preloadAll } = require(path.join(__dirname, '../server/poker/botModel'));

// ============================================================
// テストシナリオ定義
// 手牌・フェーズ・チップ等を自由に変更してください
// ============================================================
const SCENARIOS = [
  // ── 27TD ──────────────────────────────────────────────────
  {
    label: '27TD: AAペア（最悪の手） draw1',
    mode: '27',
    phase: 'draw1',
    hand: ['AH', 'AC', '5D', '8S', '3H'],
  },
  {
    label: '27TD: KKペア draw1',
    mode: '27',
    phase: 'draw1',
    hand: ['KH', 'KC', '7D', '4S', '2H'],
  },
  {
    label: '27TD: ノーペア 高カード K,Q,9 draw1',
    mode: '27',
    phase: 'draw1',
    hand: ['KH', 'QD', '9S', '5C', '3H'],
  },
  {
    label: '27TD: 良い手 2,3,4,5,7 draw1（スタンドパット期待）',
    mode: '27',
    phase: 'draw1',
    hand: ['2H', '3D', '4S', '5C', '7H'],
  },
  {
    label: '27TD: ほぼ完成 2,3,5,7,9 draw2（9だけ捨て期待）',
    mode: '27',
    phase: 'draw2',
    hand: ['2H', '3D', '5S', '7C', '9H'],
  },
  {
    label: '27TD: bet1でレイズ判断 良い手',
    mode: '27',
    phase: 'bet1',
    hand: ['2H', '3D', '4S', '5C', '7H'],
    pot: 2000,
    currentBet: 0,
    chips: 3000,
  },
  {
    label: '27TD: bet1でコール判断 悪い手',
    mode: '27',
    phase: 'bet1',
    hand: ['KH', 'KC', '7D', '4S', '2H'],
    pot: 2000,
    currentBet: 400,
    chips: 3000,
  },

  // ── Badugi ──────────────────────────────────────────────────
  {
    label: 'Badugi: 同スートが2枚 draw1（捨て期待）',
    mode: 'badugi',
    phase: 'draw1',
    hand: ['7C', '6D', '6S', 'AS'],
  },
  {
    label: 'Badugi: 4バドゥーギ完成 draw1（スタンドパット期待）',
    mode: 'badugi',
    phase: 'draw1',
    hand: ['2H', '3D', '4S', '5C'],
  },
  {
    label: 'Badugi: 3枚バドゥーギ draw2',
    mode: 'badugi',
    phase: 'draw2',
    hand: ['2H', '3D', '4S', 'KH'],
  },
  {
    label: 'Badugi: bet0でレイズ判断 4枚バドゥーギ',
    mode: 'badugi',
    phase: 'bet0',
    hand: ['2H', '3D', '4S', '5C'],
    pot: 800,
    currentBet: 400,
    chips: 4600,
  },
];

// ============================================================
// フェイクroomを構築
// ============================================================
function makeRoom(scenario) {
  const {
    mode,
    phase,
    hand,
    pot         = 1200,
    currentBet  = 400,
    chips       = 4600,
    bigBlind    = 400,
    startingChips = 5000,
    raiseCount  = 1,
  } = scenario;

  const botPlayer = {
    id:    'bot::test',
    name:  'TestBot',
    hand,
    chips,
    bet:   currentBet > 0 ? currentBet : 0,
    folded: false,
    sittingOut: false,
    drawCounts: [],
  };

  const opponents = [
    { id: 'opp1', chips: 4200, folded: false, sittingOut: false, bet: currentBet, drawCounts: [] },
    { id: 'opp2', chips: 3800, folded: false, sittingOut: false, bet: currentBet, drawCounts: [] },
    { id: 'opp3', chips: 3400, folded: false, sittingOut: false, bet: currentBet, drawCounts: [] },
  ];

  const room = {
    phase,
    pot,
    currentBet,
    raiseCount,
    bigBlind,
    betSize: phase === 'bet0' || phase === 'draw1' || phase === 'bet1' ? bigBlind : bigBlind * 2,
    startingChips,
    dealerIndex: 0,
    currentMode: mode,
    streetBetCounts: [0, 0, 0, 0],
    positionAggression: {},
    players: [botPlayer, ...opponents],
    actionIndex: 0,
  };

  return { room, botPlayer };
}

// ============================================================
// メイン実行
// ============================================================
async function main() {
  console.log('=== BOTモデル単体テスト ===\n');
  console.log('モデルをロード中...');
  await preloadAll();
  console.log('ロード完了\n');

  for (const scenario of SCENARIOS) {
    console.log('─'.repeat(60));
    console.log(`【${scenario.label}】`);
    console.log(`  手牌: ${scenario.hand.join(' ')}`);

    const { room, botPlayer } = makeRoom(scenario);
    const isDrawPhase = scenario.phase.startsWith('draw');
    const isBetPhase  = scenario.phase.startsWith('bet');

    if (isDrawPhase) {
      // ドロー判断（decideBotDrawWithRoom と同じロジック = model + rule fallback）
      const { decideBotDrawWithRoom: drawWithRoom } = require(path.join(__dirname, '../server/poker/botManager'));
      const indices = await drawWithRoom(room, botPlayer, scenario.mode);
      const kept     = scenario.hand.filter((_, i) => !indices.includes(i));
      const discarded = scenario.hand.filter((_, i) => indices.includes(i));
      console.log(`  → 捨てるカード: [${indices.join(',')}] ${discarded.length ? discarded.join(' ') : '（なし / スタンドパット）'} / 残す: ${kept.join(' ')}`);

    } else if (isBetPhase) {
      // ベット判断
      const toCall   = Math.max(0, room.currentBet - botPlayer.bet);
      const canRaise = room.raiseCount < 5;
      let legal;
      if (toCall === 0) {
        legal = canRaise ? ['check', 'bet'] : ['check'];
      } else {
        legal = ['fold', 'call'];
        if (canRaise) legal.push('raise');
      }

      const action = await decideBotBetAction(room, botPlayer);
      console.log(`  pot=${room.pot} currentBet=${room.currentBet} chips=${botPlayer.chips}`);
      console.log(`  合法アクション: ${legal.join('/')} → 判断: ${action}`);
    }
  }

  console.log('\n─'.repeat(60));
  console.log('テスト完了');
  process.exit(0);
}

// decideBotBetActionをインポート
const { decideBotBetAction } = require(path.join(__dirname, '../server/poker/botManager'));

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
