/**
 * scripts/test-poker-logic.js
 * チップ精算・手役評価の回帰テスト（Node 標準 assert のみ・依存ゼロ）
 *
 * 実行: node scripts/test-poker-logic.js
 *
 * 目的: チップ（=金銭）に直結する純粋関数の正しさを保証する。
 *   - handEvaluator: ドロー系の勝者判定
 *   - studEvaluator: スタッド系の Hi/Lo 勝者判定
 *   - studManager._awardStudPots: チップ保存則（精算前後で総量不変）
 *
 * 各期待値は実装の実測値ではなく「ポーカーのルール上正しい結果」に基づく。
 * テストが落ちた場合、実装かテストのどちらが誤っているかを必ず精査すること。
 */

const assert = require('assert');
const he = require('../server/poker/handEvaluator');
const se = require('../server/poker/studEvaluator');
const sm = require('../server/poker/studManager');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function makeStudRoom(mode, players, pot) {
  return { id: 'test-room-0000', currentMode: mode, mode, pot, dealerIndex: 0, players };
}

// チップ保存則アサーション: 精算前後で「全チップ + pot」が不変
function assertChipConservation(room, players, label) {
  const before = players.reduce((s, p) => s + p.chips, 0) + room.pot;
  sm._awardStudPots(room, players.filter((p) => !p.folded && !p.sittingOut));
  const after = players.reduce((s, p) => s + p.chips, 0) + room.pot;
  assert.strictEqual(after, before, `${label}: チップ保存則違反 before=${before} after=${after}`);
  assert.strictEqual(room.pot, 0, `${label}: 精算後 pot が 0 でない (${room.pot})`);
}

console.log('\n=== handEvaluator: 2-7 ローボール ===');

test('7-5-4-3-2 がワンペアより強い（ローは低いほど強い）', () => {
  const nuts = ['7S', '5H', '4D', '3C', '2S'];
  const pair = ['2S', '2H', '5D', '4C', '3S'];
  assert.ok(he.compare27Hands(nuts, pair) < 0, 'nuts が勝つべき');
});

test('findWinners が単独勝者を返す', () => {
  const players = [
    { id: 'a', hand: ['7S', '5H', '4D', '3C', '2S'] },
    { id: 'b', hand: ['2S', '2H', '5D', '4C', '3S'] },
  ];
  const w = he.findWinners(players, '27');
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].id, 'a');
});

test('findWinners が引き分けで複数勝者を返す（スプリット）', () => {
  const players = [
    { id: 'x', hand: ['7S', '5H', '4D', '3C', '2S'] },
    { id: 'y', hand: ['7H', '5S', '4C', '3D', '2H'] },
  ];
  const w = he.findWinners(players, '27');
  assert.strictEqual(w.length, 2, '同点は2人勝者');
});

test('空配列で findWinners がクラッシュしない', () => {
  assert.deepStrictEqual(he.findWinners([], '27'), []);
  assert.deepStrictEqual(he.findWinners(null, '27'), []);
});

console.log('\n=== studEvaluator: スタッド Hi/Lo ===');

test('7枚から最良5枚を選ぶ（両者同じストレートで引き分け）', () => {
  // B: 2,3,4,5,6,8,9 → ストレート 2-3-4-5-6
  // C: 2,2,3,3,4,5,6 → ストレート 2-3-4-5-6（ペアは無視され最良5枚はストレート）
  const B = { id: 'b', cards: ['2C', '3D', '4H', '5S', '6C', '8D', '9H'] };
  const C = { id: 'c', cards: ['2S', '2H', '3C', '3S', '4D', '5C', '6H'] };
  const w = se.findHiWinners([B, C], 'stud_s');
  assert.strictEqual(w.length, 2, '両者ストレートで引き分け');
});

test('razz では findHiWinners が空（ハイ無し）', () => {
  const players = [{ id: 'a', cards: ['AS', '2H', '3D', '4C', '5S', '6D', '7H'] }];
  assert.deepStrictEqual(se.findHiWinners(players, 'razz'), []);
});

test('stud_s では findLoWinners が空（ロー無し）', () => {
  const players = [{ id: 'a', cards: ['AS', '2H', '3D', '4C', '5S', '6D', '7H'] }];
  assert.deepStrictEqual(se.findLoWinners(players, 'stud_s'), []);
});

