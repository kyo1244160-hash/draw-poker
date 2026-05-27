/**
 * lib/modeLabels.ts — ゲームモード表示ラベルの一元管理
 *
 * 散在していた MODE_LABEL マップを集約。新モード追加時はここを更新するだけで
 * すべてのUI（PokerTable, TournamentTable, Room, MyPageModal, tournament[id]）に
 * 反映される。
 */

/** モード識別子（DB の tournaments.mode と一致） */
export type ModeKey = '27' | 'badugi' | 'mix' | 'a5' | '27sd' | 'mix3';

/** フル表記（テーブル上部・ルール説明・モード別成績用） */
export const MODE_LABEL_FULL: Record<string, string> = {
  '27':     '2-7 Triple Draw',
  badugi:   'Badugi',
  mix:      'Mix (2-7↔Badugi)',
  a5:       'A-5 Triple Draw',
  '27sd':   '2-7 Single Draw',
  mix3:     'Mix-3',
};

/** 短縮表記（トーナメントカードのバッジ用） */
export const MODE_LABEL_SHORT: Record<string, string> = {
  '27':     '2-7',
  badugi:   'Badugi',
  mix:      'MIX',
  a5:       'A-5',
  '27sd':   '27SD',
  mix3:     'MIX-3',
};

/** バッジ等の表示色 */
export const MODE_COLOR: Record<string, string> = {
  '27':     '#88bbee',
  badugi:   '#cc9966',
  mix:      '#aa88dd',
  a5:       '#88dd88',
  '27sd':   '#dd88aa',
  mix3:     '#aa88dd',
};

export const MODE_BG: Record<string, string> = {
  '27':     'rgba(68,136,204,0.2)',
  badugi:   'rgba(204,119,68,0.2)',
  mix:      'rgba(170,136,221,0.2)',
  a5:       'rgba(100,200,100,0.2)',
  '27sd':   'rgba(200,100,150,0.2)',
  mix3:     'rgba(170,136,221,0.2)',
};

export const MODE_BORDER: Record<string, string> = {
  '27':     'rgba(68,136,204,0.4)',
  badugi:   'rgba(204,119,68,0.4)',
  mix:      'rgba(170,136,221,0.4)',
  a5:       'rgba(100,200,100,0.4)',
  '27sd':   'rgba(200,100,150,0.4)',
  mix3:     'rgba(170,136,221,0.4)',
};

export const MODE_LEFT_BORDER: Record<string, string> = {
  '27':     '#4488cc',
  badugi:   '#cc7744',
  mix:      '#aa88dd',
  a5:       '#66cc88',
  '27sd':   '#cc6688',
  mix3:     '#aa88dd',
};

/** ヘルパー関数 */
export const modeLabelFull  = (m: string): string => MODE_LABEL_FULL[m]  ?? m;
export const modeLabelShort = (m: string): string => MODE_LABEL_SHORT[m] ?? m;
export const modeColor      = (m: string): string => MODE_COLOR[m]       ?? '#88bbee';
export const modeBg         = (m: string): string => MODE_BG[m]          ?? 'rgba(68,136,204,0.2)';
export const modeBorder     = (m: string): string => MODE_BORDER[m]      ?? 'rgba(68,136,204,0.4)';
export const modeLeftBorder = (m: string): string => MODE_LEFT_BORDER[m] ?? '#4488cc';
