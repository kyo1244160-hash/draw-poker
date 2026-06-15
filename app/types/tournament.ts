// app/types/tournament.ts — トーナメント関連の共有型定義

export interface BlindUpdate {
  level: number | null;          // nullの場合はブレイク
  sb: number;
  bb: number;
  bbAnte?: number;
  smallBet: number;
  bigBet: number;
  secondsToNextLevel: number;
  nextSb: number | null;         // 次レベルのSB
  nextBb: number | null;         // 次レベルのBB
  nextBbAnte?: number | null;    // 次レベルのBBアンティ
  isLastLevel: boolean;
  isBreak: boolean;              // 休憩中かどうか
  breakLabel: string | null;     // 休憩ラベル（"Break 1"等）
  lateRegOpen: boolean;          // レイトレジスト受付中かどうか
  lateRegLevelCutoff: number;    // レイトレジスト終了レベル
  lateRegSecondsRemaining?: number | null;  // 時間ベースの残り秒数（nullならレベルベース）
  notify?: 'blindUp' | 'break' | null;  // ブラインドアップ/ブレイク突入通知
  pendingLevelUp?: boolean;              // 次のハンドでブラインドアップ予定
}

export interface TournamentStatus {
  tournamentId: string;
  totalPlayers: number;
  remainingPlayers: number;
  averageStack: number;
  isFinalTable: boolean;         // ファイナルテーブル突入フラグ
}

export interface TournamentRankEntry {
  accountId: string;
  nickname?: string;
  rank: number;
  chips?: number;
}

export interface PlayerState {
  id: string;
  name: string;
  chips: number;
  bet: number;
  folded: boolean;
  sittingOut: boolean;
  disconnected: boolean;
  isAway?: boolean;
  hand: string[];       // '??' if hidden
  isSelf: boolean;
  isMyTurn: boolean;
  isDealer: boolean;
  isSB: boolean;
  isBB: boolean;
  isWinner?: boolean;
  drewThisRound?: boolean;
  drawCount?: number | null;
  result?: string;
  toCall?: number;
  canCheck?: boolean;
  canRaise?: boolean;
  isAllIn?: boolean;
  isPendingPlayer?: boolean;  // pendingPlayers待機中（次のハンドから参加）
  betSize?: number;
  betSizeOptions?: number[];
  isFourthStreetPair?: boolean;
  // スタッド系（BEAST+ / stud_mix）対応
  studCards?: { code: string; up: boolean; folded?: boolean }[]; // カードごとの表裏情報
  isBringIn?: boolean;        // 3rd street のブリングイン強制者
  // スタッド系のコンプリート/レイズ表示用
  isComplete?: boolean;       // bet/raiseアクションがコンプリート(3rd street)かどうか
  raiseToTotal?: number;      // コンプリート/レイズ後の合計ベット額
  raiseCost?: number;         // 実際に投じるチップ額（raiseToTotal - 現在のbet）
  mustBringIn?: boolean;      // 【ブリングイン選択制】ブリングイン義務者の手番（bringIn/complete選択待ち）
  bringInCost?: number;       // ブリングイン額（最小）
  completeCost?: number;      // コンプリート額（スモールベット）
  // NL（27sd）対応: クライアントUI構築用情報。
  // isNL=true のときのみ minBet/minRaiseTotal/maxBetTotal が利用可能
  isNL?: boolean;
  minBet?: number;          // bet時の下限
  minRaiseTotal?: number;   // raise時の下限（totalBet基準）
  maxBetTotal?: number;     // 上限（player.bet + player.chips）
  timerRemaining?: number;
}

export interface PotEntry {
  amount: number;
  label: string;  // 'メインポット' | 'サイドポット1' | ...
}

export interface GameMeta {
  _meta: true;
  phase: string;
  pot: number;
  pots?: PotEntry[];   // メイン/サイドポット内訳（オールイン時）
  currentBet?: number;
  betSize?: number;
  betSizeOptions?: number[];
  isFourthStreetPair?: boolean;
  raiseCount?: number;
  maxRaises?: number;
  currentMode: string;
  handCount: number;
  dealerIndex?: number;
  timerRemaining?: number;
  timerLimit?: number;
  pendingPlayers?: string[];
  isTournament?: boolean;
  tournamentId?: string;
  roomId?: string;     // Vol.11追加: PokerTable の roomId フィルタに使用
  // スタッド系（BEAST+ / stud_mix）対応
  isStud?: boolean;
  isBoard?: boolean;
  board?: string[];
  street?: string | null;       // '3rd'|'4th'|'5th'|'6th'|'7th'|'showdown'
  bringInIndex?: number;
  ante?: number;
  bringInAmount?: number;
  // NL（27sd）対応
  isNL?: boolean;
  bigBlind?: number;
  smallBlind?: number;
  bbAnte?: number;
  lastRaiseSize?: number;
}

export interface GameState {
  players: PlayerState[];
  meta: GameMeta | null;
  isSpectator?: boolean;
}

export interface TournamentInfo {
  id: string;
  name: string;
  mode: string;
  status: 'registering' | 'running' | 'finished' | 'cancelled';
  scheduled_start_at: string;
  starting_chips: number;
  max_players: number | null;
  entry_count: number;
  is_sit_and_go?: boolean;
  min_players?: number;
}