test('stud_e のローは8以下クオリファイ必須（9highは不成立）', () => {
  // 9 を含むためローは A2345... ではなく、全カード9以上混じりで不成立を作る
  const noLo = { id: 'a', cards: ['9S', 'TH', 'JD', 'QC', 'KS', 'AD', '9H'] };
  const lo = se.findLoWinners([noLo], 'stud_e');
  assert.strictEqual(lo.length, 0, '8以下5枚が無ければロー不成立');
});

console.log('\n=== Razz: ノークオリファイ表記の修正 ===');

test('Razz は5枚未満でも「ノークオリファイ」と表示しない（中間ストリート）', () => {
  // 2,9,8,8,K（8ペアで unique=4種）→ 旧実装は「ノークオリファイ」
  const name = se.studHandName(['2C', '9H', '8H', '8D', 'KC'], 'razz');
  assert.notStrictEqual(name, 'ノークオリファイ', 'Razzにノークオリファイは存在しない');
  assert.strictEqual(name, 'K-9-8-2', '現状の最良ローを降順表示');
});

test('Razz 7枚は確定ローを表示', () => {
  const name = se.studHandName(['2C', '9H', '8H', '8D', 'KC', '5S', '3D'], 'razz');
  assert.strictEqual(name, '9-8-5-3-2', '7枚から最良5枚ロー');
});

test('Razz 3rd street（3枚）も表示できる', () => {
  const name = se.studHandName(['2C', '9H', '8H'], 'razz');
  assert.strictEqual(name, '9-8-2');
});

test('Razz 勝者判定: 5枚揃いが部分手に勝つ', () => {
  const players = [
    { id: 'a', cards: ['2C', '9H', '8H', '8D', 'KC'] },       // 部分(8ペア) K-9-8-2
    { id: 'b', cards: ['AC', '3D', '5H', '7S', '9C'] },       // 完全 9-7-5-3-A
  ];
  const w = se.findLoWinners(players, 'razz');
  assert.deepStrictEqual(w, ['b'], '5枚揃いの b が勝つ');
});

test('Razz 勝者判定: 全員ペアでも勝者が出る（保存則の前提）', () => {
  const players = [
    { id: 'a', cards: ['2C', '2D', '3H', '3S', '4C'] },  // unique {2,3,4}=3種
    { id: 'b', cards: ['5C', '5D', '6H', '6S', '7C'] },  // unique {5,6,7}=3種
  ];
  const w = se.findLoWinners(players, 'razz');
  assert.strictEqual(w.length, 1, '同じユニーク数なら低い方が勝つ');
  assert.strictEqual(w[0], 'a', 'a (2-3-4) が b (5-6-7) より強い');
});

console.log('\n=== 中間ストリート手役の捏造防止（スクショ4バグ）===');

test('3枚 A,2,4 はワンペアでなくハイカード（ダミー水増し禁止）', () => {
  // 旧実装はダミーカード2C,3Cで水増しし、偽のペアを作っていた
  assert.strictEqual(se.studHandName(['AD', '2H', '4S'], 'stud_e'), 'ハイカード');
});

test('同スート3枚はフラッシュにならない（5枚必須）', () => {
  assert.strictEqual(se.studHandName(['AH', '2H', '4H'], 'stud_s'), 'ハイカード');
});

test('連続3枚はストレートにならない（5枚必須）', () => {
  assert.strictEqual(se.studHandName(['2H', '3S', '4D'], 'stud_s'), 'ハイカード');
});

test('実ペア（4,4,7,K）は正しくワンペア', () => {
  assert.strictEqual(se.studHandName(['4H', '4S', '7D', 'KC'], 'stud_s'), 'ワンペア');
});

test('5枚の同スートは正しくフラッシュ', () => {
  assert.strictEqual(se.studHandName(['AH', '2H', '4H', '7H', '9H'], 'stud_s'), 'フラッシュ');
});

test('5枚の連続は正しくストレート', () => {
  assert.strictEqual(se.studHandName(['2C', '3D', '4H', '5S', '6C'], 'stud_s'), 'ストレート');
});

test('7枚ショーダウンの勝者判定は正常（フォーカード > ストレート）', () => {
  const players = [
    { id: 'a', cards: ['AS', 'AH', 'AD', 'AC', 'KS', 'KH', 'QD'] },
    { id: 'b', cards: ['2C', '3D', '4H', '5S', '6C', '8D', '9H'] },
  ];
  assert.deepStrictEqual(se.findHiWinners(players, 'stud_s'), ['a']);
});

