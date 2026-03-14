// app/types/tournament.ts — トーナメント関連の共有型定義

export interface BlindUpdate {
  level: number;
  sb: number;
  bb: number;
  smallBet: number;
  bigBet: number;
  secondsToNextLevel: number;
  nextSb: number | null;
  nextBb: number | null;
  isLastLevel: boolean;
}

export interface TournamentStatus {
  tournamentId: string;
  totalPlayers: number;
  remainingPlayers: number;
  averageStack: number;
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
  betSize?: number;
  timerRemaining?: number;
}

export interface GameMeta {
  _meta: true;
  phase: string;
  pot: number;
  currentBet?: number;
  raiseCount?: number;
  currentMode: string;
  handCount: number;
  dealerIndex?: number;
  timerLimit?: number;
  pendingPlayers?: string[];
  isTournament?: boolean;
  tournamentId?: string;
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
}
