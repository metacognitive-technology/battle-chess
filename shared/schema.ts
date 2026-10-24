import { sql } from "drizzle-orm";
import { pgTable, text, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Game Types
export type PieceType = 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn';
export type PlayerColor = 'white' | 'black';

export interface Piece {
  type: PieceType;
  color: PlayerColor;
  hasMoved?: boolean;
  id?: string;
}

export interface Square {
  row: number;
  col: number;
  piece: Piece | null;
  isWall: boolean;
}

export type Board = Square[][];

export interface Position {
  row: number;
  col: number;
}

export interface Move {
  from: Position;
  to: Position;
  piece: Piece;
  captured?: Piece;
  isArrowAttack?: boolean;
  isAxeAttack?: boolean;
  isBombAttack?: boolean;
  isWallBuild?: boolean;
  diceRoll?: number;
  diceRequired?: number;
  success?: boolean;
  notation: string;
  promotionPiece?: PieceType;
}

export type PromotionPieceType = 'queen' | 'rook' | 'bishop' | 'knight';

export type GamePhase = 'waiting' | 'budget_setup' | 'setup' | 'playing' | 'finished';
export type GameMode = 'pvp' | 'pvc' | 'cvc';
export type BudgetMode = 'shared' | 'individual';
/** cand-r32 is the FILTER champion. legacy is the previous heuristic computer. */
export type ComputerPolicyId = 'cand-r32' | 'legacy';

export interface AttackSettings {
  pawnSuccessRoll: number;
  bishopMinRoll: number;
  knightMinRoll: number;
  bombSuccessRoll: number;
  wallBuildRoll: number;
  totalAttackBudget?: number;
  pawnAttackPercent?: number;
  bishopAttackPercent?: number;
  knightAttackPercent?: number;
  bombAttackPercent?: number;
  wallBuildPercent?: number;
  maxBishopAttacks?: number;
  maxRookAttacks?: number;
}

export interface GameState {
  id: string;
  board: Board;
  currentTurn: PlayerColor;
  phase: GamePhase;
  gameMode: GameMode;
  aiColor?: PlayerColor;
  aiControlled?: { white: boolean; black: boolean };
  aiDepth?: number;
  /** Computer-player policy. Omitted games use cand-r32. */
  computerPolicy?: ComputerPolicyId;
  setupWallsRemaining: { white: number; black: number };
  maxWallsPerPlayer: number;
  moveHistory: Move[];
  capturedPieces: { white: Piece[]; black: Piece[] };
  players: { white: string | null; black: string | null };
  winner: PlayerColor | 'draw' | null;
  lastDiceRoll?: { value: number; type: 'd4' | 'd6' | '2d6' | 'd10'; success: boolean };
  aiThinkingPly?: number;
  aiThinkingMaxPly?: number;
  pendingArrowTarget?: Position;
  selectedPiece?: Position;
  attackSettings: AttackSettings;
  budgetMode?: BudgetMode;
  whiteAttackSettings?: AttackSettings;
  blackAttackSettings?: AttackSettings;
  budgetReadyPlayers?: string[];
  maxBishopAttacks?: number;
  maxRookAttacks?: number;
  specialAttackCounts?: {
    [pieceId: string]: number;
  };
}

export interface GameMessage {
  type: 'join' | 'setup_wall' | 'setup_random_walls' | 'setup_maze_walls' | 'setup_load_layout' | 'ready' | 'move' | 'arrow_attack' | 'axe_attack' | 'bomb_attack' | 'wall_attack' | 'state' | 'error' | 'player_joined' | 'player_left' | 'reconnect' | 'needsPromotion' | 'takeover' | 'games_updated' | 'watch_cvc' | 'stop_cvc' | 'pause_cvc' | 'offer_draw' | 'respond_draw' | 'draw_offered' | 'draw_response' | 'handoff' | 'take_control' | 'budget_submit';
  payload: any;
  playerId?: string;
}

export const gameConfigSchema = z.object({
  maxWallsPerPlayer: z.number().min(0).max(32).default(8),
  attackSettings: z.object({
    pawnSuccessRoll: z.number().min(0).max(6).default(6),
    bishopMinRoll: z.number().min(0).max(12).default(0),
    knightMinRoll: z.number().min(1).max(7).default(4),
    bombSuccessRoll: z.number().min(0).max(10).default(1),
    wallBuildRoll: z.number().min(0).max(10).default(5),
    totalAttackBudget: z.number().min(0).max(500).default(250).optional(),
    pawnAttackPercent: z.number().min(0).max(100).default(100).optional(),
    bishopAttackPercent: z.number().min(0).max(100).default(50).optional(),
    knightAttackPercent: z.number().min(0).max(100).default(50).optional(),
    bombAttackPercent: z.number().min(0).max(100).default(10).optional(),
    wallBuildPercent: z.number().min(0).max(100).default(50).optional(),
  }).optional(),
});

export type GameConfig = z.infer<typeof gameConfigSchema>;

export interface SavedGameInfo {
  id: string;
  phase: GamePhase;
  currentTurn: PlayerColor;
  moveCount: number;
  whitePlayer: string | null;
  blackPlayer: string | null;
  winner: PlayerColor | 'draw' | null;
  updatedAt: string;
  gameMode?: GameMode;
}