console.log('\n=== removePlayerForBalance: バランシング時の安全削除 ===');

test('removePlayerForBalance: actionIndexより前の削除でactionIndexがデクリメント', () => {
  const r = sm.ensureStudRoom('rb-test1', {});
  r.players = [
    { id: 'p0', accountId: 'a0', name: 'P0' },
    { id: 'p1', accountId: 'a1', name: 'P1' },
    { id: 'p2', accountId: 'a2', name: 'P2' },
  ];
  r.actionIndex = 2; r.fixedDealerIdx = 1; r.phase = 'bet3rd';
  sm.removePlayerForBalance('rb-test1', 'p0', 'a0');
  assert.strictEqual(r.actionIndex, 1, 'actionIndexがデクリメント');
  assert.strictEqual(r.fixedDealerIdx, 0, 'fixedDealerIdxもデクリメント');
  assert.strictEqual(r.players.length, 2);
  sm.studRooms.delete('rb-test1');
});

test('removePlayerForBalance: actionIndex本人の削除で-1', () => {
  const r = sm.ensureStudRoom('rb-test2', {});
  r.players = [{ id: 'p0', accountId: 'a0', name: 'P0' }, { id: 'p1', accountId: 'a1', name: 'P1' }];
  r.actionIndex = 1; r.phase = 'bet3rd';
  sm.removePlayerForBalance('rb-test2', 'p1', 'a1');
  assert.strictEqual(r.actionIndex, -1, 'actionIndex本人削除で-1');
  sm.studRooms.delete('rb-test2');
});

test('removePlayerForBalance: 最後の1人削除でphase=waiting', () => {
  const r = sm.ensureStudRoom('rb-test3', {});
  r.players = [{ id: 'p0', accountId: 'a0', name: 'P0' }];
  r.actionIndex = 0; r.phase = 'bet3rd'; r.pot = 500;
  sm.removePlayerForBalance('rb-test3', 'p0', 'a0');
  assert.strictEqual(r.phase, 'waiting', '空になったらwaiting');
  assert.strictEqual(r.players.length, 0);
  sm.studRooms.delete('rb-test3');
});

test('removePlayerForBalance: accountId照合（socket.id変更後も削除できる）', () => {
  const r = sm.ensureStudRoom('rb-test4', {});
  r.players = [{ id: 'OLD', accountId: 'a0', name: 'P0' }, { id: 'p1', accountId: 'a1', name: 'P1' }];
  r.actionIndex = 0; r.phase = 'showdown';
  const ok = sm.removePlayerForBalance('rb-test4', 'NEWID', 'a0');
  assert.strictEqual(ok, true, 'accountId一致で削除成功');
  assert.strictEqual(r.players.length, 1);
  assert.strictEqual(r.players[0].name, 'P1');
  sm.studRooms.delete('rb-test4');
});

test('removePlayerForBalance: 存在しないプレイヤーはfalse', () => {
  const r = sm.ensureStudRoom('rb-test5', {});
  r.players = [{ id: 'p0', accountId: 'a0', name: 'P0' }];
  assert.strictEqual(sm.removePlayerForBalance('rb-test5', 'xxx', 'yyy'), false);
  sm.studRooms.delete('rb-test5');
});

test('syncToGameManager は accountId で照合しチップを書き戻す（id変更後も成功）', () => {
  const room = sm.ensureStudRoom('test-sync-acc', {});
  room.currentMode = 'stud_s'; room.mode = 'stud_s';
  room.smallBet = 400; room.bigBet = 800; room.handCount = 5;
  room.players = [
    { id: 'OLD_SOCKET_1', accountId: 'acc-1', name: 'HOGE', chips: 5400, sittingOut: false },
    { id: 'OLD_SOCKET_2', accountId: 'acc-2', name: 'Fujita', chips: 4600, sittingOut: false },
  ];
  // gameManager 側は再接続で socket.id が変わっている状況を再現
  const gmRoom = {
    id: 'test-sync-acc',
    handCount: 0,
    players: [
      { id: 'NEW_SOCKET_1', accountId: 'acc-1', name: 'HOGE', chips: 0 },   // id変更・チップ古い
      { id: 'NEW_SOCKET_2', accountId: 'acc-2', name: 'Fujita', chips: 0 },
    ],
  };
  sm.syncToGameManager(gmRoom);
  // accountId 照合で正しくチップが書き戻される（id が違っても）
  assert.strictEqual(gmRoom.players[0].chips, 5400, 'HOGEのチップがaccountId経由で復元');
  assert.strictEqual(gmRoom.players[1].chips, 4600, 'FujitaのチップがaccountId経由で復元');
  sm.studRooms.delete('test-sync-acc');
});

