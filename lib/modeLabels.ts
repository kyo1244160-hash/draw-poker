/**
 * lib/modeLabels.ts — ゲームモード表示ラベルの一元管理
 *
 * 散在していた MODE_LABEL マップを集約。新モード追加時はここを更新するだけで
 * すべてのUI（PokerTable, TournamentTable, Room, MyPageModal, tournament[id]）に
 * 反映される。
 */

/** モード識別子（DB の tournaments.mode と一致） */
export type ModeKey =
  | '27' | 'badugi' | 'mix' | 'a5' | '27sd' | 'mix3'
  | 'beast+' | 'horse' | 'stud_mix' | 'stud_s' | 'stud_e' | 'razz'
  | 'fl_holdem' | 'fl_omaha8';

/** フル表記（テーブル上部・ルール説明・モード別成績用） */
export const MODE_LABEL_FULL: Record<string, string> = {
  '27':       '2-7 Triple Draw',
  badugi:     'Badugi',
  mix:        'Mix (2-7↔Badugi)',
  a5:         'A-5 Triple Draw',
  '27sd':     '2-7 Single Draw',
  mix3:       'Mix-3',
  'beast+':   'BEAST+',
  horse:      'HORSE',
  fl_holdem:  "Fixed Limit Hold'em",
  fl_omaha8:  'Omaha Hi-Lo',
  stud_mix:   'Stud Mix (S/E/Razz)',
  stud_s:     '7 Card Stud',
  stud_e:     'Stud Hi/Lo',
  razz:       'Razz',
};

/** 短縮表記（トーナメントカードのバッジ用） */
export const MODE_LABEL_SHORT: Record<string, string> = {
  '27':       '2-7',
  badugi:     'Badugi',
  mix:        'MIX',
  a5:         'A-5',
  '27sd':     '27SD',
  mix3:       'MIX-3',
  'beast+':   'BEAST+',
  horse:      'HORSE',
  fl_holdem:  "FLHE",
  fl_omaha8:  'O8',
  stud_mix:   'STUD-MIX',
  stud_s:     'STUD',
  stud_e:     'STUD8',
  razz:       'RAZZ',
};

/** バッジ等の表示色 */
export const MODE_COLOR: Record<string, string> = {
  '27':       '#88bbee',
  badugi:     '#cc9966',
  mix:        '#aa88dd',
  a5:         '#88dd88',
  '27sd':     '#dd88aa',
  mix3:       '#aa88dd',
  'beast+':   '#e0b050',
  horse:      '#d0b85a',
  fl_holdem:  '#5fb8c8',
  fl_omaha8:  '#70b080',
  stud_mix:   '#50c0d0',
  stud_s:     '#50c0d0',
  stud_e:     '#50a0d0',
  razz:       '#70b080',
};

export const MODE_BG: Record<string, string> = {
  '27':       'rgba(68,136,204,0.2)',
  badugi:     'rgba(204,119,68,0.2)',
  mix:        'rgba(170,136,221,0.2)',
  a5:         'rgba(100,200,100,0.2)',
  '27sd':     'rgba(200,100,150,0.2)',
  mix3:       'rgba(170,136,221,0.2)',
  'beast+':   'rgba(224,176,80,0.2)',
  horse:      'rgba(208,184,90,0.2)',
  fl_holdem:  'rgba(95,184,200,0.2)',
  fl_omaha8:  'rgba(112,176,128,0.2)',
  stud_mix:   'rgba(80,192,208,0.2)',
  stud_s:     'rgba(80,192,208,0.2)',
  stud_e:     'rgba(80,160,208,0.2)',
  razz:       'rgba(112,176,128,0.2)',
};

export const MODE_BORDER: Record<string, string> = {
  '27':       'rgba(68,136,204,0.4)',
  badugi:     'rgba(204,119,68,0.4)',
  mix:        'rgba(170,136,221,0.4)',
  a5:         'rgba(100,200,100,0.4)',
  '27sd':     'rgba(200,100,150,0.4)',
  mix3:       'rgba(170,136,221,0.4)',
  'beast+':   'rgba(224,176,80,0.4)',
  horse:      'rgba(208,184,90,0.4)',
  fl_holdem:  'rgba(95,184,200,0.4)',
  fl_omaha8:  'rgba(112,176,128,0.4)',
  stud_mix:   'rgba(80,192,208,0.4)',
  stud_s:     'rgba(80,192,208,0.4)',
  stud_e:     'rgba(80,160,208,0.4)',
  razz:       'rgba(112,176,128,0.4)',
};

export const MODE_LEFT_BORDER: Record<string, string> = {
  '27':       '#4488cc',
  badugi:     '#cc7744',
  mix:        '#aa88dd',
  a5:         '#66cc88',
  '27sd':     '#cc6688',
  mix3:       '#aa88dd',
  'beast+':   '#e0b050',
  horse:      '#d0b85a',
  fl_holdem:  '#5fb8c8',
  fl_omaha8:  '#70b080',
  stud_mix:   '#50c0d0',
  stud_s:     '#50c0d0',
  stud_e:     '#50a0d0',
  razz:       '#70b080',
};

/** ヘルパー関数 */
export const modeLabelFull  = (m: string): string => MODE_LABEL_FULL[m]  ?? m;
export const modeLabelShort = (m: string): string => MODE_LABEL_SHORT[m] ?? m;
export const modeColor      = (m: string): string => MODE_COLOR[m]       ?? '#88bbee';
export const modeBg         = (m: string): string => MODE_BG[m]          ?? 'rgba(68,136,204,0.2)';
export const modeBorder     = (m: string): string => MODE_BORDER[m]      ?? 'rgba(68,136,204,0.4)';
export const modeLeftBorder = (m: string): string => MODE_LEFT_BORDER[m] ?? '#4488cc';
