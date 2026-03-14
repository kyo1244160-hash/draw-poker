'use strict';

/**
 * ブラインドスケジュール定義
 * levels フィールド: [{ level, sb, bb, smallBet, bigBet, durationMinutes }]
 *   durationMinutes: 0 = 最終レベル（タイマーなし・永続）
 *   smallBet = フィックスドリミットのSMALL_BET（通常 = bb）
 *   bigBet   = フィックスドリミットのBIG_BET（通常 = bb × 2）
 */

const SCHEDULES = {
  standard: {
    id: 'standard',
    name: 'スタンダード',
    description: '20分ごとにレベルアップ（全7レベル）',
    levels: [
      { level: 1, sb:   5, bb:  10, smallBet:  10, bigBet:  20, durationMinutes: 20 },
      { level: 2, sb:  10, bb:  20, smallBet:  20, bigBet:  40, durationMinutes: 20 },
      { level: 3, sb:  25, bb:  50, smallBet:  50, bigBet: 100, durationMinutes: 20 },
      { level: 4, sb:  50, bb: 100, smallBet: 100, bigBet: 200, durationMinutes: 20 },
      { level: 5, sb: 100, bb: 200, smallBet: 200, bigBet: 400, durationMinutes: 20 },
      { level: 6, sb: 200, bb: 400, smallBet: 400, bigBet: 800, durationMinutes: 20 },
      { level: 7, sb: 400, bb: 800, smallBet: 800, bigBet: 1600, durationMinutes: 0 },
    ],
  },
  turbo: {
    id: 'turbo',
    name: 'ターボ',
    description: '10分ごとにレベルアップ（全7レベル）',
    levels: [
      { level: 1, sb:   5, bb:  10, smallBet:  10, bigBet:  20, durationMinutes: 10 },
      { level: 2, sb:  10, bb:  20, smallBet:  20, bigBet:  40, durationMinutes: 10 },
      { level: 3, sb:  25, bb:  50, smallBet:  50, bigBet: 100, durationMinutes: 10 },
      { level: 4, sb:  50, bb: 100, smallBet: 100, bigBet: 200, durationMinutes: 10 },
      { level: 5, sb: 100, bb: 200, smallBet: 200, bigBet: 400, durationMinutes: 10 },
      { level: 6, sb: 200, bb: 400, smallBet: 400, bigBet: 800, durationMinutes: 10 },
      { level: 7, sb: 400, bb: 800, smallBet: 800, bigBet: 1600, durationMinutes: 0 },
    ],
  },
  test: {
    id: 'test',
    name: 'テスト用',
    description: 'ハンドごとにレベルアップ（開発・テスト専用）',
    levels: [
      { level: 1, sb:   5, bb:  10, smallBet:  10, bigBet:  20, durationMinutes: 0 },
    ],
  },
};

/**
 * スケジュール ID からレベル配列を取得
 * DB に保存されているスケジュールを優先し、
 * フォールバックとしてここのデフォルト値を使う
 */
function getSchedule(scheduleId) {
  return SCHEDULES[scheduleId] ?? SCHEDULES.standard;
}

function getDefaultScheduleIds() {
  return Object.keys(SCHEDULES);
}

module.exports = { SCHEDULES, getSchedule, getDefaultScheduleIds };