test('updateStudPlayerSocketId が studManager 側の id を更新する', () => {
  const room = sm.ensureStudRoom('test-update-id', {});
  room.players = [
    { id: 'OLD', accountId: 'acc-x', name: 'HOGE', chips: 5400, sittingOut: false, disconnected: true },
  ];
  const updated = sm.updateStudPlayerSocketId('test-update-id', 'acc-x', 'HOGE', 'NEW');
  assert.strictEqual(updated, true, '更新成功');
  assert.strictEqual(room.players[0].id, 'NEW', 'idがNEWに更新');
  assert.strictEqual(room.players[0].disconnected, false, 'disconnectedも解除');
  sm.studRooms.delete('test-update-id');
});

test('syncToGameManager: id一致のみ（accountIdなし）でも従来通り動作', () => {
  const room = sm.ensureStudRoom('test-sync-id', {});
  room.handCount = 3;
  room.players = [
    { id: 'SOCK_1', accountId: null, name: 'Bot1', chips: 3000, sittingOut: false },
  ];
  const gmRoom = {
    id: 'test-sync-id', handCount: 0,
    players: [{ id: 'SOCK_1', accountId: null, name: 'Bot1', chips: 0 }],
  };
  sm.syncToGameManager(gmRoom);
  assert.strictEqual(gmRoom.players[0].chips, 3000, 'id照合でチップ復元');
  sm.studRooms.delete('test-sync-id');
});

test('3rd street【選択制】: BI者から開始、bringInで最小ポスト、左隣へ進む', () => {
  const room = sm.ensureStudRoom('test-bringin-flow', {});
  room.currentMode = 'stud_s'; room.mode = 'stud_s';
  room.smallBet = 400; room.bigBet = 800; room.handCount = 0;
  room.players = [
    { id: 'p1', name: 'A', chips: 5000, sittingOut: false },
    { id: 'p2', name: 'B', chips: 5000, sittingOut: false },
    { id: 'p3', name: 'C', chips: 5000, sittingOut: false },
  ];
  sm.startStudHand(room, () => {}, { skipHandCountIncrement: true });

  const biIdx = room.bringInIndex;
  assert.ok(biIdx >= 0, 'ブリングイン者が決まる');
  // 【選択制】開始時は強制ポストされない（bet=0, currentBet=0）
  assert.strictEqual(room.currentBet, 0, '開始時 currentBet=0（強制ポストなし）');
  assert.strictEqual(room.players[biIdx].bet, 0, 'BI者はまだポストしていない');
  assert.strictEqual(room.players[biIdx].mustBringIn, true, 'BI者は選択待ち');
  // 【選択制】アクションはBI者本人から始まる
  assert.strictEqual(room.actionIndex, biIdx, '開始はBI者本人');

  // BI者が bringIn を選択
  const biPlayer = room.players[biIdx];
  const r1 = sm.studBetAction(room.id, biPlayer.id, 'bringIn', 0);
  assert.ok(r1, 'bringIn成功');
  assert.strictEqual(room.players[biIdx].bet, room.bringInAmount, 'bringInで最小額ポスト');
  assert.strictEqual(room.players[biIdx].mustBringIn, false, '選択完了');

  // 残りを進める
  let guard = 0;
  while (room.phase === 'bet3rd' && guard < 12) {
    guard++;
    const cur = room.players[room.actionIndex];
    const toCall = room.currentBet - cur.bet;
    const r = sm.studBetAction(room.id, cur.id, toCall > 0 ? 'call' : 'check', 0);
    assert.ok(r, `studBetAction成功(${cur.name})`);
  }
  assert.strictEqual(room.phase, 'bet4th', '3rd完了で4thへ');
  sm.studRooms.delete('test-bringin-flow');
});

