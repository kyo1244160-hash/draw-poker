'use strict';

/**
 * ブラインドスケジュール定義
 * levels フィールド: [{ level, sb, bb, smallBet, bigBet, durationMinutes, isBreak? }]
 *   durationMinutes: 0 = 最終レベル（タイマーなし・永続）
 *   isBreak: true = 休憩レベル（ゲームを一時停止、ブラインド変化なし）
 *   lateLevelCutoff: レイトレジスト受付終了レベル（省略時=1 = 1レベル目終了まで）
 */

const SCHEDULES = {
  standard: {
    id: 'standard',
    name: 'スタンダード',
    description: '20分ごとにレベルアップ（全7レベル・Lv3後休憩）',
    lateLevelCutoff: 2,
    levels: [
      { level: 1, sb:   5, bb:  10, smallBet:  10, bigBet:  20, durationMinutes: 20 },
      { level: 2, sb:  10, bb:  20, smallBet:  20, bigBet:  40, durationMinutes: 20 },
      { level: 3, sb:  25, bb:  50, smallBet:  50, bigBet: 100, durationMinutes: 20 },
      { level: null, sb: 0, bb: 0, smallBet: 0, bigBet: 0, durationMinutes: 15, isBreak: true, breakLabel: 'Break 1' },
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
    lateLevelCutoff: 2,
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
    lateLevelCutoff: 0,
    levels: [
      { level: 1, sb:   5, bb:  10, smallBet:  10, bigBet:  20, durationMinutes: 0 },
    ],
  },
  test1min: {
    id: 'test1min',
    name: 'テスト用(1分)',
    description: '1分ごとにレベルアップ・Lv2後30秒休憩',
    lateLevelCutoff: 1,
    levels: [
      { level: 1, sb:   5, bb:  10, smallBet:  10, bigBet:  20, durationMinutes: 1 },
      { level: 2, sb:  10, bb:  20, smallBet:  20, bigBet:  40, durationMinutes: 1 },
      { level: null, sb: 0, bb: 0, smallBet: 0, bigBet: 0, durationMinutes: 0.5, isBreak: true, breakLabel: 'Break' },
      { level: 3, sb:  25, bb:  50, smallBet:  50, bigBet: 100, durationMinutes: 1 },
      { level: 4, sb:  50, bb: 100, smallBet: 100, bigBet: 200, durationMinutes: 1 },
      { level: 5, sb: 100, bb: 200, smallBet: 200, bigBet: 400, durationMinutes: 1 },
      { level: 6, sb: 200, bb: 400, smallBet: 400, bigBet: 800, durationMinutes: 0 },
    ],
  },
  test2min: {
    id: 'test2min',
    name: 'テスト用(2分)',
    description: '2分ごとにレベルアップ（テスト専用）',
    lateLevelCutoff: 1,
    levels: [
      { level: 1, sb:   5, bb:  10, smallBet:  10, bigBet:  20, durationMinutes: 2 },
      { level: 2, sb:  10, bb:  20, smallBet:  20, bigBet:  40, durationMinutes: 2 },
      { level: 3, sb:  25, bb:  50, smallBet:  50, bigBet: 100, durationMinutes: 2 },
      { level: 4, sb:  50, bb: 100, smallBet: 100, bigBet: 200, durationMinutes: 2 },
      { level: 5, sb: 100, bb: 200, smallBet: 200, bigBet: 400, durationMinutes: 2 },
      { level: 6, sb: 200, bb: 400, smallBet: 400, bigBet: 800, durationMinutes: 0 },
    ],
  },
};

function getSchedule(scheduleId) {
  return SCHEDULES[scheduleId] ?? SCHEDULES.standard;
}

function getDefaultScheduleIds() {
  return Object.keys(SCHEDULES);
}

module.exports = { SCHEDULES, getSchedule, getDefaultScheduleIds };