test('3rd street【選択制】: BI者がcompleteでスモールベット・raiseCount=1', () => {
  const room = sm.ensureStudRoom('test-complete', {});
  room.currentMode = 'stud_s'; room.mode = 'stud_s';
  room.smallBet = 400; room.bigBet = 800; room.handCount = 0;
  room.players = [
    { id: 'p1', name: 'A', chips: 5000, sittingOut: false },
    { id: 'p2', name: 'B', chips: 5000, sittingOut: false },
    { id: 'p3', name: 'C', chips: 5000, sittingOut: false },
  ];
  sm.startStudHand(room, () => {}, { skipHandCountIncrement: true });

  // BI者の手番で buildStudGameState を見ると mustBringIn と選択肢額が出る
  const biIdx = room.bringInIndex;
  const biPlayer = room.players[biIdx];
  const state = sm.buildStudGameState(room, biPlayer.id);
  const self = state.find((s) => s.isSelf);
  assert.strictEqual(self.mustBringIn, true, 'BI者はmustBringIn');
  assert.strictEqual(self.bringInCost, room.bringInAmount, 'ブリングイン額が出る');
  assert.strictEqual(self.completeCost, room.smallBet, 'コンプリート額=smallBet');

  // complete を選択 → スモールベット全額、raiseCount=1
  const r = sm.studBetAction(room.id, biPlayer.id, 'complete', 0);
  assert.ok(r, 'complete成功');
  assert.strictEqual(room.players[biIdx].bet, room.smallBet, 'completeでsmallBet全額');
  assert.strictEqual(room.currentBet, room.smallBet, 'currentBet=smallBet');
  assert.strictEqual(room.raiseCount, 1, 'completeでraiseCount=1');
  sm.studRooms.delete('test-complete');
});

test('razz【選択制】: BI者は選択待ちで開始時はポストしない', () => {
  const room = sm.ensureStudRoom('test-razz-bringin', {});
  room.currentMode = 'razz'; room.mode = 'razz';
  room.smallBet = 400; room.bigBet = 800; room.handCount = 0;
  room.players = [
    { id: 'p1', name: 'A', chips: 5000, sittingOut: false },
    { id: 'p2', name: 'B', chips: 5000, sittingOut: false },
    { id: 'p3', name: 'C', chips: 5000, sittingOut: false },
  ];
  sm.startStudHand(room, () => {}, { skipHandCountIncrement: true });
  const biIdx = room.bringInIndex;
  assert.ok(biIdx >= 0, 'razzでもブリングイン者が決まる');
  assert.strictEqual(room.players[biIdx].bet, 0, 'razz: 開始時は未ポスト（選択制）');
  assert.strictEqual(room.players[biIdx].mustBringIn, true, 'razz: BI者は選択待ち');
  assert.strictEqual(room.actionIndex, biIdx, 'razz: BI者本人から開始');
  sm.studRooms.delete('test-razz-bringin');
});

console.log('\n=== ブリングイン判定: Razzのエース最低・stud_sのエース最高 ===');

test('Razz: 最高(最悪)カード保持者がBI。A♠はBIにならない', () => {
  // A♠(最良) / 6♣ / J♦ → J♦が最悪→BI
  const players = [
    { id: 'hoge', upCard: 'AS' },
    { id: 'carl', upCard: '6C' },
    { id: 'ray', upCard: 'JD' },
  ];
  assert.strictEqual(se.findBringIn(players, 'razz'), 'ray', 'Razzは最高札J♦がBI（A♠ではない）');
});

test('Razz: 全員同ランクはスート最高がBI', () => {
  const players = [
    { id: 'a', upCard: 'KS' },  // スペード最高
    { id: 'b', upCard: 'KC' },
  ];
  assert.strictEqual(se.findBringIn(players, 'razz'), 'a', 'K♠がBI');
});

test('stud_s: 最低カードがBI。A♠はハイ扱いでBIにならない', () => {
  const players = [
    { id: 'p1', upCard: 'AS' },  // Aはハイ→BIにならない
    { id: 'p2', upCard: '5C' },  // 5が最低→BI
    { id: 'p3', upCard: 'KD' },
  ];
  assert.strictEqual(se.findBringIn(players, 'stud_s'), 'p2', '5♣が最低でBI');
});

test('stud_s: 2♣が最弱でBI', () => {
  const players = [
    { id: 'x', upCard: '2C' },
    { id: 'y', upCard: '3D' },
    { id: 'z', upCard: '7S' },
  ];
  assert.strictEqual(se.findBringIn(players, 'stud_s'), 'x', '2♣が最弱でBI');
});

test('stud_s 単独勝者（保存則）', () => {
  const players = [
    { id: 'a', name: 'A', chips: 100, folded: false, sittingOut: false, totalContribution: 50, cards: ['AS', 'KS', 'QS', 'JS', 'TS', '9S', '8S'] },
    { id: 'b', name: 'B', chips: 100, folded: false, sittingOut: false, totalContribution: 50, cards: ['2C', '3D', '4H', '5S', '7C', '8D', '9H'] },
  ];
  const room = makeStudRoom('stud_s', players, 100);
  assertChipConservation(room, players, 'stud_s単独');
  assert.strictEqual(players[0].chips, 200, 'A がポット総取り');
});

test('サイドポット分割（保存則）', () => {
  // A=30拠出(オールイン), B=60, C=60 → pot=150
  const players = [
    { id: 'a', name: 'A', chips: 0, folded: false, sittingOut: false, totalContribution: 30, cards: ['AS', 'AH', 'AD', 'AC', 'KS', 'KH', 'QD'] }, // フォーカード
    { id: 'b', name: 'B', chips: 0, folded: false, sittingOut: false, totalContribution: 60, cards: ['2C', '3D', '4H', '5S', '6C', '8D', '9H'] },
    { id: 'c', name: 'C', chips: 0, folded: false, sittingOut: false, totalContribution: 60, cards: ['2S', '2H', '3C', '3S', '4D', '5C', '6H'] },
  ];
  const room = makeStudRoom('stud_s', players, 150);
  assertChipConservation(room, players, 'サイドポット');
  // A は contribution=30 までのメインポット(30×3=90)を獲得
  assert.strictEqual(players[0].chips, 90, 'A はメインポット90を獲得');
});

test('stud_e Hi/Lo スプリット（保存則）', () => {
  const players = [
    { id: 'a', name: 'A', chips: 0, folded: false, sittingOut: false, totalContribution: 50, cards: ['AS', 'AH', 'AD', 'KC', 'KS', 'QH', 'JD'] }, // フルハウス（ハイ）
    { id: 'b', name: 'B', chips: 0, folded: false, sittingOut: false, totalContribution: 50, cards: ['AC', '2D', '3H', '4S', '5C', '7D', '8H'] }, // A2345（最強ロー）
  ];
  const room = makeStudRoom('stud_e', players, 100);
  assertChipConservation(room, players, 'Hi/Loスプリット');
  assert.strictEqual(players[0].chips, 50, 'A がハイ半分');
  assert.strictEqual(players[1].chips, 50, 'B がロー半分');
});

test('3段階サイドポット: オールイン者+フォールド者混在（保存則）', () => {
  // A=20拠出(オールイン,勝ち最強), B=50拠出(オールイン), C=100拠出(コール), D=100拠出だがフォールド
  // pot = 20 + 50 + 100 + 100 = 270
  // メインポット(level20): 20×4=80 → A資格(最強)で総取り
  // level50: (50-20)×3(B,C,D拠出)=90 → A脱落(20まで), B資格(2番手)で獲得
  // level100: (100-50)×2(C,D)=100 → C資格(Dはフォールド)で獲得
  const players = [
    { id: 'a', name: 'A', chips: 0, folded: false, sittingOut: false, totalContribution: 20, cards: ['AS', 'AH', 'AD', 'AC', 'KS', 'KH', 'QD'] }, // フォーカードA(最強)
    { id: 'b', name: 'B', chips: 0, folded: false, sittingOut: false, totalContribution: 50, cards: ['KS', 'KH', 'KD', 'KC', 'QS', 'QH', 'JD'] }, // フォーカードK(2番手)
    { id: 'c', name: 'C', chips: 0, folded: false, sittingOut: false, totalContribution: 100, cards: ['2C', '3D', '4H', '5S', '7C', '8D', '9H'] }, // ノーペア(最弱)
    { id: 'd', name: 'D', chips: 0, folded: true,  sittingOut: false, totalContribution: 100, cards: ['2S', '2H', '3C', '3S', '4D', '5C', '6H'] }, // フォールド
  ];
  const room = makeStudRoom('stud_s', players, 270);
  assertChipConservation(room, players, '3段階サイドポット');
  // メインポット80(A) + level50ポット90(B) + level100ポット100(C)
  assert.strictEqual(players[0].chips, 80,  'A=メインポット80');
  assert.strictEqual(players[1].chips, 90,  'B=level50ポット90');
  assert.strictEqual(players[2].chips, 100, 'C=level100ポット100');
  assert.strictEqual(players[3].chips, 0,   'D=フォールドで0');
});

test('オールインフォールド: 部分拠出後にフォールドしたプレイヤーの拠出もポットに含まれる（保存則）', () => {
  // A=30拠出後フォールド, B=100, C=100 → pot=230
  // A の30はポットに残る。B vs C で全額争う。
  const players = [
    { id: 'a', name: 'A', chips: 0, folded: true,  sittingOut: false, totalContribution: 30,  cards: ['2S', '3H', '4D', '5C', '7S', '8H', '9D'] },
    { id: 'b', name: 'B', chips: 0, folded: false, sittingOut: false, totalContribution: 100, cards: ['AS', 'AH', 'AD', 'AC', 'KS', 'KH', 'QD'] }, // フォーカード(勝ち)
    { id: 'c', name: 'C', chips: 0, folded: false, sittingOut: false, totalContribution: 100, cards: ['2C', '2D', '3H', '3S', '4D', '5C', '6H'] },
  ];
  const room = makeStudRoom('stud_s', players, 230);
  assertChipConservation(room, players, 'オールインフォールド拠出');
  assert.strictEqual(players[1].chips, 230, 'B が全ポット230を獲得（Aの拠出含む）');
});

test('全員同額オールインでスプリット（保存則・端数処理）', () => {
  // 3人が33ずつ拠出 pot=99、stud_s で A と B が同点勝者
  const players = [
    { id: 'a', name: 'A', chips: 0, folded: false, sittingOut: false, totalContribution: 33, cards: ['AS', 'AH', 'KD', 'KC', 'QS', 'JH', '9D'] }, // 2ペアAK
    { id: 'b', name: 'B', chips: 0, folded: false, sittingOut: false, totalContribution: 33, cards: ['AD', 'AC', 'KS', 'KH', 'QD', 'JC', '9S'] }, // 2ペアAK(同点)
    { id: 'c', name: 'C', chips: 0, folded: false, sittingOut: false, totalContribution: 33, cards: ['2C', '3D', '4H', '5S', '7C', '8D', 'TH'] }, // ノーペア(負け)
  ];
  const room = makeStudRoom('stud_s', players, 99);
  assertChipConservation(room, players, '同額スプリット端数');
  // 99を2人で分割 → 49+50（端数1はdealerIndex起点で最初の勝者へ）
  const total = players[0].chips + players[1].chips;
  assert.strictEqual(total, 99, 'A+B で全ポット99');
  assert.strictEqual(players[2].chips, 0, 'C は0');
});

test('全員フォールドの異常系（contestants空）でクラッシュしない', () => {
  const players = [
    { id: 'a', name: 'A', chips: 50, folded: true, sittingOut: false, totalContribution: 50, cards: ['AS', 'KS', 'QS', 'JS', 'TS', '9S', '8S'] },
  ];
  const room = makeStudRoom('stud_s', players, 50);
  // contestants が空でも例外を投げず pot=0 にする想定
  assert.doesNotThrow(() => {
    sm._awardStudPots(room, players.filter((p) => !p.folded && !p.sittingOut));
  });
  assert.strictEqual(room.pot, 0, 'contestants空でも pot は 0 にリセット');
});

test('1人だけ残った場合は総取り', () => {
  const players = [
    { id: 'a', name: 'A', chips: 0, folded: false, sittingOut: false, totalContribution: 50, cards: ['AS', 'KS', 'QS', 'JS', 'TS', '9S', '8S'] },
    { id: 'b', name: 'B', chips: 0, folded: true, sittingOut: false, totalContribution: 50, cards: ['2C', '3D', '4H', '5S', '7C', '8D', '9H'] },
  ];
  const room = makeStudRoom('stud_s', players, 100);
  const before = players.reduce((s, p) => s + p.chips, 0) + room.pot;
  sm._awardStudPots(room, players.filter((p) => !p.folded && !p.sittingOut));
  const after = players.reduce((s, p) => s + p.chips, 0) + room.pot;
  assert.strictEqual(after, before, '保存則');
  assert.strictEqual(players[0].chips, 100, '残った1人が総取り');
});

// ==========================================================
// 【002/008 修正】モードローテーション: 人数非依存
// ==========================================================
console.log('\n=== モードローテーション: 人数変動でモードがズレない ===');
const gm = require('../server/poker/gameManager');

function makeMixRoom(mode, playerCount) {
  const room = gm.getOrCreateRoom(`test-mix-${mode}-${Date.now()}-${Math.random()}`, { mode });
  room.mode = mode;
  room.players = Array.from({ length: playerCount }, (_, i) => ({
    id: `p${i}`, name: `P${i}`, chips: 5000,
  }));
  return room;
}

test('beast+: 各モードが開始時人数分のハンド継続する', () => {
  const room = makeMixRoom('beast+', 3);
  const seq = ['badugi', 'stud_e', 'a5', 'stud_s', '27', 'razz'];
  // 3人なので各モード3ハンド。最初の3ハンドは badugi のはず
  for (let i = 0; i < 3; i++) {
    const mode = gm.advanceModeRotation(room);
    room._modeHandsDone = (room._modeHandsDone ?? 0) + 1;
    assert.strictEqual(mode, 'badugi', `hand${i} は badugi のはず (実際=${mode})`);
  }
  // 4ハンド目で stud_e へ
  const mode4 = gm.advanceModeRotation(room);
  room._modeHandsDone = (room._modeHandsDone ?? 0) + 1;
  assert.strictEqual(mode4, 'stud_e', `hand3 は stud_e のはず (実際=${mode4})`);
});

test('beast+: モード継続中に人数が変わってもモードがズレない', () => {
  const room = makeMixRoom('beast+', 6);
  // 6人 → badugi が6ハンド継続するはず
  const modes = [];
  for (let i = 0; i < 3; i++) {
    modes.push(gm.advanceModeRotation(room));
    room._modeHandsDone = (room._modeHandsDone ?? 0) + 1;
  }
  // 3ハンド消化後、人数が4人に減る（テーブルバランス）
  room.players = room.players.slice(0, 4);
  // 残り3ハンドも badugi のまま（開始時の6で固定されている）
  for (let i = 0; i < 3; i++) {
    modes.push(gm.advanceModeRotation(room));
    room._modeHandsDone = (room._modeHandsDone ?? 0) + 1;
  }
  assert.ok(modes.every((m) => m === 'badugi'), `全6ハンドbadugiのはず (実際=${modes.join(',')})`);
  // 7ハンド目で stud_e へ（新人数4で再固定）
  const mode7 = gm.advanceModeRotation(room);
  room._modeHandsDone = (room._modeHandsDone ?? 0) + 1;
  assert.strictEqual(mode7, 'stud_e', `7ハンド目は stud_e のはず (実際=${mode7})`);
});

test('peekNextMode と advanceModeRotation の結果が一致する', () => {
  const room = makeMixRoom('beast+', 4);
  for (let i = 0; i < 30; i++) {
    const peeked = gm.peekNextMode(room);
    const actual = gm.advanceModeRotation(room);
    room._modeHandsDone = (room._modeHandsDone ?? 0) + 1;
    assert.strictEqual(peeked, actual, `hand${i}: peek=${peeked} actual=${actual} 不一致`);
  }
});

test('stud_mix: スタッド3種が正しくローテーションする', () => {
  const room = makeMixRoom('stud_mix', 2);
  const got = [];
  // 2人 → 各モード2ハンド。S,S,E,E,Razz,Razz
  for (let i = 0; i < 6; i++) {
    got.push(gm.advanceModeRotation(room));
    room._modeHandsDone = (room._modeHandsDone ?? 0) + 1;
  }
  assert.deepStrictEqual(got, ['stud_s', 'stud_s', 'stud_e', 'stud_e', 'razz', 'razz'],
    `stud_mix ローテーション不正 (実際=${got.join(',')})`);
});

test('Razz: A♠保持者は単独では絶対にBIにならない（002回帰）', () => {
  // Razz で A♠ は最良カード。他に高いカードがあれば BI にならない。
  const bi = se.findBringIn([
    { id: 'HOGE', upCard: 'AS' },
    { id: 'Ray',  upCard: 'JD' },
    { id: 'Carl', upCard: '6C' },
  ], 'razz');
  assert.strictEqual(bi, 'Ray', `Razz: J保持者がBIのはず (実際=${bi})`);
  assert.notStrictEqual(bi, 'HOGE', 'A♠保持者がBIになってはいけない');
});


console.log(`テスト結果: ${passed} passed, ${failed} failed`);
console.log(`========================================`);

if (failed > 0) {
  console.log('\n失敗したテスト:');
  failures.forEach(({ name, err }) => {
    console.log(`  ❌ ${name}: ${err.message}`);
  });
  process.exit(1);
} else {
  console.log('✅ 全テスト合格');
  process.exit(0);
}
