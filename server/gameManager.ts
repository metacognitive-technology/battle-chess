import { randomUUID, randomBytes } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { GameState, Board, Square, Piece, Position, PlayerColor, Move, PieceType, GameMessage, GameMode, AttackSettings, ComputerPolicyId } from "@shared/schema";
import type { WebSocket } from "ws";
import { actionIsLegal, chooseComputerAction } from "./policy/choose.ts";
import { parseSquare } from "./policy/notation.ts";

const BOARD_SIZE = 12;
const MAX_MOVE_DISTANCE = 8;
const AI_PLAYER_ID = 'ai-player';

function withCertainPawnAttacks<T extends AttackSettings>(settings: T): T {
  return { ...settings, pawnAttackPercent: 100, pawnSuccessRoll: 6 };
}

function normalizePawnSettings(state: GameState): void {
  state.attackSettings = withCertainPawnAttacks(state.attackSettings);
  if (state.whiteAttackSettings) state.whiteAttackSettings = withCertainPawnAttacks(state.whiteAttackSettings);
  if (state.blackAttackSettings) state.blackAttackSettings = withCertainPawnAttacks(state.blackAttackSettings);
}

function policyIdOf(state: GameState): ComputerPolicyId {
  return state.computerPolicy === 'legacy' ? 'legacy' : 'cand-r32';
}

function generateShortId(length = 9): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

// A* pathfinding for AI to navigate around walls
// Uses Chebyshev distance (8-directional with uniform cost)
interface AStarNode {
  row: number;
  col: number;
  g: number; // Cost from start
  h: number; // Heuristic (Chebyshev distance to goal)
  f: number; // Total cost (g + h)
}

// Cache for A* path distances to reduce redundant calculations per AI turn
let aStarCache: Map<string, number> = new Map();
let aStarCacheBoard: string = '';

function clearAStarCache(): void {
  aStarCache.clear();
  aStarCacheBoard = '';
}

function getBoardHash(board: Board): string {
  // Simple hash based on wall positions (pieces move, so we only cache per wall config)
  let hash = '';
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c].isWall) hash += `${r},${c};`;
    }
  }
  return hash;
}

function aStarPathfind(board: Board, start: Position, goal: Position): number {
  // Returns the path length or Infinity if no path exists
  // Uses Chebyshev distance heuristic for 8-directional movement
  
  const cacheKey = `${start.row},${start.col}-${goal.row},${goal.col}`;
  const boardHash = getBoardHash(board);
  
  // Clear cache if board walls have changed
  if (boardHash !== aStarCacheBoard) {
    aStarCache.clear();
    aStarCacheBoard = boardHash;
  }
  
  // Check cache first
  if (aStarCache.has(cacheKey)) {
    return aStarCache.get(cacheKey)!;
  }
  
  const openSet: AStarNode[] = [];
  const closedSet = new Set<string>();
  const gScores = new Map<string, number>();
  
  // Chebyshev distance (max of absolute differences) - admissible for 8-direction
  const heuristic = (pos: Position): number => {
    return Math.max(Math.abs(pos.row - goal.row), Math.abs(pos.col - goal.col));
  };
  
  const posKey = (row: number, col: number): string => `${row},${col}`;
  
  const startNode: AStarNode = {
    row: start.row,
    col: start.col,
    g: 0,
    h: heuristic(start),
    f: heuristic(start),
  };
  
  openSet.push(startNode);
  gScores.set(posKey(start.row, start.col), 0);
  
  // 8-directional movement (king-like for general pathfinding)
  const directions = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],          [0, 1],
    [1, -1], [1, 0], [1, 1],
  ];
  
  let iterations = 0;
  const maxIterations = BOARD_SIZE * BOARD_SIZE * 2;
  
  while (openSet.length > 0 && iterations < maxIterations) {
    iterations++;
    
    // Find node with lowest f score (use priority extraction)
    let lowestIdx = 0;
    for (let i = 1; i < openSet.length; i++) {
      if (openSet[i].f < openSet[lowestIdx].f) {
        lowestIdx = i;
      }
    }
    const current = openSet.splice(lowestIdx, 1)[0];
    
    // Reached goal
    if (current.row === goal.row && current.col === goal.col) {
      aStarCache.set(cacheKey, current.g);
      return current.g;
    }
    
    const currentKey = posKey(current.row, current.col);
    closedSet.add(currentKey);
    
    // Explore neighbors
    for (const [dr, dc] of directions) {
      const newRow = current.row + dr;
      const newCol = current.col + dc;
      
      // Check bounds
      if (newRow < 0 || newRow >= BOARD_SIZE || newCol < 0 || newCol >= BOARD_SIZE) {
        continue;
      }
      
      const neighborKey = posKey(newRow, newCol);
      
      // Skip if already in closed set
      if (closedSet.has(neighborKey)) {
        continue;
      }
      
      // Skip walls
      const square = board[newRow][newCol];
      if (square.isWall) {
        continue;
      }
      
      // Allow goal position even if occupied (for approaching enemy)
      const isGoal = newRow === goal.row && newCol === goal.col;
      if (square.piece && !isGoal) {
        continue;
      }
      
      const tentativeG = current.g + 1;
      const existingG = gScores.get(neighborKey);
      
      if (existingG !== undefined && tentativeG >= existingG) {
        continue;
      }
      
      gScores.set(neighborKey, tentativeG);
      
      const h = heuristic({ row: newRow, col: newCol });
      const newNode: AStarNode = {
        row: newRow,
        col: newCol,
        g: tentativeG,
        h,
        f: tentativeG + h,
      };
      
      // Remove if already in open set with worse score
      const existingIdx = openSet.findIndex(n => n.row === newRow && n.col === newCol);
      if (existingIdx !== -1) {
        openSet.splice(existingIdx, 1);
      }
      
      openSet.push(newNode);
    }
  }
  
  // No path found
  aStarCache.set(cacheKey, Infinity);
  return Infinity;
}

// Find the enemy king position
function findKingPosition(board: Board, color: PlayerColor): Position | null {
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const piece = board[row][col].piece;
      if (piece && piece.type === 'king' && piece.color === color) {
        return { row, col };
      }
    }
  }
  return null;
}

// Get the directory for saving game files - handle both ESM and CJS
// Use a function to safely get __dirname in both environments
function getCurrentDir(): string {
  try {
    // In CJS environment (production bundle), __dirname is available
    if (typeof __dirname !== 'undefined') {
      return __dirname;
    }
  } catch {
    // __dirname not defined in ESM
  }
  
  // ESM environment - compute from import.meta.url
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    // Fallback to process.cwd() if all else fails
    return process.cwd();
  }
}

const GAMES_DIR = join(getCurrentDir(), 'data', 'games');
const STATS_FILE = join(getCurrentDir(), 'data', 'attack_stats.json');

// Ensure games directory exists
if (!existsSync(GAMES_DIR)) {
  mkdirSync(GAMES_DIR, { recursive: true });
}

export interface PerGameStats {
  bishopArrows: number;
  rookBombs: number;
  rookWallBuilds: number;
}

export interface AttackStatsFile {
  games: PerGameStats[];
}

export interface AttackStatsResponse {
  gamesPlayed: number;
  bishopArrows: { min: number; avg: number; max: number };
  rookBombs: { min: number; avg: number; max: number };
  rookWallBuilds: { min: number; avg: number; max: number };
}

function loadAttackStatsFile(): AttackStatsFile {
  try {
    if (existsSync(STATS_FILE)) {
      const data = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
      if (Array.isArray(data.games)) return data;
    }
  } catch {}
  return { games: [] };
}

function saveAttackStatsFile(stats: AttackStatsFile): void {
  try {
    writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save attack stats:', error);
  }
}

function computeAttackStats(file: AttackStatsFile): AttackStatsResponse {
  const g = file.games;
  if (g.length === 0) {
    return {
      gamesPlayed: 0,
      bishopArrows: { min: 0, avg: 0, max: 0 },
      rookBombs: { min: 0, avg: 0, max: 0 },
      rookWallBuilds: { min: 0, avg: 0, max: 0 },
    };
  }
  const stat = (key: keyof PerGameStats) => {
    const vals = g.map(x => x[key]);
    return {
      min: Math.min(...vals),
      avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
      max: Math.max(...vals),
    };
  };
  return {
    gamesPlayed: g.length,
    bishopArrows: stat('bishopArrows'),
    rookBombs: stat('rookBombs'),
    rookWallBuilds: stat('rookWallBuilds'),
  };
}

export interface SavedGameInfo {
  id: string;
  phase: GameState['phase'];
  currentTurn: PlayerColor;
  moveCount: number;
  whitePlayer: string | null;
  blackPlayer: string | null;
  winner: PlayerColor | 'draw' | null;
  updatedAt: string;
  gameMode?: GameMode;
}

interface Player {
  ws: WebSocket;
  id: string;
  color: PlayerColor;
}

interface GameRoom {
  state: GameState;
  players: Map<string, Player>;
  readyPlayers: Set<string>;
  attackCounts: PerGameStats;
}

export class GameManager {
  private games: Map<string, GameRoom> = new Map();
  private playerToGame: Map<string, string> = new Map();
  private trackedGameIds: Set<string> = new Set();
  private flushedGameIds: Set<string> = new Set();

  recordAttackStat(gameId: string, type: 'bishopArrow' | 'rookBomb' | 'rookWallBuild'): void {
    const room = this.games.get(gameId);
    if (!room) return;
    if (type === 'bishopArrow') room.attackCounts.bishopArrows++;
    else if (type === 'rookBomb') room.attackCounts.rookBombs++;
    else if (type === 'rookWallBuild') room.attackCounts.rookWallBuilds++;
  }

  flushGameStats(gameId: string): void {
    if (this.flushedGameIds.has(gameId)) return;
    const room = this.games.get(gameId);
    if (!room) return;
    this.flushedGameIds.add(gameId);
    const file = loadAttackStatsFile();
    file.games.push({ ...room.attackCounts });
    saveAttackStatsFile(file);
  }

  getAttackStats(): AttackStatsResponse {
    return computeAttackStats(loadAttackStatsFile());
  }

  getAttackSettingsForColor(state: GameState, color: PlayerColor): AttackSettings {
    if (state.budgetMode === 'individual') {
      const perPlayer = color === 'white' ? state.whiteAttackSettings : state.blackAttackSettings;
      if (perPlayer) return withCertainPawnAttacks(perPlayer);
    }
    return withCertainPawnAttacks(state.attackSettings);
  }

  /** One attack roll. Pawn attacks always succeed. Other kinds are unchanged. */
  resolveAttack(attackType: 'pawn' | 'bishop' | 'knight' | 'bomb' | 'wallBuild', settings: AttackSettings, distance?: number): boolean {
    return this.checkAttackSuccess(settings, attackType, distance);
  }

  private checkAttackSuccess(settings: AttackSettings, attackType: 'pawn' | 'bishop' | 'knight' | 'bomb' | 'wallBuild', distance?: number): boolean {
    if (attackType === 'pawn') return true;
    const percentMap: Record<string, number | undefined> = {
      pawn: settings.pawnAttackPercent,
      bishop: settings.bishopAttackPercent,
      knight: settings.knightAttackPercent,
      bomb: settings.bombAttackPercent,
      wallBuild: settings.wallBuildPercent,
    };
    const percent = percentMap[attackType];
    if (percent !== undefined) {
      return Math.random() * 100 < percent;
    }
    switch (attackType) {
      case 'bishop': {
        const die1 = Math.floor(Math.random() * 6) + 1;
        const die2 = Math.floor(Math.random() * 6) + 1;
        const threshold = settings.bishopMinRoll || distance || 2;
        return (die1 + die2) >= threshold;
      }
      case 'knight': return Math.floor(Math.random() * 6) + 1 >= (settings.knightMinRoll ?? 4);
      case 'bomb': return Math.floor(Math.random() * 10) + 1 <= (settings.bombSuccessRoll ?? 1);
      case 'wallBuild': return Math.floor(Math.random() * 10) + 1 <= (settings.wallBuildRoll ?? 5);
    }
  }

  // File persistence methods
  private getGameFilePath(gameId: string): string {
    return join(GAMES_DIR, `${gameId}.json`);
  }

  saveGame(state: GameState): void {
    try {
      const filePath = this.getGameFilePath(state.id);
      const data = JSON.stringify(state, null, 2);
      writeFileSync(filePath, data, 'utf-8');
    } catch (error) {
      console.error(`Failed to save game ${state.id}:`, error);
    }
    if (state.winner) {
      this.flushGameStats(state.id);
    }
  }

  loadGame(gameId: string): GameState | null {
    try {
      const filePath = this.getGameFilePath(gameId);
      if (!existsSync(filePath)) return null;
      const data = readFileSync(filePath, 'utf-8');
      const state = JSON.parse(data) as GameState;
      // Add default attackSettings for old games that don't have them
      if (!state.attackSettings) {
        state.attackSettings = {
          pawnSuccessRoll: 6,
          bishopMinRoll: 0,
          knightMinRoll: 4,
          bombSuccessRoll: 1,
          wallBuildRoll: 5,
          pawnAttackPercent: 100,
        };
      }
      normalizePawnSettings(state);
      return state;
    } catch (error) {
      console.error(`Failed to load game ${gameId}:`, error);
      return null;
    }
  }

  listSavedGames(): SavedGameInfo[] {
    try {
      const files = readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
      const games: SavedGameInfo[] = [];

      for (const file of files) {
        try {
          const filePath = join(GAMES_DIR, file);
          const stat = statSync(filePath);
          const data = readFileSync(filePath, 'utf-8');
          const state = JSON.parse(data) as GameState;
          
          games.push({
            id: state.id,
            phase: state.phase,
            currentTurn: state.currentTurn,
            moveCount: state.moveHistory.length,
            whitePlayer: state.players.white,
            blackPlayer: state.players.black,
            winner: state.winner,
            updatedAt: stat.mtime.toISOString(),
            gameMode: state.gameMode,
          });
        } catch (e) {
          // Skip invalid files
        }
      }

      // Sort by most recently updated
      return games.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } catch (error) {
      console.error('Failed to list saved games:', error);
      return [];
    }
  }

  deleteGame(gameId: string, requestingPlayerId?: string): boolean {
    try {
      const filePath = this.getGameFilePath(gameId);
      if (!existsSync(filePath)) {
        return false;
      }
      
      // Load game to check ownership if playerId provided
      if (requestingPlayerId) {
        const state = this.loadGame(gameId);
        if (state) {
          const isOwner = state.players.white === requestingPlayerId || 
                          state.players.black === requestingPlayerId;
          if (!isOwner) {
            return false;
          }
        }
      }
      
      // Remove from memory if present
      this.games.delete(gameId);
      
      unlinkSync(filePath);
      return true;
    } catch (error) {
      console.error(`Failed to delete game ${gameId}:`, error);
      return false;
    }
  }

  deleteAllGames(): number {
    try {
      if (!existsSync(GAMES_DIR)) {
        return 0;
      }
      
      const files = readdirSync(GAMES_DIR);
      let deleted = 0;
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const gameId = file.replace('.json', '');
          try {
            // Remove from memory if present
            this.games.delete(gameId);
            // Delete file
            unlinkSync(this.getGameFilePath(gameId));
            deleted++;
          } catch (e) {
            // Continue with other files
          }
        }
      }
      
      return deleted;
    } catch (error) {
      console.error('Failed to delete all games:', error);
      return 0;
    }
  }

  // Load a saved game into memory for play
  loadGameIntoMemory(gameId: string): GameState | null {
    // First check if already in memory
    const existingRoom = this.games.get(gameId);
    if (existingRoom) {
      return existingRoom.state;
    }

    // Load from file
    const state = this.loadGame(gameId);
    if (!state) return null;

    // Create a room for it (players will connect via WebSocket)
    const room: GameRoom = {
      state,
      players: new Map(),
      readyPlayers: new Set(),
      attackCounts: { bishopArrows: 0, rookBombs: 0, rookWallBuilds: 0 },
    };

    this.games.set(gameId, room);
    return state;
  }

  createGame(ws: WebSocket, maxWalls: number, gameMode: GameMode = 'pvp', attackSettings?: AttackSettings, budgetMode?: 'shared' | 'individual', aiDepth?: number, computerPolicy?: ComputerPolicyId): { gameId: string; playerId: string; color: PlayerColor } {
    const gameId = generateShortId();
    const playerId = generateShortId();
    
    const isVsComputer = gameMode === 'pvc';
    
    const defaultAttackSettings: AttackSettings = {
      pawnSuccessRoll: 6,
      bishopMinRoll: 0,
      knightMinRoll: 4,
      bombSuccessRoll: 1,
      wallBuildRoll: 5,
      pawnAttackPercent: 100,
    };
    
    const finalAttackSettings = withCertainPawnAttacks(attackSettings || defaultAttackSettings);
    const effectiveBudgetMode = budgetMode || 'shared';
    
    const maxBishopAttacks = attackSettings?.maxBishopAttacks ?? 10;
    const maxRookAttacks = attackSettings?.maxRookAttacks ?? 10;
    
    const state: GameState = {
      id: gameId,
      board: this.createInitialBoard(),
      currentTurn: 'white',
      phase: isVsComputer ? (maxWalls > 0 ? 'setup' : 'playing') : 'waiting',
      gameMode,
      aiColor: isVsComputer ? 'black' : undefined,
      aiControlled: { white: false, black: isVsComputer },
      setupWallsRemaining: { white: maxWalls, black: maxWalls },
      maxWallsPerPlayer: maxWalls,
      moveHistory: [],
      capturedPieces: { white: [], black: [] },
      players: { white: playerId, black: isVsComputer ? AI_PLAYER_ID : null },
      winner: null,
      attackSettings: finalAttackSettings,
      budgetMode: effectiveBudgetMode,
      budgetReadyPlayers: [],
      aiDepth: Math.max(0, Math.min(8, aiDepth ?? 0)),
      computerPolicy: computerPolicy === 'legacy' ? 'legacy' : 'cand-r32',
      maxBishopAttacks: Math.max(0, Math.min(75, maxBishopAttacks)),
      maxRookAttacks: Math.max(0, Math.min(75, maxRookAttacks)),
      specialAttackCounts: {},
    };
    
    if (effectiveBudgetMode === 'individual') {
      state.whiteAttackSettings = undefined;
      state.blackAttackSettings = undefined;
    } else {
      state.whiteAttackSettings = { ...finalAttackSettings };
      state.blackAttackSettings = { ...finalAttackSettings };
    }
    
    if (isVsComputer && effectiveBudgetMode === 'individual') {
      state.blackAttackSettings = this.generateAIBudgetSettings(finalAttackSettings.totalAttackBudget || 250);
      state.budgetReadyPlayers = [AI_PLAYER_ID];
    }
    
    const room: GameRoom = {
      state,
      players: new Map([[playerId, { ws, id: playerId, color: 'white' }]]),
      readyPlayers: new Set(),
      attackCounts: { bishopArrows: 0, rookBombs: 0, rookWallBuilds: 0 },
    };
    
    // For vs computer, auto-ready the AI and place random walls
    if (isVsComputer) {
      room.readyPlayers.add(AI_PLAYER_ID);
      this.placeAIWalls(state, maxWalls);
    }
    
    this.games.set(gameId, room);
    this.playerToGame.set(playerId, gameId);
    
    // Save game to file
    this.saveGame(state);
    
    return { gameId, playerId, color: 'white' };
  }
  
  // Active CvC game intervals
  private cvcIntervals: Map<string, NodeJS.Timeout> = new Map();
  
  // Callback for broadcasting state updates
  private onCvCStateUpdate?: (gameId: string, state: GameState) => void;
  
  setCvCStateUpdateCallback(callback: (gameId: string, state: GameState) => void) {
    this.onCvCStateUpdate = callback;
  }

  // Create a computer vs computer game that plays visibly
  createCvCGame(maxWalls: number, attackSettings?: AttackSettings, aiDepth?: number, computerPolicy?: ComputerPolicyId, autoplay = true): { gameId: string; state: GameState } {
    const gameId = generateShortId();
    
    const defaultAttackSettings: AttackSettings = {
      pawnSuccessRoll: 6,
      bishopMinRoll: 0,
      knightMinRoll: 4,
      bombSuccessRoll: 1,
      wallBuildRoll: 5,
      pawnAttackPercent: 100,
    };
    
    const finalSettings = withCertainPawnAttacks(attackSettings || defaultAttackSettings);
    const state: GameState = {
      id: gameId,
      board: this.createInitialBoard(),
      currentTurn: 'white',
      phase: 'playing',
      gameMode: 'cvc',
      aiColor: undefined,
      aiControlled: { white: true, black: true },
      setupWallsRemaining: { white: 0, black: 0 },
      maxWallsPerPlayer: maxWalls,
      moveHistory: [],
      capturedPieces: { white: [], black: [] },
      players: { white: AI_PLAYER_ID, black: AI_PLAYER_ID },
      winner: null,
      attackSettings: finalSettings,
      aiDepth: Math.max(0, Math.min(8, aiDepth ?? 0)),
      computerPolicy: computerPolicy === 'legacy' ? 'legacy' : 'cand-r32',
      maxBishopAttacks: Math.max(0, Math.min(75, finalSettings.maxBishopAttacks ?? 10)),
      maxRookAttacks: Math.max(0, Math.min(75, finalSettings.maxRookAttacks ?? 10)),
      specialAttackCounts: {},
    };
    
    // Place walls for both sides
    this.placeCvCWalls(state, maxWalls, 'white');
    this.placeCvCWalls(state, maxWalls, 'black');
    
    const room: GameRoom = {
      state,
      players: new Map(),
      readyPlayers: new Set(),
      attackCounts: { bishopArrows: 0, rookBombs: 0, rookWallBuilds: 0 },
    };
    
    this.games.set(gameId, room);
    this.saveGame(state);
    
    // Start the game with visible moves (500ms between moves)
    if (autoplay) this.startCvCGameLoop(gameId);
    
    return { gameId, state };
  }
  
  private startCvCGameLoop(gameId: string) {
    const MAX_MOVES = 500;
    const REGULAR_DELAY = 500;
    const SPECIAL_ATTACK_DELAY = 1500;
    
    const scheduleNext = () => {
      const room = this.games.get(gameId);
      if (!room || room.state.phase !== 'playing') {
        this.cvcIntervals.delete(gameId);
        return;
      }
      
      if (room.state.gameMode !== 'cvc') {
        this.cvcIntervals.delete(gameId);
        return;
      }
      
      const state = room.state;
      const currentColor = state.currentTurn;
      state.lastDiceRoll = undefined;
      const moveResult = this.makeCvCMove(state, currentColor);
      
      if (!moveResult) {
        const inCheck = this.isInCheck(state.board, currentColor);
        if (inCheck) {
          state.winner = currentColor === 'white' ? 'black' : 'white';
        } else {
          state.winner = 'draw';
        }
        state.phase = 'finished';
        this.saveGame(state);
        this.onCvCStateUpdate?.(gameId, state);
        this.cvcIntervals.delete(gameId);
        return;
      }
      
      this.saveGame(state);
      this.onCvCStateUpdate?.(gameId, state);
      
      if (state.moveHistory.length >= MAX_MOVES) {
        state.winner = 'draw';
        state.phase = 'finished';
        this.saveGame(state);
        this.onCvCStateUpdate?.(gameId, state);
        this.cvcIntervals.delete(gameId);
        return;
      }
      
      const delay = moveResult === 'special' ? SPECIAL_ATTACK_DELAY : REGULAR_DELAY;
      const timeout = setTimeout(scheduleNext, delay);
      this.cvcIntervals.set(gameId, timeout);
    };
    
    const timeout = setTimeout(scheduleNext, REGULAR_DELAY);
    this.cvcIntervals.set(gameId, timeout);
  }
  
  // Join as observer for CvC game
  // Stop a CvC game (for resign/stop functionality)
  stopCvCGame(gameId: string): GameState | null {
    const room = this.games.get(gameId);
    if (!room || room.state.gameMode !== 'cvc') return null;
    
    // Stop the game loop
    const timeout = this.cvcIntervals.get(gameId);
    if (timeout) {
      clearTimeout(timeout);
      this.cvcIntervals.delete(gameId);
    }
    
    // Mark game as finished (draw/stopped)
    room.state.phase = 'finished';
    room.state.winner = null; // Stopped, no winner
    this.saveGame(room.state);
    
    return room.state;
  }
  
  pauseCvCGame(gameId: string, paused: boolean): void {
    const room = this.games.get(gameId);
    if (!room || room.state.gameMode !== 'cvc') return;
    
    if (paused) {
      // Pause - stop the game loop
      const timeout = this.cvcIntervals.get(gameId);
      if (timeout) {
        clearTimeout(timeout);
        this.cvcIntervals.delete(gameId);
      }
    } else {
      // Resume - restart the game loop if game is still playing
      if (room.state.phase === 'playing' && !this.cvcIntervals.has(gameId)) {
        this.startCvCGameLoop(gameId);
      }
    }
  }

  joinCvCAsObserver(ws: WebSocket, gameId: string): { state: GameState } | null {
    let room = this.games.get(gameId);
    if (!room) {
      const state = this.loadGame(gameId);
      if (!state) return null;
      room = {
        state,
        players: new Map(),
        readyPlayers: new Set(),
        attackCounts: { bishopArrows: 0, rookBombs: 0, rookWallBuilds: 0 },
      };
      this.games.set(gameId, room);
      
      // If game is still playing, restart the loop
      if (state.phase === 'playing' && state.gameMode === 'cvc') {
        this.startCvCGameLoop(gameId);
      }
    }
    
    // Add as observer (no player ID needed)
    const observerId = `observer-${generateShortId()}`;
    room.players.set(observerId, { ws, id: observerId, color: 'white' });
    
    return { state: room.state };
  }
  
  private placeCvCWalls(state: GameState, count: number, color: PlayerColor): void {
    const isWhite = color === 'white';
    const startRow = isWhite ? BOARD_SIZE / 2 : 0;
    const endRow = isWhite ? BOARD_SIZE : BOARD_SIZE / 2;
    
    let placed = 0;
    const attempts: Position[] = [];
    
    for (let row = startRow; row < endRow; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (!state.board[row][col].piece && !state.board[row][col].isWall) {
          attempts.push({ row, col });
        }
      }
    }
    
    // Shuffle
    for (let i = attempts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [attempts[i], attempts[j]] = [attempts[j], attempts[i]];
    }
    
    for (const pos of attempts) {
      if (placed >= count) break;
      state.board[pos.row][pos.col].isWall = true;
      placed++;
    }
  }
  
  private makeCvCMove(state: GameState, color: PlayerColor): false | 'regular' | 'special' {
    if (policyIdOf(state) !== 'legacy') {
      return this.applyPolicyAction(state.id);
    }
    const board = state.board;
    const inCheck = this.isInCheck(board, color);
    
    interface AIMove { from: Position; to: Position; score: number; isArrow?: boolean; isAxe?: boolean; isBomb?: boolean; escapesCheck?: boolean }
    const possibleMoves: AIMove[] = [];
    
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = board[row][col].piece;
        if (piece && piece.color === color) {
          const from = { row, col };
          const moves = this.getValidMoves(board, from);
          
          for (const to of moves) {
            const targetPiece = board[to.row][to.col].piece;
            let score = Math.random() * 0.5;
            
            const newBoard: Board = JSON.parse(JSON.stringify(board));
            newBoard[to.row][to.col].piece = piece;
            newBoard[from.row][from.col].piece = null;
            const escapesCheck = !this.isInCheck(newBoard, color);
            
            if (inCheck) {
              if (escapesCheck) {
                score += 1000;
              } else {
                score -= 2000;
              }
            }
            
            if (targetPiece) {
              const values: Record<PieceType, number> = {
                pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100
              };
              score += values[targetPiece.type] * 10;
              // Pawns should always attack adjacent enemies - give high priority
              if (piece.type === 'pawn') {
                score += 500; // High priority for pawn attacks
              }
            }
            
            if (piece.type === 'pawn') {
              const advancement = color === 'white' ? (BOARD_SIZE - 1 - to.row) : to.row;
              score += advancement * 0.1;
            }
            
            // Bishop safety and development
            if (piece.type === 'bishop') {
              const enemyColorForBishop = color === 'white' ? 'black' : 'white';
              
              const destThreatened = this.isSquareAttackedBy(newBoard, to, enemyColorForBishop);
              
              if (destThreatened && !targetPiece) {
                score -= 80;
              } else if (destThreatened && targetPiece) {
                const captureValue = ({ pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 } as Record<PieceType, number>)[targetPiece.type];
                if (captureValue < 3) score -= 40;
              }
              
              if (!destThreatened) {
                const lanes = this.countBishopFiringLanes(newBoard, to, color);
                score += lanes * 6;
                if (lanes >= 4) score += 15;
              }
              
              if (state.moveHistory.length < 20) {
                const startRow = color === 'white' ? BOARD_SIZE - 1 : 0;
                if (from.row === startRow) {
                  score += 50;
                  const centerCol = BOARD_SIZE / 2;
                  const towardCenter = Math.abs(to.col - centerCol) < Math.abs(from.col - centerCol);
                  if (towardCenter) score += 20;
                }
              }
              
              let totalPieces = 0;
              for (let r = 0; r < BOARD_SIZE; r++) {
                for (let c = 0; c < BOARD_SIZE; c++) {
                  if (board[r][c].piece) totalPieces++;
                }
              }
              if (totalPieces <= 16 || state.moveHistory.length > 80) {
                if (!destThreatened) score += 25;
              }
            }
            
            const centerDist = Math.abs(to.row - BOARD_SIZE / 2) + Math.abs(to.col - BOARD_SIZE / 2);
            score += (BOARD_SIZE - centerDist) * 0.05;
            
            // A* pathfinding: bonus for moves that get closer to enemy king
            const enemyColor = color === 'white' ? 'black' : 'white';
            const enemyKingPos = findKingPosition(board, enemyColor);
            if (enemyKingPos && !targetPiece) {
              const currentPathDist = aStarPathfind(board, from, enemyKingPos);
              
              // Simulate moving the piece
              const tempBoard: Board = JSON.parse(JSON.stringify(board));
              tempBoard[to.row][to.col].piece = piece;
              tempBoard[from.row][from.col].piece = null;
              const newPathDist = aStarPathfind(tempBoard, to, enemyKingPos);
              
              if (newPathDist < currentPathDist && newPathDist !== Infinity) {
                const improvement = currentPathDist - newPathDist;
                score += improvement * 2;
                if (newPathDist <= 4) {
                  score += (5 - newPathDist) * 3;
                }
              }
              
              if (newPathDist > currentPathDist && currentPathDist !== Infinity) {
                score -= 1;
              }
            }
            
            possibleMoves.push({ from, to, score, escapesCheck });
          }
          
          if (piece.type === 'bishop' && !inCheck) {
            const cvcBPieceUsed = piece.id ? (state.specialAttackCounts?.[piece.id] ?? 0) : 0;
            const cvcBMax = state.maxBishopAttacks ?? 10;
            if (cvcBPieceUsed < cvcBMax) {
            const recentColorMoves = state.moveHistory.slice(-30).filter(m => m.piece.color === color);
            let consecutiveBishopChases = 0;
            let movesAfterChase = 0;
            let chaseDetected = false;
            for (let i = recentColorMoves.length - 1; i >= 0; i--) {
              const m = recentColorMoves[i];
              if (!chaseDetected) {
                if (m.isArrowAttack && m.piece.type === 'bishop' && !m.captured) {
                  consecutiveBishopChases++;
                } else if (consecutiveBishopChases >= 5) {
                  chaseDetected = true;
                  movesAfterChase = recentColorMoves.length - 1 - i;
                } else {
                  break;
                }
              }
            }
            if (consecutiveBishopChases >= 5 && !chaseDetected) {
              chaseDetected = true;
              movesAfterChase = 0;
            }
            const bishopChaseFatigue = chaseDetected && movesAfterChase < 6;

            const arrowTargets = this.getArrowTargets(board, from, color);
            for (const to of arrowTargets) {
              const targetPiece = board[to.row][to.col].piece;
              if (targetPiece) {
                const values: Record<PieceType, number> = {
                  pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100
                };
                let score = values[targetPiece.type] * 10 + 400 + Math.random() * 0.5;
                if (targetPiece.type === 'king') score += 500;
                if (targetPiece.type === 'bishop') {
                  if (bishopChaseFatigue) {
                    score -= 500;
                  } else {
                    score += 200;
                  }
                }
                possibleMoves.push({ from, to, score, isArrow: true });
              }
            }
            }
          }
          
          // Axe attacks for knights
          if (piece.type === 'knight' && !inCheck) {
            const axeTargets = this.getAxeTargets(board, from, color);
            for (const to of axeTargets) {
              const targetPiece = board[to.row][to.col].piece;
              if (targetPiece) {
                const values: Record<PieceType, number> = {
                  pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100
                };
                const score = values[targetPiece.type] * 10 * 0.5 + Math.random() * 0.5;
                possibleMoves.push({ from, to, score, isAxe: true });
              }
            }
          }
          
          if (piece.type === 'rook' && !inCheck) {
            const cvcRPieceUsed = piece.id ? (state.specialAttackCounts?.[piece.id] ?? 0) : 0;
            const cvcRMax = state.maxRookAttacks ?? 10;
            if (cvcRPieceUsed < cvcRMax) {
            const bombTargets = this.getBombTargets(board, from);
            const enemyColor = color === 'white' ? 'black' : 'white';
            const enemyKingPos = findKingPosition(board, enemyColor);
            
            // Count walls and blocked pieces
            let totalWalls = 0;
            for (let r = 0; r < BOARD_SIZE; r++) {
              for (let c = 0; c < BOARD_SIZE; c++) {
                if (board[r][c].isWall) totalWalls++;
              }
            }
            const isHeavilyWalled = totalWalls > 15;
            
            let blockedPieces = 0;
            if (enemyKingPos) {
              for (let r = 0; r < BOARD_SIZE; r++) {
                for (let c = 0; c < BOARD_SIZE; c++) {
                  const p = board[r][c].piece;
                  if (p && p.color === color && p.type !== 'king') {
                    if (aStarPathfind(board, { row: r, col: c }, enemyKingPos) === Infinity) {
                      blockedPieces++;
                    }
                  }
                }
              }
            }
            
            for (const to of bombTargets) {
              let score = 350 + Math.random() * 0.5;
              if (isHeavilyWalled) score += 150;
              if (blockedPieces >= 3) score += 200;
              
              if (enemyKingPos) {
                const currentPathDist = aStarPathfind(board, from, enemyKingPos);
                const tempBoard: Board = JSON.parse(JSON.stringify(board));
                tempBoard[to.row][to.col].isWall = false;
                const newPathDist = aStarPathfind(tempBoard, from, enemyKingPos);
                
                if (currentPathDist === Infinity && newPathDist !== Infinity) {
                  score += 500;
                } else if (newPathDist < currentPathDist) {
                  score += (currentPathDist - newPathDist) * 25;
                }
                
                let piecesHelped = 0;
                for (let r = 0; r < BOARD_SIZE; r++) {
                  for (let c = 0; c < BOARD_SIZE; c++) {
                    const otherPiece = board[r][c].piece;
                    if (otherPiece && otherPiece.color === color && (r !== from.row || c !== from.col)) {
                      const otherCurrentDist = aStarPathfind(board, { row: r, col: c }, enemyKingPos);
                      const otherNewDist = aStarPathfind(tempBoard, { row: r, col: c }, enemyKingPos);
                      
                      if (otherCurrentDist === Infinity && otherNewDist !== Infinity) {
                        score += 150;
                        piecesHelped++;
                      } else if (otherNewDist < otherCurrentDist - 2) {
                        score += 40;
                        piecesHelped++;
                      }
                    }
                  }
                }
                
                if (piecesHelped >= 3) score += 100;
              }
              
              possibleMoves.push({ from, to, score, isBomb: true });
            }
            }
          }
        }
      }
    }
    
    if (possibleMoves.length === 0) return false;
    
    possibleMoves.sort((a, b) => b.score - a.score);
    
    let validMoves = possibleMoves;
    if (inCheck) {
      const checkEscaping = possibleMoves.filter(m => m.escapesCheck);
      if (checkEscaping.length > 0) validMoves = checkEscaping;
      else return false; // No way to escape check = checkmate
    }
    
    const topMoves = validMoves.slice(0, Math.min(3, validMoves.length));
    const selected = topMoves[Math.floor(Math.random() * topMoves.length)];
    
    const isSpecial = !!(selected.isArrow || selected.isAxe || selected.isBomb);
    
    // Execute the move directly on state
    if (selected.isArrow) {
      this.executeCvCArrowAttack(state, selected.from, selected.to);
    } else if (selected.isAxe) {
      this.executeCvCAxeAttack(state, selected.from, selected.to);
    } else if (selected.isBomb) {
      this.executeCvCBombAttack(state, selected.from, selected.to);
    } else {
      this.executeCvCMove(state, selected.from, selected.to);
      // Check if pawn attack happened (has lastDiceRoll set)
      if (state.lastDiceRoll) return 'special';
    }
    
    return isSpecial ? 'special' : 'regular';
  }
  
  private executeCvCMove(state: GameState, from: Position, to: Position): void {
    const board = state.board;
    const piece = board[from.row][from.col].piece!;
    const targetPiece = board[to.row][to.col].piece;
    const color = piece.color;
    
    let actualCaptured: Piece | undefined;
    
    let pawnDiceRoll: number | undefined;
    let pawnSuccess: boolean | undefined;
    
    if (targetPiece) {
      // Combat
      if (piece.type === 'pawn') {
        const roll = Math.floor(Math.random() * 6) + 1;
        pawnDiceRoll = roll;
        const settings = this.getAttackSettingsForColor(state, color);
        const success = this.checkAttackSuccess(settings, 'pawn');
        pawnSuccess = success;
        
        state.lastDiceRoll = { value: roll, type: 'd6' as const, success };
        
        if (success) {
          actualCaptured = targetPiece;
          state.capturedPieces[color].push(targetPiece);
          board[to.row][to.col].piece = { ...piece, hasMoved: true };
          board[from.row][from.col].piece = null;
        }
        // Failure - turn still changes, piece stays put
      } else {
        // Non-pawn captures succeed
        actualCaptured = targetPiece;
        state.capturedPieces[color].push(targetPiece);
        board[to.row][to.col].piece = { ...piece, hasMoved: true };
        board[from.row][from.col].piece = null;
      }
    } else {
      // Regular move
      board[to.row][to.col].piece = { ...piece, hasMoved: true };
      board[from.row][from.col].piece = null;
      
      // Castling
      if (piece.type === 'king' && Math.abs(to.col - from.col) > 1) {
        const isKingside = to.col === BOARD_SIZE - 1;
        const rookFromCol = isKingside ? BOARD_SIZE - 1 : 0;
        const rookToCol = isKingside ? to.col - 1 : to.col + 1;
        const rookPiece = board[from.row][rookFromCol].piece;
        if (rookPiece) {
          board[from.row][rookToCol].piece = { ...rookPiece, hasMoved: true };
          if (rookFromCol !== to.col) {
            board[from.row][rookFromCol].piece = null;
          }
        }
      }
    }
    
    // Pawn promotion - AI always promotes to queen
    if (piece.type === 'pawn') {
      const promotionRow = color === 'white' ? 0 : BOARD_SIZE - 1;
      if (to.row === promotionRow && board[to.row][to.col].piece) {
        board[to.row][to.col].piece = { type: 'queen', color, hasMoved: true };
      }
    }
    
    const moveEntry: Move = { from, to, piece, captured: actualCaptured, notation: this.getMoveNotation(piece, from, to, actualCaptured, pawnDiceRoll) };
    if (pawnDiceRoll !== undefined) {
      moveEntry.diceRoll = pawnDiceRoll;
      moveEntry.diceRequired = 1;
      moveEntry.success = pawnSuccess;
    }
    state.moveHistory.push(moveEntry);
    
    // Check for king capture
    if (actualCaptured && actualCaptured.type === 'king') {
      state.winner = color;
      state.phase = 'finished';
    } else {
      // Switch turns
      state.currentTurn = color === 'white' ? 'black' : 'white';
      
      // Check for checkmate or stalemate
      this.checkGameEnd(state, color);
    }
  }
  
  private executeCvCArrowAttack(state: GameState, from: Position, to: Position): void {
    const board = state.board;
    const targetPiece = board[to.row][to.col].piece;
    const piece = board[from.row][from.col].piece!;
    const color = piece.color;
    
    const distance = Math.abs(to.row - from.row);
    const settings = this.getAttackSettingsForColor(state, color);
    const success = targetPiece ? this.checkAttackSuccess(settings, 'bishop', distance) : false;
    const roll = Math.floor(Math.random() * 4) + 1;
    
    const diceRoll = { value: roll, type: 'd4' as const, success };
    state.lastDiceRoll = diceRoll;
    
    state.moveHistory.push({
      from,
      to,
      piece,
      captured: success && targetPiece ? targetPiece : undefined,
      isArrowAttack: true,
      diceRoll: roll,
      diceRequired: 4,
      success,
      notation: this.getMoveNotation(piece, from, to, success && targetPiece ? targetPiece : undefined, roll, true),
    });
    
    if (success && targetPiece) {
      state.capturedPieces[color].push(targetPiece);
      board[to.row][to.col].piece = null;
      
      if (targetPiece.type === 'king') {
        state.winner = color;
        state.phase = 'finished';
        return;
      }
    }
    
    const enemyColor = color === 'white' ? 'black' : 'white';
    state.currentTurn = enemyColor;
    
    this.checkGameEnd(state, color);
  }
  
  private executeCvCAxeAttack(state: GameState, from: Position, to: Position): void {
    const board = state.board;
    const targetPiece = board[to.row][to.col].piece;
    const piece = board[from.row][from.col].piece!;
    const color = piece.color;
    
    const settings = this.getAttackSettingsForColor(state, color);
    const success = targetPiece ? this.checkAttackSuccess(settings, 'knight') : false;
    const roll = Math.floor(Math.random() * 6) + 1;
    
    const diceRoll = { value: roll, type: 'd6' as const, success };
    state.lastDiceRoll = diceRoll;
    
    state.moveHistory.push({
      from,
      to,
      piece,
      captured: success && targetPiece ? targetPiece : undefined,
      isAxeAttack: true,
      diceRoll: roll,
      diceRequired: settings?.knightMinRoll ?? 4,
      success,
      notation: `${piece.type === 'knight' ? 'N' : ''}🪓${String.fromCharCode(97 + to.col)}${BOARD_SIZE - to.row}(${roll}${success ? '✓' : '✗'})`,
    });
    
    if (success && targetPiece) {
      state.capturedPieces[color].push(targetPiece);
      board[to.row][to.col].piece = null;
      
      if (targetPiece.type === 'king') {
        state.winner = color;
        state.phase = 'finished';
        return;
      }
    }
    
    const enemyColor = color === 'white' ? 'black' : 'white';
    state.currentTurn = enemyColor;
    
    this.checkGameEnd(state, color);
  }
  
  private executeCvCBombAttack(state: GameState, from: Position, to: Position): void {
    const board = state.board;
    const piece = board[from.row][from.col].piece!;
    const color = piece.color;
    
    // Roll 1d10, need <= bombSuccessRoll (default 1)
    const roll = Math.floor(Math.random() * 10) + 1;
    const bombSettings = this.getAttackSettingsForColor(state, color);
    const success = this.checkAttackSuccess(bombSettings, 'bomb');
    
    if (success && board[to.row][to.col].isWall) {
      board[to.row][to.col].isWall = false;
    }
    
    // Record the move
    state.moveHistory.push({
      from,
      to,
      piece,
      isBombAttack: true,
      diceRoll: roll,
      diceRequired: bombSettings?.bombSuccessRoll ?? 1,
      success,
      notation: `R💣${String.fromCharCode(97 + to.col)}${BOARD_SIZE - to.row}(${roll}${success ? '✓' : '✗'})`,
    });
    
    state.lastDiceRoll = { value: roll, type: 'd10', success };
    
    const enemyColor = color === 'white' ? 'black' : 'white';
    state.currentTurn = enemyColor;
    
    // Destroying a wall can open lines of attack - check for checkmate/stalemate
    if (success) {
      this.checkGameEnd(state, color);
    }
  }

  private executeCvCWallBuild(state: GameState, from: Position, to: Position): void {
    const board = state.board;
    const piece = board[from.row][from.col].piece;
    if (!piece) return;
    const color = piece.color;
    const settings = this.getAttackSettingsForColor(state, color);
    const roll = Math.floor(Math.random() * 10) + 1;
    const empty = !board[to.row][to.col].piece && !board[to.row][to.col].isWall;
    const success = empty && this.checkAttackSuccess(settings, 'wallBuild');
    if (success) board[to.row][to.col].isWall = true;
    state.lastDiceRoll = { value: roll, type: 'd10', success };
    state.moveHistory.push({
      from,
      to,
      piece,
      isWallBuild: true,
      diceRoll: roll,
      diceRequired: settings.wallBuildRoll ?? 5,
      success,
      notation: `R${String.fromCharCode(97 + from.col)}${BOARD_SIZE - from.row}🧱${String.fromCharCode(97 + to.col)}${BOARD_SIZE - to.row}[d10:${roll}${success ? '✓' : '✗'}]`,
    });
    state.currentTurn = color === 'white' ? 'black' : 'white';
    if (success) this.checkGameEnd(state, color);
  }

  /** Play one cand-r32 action onto the live state. Does not save. */
  private applyPolicyAction(gameId: string): false | 'regular' | 'special' {
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'playing') return false;
    const state = room.state;
    const action = chooseComputerAction(state);
    if (!action || !actionIsLegal(state, action)) return false;
    const from = parseSquare(action.from);
    const to = parseSquare(action.to);
    state.lastDiceRoll = undefined;
    const before = state.moveHistory.length;
    if (action.kind === 'arrow') this.executeCvCArrowAttack(state, from, to);
    else if (action.kind === 'axe') this.executeCvCAxeAttack(state, from, to);
    else if (action.kind === 'bomb') this.executeCvCBombAttack(state, from, to);
    else if (action.kind === 'wall') this.executeCvCWallBuild(state, from, to);
    else this.executeCvCMove(state, from, to);
    if (state.moveHistory.length === before) return false;
    const played = state.moveHistory[state.moveHistory.length - 1];
    if (played.from.row !== from.row || played.from.col !== from.col || played.to.row !== to.row || played.to.col !== to.col) {
      return false;
    }
    if (action.kind === 'arrow' || action.kind === 'bomb' || action.kind === 'wall') {
      const piece = played.piece;
      if (piece.id) {
        if (!state.specialAttackCounts) state.specialAttackCounts = {};
        state.specialAttackCounts[piece.id] = (state.specialAttackCounts[piece.id] ?? 0) + 1;
      }
      if (action.kind === 'arrow') this.recordAttackStat(gameId, 'bishopArrow');
      else if (action.kind === 'bomb') this.recordAttackStat(gameId, 'rookBomb');
      else this.recordAttackStat(gameId, 'rookWallBuild');
    }
    return action.kind === 'move' && !state.lastDiceRoll ? 'regular' : 'special';
  }
  
  // Allow a human to take over a color in a saved game
  takeoverGame(ws: WebSocket, gameId: string, color: PlayerColor): { playerId: string; state: GameState } | null {
    // Load game from file if not in memory
    let state = this.games.get(gameId)?.state;
    if (!state) {
      const loaded = this.loadGame(gameId);
      if (!loaded) return null;
      state = loaded;
    }
    
    const playerId = generateShortId();
    
    // Update the game state
    state.players[color] = playerId;
    
    // If CvC game being taken over, change to PvC or PvP
    if (state.gameMode === 'cvc') {
      const otherColor = color === 'white' ? 'black' : 'white';
      if (state.players[otherColor] === AI_PLAYER_ID) {
        state.gameMode = 'pvc';
        state.aiColor = otherColor;
      } else {
        state.gameMode = 'pvp';
      }
    } else if (state.gameMode === 'pvc') {
      // If taking over the AI color
      if (state.aiColor === color) {
        state.gameMode = 'pvp';
        state.aiColor = undefined;
      }
    }
    
    let room = this.games.get(gameId);
    if (!room) {
      room = {
        state,
        players: new Map(),
        readyPlayers: new Set(),
        attackCounts: { bishopArrows: 0, rookBombs: 0, rookWallBuilds: 0 },
      };
      this.games.set(gameId, room);
    }
    
    room.players.set(playerId, { ws, id: playerId, color });
    this.playerToGame.set(playerId, gameId);
    
    // Save updated game
    this.saveGame(state);
    
    return { playerId, state };
  }
  
  private placeAIWalls(state: GameState, count: number): void {
    const aiColor = state.aiColor;
    if (!aiColor) return;
    
    const isWhiteAI = aiColor === 'white';
    const startRow = isWhiteAI ? BOARD_SIZE / 2 : 0;
    const endRow = isWhiteAI ? BOARD_SIZE : BOARD_SIZE / 2;
    
    let placed = 0;
    const attempts: Position[] = [];
    
    // Collect valid positions
    for (let row = startRow; row < endRow; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (!state.board[row][col].piece && !state.board[row][col].isWall) {
          attempts.push({ row, col });
        }
      }
    }
    
    // Shuffle and place walls
    for (let i = attempts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [attempts[i], attempts[j]] = [attempts[j], attempts[i]];
    }
    
    for (const pos of attempts) {
      if (placed >= count) break;
      state.board[pos.row][pos.col].isWall = true;
      placed++;
    }
    
    state.setupWallsRemaining[aiColor] = 0;
  }

  joinGame(ws: WebSocket, gameId: string): { playerId: string; color: PlayerColor } | null {
    let room = this.games.get(gameId);
    if (!room) {
      const state = this.loadGame(gameId);
      if (state) {
        room = {
          state,
          players: new Map(),
          readyPlayers: new Set(),
          attackCounts: { bishopArrows: 0, rookBombs: 0, rookWallBuilds: 0 },
        };
        this.games.set(gameId, room);
      } else {
        return null;
      }
    }
    
    if (room.state.players.black) {
      return null;
    }
    
    const playerId = generateShortId();
    room.state.players.black = playerId;
    room.players.set(playerId, { ws, id: playerId, color: 'black' });
    this.playerToGame.set(playerId, gameId);
    
    if (room.state.budgetMode === 'individual') {
      room.state.phase = 'budget_setup';
    } else if (room.state.maxWallsPerPlayer > 0) {
      room.state.phase = 'setup';
    } else {
      room.state.phase = 'playing';
    }
    
    this.saveGame(room.state);
    
    return { playerId, color: 'black' };
  }
  
  private generateAIBudgetSettings(totalBudget: number): AttackSettings {
    const weights = [1, 3, 3, 1, 2];
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const pawnPct = Math.min(100, Math.round((weights[0] / totalWeight) * totalBudget));
    const bishopPct = Math.min(100, Math.round((weights[1] / totalWeight) * totalBudget));
    const knightPct = Math.min(100, Math.round((weights[2] / totalWeight) * totalBudget));
    const bombPct = Math.min(100, Math.round((weights[3] / totalWeight) * totalBudget));
    const wallPct = Math.min(100, Math.round((weights[4] / totalWeight) * totalBudget));
    return withCertainPawnAttacks({
      pawnSuccessRoll: Math.round(pawnPct / 100 * 6),
      bishopMinRoll: 0,
      knightMinRoll: 6 + 1 - Math.round(knightPct / 100 * 6),
      bombSuccessRoll: Math.round(bombPct / 100 * 10),
      wallBuildRoll: Math.round(wallPct / 100 * 10),
      totalAttackBudget: totalBudget,
      pawnAttackPercent: pawnPct,
      bishopAttackPercent: bishopPct,
      knightAttackPercent: knightPct,
      bombAttackPercent: bombPct,
      wallBuildPercent: wallPct,
    });
  }
  
  handleBudgetSubmit(playerId: string, settings: AttackSettings): GameState | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'budget_setup') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    const budget = room.state.attackSettings.totalAttackBudget || 250;
    // Pawn attacks are always 100% and are not drawn from the shared budget.
    const total = (settings.bishopAttackPercent || 0) +
      (settings.knightAttackPercent || 0) + (settings.bombAttackPercent || 0) + (settings.wallBuildPercent || 0);
    
    if (total > budget) return null;
    
    const pawnPct = settings.pawnAttackPercent || 0;
    const bishopPct = settings.bishopAttackPercent || 0;
    const knightPct = settings.knightAttackPercent || 0;
    const bombPct = settings.bombAttackPercent || 0;
    const wallPct = settings.wallBuildPercent || 0;
    
    const playerSettings: AttackSettings = withCertainPawnAttacks({
      pawnSuccessRoll: Math.round(pawnPct / 100 * 6),
      bishopMinRoll: 0,
      knightMinRoll: 6 + 1 - Math.round(knightPct / 100 * 6),
      bombSuccessRoll: Math.round(bombPct / 100 * 10),
      wallBuildRoll: Math.round(wallPct / 100 * 10),
      totalAttackBudget: budget,
      pawnAttackPercent: pawnPct,
      bishopAttackPercent: bishopPct,
      knightAttackPercent: knightPct,
      bombAttackPercent: bombPct,
      wallBuildPercent: wallPct,
    });
    
    if (player.color === 'white') {
      room.state.whiteAttackSettings = playerSettings;
    } else {
      room.state.blackAttackSettings = playerSettings;
    }
    
    if (!room.state.budgetReadyPlayers) room.state.budgetReadyPlayers = [];
    if (!room.state.budgetReadyPlayers.includes(playerId)) {
      room.state.budgetReadyPlayers.push(playerId);
    }
    
    const neededCount = room.state.gameMode === 'pvc' ? 1 : 2;
    const humanReady = room.state.budgetReadyPlayers.filter(id => id !== AI_PLAYER_ID).length;
    const aiReady = room.state.budgetReadyPlayers.includes(AI_PLAYER_ID) ? 1 : 0;
    const totalReady = humanReady + aiReady;
    
    if (totalReady >= neededCount) {
      if (room.state.maxWallsPerPlayer > 0) {
        room.state.phase = 'setup';
      } else {
        room.state.phase = 'playing';
      }
    }
    
    this.saveGame(room.state);
    return room.state;
  }

  reconnectPlayer(ws: WebSocket, playerId: string, gameId: string): boolean {
    // Try to load from file if not in memory
    let room = this.games.get(gameId);
    if (!room) {
      const state = this.loadGame(gameId);
      if (state) {
        room = {
          state,
          players: new Map(),
          readyPlayers: new Set(),
          attackCounts: { bishopArrows: 0, rookBombs: 0, rookWallBuilds: 0 },
        };
        this.games.set(gameId, room);
      } else {
        return false;
      }
    }
    
    // Check if this player belongs to this game
    const isWhitePlayer = room.state.players.white === playerId;
    const isBlackPlayer = room.state.players.black === playerId;
    
    if (!isWhitePlayer && !isBlackPlayer) {
      return false;
    }
    
    // Add or update player WebSocket
    const color: PlayerColor = isWhitePlayer ? 'white' : 'black';
    room.players.set(playerId, { ws, id: playerId, color });
    this.playerToGame.set(playerId, gameId);
    
    return true;
  }

  handleSetupWall(playerId: string, position: Position): GameState | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'setup') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    const color = player.color;
    const isOwnHalf = color === 'white' 
      ? position.row >= BOARD_SIZE / 2 
      : position.row < BOARD_SIZE / 2;
    
    if (!isOwnHalf) return null;
    
    const square = room.state.board[position.row][position.col];
    if (square.piece) return null;
    
    // Toggle wall
    if (square.isWall) {
      square.isWall = false;
      room.state.setupWallsRemaining[color]++;
    } else {
      if (room.state.setupWallsRemaining[color] <= 0) return null;
      square.isWall = true;
      room.state.setupWallsRemaining[color]--;
    }
    
    // Save game to file
    this.saveGame(room.state);
    
    return room.state;
  }
  
  handleRandomWalls(playerId: string): GameState | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'setup') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    const color = player.color;
    const remaining = room.state.setupWallsRemaining[color];
    if (remaining <= 0) return room.state;
    
    // Determine the player's half of the board
    const isWhite = color === 'white';
    const startRow = isWhite ? BOARD_SIZE / 2 : 0;
    const endRow = isWhite ? BOARD_SIZE : BOARD_SIZE / 2;
    
    // Collect valid positions (empty squares without walls or pieces)
    const validPositions: Position[] = [];
    for (let row = startRow; row < endRow; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const square = room.state.board[row][col];
        if (!square.piece && !square.isWall) {
          validPositions.push({ row, col });
        }
      }
    }
    
    // Shuffle positions
    for (let i = validPositions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [validPositions[i], validPositions[j]] = [validPositions[j], validPositions[i]];
    }
    
    // Place walls randomly
    let placed = 0;
    for (const pos of validPositions) {
      if (placed >= remaining) break;
      room.state.board[pos.row][pos.col].isWall = true;
      placed++;
    }
    
    room.state.setupWallsRemaining[color] = remaining - placed;
    
    // Save game to file
    this.saveGame(room.state);
    
    return room.state;
  }
  
  handleMazeWalls(playerId: string): GameState | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'setup') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    const color = player.color;
    
    // First clear existing walls for this player
    const isWhite = color === 'white';
    const startRow = isWhite ? BOARD_SIZE / 2 : 0;
    const endRow = isWhite ? BOARD_SIZE : BOARD_SIZE / 2;
    
    let wallCount = 0;
    for (let row = startRow; row < endRow; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (room.state.board[row][col].isWall) {
          room.state.board[row][col].isWall = false;
          wallCount++;
        }
      }
    }
    
    // Restore wall count
    const totalWalls = room.state.setupWallsRemaining[color] + wallCount;
    const halfHeight = BOARD_SIZE / 2;
    
    // Generate maze using recursive division with corridors
    const generateMazePattern = (): Position[] => {
      const positions: Position[] = [];
      const validSquares: Position[] = [];
      
      // Collect all valid positions (no pieces)
      for (let row = startRow; row < endRow; row++) {
        for (let col = 0; col < BOARD_SIZE; col++) {
          if (!room.state.board[row][col].piece) {
            validSquares.push({ row, col });
          }
        }
      }
      
      // Create maze structure with chambers and corridors
      // Divide the half into chambers using walls with passage gaps
      
      // Vertical dividers at different columns with 2-cell gaps
      const dividerCols = [3, 7, 11];
      for (const col of dividerCols) {
        if (col >= BOARD_SIZE) continue;
        // Create gap positions (2-3 squares wide)
        const gapStart = startRow + Math.floor(Math.random() * (halfHeight - 2));
        const gapSize = 2 + Math.floor(Math.random() * 2);
        
        for (let row = startRow; row < endRow; row++) {
          // Skip the gap area
          if (row >= gapStart && row < gapStart + gapSize) continue;
          if (!room.state.board[row][col].piece) {
            positions.push({ row, col });
          }
        }
      }
      
      // Horizontal dividers with gaps
      const midRow = startRow + Math.floor(halfHeight / 2);
      const horizontalRows = [midRow];
      if (halfHeight > 4) {
        horizontalRows.push(startRow + 1);
        horizontalRows.push(endRow - 2);
      }
      
      for (const row of horizontalRows) {
        if (row < startRow || row >= endRow) continue;
        // Create multiple gaps in horizontal walls
        const numGaps = 2 + Math.floor(Math.random() * 2);
        const gaps: number[] = [];
        for (let g = 0; g < numGaps; g++) {
          gaps.push(Math.floor(Math.random() * BOARD_SIZE));
        }
        
        for (let col = 0; col < BOARD_SIZE; col++) {
          // Skip gap areas (2 squares wide)
          const nearGap = gaps.some(g => Math.abs(col - g) <= 1);
          if (nearGap) continue;
          if (!room.state.board[row][col].piece) {
            positions.push({ row, col });
          }
        }
      }
      
      // Add some L-shaped and corner pieces for visual interest
      const cornerPatterns = [
        [[0, 0], [0, 1], [1, 0]], // L top-left
        [[0, 0], [0, 1], [-1, 0]], // L bottom-left
        [[0, 0], [1, 0], [1, 1]], // corner
      ];
      
      for (let i = 0; i < Math.floor(totalWalls * 0.15); i++) {
        const pattern = cornerPatterns[Math.floor(Math.random() * cornerPatterns.length)];
        const baseRow = startRow + 1 + Math.floor(Math.random() * (halfHeight - 2));
        const baseCol = 1 + Math.floor(Math.random() * (BOARD_SIZE - 2));
        
        for (const [dr, dc] of pattern) {
          const r = baseRow + dr;
          const c = baseCol + dc;
          if (r >= startRow && r < endRow && c >= 0 && c < BOARD_SIZE) {
            if (!room.state.board[r][c].piece) {
              positions.push({ row: r, col: c });
            }
          }
        }
      }
      
      return positions;
    };
    
    const allPositions = generateMazePattern();
    
    // Remove duplicates
    const uniquePositions = allPositions.filter((pos, idx) => 
      allPositions.findIndex(p => p.row === pos.row && p.col === pos.col) === idx
    );
    
    // Shuffle positions for variety
    for (let i = uniquePositions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [uniquePositions[i], uniquePositions[j]] = [uniquePositions[j], uniquePositions[i]];
    }
    
    // Place walls up to the limit
    let placed = 0;
    for (const pos of uniquePositions) {
      if (placed >= totalWalls) break;
      if (!room.state.board[pos.row][pos.col].piece && !room.state.board[pos.row][pos.col].isWall) {
        room.state.board[pos.row][pos.col].isWall = true;
        placed++;
      }
    }
    
    // If we haven't placed all walls, fill remaining randomly
    if (placed < totalWalls) {
      const remaining: Position[] = [];
      for (let row = startRow; row < endRow; row++) {
        for (let col = 0; col < BOARD_SIZE; col++) {
          if (!room.state.board[row][col].piece && !room.state.board[row][col].isWall) {
            remaining.push({ row, col });
          }
        }
      }
      
      // Shuffle remaining
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      
      for (const pos of remaining) {
        if (placed >= totalWalls) break;
        room.state.board[pos.row][pos.col].isWall = true;
        placed++;
      }
    }
    
    room.state.setupWallsRemaining[color] = totalWalls - placed;
    
    // Save game to file
    this.saveGame(room.state);
    
    return room.state;
  }

  handleLoadLayout(playerId: string, walls: Position[]): GameState | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'setup') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    const color = player.color;
    
    // Clear all existing walls for this player's half
    const isWhite = color === 'white';
    const startRow = isWhite ? BOARD_SIZE / 2 : 0;
    const endRow = isWhite ? BOARD_SIZE : BOARD_SIZE / 2;
    
    let existingWallCount = 0;
    for (let row = startRow; row < endRow; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (room.state.board[row][col].isWall) {
          room.state.board[row][col].isWall = false;
          existingWallCount++;
        }
      }
    }
    
    const totalWalls = room.state.setupWallsRemaining[color] + existingWallCount;
    
    // Place walls from the layout (only on this player's half)
    let placed = 0;
    for (const pos of walls) {
      if (placed >= totalWalls) break;
      if (pos.row >= startRow && pos.row < endRow && pos.col >= 0 && pos.col < BOARD_SIZE) {
        const square = room.state.board[pos.row][pos.col];
        if (!square.piece && !square.isWall) {
          square.isWall = true;
          placed++;
        }
      }
    }
    
    room.state.setupWallsRemaining[color] = totalWalls - placed;
    
    this.saveGame(room.state);
    return room.state;
  }

  handleReady(playerId: string): GameState | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'setup') return null;
    
    room.readyPlayers.add(playerId);
    
    // If both players ready, start the game
    if (room.readyPlayers.size >= 2) {
      room.state.phase = 'playing';
    }
    
    // Save game to file
    this.saveGame(room.state);
    
    return room.state;
  }

  handleMove(playerId: string, from: Position, to: Position, resign?: boolean, promotionPiece?: 'queen' | 'rook' | 'bishop' | 'knight'): { state: GameState; diceRoll?: { value: number; type: 'd4' | 'd6'; success: boolean }; needsPromotion?: boolean } | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'playing') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    // Handle resignation
    if (resign) {
      room.state.winner = player.color === 'white' ? 'black' : 'white';
      room.state.phase = 'finished';
      this.saveGame(room.state);
      return { state: room.state };
    }
    
    // Validate it's the player's turn
    if (room.state.currentTurn !== player.color) return null;
    
    const board = room.state.board;
    const piece = board[from.row][from.col].piece;
    if (!piece || piece.color !== player.color) return null;
    
    // Validate move
    const validMoves = this.getValidMoves(board, from);
    if (!validMoves.some(m => m.row === to.row && m.col === to.col)) return null;
    
    const targetPiece = board[to.row][to.col].piece;
    let diceRoll: { value: number; type: 'd4' | 'd6'; success: boolean } | undefined;
    
    // Clear previous dice roll for non-attack moves
    room.state.lastDiceRoll = undefined;
    
    // Pawn attack requires dice roll
    if (piece.type === 'pawn' && targetPiece) {
      const roll = Math.floor(Math.random() * 6) + 1;
      const pawnSettings = this.getAttackSettingsForColor(room.state, player.color);
      const success = this.checkAttackSuccess(pawnSettings, 'pawn');
      diceRoll = { value: roll, type: 'd6', success };
      room.state.lastDiceRoll = diceRoll;
      
      if (!success) {
        room.state.currentTurn = player.color === 'white' ? 'black' : 'white';
        this.saveGame(room.state);
        return { state: room.state, diceRoll };
      }
    }
    
    // Execute move
    board[from.row][from.col].piece = null;
    
    if (targetPiece) {
      room.state.capturedPieces[player.color].push(targetPiece);
      
      // Check for king capture (win condition)
      if (targetPiece.type === 'king') {
        room.state.winner = player.color;
        room.state.phase = 'finished';
      }
    }
    
    // Check for pawn promotion
    const isPromotion = piece.type === 'pawn' && 
      ((player.color === 'white' && to.row === 0) || (player.color === 'black' && to.row === 11));
    
    if (isPromotion && !promotionPiece) {
      // Need to ask client for promotion choice - don't execute move yet
      // Restore piece to original position
      board[from.row][from.col].piece = piece;
      return { state: room.state, needsPromotion: true };
    }
    
    // Check for castling
    let isCastling = false;
    let castlingNotation = '';
    if (piece.type === 'king' && !piece.hasMoved && Math.abs(to.col - from.col) > 1) {
      isCastling = true;
      if (to.col === 11) {
        // Kingside castling - move rook from col 9 to col 10
        const rook = board[from.row][9].piece;
        board[from.row][9].piece = null;
        board[from.row][10].piece = { ...rook!, hasMoved: true };
        castlingNotation = 'O-O';
      } else if (to.col === 0) {
        // Queenside castling - move rook from col 2 to col 1
        const rook = board[from.row][2].piece;
        board[from.row][2].piece = null;
        board[from.row][1].piece = { ...rook!, hasMoved: true };
        castlingNotation = 'O-O-O';
      }
    }
    
    // Place piece (possibly promoted)
    const finalPiece = isPromotion && promotionPiece 
      ? { type: promotionPiece, color: piece.color, hasMoved: true }
      : { ...piece, hasMoved: true };
    board[to.row][to.col].piece = finalPiece;
    
    const move: Move = {
      from,
      to,
      piece,
      captured: targetPiece || undefined,
      diceRoll: diceRoll?.value,
      diceRequired: piece.type === 'pawn' && targetPiece ? 6 : undefined,
      success: diceRoll ? diceRoll.success : undefined,
      notation: isCastling ? castlingNotation : this.getMoveNotation(piece, from, to, targetPiece || undefined, diceRoll?.value, promotionPiece),
      promotionPiece: promotionPiece,
    };
    room.state.moveHistory.push(move);
    
    // Swap turns
    room.state.currentTurn = player.color === 'white' ? 'black' : 'white';
    
    // Check for checkmate
    if (this.isCheckmate(board, room.state.currentTurn)) {
      room.state.winner = player.color;
      room.state.phase = 'finished';
    }
    
    // Save game to file
    this.saveGame(room.state);
    
    return { state: room.state, diceRoll };
  }

  handleArrowAttack(playerId: string, from: Position, to: Position): { state: GameState; diceRoll: { value: number; type: '2d6'; success: boolean } } | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'playing') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    if (room.state.currentTurn !== player.color) return null;
    
    const board = room.state.board;
    const piece = board[from.row][from.col].piece;
    if (piece && piece.id) {
      const pieceUsed = room.state.specialAttackCounts?.[piece.id] ?? 0;
      const maxB = room.state.maxBishopAttacks ?? 10;
      if (pieceUsed >= maxB) return null;
    }
    if (!piece || piece.type !== 'bishop' || piece.color !== player.color) return null;
    
    // Verify straight line (any direction: horizontal, vertical, or diagonal)
    const rowDiff = to.row - from.row;
    const colDiff = to.col - from.col;
    
    // Must be horizontal, vertical, or diagonal
    const isHorizontal = rowDiff === 0 && colDiff !== 0;
    const isVertical = colDiff === 0 && rowDiff !== 0;
    const isDiagonal = Math.abs(rowDiff) === Math.abs(colDiff) && rowDiff !== 0;
    
    if (!isHorizontal && !isVertical && !isDiagonal) return null;
    
    const distance = Math.max(Math.abs(rowDiff), Math.abs(colDiff));
    
    // Check path is clear (arrows travel through squares)
    const rowDir = rowDiff === 0 ? 0 : (rowDiff > 0 ? 1 : -1);
    const colDir = colDiff === 0 ? 0 : (colDiff > 0 ? 1 : -1);
    
    for (let i = 1; i < distance; i++) {
      const checkRow = from.row + i * rowDir;
      const checkCol = from.col + i * colDir;
      if (board[checkRow][checkCol].isWall || board[checkRow][checkCol].piece) {
        return null; // Path is blocked
      }
    }
    
    const targetPiece = board[to.row][to.col].piece;
    if (!targetPiece || targetPiece.color === player.color) return null;
    if (targetPiece.type === 'knight' || targetPiece.type === 'rook') return null;
    
    // Roll 2d6 for arrow - need to roll >= threshold to hit
    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;
    const roll = die1 + die2;
    const arrowSettings = this.getAttackSettingsForColor(room.state, player.color);
    const success = this.checkAttackSuccess(arrowSettings, 'bishop', distance);
    
    const diceRoll = { value: roll, type: '2d6' as const, success };
    room.state.lastDiceRoll = diceRoll;
    
    const move: Move = {
      from,
      to,
      piece,
      captured: success ? targetPiece : undefined,
      isArrowAttack: true,
      diceRoll: roll,
      diceRequired: 12,
      success,
      notation: this.getMoveNotation(piece, from, to, success ? targetPiece : undefined, roll, true),
    };
    room.state.moveHistory.push(move);
    
    if (!room.state.specialAttackCounts) {
      room.state.specialAttackCounts = {};
    }
    if (piece.id) {
      room.state.specialAttackCounts[piece.id] = (room.state.specialAttackCounts[piece.id] ?? 0) + 1;
    }
    this.recordAttackStat(gameId!, 'bishopArrow');
    
    if (success) {
      room.state.capturedPieces[player.color].push(targetPiece);
      board[to.row][to.col].piece = null;
      
      if (targetPiece.type === 'king') {
        room.state.winner = player.color;
        room.state.phase = 'finished';
      }
    }
    
    // Swap turns
    room.state.currentTurn = player.color === 'white' ? 'black' : 'white';
    
    // Check for checkmate after attack
    if (room.state.phase !== 'finished' && this.isCheckmate(board, room.state.currentTurn)) {
      room.state.winner = player.color;
      room.state.phase = 'finished';
    }
    
    // Save game to file
    this.saveGame(room.state);
    
    return { state: room.state, diceRoll };
  }

  handleAxeAttack(playerId: string, from: Position, to: Position): { state: GameState; diceRoll: { value: number; type: 'd6'; success: boolean } } | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'playing') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    if (room.state.currentTurn !== player.color) return null;
    
    const board = room.state.board;
    const piece = board[from.row][from.col].piece;
    if (!piece || piece.type !== 'knight' || piece.color !== player.color) return null;
    
    // Validate target is 1 square away (adjacent)
    const rowDiff = Math.abs(to.row - from.row);
    const colDiff = Math.abs(to.col - from.col);
    if (rowDiff > 1 || colDiff > 1 || (rowDiff === 0 && colDiff === 0)) return null;
    
    const targetPiece = board[to.row][to.col].piece;
    if (!targetPiece || targetPiece.color === player.color) return null;
    
    // Rooks are immune to knight axe attacks
    if (targetPiece.type === 'rook') return null;
    
    // Roll 1d6 for axe - need to roll >= threshold to hit
    const roll = Math.floor(Math.random() * 6) + 1;
    const axeSettings = this.getAttackSettingsForColor(room.state, player.color);
    const success = this.checkAttackSuccess(axeSettings, 'knight');
    
    const diceRoll = { value: roll, type: 'd6' as const, success };
    room.state.lastDiceRoll = diceRoll;
    
    const move: Move = {
      from,
      to,
      piece,
      captured: success ? targetPiece : undefined,
      isArrowAttack: false,
      diceRoll: roll,
      diceRequired: 4,
      success,
      notation: `N${String.fromCharCode(97 + from.col)}${12 - from.row}⚔${String.fromCharCode(97 + to.col)}${12 - to.row}[d6:${roll}]`,
    };
    room.state.moveHistory.push(move);
    
    if (success) {
      room.state.capturedPieces[player.color].push(targetPiece);
      board[to.row][to.col].piece = null;
      
      if (targetPiece.type === 'king') {
        room.state.winner = player.color;
        room.state.phase = 'finished';
      }
    }
    
    // Swap turns
    room.state.currentTurn = player.color === 'white' ? 'black' : 'white';
    
    // Check for checkmate after attack
    if (room.state.phase !== 'finished' && this.isCheckmate(board, room.state.currentTurn)) {
      room.state.winner = player.color;
      room.state.phase = 'finished';
    }
    
    // Save game to file
    this.saveGame(room.state);
    
    return { state: room.state, diceRoll };
  }

  handleBombAttack(playerId: string, from: Position, to: Position): { state: GameState; diceRoll: { value: number; type: 'd10'; success: boolean } } | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'playing') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    if (room.state.currentTurn !== player.color) return null;
    
    const board = room.state.board;
    const piece = board[from.row][from.col].piece;
    if (!piece || piece.type !== 'rook' || piece.color !== player.color) return null;
    
    if (piece.id) {
      const rookUsed = room.state.specialAttackCounts?.[piece.id] ?? 0;
      const maxR = room.state.maxRookAttacks ?? 10;
      if (rookUsed >= maxR) return null;
    }
    
    // Validate target is adjacent (1 square away)
    const rowDiff = Math.abs(to.row - from.row);
    const colDiff = Math.abs(to.col - from.col);
    if (rowDiff > 1 || colDiff > 1 || (rowDiff === 0 && colDiff === 0)) return null;
    
    // Validate target is a wall
    if (!board[to.row][to.col].isWall) return null;
    
    // Roll 1d10 for bomb attack - configurable success rate
    const roll = Math.floor(Math.random() * 10) + 1;
    const bombHandlerSettings = this.getAttackSettingsForColor(room.state, player.color);
    const success = this.checkAttackSuccess(bombHandlerSettings, 'bomb');
    
    const diceRoll = { value: roll, type: 'd10' as const, success };
    room.state.lastDiceRoll = diceRoll;
    
    const move: Move = {
      from,
      to,
      piece,
      captured: undefined,
      isArrowAttack: false,
      diceRoll: roll,
      diceRequired: 10,
      success,
      notation: `R${String.fromCharCode(97 + from.col)}${12 - from.row}💣${String.fromCharCode(97 + to.col)}${12 - to.row}[d10:${roll}${success ? '✓' : '✗'}]`,
    };
    room.state.moveHistory.push(move);
    
    if (!room.state.specialAttackCounts) {
      room.state.specialAttackCounts = {};
    }
    if (piece.id) {
      room.state.specialAttackCounts[piece.id] = (room.state.specialAttackCounts[piece.id] ?? 0) + 1;
    }
    this.recordAttackStat(gameId!, 'rookBomb');
    
    if (success) {
      board[to.row][to.col].isWall = false;
    }
    
    // Swap turns
    room.state.currentTurn = player.color === 'white' ? 'black' : 'white';
    
    // Save game to file
    this.saveGame(room.state);
    
    return { state: room.state, diceRoll };
  }
  
  handleWallAttack(playerId: string, from: Position, to: Position): { state: GameState; diceRoll: { value: number; type: 'd10'; success: boolean } } | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'playing') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    if (room.state.currentTurn !== player.color) return null;
    
    const board = room.state.board;
    const piece = board[from.row][from.col].piece;
    if (!piece || piece.type !== 'rook' || piece.color !== player.color) return null;
    
    if (piece.id) {
      const wallUsed = room.state.specialAttackCounts?.[piece.id] ?? 0;
      const wMaxR = room.state.maxRookAttacks ?? 10;
      if (wallUsed >= wMaxR) return null;
    }
    
    // Validate target is adjacent (1 square away)
    const rowDiff = Math.abs(to.row - from.row);
    const colDiff = Math.abs(to.col - from.col);
    if (rowDiff > 1 || colDiff > 1 || (rowDiff === 0 && colDiff === 0)) return null;
    
    // Validate target is an empty square (no piece, no wall)
    if (board[to.row][to.col].piece || board[to.row][to.col].isWall) return null;
    
    // Roll 1d10 for wall build - configurable success rate (default 50%)
    const roll = Math.floor(Math.random() * 10) + 1;
    const wallSettings = this.getAttackSettingsForColor(room.state, player.color);
    const success = this.checkAttackSuccess(wallSettings, 'wallBuild');
    
    const diceRoll = { value: roll, type: 'd10' as const, success };
    room.state.lastDiceRoll = diceRoll;
    
    const move: Move = {
      from,
      to,
      piece,
      captured: undefined,
      isArrowAttack: false,
      isWallBuild: true,
      diceRoll: roll,
      diceRequired: 10,
      success,
      notation: `R${String.fromCharCode(97 + from.col)}${12 - from.row}🧱${String.fromCharCode(97 + to.col)}${12 - to.row}[d10:${roll}${success ? '✓' : '✗'}]`,
    };
    room.state.moveHistory.push(move);
    
    if (!room.state.specialAttackCounts) {
      room.state.specialAttackCounts = {};
    }
    if (piece.id) {
      room.state.specialAttackCounts[piece.id] = (room.state.specialAttackCounts[piece.id] ?? 0) + 1;
    }
    this.recordAttackStat(gameId!, 'rookWallBuild');
    
    if (success) {
      board[to.row][to.col].isWall = true;
    }
    
    // Swap turns
    room.state.currentTurn = player.color === 'white' ? 'black' : 'white';
    
    // Save game to file
    this.saveGame(room.state);
    
    return { state: room.state, diceRoll };
  }

  getRoom(gameId: string): GameRoom | undefined {
    return this.games.get(gameId);
  }

  getGameIdForPlayer(playerId: string): string | undefined {
    return this.playerToGame.get(playerId);
  }

  removePlayer(playerId: string): void {
    const gameId = this.playerToGame.get(playerId);
    if (gameId) {
      const room = this.games.get(gameId);
      if (room) {
        room.players.delete(playerId);
        if (room.players.size === 0) {
          this.games.delete(gameId);
        }
      }
      this.playerToGame.delete(playerId);
    }
  }

  isAITurn(gameId: string): boolean {
    const room = this.games.get(gameId);
    if (!room) return false;
    const state = room.state;
    if (state.phase !== 'playing') return false;
    
    // Check if current turn's player has handed off to AI
    const currentColor = state.currentTurn;
    if (state.aiControlled?.[currentColor]) return true;
    
    // Legacy check for PvC games
    return state.gameMode === 'pvc' && state.currentTurn === state.aiColor;
  }
  
  handoffToAI(playerId: string): GameState | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'playing') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    // Initialize aiControlled if not present
    if (!room.state.aiControlled) {
      room.state.aiControlled = { white: false, black: false };
    }
    
    room.state.aiControlled[player.color] = true;
    this.saveGame(room.state);
    return room.state;
  }
  
  takeControl(playerId: string): GameState | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;
    
    const room = this.games.get(gameId);
    if (!room || room.state.phase !== 'playing') return null;
    
    const player = room.players.get(playerId);
    if (!player) return null;
    
    // Initialize aiControlled if not present
    if (!room.state.aiControlled) {
      room.state.aiControlled = { white: false, black: false };
    }
    
    room.state.aiControlled[player.color] = false;
    this.saveGame(room.state);
    return room.state;
  }

  private isSquareAttackedBy(board: Board, pos: Position, byColor: PlayerColor): boolean {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = board[row][col].piece;
        if (piece && piece.color === byColor) {
          const attacks = this.getRawAttacks(board, { row, col }, piece);
          if (attacks.some(a => a.row === pos.row && a.col === pos.col)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private countBishopFiringLanes(board: Board, pos: Position, color: PlayerColor): number {
    const directions = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
    let lanes = 0;
    for (const [dr, dc] of directions) {
      let dist = 0;
      let r = pos.row + dr, c = pos.col + dc;
      while (this.isValidPosition(r, c) && !board[r][c].isWall) {
        dist++;
        if (board[r][c].piece) {
          if (board[r][c].piece!.color !== color && dist >= 2) lanes++;
          break;
        }
        r += dr;
        c += dc;
      }
      if (dist >= 2 && !(this.isValidPosition(r, c) && board[r][c].piece)) lanes++;
    }
    return lanes;
  }

  private evaluateBoard(board: Board, forColor: PlayerColor): number {
    const enemyColor = forColor === 'white' ? 'black' : 'white';
    
    let totalPieces = 0;
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (board[row][col].piece) totalPieces++;
      }
    }
    const isEndgame = totalPieces <= 16;
    
    const pieceValues: Record<PieceType, number> = {
      pawn: 100, knight: 320, bishop: isEndgame ? 400 : 350, rook: 500, queen: 900, king: 20000
    };
    
    let score = 0;
    
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = board[row][col].piece;
        if (!piece) continue;
        
        const isOwn = piece.color === forColor;
        const multiplier = isOwn ? 1 : -1;
        
        score += pieceValues[piece.type] * multiplier;
        
        const centerDistRow = Math.abs(row - BOARD_SIZE / 2 + 0.5);
        const centerDistCol = Math.abs(col - BOARD_SIZE / 2 + 0.5);
        const centerBonus = (BOARD_SIZE - centerDistRow - centerDistCol) * 0.5;
        score += centerBonus * multiplier;
        
        if (piece.type === 'pawn') {
          const advancement = piece.color === 'white' ? (BOARD_SIZE - 1 - row) : row;
          score += advancement * 3 * multiplier;
        }
        
        if (piece.type === 'bishop') {
          const pos = { row, col };
          const lanes = this.countBishopFiringLanes(board, pos, piece.color);
          score += lanes * 5 * multiplier;
          
          const opponentColor = piece.color === forColor ? enemyColor : forColor;
          const isSafe = !this.isSquareAttackedBy(board, pos, opponentColor);
          if (isSafe) {
            score += (isEndgame ? 25 : 12) * multiplier;
          } else {
            score -= (isEndgame ? 20 : 10) * multiplier;
          }
        }
      }
    }
    
    return score;
  }

  private generateMovesForColor(board: Board, color: PlayerColor): Array<{ from: Position; to: Position }> {
    const moves: Array<{ from: Position; to: Position }> = [];
    
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = board[row][col].piece;
        if (piece && piece.color === color) {
          const from = { row, col };
          const validMoves = this.getValidMoves(board, from);
          for (const to of validMoves) {
            moves.push({ from, to });
          }
        }
      }
    }
    
    return moves;
  }

  private applyMoveOnBoard(board: Board, from: Position, to: Position): Board {
    const newBoard: Board = board.map(row => row.map(cell => ({
      ...cell,
      piece: cell.piece ? { ...cell.piece } : null
    })));
    
    const piece = newBoard[from.row][from.col].piece;
    if (piece) {
      if (piece.type === 'pawn') {
        const promotionRow = piece.color === 'white' ? 0 : BOARD_SIZE - 1;
        if (to.row === promotionRow) {
          newBoard[to.row][to.col].piece = { type: 'queen', color: piece.color };
        } else {
          newBoard[to.row][to.col].piece = piece;
        }
      } else {
        newBoard[to.row][to.col].piece = piece;
      }
    }
    newBoard[from.row][from.col].piece = null;
    
    return newBoard;
  }

  private minimax(board: Board, depth: number, alpha: number, beta: number, maximizingColor: PlayerColor, currentColor: PlayerColor): number {
    if (depth === 0) {
      return this.evaluateBoard(board, maximizingColor);
    }
    
    const isInCheck = this.isInCheck(board, currentColor);
    const moves = this.generateMovesForColor(board, currentColor);
    
    const legalMoves = moves.filter(m => {
      const newBoard = this.applyMoveOnBoard(board, m.from, m.to);
      return !this.isInCheck(newBoard, currentColor);
    });
    
    if (legalMoves.length === 0) {
      if (isInCheck) {
        return currentColor === maximizingColor ? -99999 + (4 - depth) : 99999 - (4 - depth);
      }
      return 0;
    }
    
    // Move ordering: captures first for better pruning
    legalMoves.sort((a, b) => {
      const captA = board[a.to.row][a.to.col].piece ? 1 : 0;
      const captB = board[b.to.row][b.to.col].piece ? 1 : 0;
      return captB - captA;
    });
    
    const nextColor = currentColor === 'white' ? 'black' : 'white';
    
    if (currentColor === maximizingColor) {
      let maxEval = -Infinity;
      for (const move of legalMoves) {
        const newBoard = this.applyMoveOnBoard(board, move.from, move.to);
        const evalScore = this.minimax(newBoard, depth - 1, alpha, beta, maximizingColor, nextColor);
        maxEval = Math.max(maxEval, evalScore);
        alpha = Math.max(alpha, evalScore);
        if (beta <= alpha) break;
      }
      return maxEval;
    } else {
      let minEval = Infinity;
      for (const move of legalMoves) {
        const newBoard = this.applyMoveOnBoard(board, move.from, move.to);
        const evalScore = this.minimax(newBoard, depth - 1, alpha, beta, maximizingColor, nextColor);
        minEval = Math.min(minEval, evalScore);
        beta = Math.min(beta, evalScore);
        if (beta <= alpha) break;
      }
      return minEval;
    }
  }

  async makeAIMove(gameId: string, onPlyUpdate?: (ply: number, maxPly: number) => void): Promise<{ state: GameState; diceRoll?: { value: number; type: 'd4' | 'd6' | 'd10'; success: boolean } } | null> {
    const room = this.games.get(gameId);
    if (!room || !this.isAITurn(gameId)) return null;

    if (policyIdOf(room.state) !== 'legacy') {
      const kind = this.applyPolicyAction(gameId);
      if (!kind) return null;
      this.saveGame(room.state);
      const dice = room.state.lastDiceRoll;
      const diceType = dice && dice.type !== '2d6' ? dice.type : undefined;
      return {
        state: room.state,
        diceRoll: dice && diceType ? { value: dice.value, type: diceType, success: dice.success } : undefined,
      };
    }

    const state = room.state;
    // Use current turn color when that player is AI-controlled, fallback to legacy aiColor
    const aiColor = state.aiControlled?.[state.currentTurn] ? state.currentTurn : state.aiColor!;
    const board = state.board;

    // Check if AI is currently in check
    const inCheck = this.isInCheck(board, aiColor);

    // Collect all possible moves for AI
    interface AIMove { from: Position; to: Position; score: number; isArrow?: boolean; isAxe?: boolean; isBomb?: boolean; escapesCheck?: boolean }
    const possibleMoves: AIMove[] = [];

    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = board[row][col].piece;
        if (piece && piece.color === aiColor) {
          const from = { row, col };
          const moves = this.getValidMoves(board, from);
          
          for (const to of moves) {
            const targetPiece = board[to.row][to.col].piece;
            let score = Math.random() * 0.5; // Small random factor
            
            // Simulate the move to check if it escapes check
            const newBoard: Board = JSON.parse(JSON.stringify(board));
            newBoard[to.row][to.col].piece = piece;
            newBoard[from.row][from.col].piece = null;
            const escapesCheck = !this.isInCheck(newBoard, aiColor);
            
            // If in check, heavily prioritize moves that escape check
            if (inCheck) {
              if (escapesCheck) {
                score += 1000; // Massive bonus for escaping check
              } else {
                score -= 2000; // Heavily penalize moves that don't escape check
              }
            }
            
            // Prioritize captures (higher value pieces = higher score)
            if (targetPiece) {
              const values: Record<PieceType, number> = {
                pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100
              };
              score += values[targetPiece.type] * 10;
              
              // Pawns should always attack adjacent enemies - give high priority
              if (piece.type === 'pawn') {
                score += 500; // High priority for pawn attacks
              }
            }
            
            // Bonus for advancing pawns toward promotion
            if (piece.type === 'pawn') {
              const promotionRow = aiColor === 'white' ? 0 : BOARD_SIZE - 1;
              const distToPromotion = Math.abs(to.row - promotionRow);
              const advancement = BOARD_SIZE - 1 - distToPromotion;
              
              // Count total pieces to detect endgame
              let totalPieces = 0;
              for (let r = 0; r < BOARD_SIZE; r++) {
                for (let c = 0; c < BOARD_SIZE; c++) {
                  if (board[r][c].piece) totalPieces++;
                }
              }
              const isEndgame = totalPieces <= 16 || state.moveHistory.length > 80;
              
              if (isEndgame) {
                score += advancement * 8;
                if (distToPromotion === 0) {
                  score += 800; // About to promote - extremely high priority
                } else if (distToPromotion <= 2) {
                  score += 200; // Very close to promotion
                }
              } else {
                score += advancement * 0.5;
              }
            }
            
            // Bishop safety and development
            if (piece.type === 'bishop') {
              const enemyColorForBishop = aiColor === 'white' ? 'black' : 'white';
              
              const destThreatened = this.isSquareAttackedBy(newBoard, to, enemyColorForBishop);
              
              // Penalize threatened destinations, but allow good captures
              if (destThreatened && !targetPiece) {
                score -= 80; // Penalty for moving to danger without gaining material
              } else if (destThreatened && targetPiece) {
                const captureValue = ({ pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 } as Record<PieceType, number>)[targetPiece.type];
                if (captureValue < 3) score -= 40; // Not worth trading bishop for pawn
              }
              
              // Bonus for safe squares with good firing lanes
              if (!destThreatened) {
                const lanes = this.countBishopFiringLanes(newBoard, to, aiColor);
                score += lanes * 6;
                if (lanes >= 4) score += 15;
              }
              
              // Early development
              if (state.moveHistory.length < 20) {
                const startRow = aiColor === 'white' ? BOARD_SIZE - 1 : 0;
                if (from.row === startRow) {
                  score += 50;
                  const centerCol = BOARD_SIZE / 2;
                  const towardCenter = Math.abs(to.col - centerCol) < Math.abs(from.col - centerCol);
                  if (towardCenter) score += 20;
                }
              }
              
              // Endgame bishop preservation bonus
              let totalPieces = 0;
              for (let r = 0; r < BOARD_SIZE; r++) {
                for (let c = 0; c < BOARD_SIZE; c++) {
                  if (board[r][c].piece) totalPieces++;
                }
              }
              if (totalPieces <= 16 || state.moveHistory.length > 80) {
                if (!destThreatened) score += 25;
              }
            }
            
            // Bonus for central control
            const centerDist = Math.abs(to.row - BOARD_SIZE / 2) + Math.abs(to.col - BOARD_SIZE / 2);
            score += (BOARD_SIZE - centerDist) * 0.05;
            
            // A* pathfinding: bonus for moves that get closer to enemy king
            const enemyColor = aiColor === 'white' ? 'black' : 'white';
            const enemyKingPos = findKingPosition(board, enemyColor);
            if (enemyKingPos && !targetPiece) {
              // For non-capture moves, prefer moves that reduce path distance to enemy king
              const currentPathDist = aStarPathfind(board, from, enemyKingPos);
              
              // Simulate moving the piece and check new path distance
              const tempBoard: Board = JSON.parse(JSON.stringify(board));
              tempBoard[to.row][to.col].piece = piece;
              tempBoard[from.row][from.col].piece = null;
              const newPathDist = aStarPathfind(tempBoard, to, enemyKingPos);
              
              if (newPathDist < currentPathDist && newPathDist !== Infinity) {
                // Bonus for getting closer to enemy king
                const improvement = currentPathDist - newPathDist;
                score += improvement * 2;
                
                // Extra bonus for pieces that are approaching attack range
                if (newPathDist <= 4) {
                  score += (5 - newPathDist) * 3;
                }
              }
              
              // Penalty for moves that make path worse or impossible
              if (newPathDist > currentPathDist && currentPathDist !== Infinity) {
                score -= 1;
              }
              
              // Rook blockade strategy: when path is blocked, move rooks toward walls to bomb them
              if (piece.type === 'rook' && currentPathDist === Infinity) {
                // Find nearest wall in the middle zone to move toward
                let nearestWallDist = Infinity;
                const midRowMin = Math.floor(BOARD_SIZE * 0.33);
                const midRowMax = Math.floor(BOARD_SIZE * 0.67);
                for (let wr = 0; wr < BOARD_SIZE; wr++) {
                  for (let wc = 0; wc < BOARD_SIZE; wc++) {
                    if (board[wr][wc].isWall) {
                      const dist = Math.abs(to.row - wr) + Math.abs(to.col - wc);
                      // Prefer walls in the middle zone
                      const midBonus = (wr >= midRowMin && wr <= midRowMax) ? -2 : 0;
                      if (dist + midBonus < nearestWallDist) {
                        nearestWallDist = dist + midBonus;
                      }
                    }
                  }
                }
                if (nearestWallDist <= 2) {
                  score += 80; // Close to a wall - ready to bomb next turn
                } else if (nearestWallDist < Infinity) {
                  const fromNearestWall = (() => {
                    let best = Infinity;
                    for (let wr = 0; wr < BOARD_SIZE; wr++) {
                      for (let wc = 0; wc < BOARD_SIZE; wc++) {
                        if (board[wr][wc].isWall) {
                          const d = Math.abs(from.row - wr) + Math.abs(from.col - wc);
                          if (d < best) best = d;
                        }
                      }
                    }
                    return best;
                  })();
                  if (nearestWallDist < fromNearestWall) {
                    score += 40; // Moving closer to walls for future bombing
                  }
                }
              }
            }
            
            possibleMoves.push({ from, to, score, escapesCheck });
          }
          
          if (piece.type === 'bishop' && !inCheck) {
            const pvcBPieceUsed = piece.id ? (state.specialAttackCounts?.[piece.id] ?? 0) : 0;
            const pvcBMax = state.maxBishopAttacks ?? 10;
            if (pvcBPieceUsed < pvcBMax) {
            const recentColorMoves = state.moveHistory.slice(-30).filter(m => m.piece.color === aiColor);
            let consecutiveBishopChases = 0;
            let movesAfterChase = 0;
            let chaseDetected = false;
            for (let i = recentColorMoves.length - 1; i >= 0; i--) {
              const m = recentColorMoves[i];
              if (!chaseDetected) {
                if (m.isArrowAttack && m.piece.type === 'bishop' && !m.captured) {
                  consecutiveBishopChases++;
                } else if (consecutiveBishopChases >= 5) {
                  chaseDetected = true;
                  movesAfterChase = recentColorMoves.length - 1 - i;
                } else {
                  break;
                }
              }
            }
            if (consecutiveBishopChases >= 5 && !chaseDetected) {
              chaseDetected = true;
              movesAfterChase = 0;
            }
            const bishopChaseFatigue = chaseDetected && movesAfterChase < 6;

            const arrowTargets = this.getArrowTargets(board, from, aiColor);
            for (const to of arrowTargets) {
              const targetPiece = board[to.row][to.col].piece;
              if (targetPiece) {
                const values: Record<PieceType, number> = {
                  pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100
                };
                let score = values[targetPiece.type] * 15 + 600 + Math.random() * 0.5;
                if (targetPiece.type === 'king') score += 500;
                if (targetPiece.type === 'bishop') {
                  if (bishopChaseFatigue) {
                    score -= 700;
                  } else {
                    score += 300;
                  }
                }
                possibleMoves.push({ from, to, score, isArrow: true });
              }
            }
            }
          }
          
          // Add axe attacks for knights - high priority ranged attack
          if (piece.type === 'knight' && !inCheck) {
            const axeTargets = this.getAxeTargets(board, from, aiColor);
            for (const to of axeTargets) {
              const targetPiece = board[to.row][to.col].piece;
              if (targetPiece) {
                const values: Record<PieceType, number> = {
                  pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100
                };
                // Very high priority for axe attacks
                const score = values[targetPiece.type] * 12 + 550 + Math.random() * 0.5;
                possibleMoves.push({ from, to, score, isAxe: true });
              }
            }
          }
          
          if (piece.type === 'rook' && !inCheck) {
            const pvcRPieceUsed = piece.id ? (state.specialAttackCounts?.[piece.id] ?? 0) : 0;
            const pvcRMax = state.maxRookAttacks ?? 10;
            if (pvcRPieceUsed < pvcRMax) {
            const bombTargets = this.getBombTargets(board, from);
            const enemyColor = aiColor === 'white' ? 'black' : 'white';
            const enemyKingPos = findKingPosition(board, enemyColor);
            
            // Count total walls to determine if board is heavily walled
            let totalWalls = 0;
            for (let r = 0; r < BOARD_SIZE; r++) {
              for (let c = 0; c < BOARD_SIZE; c++) {
                if (board[r][c].isWall) totalWalls++;
              }
            }
            const isHeavilyWalled = totalWalls > 15;
            
            // Count how many friendly pieces have blocked paths to enemy king
            let blockedPieces = 0;
            let totalFriendlyPieces = 0;
            if (enemyKingPos) {
              for (let r = 0; r < BOARD_SIZE; r++) {
                for (let c = 0; c < BOARD_SIZE; c++) {
                  const p = board[r][c].piece;
                  if (p && p.color === aiColor && p.type !== 'king') {
                    totalFriendlyPieces++;
                    if (aStarPathfind(board, { row: r, col: c }, enemyKingPos) === Infinity) {
                      blockedPieces++;
                    }
                  }
                }
              }
            }
            
            // Determine if there's a full blockade (most/all pieces blocked)
            const blockadeRatio = totalFriendlyPieces > 0 ? blockedPieces / totalFriendlyPieces : 0;
            const isFullBlockade = blockadeRatio >= 0.6;
            
            // Check if this rook itself has no path to enemy king
            const rookPathDist = enemyKingPos ? aStarPathfind(board, from, enemyKingPos) : Infinity;
            const rookIsBlocked = rookPathDist === Infinity;
            
            // Identify walls forming a dividing barrier between board halves
            // A wall in the middle rows (rows 4-7 on a 12x12 board) is more likely part of a blockade
            const midRowMin = Math.floor(BOARD_SIZE * 0.33);
            const midRowMax = Math.floor(BOARD_SIZE * 0.67);
            
            for (const to of bombTargets) {
              let score = 350 + Math.random() * 0.5;
              if (isHeavilyWalled) score += 150;
              if (blockedPieces >= 3) score += 200;
              
              // Full blockade: make bomb attacks top priority over regular moves
              if (isFullBlockade) {
                score += 400;
                // Extra priority if the wall target is in the middle zone (part of barrier)
                if (to.row >= midRowMin && to.row <= midRowMax) {
                  score += 200;
                }
              }
              
              // Blocked rook should heavily prioritize bombing to free itself
              if (rookIsBlocked) {
                score += 250;
              }
              
              // Use A* to determine if bombing this wall opens up a path
              if (enemyKingPos) {
                const currentPathDist = aStarPathfind(board, from, enemyKingPos);
                
                // Simulate removing the wall
                const tempBoard: Board = JSON.parse(JSON.stringify(board));
                tempBoard[to.row][to.col].isWall = false;
                const newPathDist = aStarPathfind(tempBoard, from, enemyKingPos);
                
                // HUGE bonus if bombing opens a previously blocked path
                if (currentPathDist === Infinity && newPathDist !== Infinity) {
                  score += 600; // Critical: opens a blocked path for this rook
                } else if (newPathDist < currentPathDist) {
                  score += (currentPathDist - newPathDist) * 30;
                }
                
                // Check how many friendly pieces this bomb would help
                let piecesHelped = 0;
                for (let r = 0; r < BOARD_SIZE; r++) {
                  for (let c = 0; c < BOARD_SIZE; c++) {
                    const otherPiece = board[r][c].piece;
                    if (otherPiece && otherPiece.color === aiColor && (r !== from.row || c !== from.col)) {
                      const otherFrom = { row: r, col: c };
                      const otherCurrentDist = aStarPathfind(board, otherFrom, enemyKingPos);
                      const otherNewDist = aStarPathfind(tempBoard, otherFrom, enemyKingPos);
                      
                      if (otherCurrentDist === Infinity && otherNewDist !== Infinity) {
                        score += 200; // Opens path for another blocked piece
                        piecesHelped++;
                      } else if (otherNewDist < otherCurrentDist - 2) {
                        score += 50; // Significantly helps another piece
                        piecesHelped++;
                      }
                    }
                  }
                }
                
                // Bonus for bombs that help multiple pieces (bottleneck walls)
                if (piecesHelped >= 3) {
                  score += 150;
                }
                if (piecesHelped >= 5) {
                  score += 200; // Critical bottleneck - breaking this frees many pieces
                }
                
                // Prefer bombing walls that are connected to other walls (part of wall lines)
                let adjacentWalls = 0;
                for (let dr = -1; dr <= 1; dr++) {
                  for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = to.row + dr;
                    const nc = to.col + dc;
                    if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc].isWall) {
                      adjacentWalls++;
                    }
                  }
                }
                // Walls that are endpoints of wall lines (1-2 adjacent walls) are better bomb targets
                // than walls deep inside a wall cluster (many adjacent walls)
                if (adjacentWalls >= 1 && adjacentWalls <= 3) {
                  score += 80; // Good target: edge/end of a wall line
                }
              }
              
              possibleMoves.push({ from, to, score, isBomb: true });
            }
            }
          }
        }
      }
    }

    if (possibleMoves.length === 0) {
      return null;
    }

    // If in check, only consider moves that escape check
    if (inCheck) {
      const checkEscapingMoves = possibleMoves.filter(m => m.escapesCheck);
      if (checkEscapingMoves.length > 0) {
        possibleMoves.splice(0, possibleMoves.length, ...checkEscapingMoves);
      }
    }

    const aiDepth = state.aiDepth ?? 0;
    
    if (aiDepth > 0) {
      const regularMoves = possibleMoves.filter(m => !m.isArrow && !m.isAxe && !m.isBomb);
      const specialMoves = possibleMoves.filter(m => m.isArrow || m.isAxe || m.isBomb);
      
      const enemyColor = aiColor === 'white' ? 'black' : 'white';
      
      for (let currentPly = 1; currentPly <= aiDepth; currentPly++) {
        state.aiThinkingPly = currentPly;
        state.aiThinkingMaxPly = aiDepth;
        if (onPlyUpdate) {
          onPlyUpdate(currentPly, aiDepth);
          await new Promise(resolve => setImmediate(resolve));
        }
        
        for (const move of regularMoves) {
          const newBoard = this.applyMoveOnBoard(board, move.from, move.to);
          if (this.isInCheck(newBoard, aiColor)) {
            move.score = -99999;
            continue;
          }
          const minimaxScore = this.minimax(newBoard, currentPly, -Infinity, Infinity, aiColor, enemyColor);
          move.score = minimaxScore;
        }
      }
      
      state.aiThinkingPly = undefined;
      state.aiThinkingMaxPly = undefined;
      regularMoves.sort((a, b) => b.score - a.score);
      specialMoves.sort((a, b) => b.score - a.score);
      
      let selectedMove: AIMove;
      const bestRegular = regularMoves[0];
      const bestSpecial = specialMoves[0];
      
      if (bestSpecial && (!bestRegular || bestSpecial.score > 800)) {
        // Special attacks with very high heuristic scores (captures, check escapes) take priority
        selectedMove = bestSpecial;
      } else if (bestRegular) {
        selectedMove = bestRegular;
      } else {
        selectedMove = bestSpecial || possibleMoves[0];
      }
      
      if (selectedMove.isArrow) {
        return this.executeAIArrowAttack(gameId, selectedMove.from, selectedMove.to);
      } else if (selectedMove.isAxe) {
        return this.executeAIAxeAttack(gameId, selectedMove.from, selectedMove.to);
      } else if (selectedMove.isBomb) {
        return this.executeAIBombAttack(gameId, selectedMove.from, selectedMove.to);
      } else {
        return this.executeAIMove(gameId, selectedMove.from, selectedMove.to);
      }
    }
    
    // Depth 0: original heuristic-only selection
    possibleMoves.sort((a, b) => b.score - a.score);
    
    // Pick from top 3 moves with weighted probability
    const topMoves = possibleMoves.slice(0, Math.min(3, possibleMoves.length));
    const selectedMove = topMoves[Math.floor(Math.random() * topMoves.length)];

    if (selectedMove.isArrow) {
      return this.executeAIArrowAttack(gameId, selectedMove.from, selectedMove.to);
    } else if (selectedMove.isAxe) {
      return this.executeAIAxeAttack(gameId, selectedMove.from, selectedMove.to);
    } else if (selectedMove.isBomb) {
      return this.executeAIBombAttack(gameId, selectedMove.from, selectedMove.to);
    } else {
      return this.executeAIMove(gameId, selectedMove.from, selectedMove.to);
    }
  }

  private getArrowTargets(board: Board, from: Position, color: PlayerColor): Position[] {
    const targets: Position[] = [];
    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    
    for (const [dr, dc] of directions) {
      for (let dist = 1; dist <= 4; dist++) {
        const newRow = from.row + dr * dist;
        const newCol = from.col + dc * dist;
        
        if (!this.isValidPosition(newRow, newCol)) break;
        if (board[newRow][newCol].isWall) break;
        
        const targetPiece = board[newRow][newCol].piece;
        if (targetPiece) {
          if (targetPiece.color !== color && 
              targetPiece.type !== 'knight' && 
              targetPiece.type !== 'rook') {
            targets.push({ row: newRow, col: newCol });
          }
          break;
        }
      }
    }
    
    return targets;
  }

  private getAxeTargets(board: Board, from: Position, color: PlayerColor): Position[] {
    const targets: Position[] = [];
    
    // Check all 8 adjacent squares
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        
        const newRow = from.row + dr;
        const newCol = from.col + dc;
        
        if (!this.isValidPosition(newRow, newCol)) continue;
        if (board[newRow][newCol].isWall) continue;
        
        const targetPiece = board[newRow][newCol].piece;
        // Rooks are immune to knight axe attacks
        if (targetPiece && targetPiece.color !== color && targetPiece.type !== 'rook') {
          targets.push({ row: newRow, col: newCol });
        }
      }
    }
    
    return targets;
  }

  private getBombTargets(board: Board, from: Position): Position[] {
    const targets: Position[] = [];
    
    // Check all 8 adjacent squares for walls
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        
        const newRow = from.row + dr;
        const newCol = from.col + dc;
        
        if (!this.isValidPosition(newRow, newCol)) continue;
        
        // Bomb targets walls, not pieces
        if (board[newRow][newCol].isWall) {
          targets.push({ row: newRow, col: newCol });
        }
      }
    }
    
    return targets;
  }
  
  private getWallBuildTargets(board: Board, from: Position): Position[] {
    const targets: Position[] = [];
    
    // Check all 8 adjacent squares for empty squares (no piece, no wall)
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        
        const newRow = from.row + dr;
        const newCol = from.col + dc;
        
        if (!this.isValidPosition(newRow, newCol)) continue;
        
        // Wall build targets empty squares
        if (!board[newRow][newCol].isWall && !board[newRow][newCol].piece) {
          targets.push({ row: newRow, col: newCol });
        }
      }
    }
    
    return targets;
  }

  private executeAIMove(gameId: string, from: Position, to: Position): { state: GameState; diceRoll?: { value: number; type: 'd4' | 'd6'; success: boolean } } | null {
    const room = this.games.get(gameId);
    if (!room) return null;

    const state = room.state;
    // Use current turn color when that player is AI-controlled, fallback to legacy aiColor
    const aiColor = state.aiControlled?.[state.currentTurn] ? state.currentTurn : state.aiColor!;
    const board = state.board;
    const piece = board[from.row][from.col].piece;
    if (!piece) return null;

    const targetPiece = board[to.row][to.col].piece;
    let diceRoll: { value: number; type: 'd4' | 'd6'; success: boolean } | undefined;
    state.lastDiceRoll = undefined;

    // Pawn attack requires dice roll
    if (piece.type === 'pawn' && targetPiece) {
      const roll = Math.floor(Math.random() * 6) + 1;
      const aiPawnSettings = this.getAttackSettingsForColor(state, aiColor);
      const success = this.checkAttackSuccess(aiPawnSettings, 'pawn');
      diceRoll = { value: roll, type: 'd6', success };
      state.lastDiceRoll = diceRoll;

      if (!success) {
        state.currentTurn = aiColor === 'white' ? 'black' : 'white';
        this.saveGame(state);
        return { state, diceRoll };
      }
    }

    // Execute move
    board[from.row][from.col].piece = null;

    if (targetPiece) {
      state.capturedPieces[aiColor].push(targetPiece);
      if (targetPiece.type === 'king') {
        state.winner = aiColor;
        state.phase = 'finished';
      }
    }

    // Handle pawn promotion
    const promotionRow = aiColor === 'white' ? 0 : BOARD_SIZE - 1;
    let promotionPiece: PieceType | undefined;
    if (piece.type === 'pawn' && to.row === promotionRow) {
      promotionPiece = 'queen'; // AI always promotes to queen
      board[to.row][to.col].piece = { type: 'queen', color: aiColor, hasMoved: true };
    } else {
      board[to.row][to.col].piece = { ...piece, hasMoved: true };
    }

    const move: Move = {
      from,
      to,
      piece,
      captured: targetPiece || undefined,
      diceRoll: diceRoll?.value,
      diceRequired: piece.type === 'pawn' && targetPiece ? 6 : undefined,
      success: diceRoll ? diceRoll.success : undefined,
      notation: this.getMoveNotation(piece, from, to, targetPiece || undefined, diceRoll?.value, promotionPiece),
      promotionPiece,
    };
    state.moveHistory.push(move);

    state.currentTurn = aiColor === 'white' ? 'black' : 'white';

    if (this.isCheckmate(board, state.currentTurn)) {
      state.winner = aiColor;
      state.phase = 'finished';
    }

    this.saveGame(state);
    return { state, diceRoll };
  }

  private executeAIArrowAttack(gameId: string, from: Position, to: Position): { state: GameState; diceRoll: { value: number; type: 'd4' | 'd6'; success: boolean } } | null {
    const room = this.games.get(gameId);
    if (!room) return null;

    const state = room.state;
    const aiColor = state.aiControlled?.[state.currentTurn] ? state.currentTurn : state.aiColor!;
    
    const board = state.board;
    const piece = board[from.row][from.col].piece;
    if (piece && piece.id) {
      const aiBUsed = state.specialAttackCounts?.[piece.id] ?? 0;
      const aiBMax = state.maxBishopAttacks ?? 10;
      if (aiBUsed >= aiBMax) return null;
    }
    if (!piece) return null;

    const targetPiece = board[to.row][to.col].piece;
    if (!targetPiece) return null;

    const distance = Math.abs(to.row - from.row);
    const roll = Math.floor(Math.random() * 4) + 1;
    const aiArrowSettings = this.getAttackSettingsForColor(state, aiColor);
    const success = this.checkAttackSuccess(aiArrowSettings, 'bishop', distance);

    const diceRoll = { value: roll, type: 'd4' as const, success };
    state.lastDiceRoll = diceRoll;

    const move: Move = {
      from,
      to,
      piece,
      captured: success ? targetPiece : undefined,
      isArrowAttack: true,
      diceRoll: roll,
      diceRequired: 4,
      success,
      notation: this.getMoveNotation(piece, from, to, success ? targetPiece : undefined, roll, true),
    };
    state.moveHistory.push(move);
    
    if (!state.specialAttackCounts) {
      state.specialAttackCounts = {};
    }
    if (piece.id) {
      state.specialAttackCounts[piece.id] = (state.specialAttackCounts[piece.id] ?? 0) + 1;
    }
    this.recordAttackStat(gameId, 'bishopArrow');

    if (success) {
      state.capturedPieces[aiColor].push(targetPiece);
      board[to.row][to.col].piece = null;

      if (targetPiece.type === 'king') {
        state.winner = aiColor;
        state.phase = 'finished';
      }
    }

    state.currentTurn = aiColor === 'white' ? 'black' : 'white';

    // Check for checkmate after attack
    if (state.phase !== 'finished' && this.isCheckmate(board, state.currentTurn)) {
      state.winner = aiColor;
      state.phase = 'finished';
    }

    this.saveGame(state);
    return { state, diceRoll };
  }

  private executeAIAxeAttack(gameId: string, from: Position, to: Position): { state: GameState; diceRoll: { value: number; type: 'd6'; success: boolean } } | null {
    const room = this.games.get(gameId);
    if (!room) return null;

    const state = room.state;
    // Use current turn color when that player is AI-controlled, fallback to legacy aiColor
    const aiColor = state.aiControlled?.[state.currentTurn] ? state.currentTurn : state.aiColor!;
    const board = state.board;
    const piece = board[from.row][from.col].piece;
    if (!piece) return null;

    const targetPiece = board[to.row][to.col].piece;
    if (!targetPiece) return null;

    // Knight axe attack: roll d6, need >= knightMinRoll (default 4)
    const roll = Math.floor(Math.random() * 6) + 1;
    const aiAxeSettings = this.getAttackSettingsForColor(state, aiColor);
    const success = this.checkAttackSuccess(aiAxeSettings, 'knight');

    const diceRoll = { value: roll, type: 'd6' as const, success };
    state.lastDiceRoll = diceRoll;

    const move: Move = {
      from,
      to,
      piece,
      captured: success ? targetPiece : undefined,
      isAxeAttack: true,
      diceRoll: roll,
      diceRequired: state.attackSettings?.knightMinRoll ?? 4,
      success,
      notation: `${piece.type === 'knight' ? 'N' : ''}🪓${String.fromCharCode(97 + to.col)}${BOARD_SIZE - to.row}(${roll}${success ? '✓' : '✗'})`,
    };
    state.moveHistory.push(move);

    if (success) {
      state.capturedPieces[aiColor].push(targetPiece);
      board[to.row][to.col].piece = null;

      if (targetPiece.type === 'king') {
        state.winner = aiColor;
        state.phase = 'finished';
      }
    }

    state.currentTurn = aiColor === 'white' ? 'black' : 'white';

    // Check for checkmate after attack
    if (state.phase !== 'finished' && this.isCheckmate(board, state.currentTurn)) {
      state.winner = aiColor;
      state.phase = 'finished';
    }

    this.saveGame(state);
    return { state, diceRoll };
  }

  private executeAIBombAttack(gameId: string, from: Position, to: Position): { state: GameState; diceRoll: { value: number; type: 'd10'; success: boolean } } | null {
    const room = this.games.get(gameId);
    if (!room) return null;

    const state = room.state;
    const aiColor = state.aiControlled?.[state.currentTurn] ? state.currentTurn : state.aiColor!;
    
    const board = state.board;
    const piece = board[from.row][from.col].piece;
    if (piece && piece.id) {
      const aiRUsed = state.specialAttackCounts?.[piece.id] ?? 0;
      const aiRMax = state.maxRookAttacks ?? 10;
      if (aiRUsed >= aiRMax) return null;
    }
    if (!piece) return null;

    const roll = Math.floor(Math.random() * 10) + 1;
    const aiBombSettings = this.getAttackSettingsForColor(state, aiColor);
    const success = this.checkAttackSuccess(aiBombSettings, 'bomb');

    const diceRoll = { value: roll, type: 'd10' as const, success };
    state.lastDiceRoll = diceRoll;

    const move: Move = {
      from,
      to,
      piece,
      isBombAttack: true,
      diceRoll: roll,
      diceRequired: state.attackSettings?.bombSuccessRoll ?? 1,
      success,
      notation: `R💣${String.fromCharCode(97 + to.col)}${BOARD_SIZE - to.row}(${roll}${success ? '✓' : '✗'})`,
    };
    state.moveHistory.push(move);
    
    if (!state.specialAttackCounts) {
      state.specialAttackCounts = {};
    }
    if (piece.id) {
      state.specialAttackCounts[piece.id] = (state.specialAttackCounts[piece.id] ?? 0) + 1;
    }
    this.recordAttackStat(gameId, 'rookBomb');

    if (success) {
      board[to.row][to.col].isWall = false;
    }

    state.currentTurn = aiColor === 'white' ? 'black' : 'white';

    this.saveGame(state);
    return { state, diceRoll };
  }

  private createInitialBoard(): Board {
    const board: Board = [];
    
    for (let row = 0; row < BOARD_SIZE; row++) {
      const boardRow: Square[] = [];
      for (let col = 0; col < BOARD_SIZE; col++) {
        boardRow.push({
          row,
          col,
          piece: null,
          isWall: false,
        });
      }
      board.push(boardRow);
    }
    
    const offset = 2;
    const blackBackRow = 0;
    const blackPawnRow = 1;
    const whiteBackRow = 11;
    const whitePawnRow = 10;
    
    const backRowPieces: PieceType[] = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
    
    for (let i = 0; i < 8; i++) {
      board[blackBackRow][offset + i].piece = { type: backRowPieces[i], color: 'black', id: `b_${backRowPieces[i]}_${i}` };
      board[whiteBackRow][offset + i].piece = { type: backRowPieces[i], color: 'white', id: `w_${backRowPieces[i]}_${i}` };
    }
    
    for (let i = 0; i < 8; i++) {
      board[blackPawnRow][offset + i].piece = { type: 'pawn', color: 'black', id: `b_pawn_${i}` };
      board[whitePawnRow][offset + i].piece = { type: 'pawn', color: 'white', id: `w_pawn_${i}` };
    }
    
    return board;
  }

  private getValidMoves(board: Board, position: Position): Position[] {
    const square = board[position.row][position.col];
    if (!square.piece) return [];
    
    const piece = square.piece;
    const moves: Position[] = [];
    
    switch (piece.type) {
      case 'king':
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const newRow = position.row + dr;
            const newCol = position.col + dc;
            if (this.isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall) {
              const targetPiece = board[newRow][newCol].piece;
              if (!targetPiece || targetPiece.color !== piece.color) {
                // Check if this move would put the king in check
                const testBoard: Board = JSON.parse(JSON.stringify(board));
                testBoard[newRow][newCol].piece = piece;
                testBoard[position.row][position.col].piece = null;
                if (!this.wouldBeInCheck(testBoard, piece.color, { row: newRow, col: newCol })) {
                  moves.push({ row: newRow, col: newCol });
                }
              }
            }
          }
        }
        // Castling - king moves to end file, rook moves next to it
        if (!piece.hasMoved && !this.isInCheck(board, piece.color)) {
          const row = position.row;
          // Kingside castling (to column 11)
          const kingsideRookCol = 9; // Initial rook position (offset 2 + 7)
          const kingsideRook = board[row][kingsideRookCol]?.piece;
          if (kingsideRook?.type === 'rook' && kingsideRook.color === piece.color && !kingsideRook.hasMoved) {
            let pathClear = true;
            for (let c = position.col + 1; c <= 11; c++) {
              if (c === kingsideRookCol) continue;
              if (board[row][c].piece || board[row][c].isWall) {
                pathClear = false;
                break;
              }
            }
            // Also check that king doesn't pass through check
            if (pathClear) {
              let passesThroughCheck = false;
              for (let c = position.col + 1; c <= 11; c++) {
                const testBoard: Board = JSON.parse(JSON.stringify(board));
                testBoard[row][c].piece = piece;
                testBoard[position.row][position.col].piece = null;
                if (this.wouldBeInCheck(testBoard, piece.color, { row, col: c })) {
                  passesThroughCheck = true;
                  break;
                }
              }
              if (!passesThroughCheck) {
                moves.push({ row, col: 11 });
              }
            }
          }
          // Queenside castling (to column 0)
          const queensideRookCol = 2; // Initial rook position (offset 2 + 0)
          const queensideRook = board[row][queensideRookCol]?.piece;
          if (queensideRook?.type === 'rook' && queensideRook.color === piece.color && !queensideRook.hasMoved) {
            let pathClear = true;
            for (let c = position.col - 1; c >= 0; c--) {
              if (c === queensideRookCol) continue;
              if (board[row][c].piece || board[row][c].isWall) {
                pathClear = false;
                break;
              }
            }
            if (pathClear) {
              let passesThroughCheck = false;
              for (let c = position.col - 1; c >= 0; c--) {
                const testBoard: Board = JSON.parse(JSON.stringify(board));
                testBoard[row][c].piece = piece;
                testBoard[position.row][position.col].piece = null;
                if (this.wouldBeInCheck(testBoard, piece.color, { row, col: c })) {
                  passesThroughCheck = true;
                  break;
                }
              }
              if (!passesThroughCheck) {
                moves.push({ row, col: 0 });
              }
            }
          }
        }
        break;
        
      case 'pawn':
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const newRow = position.row + dr;
            const newCol = position.col + dc;
            if (this.isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall) {
              const targetPiece = board[newRow][newCol].piece;
              if (!targetPiece || targetPiece.color !== piece.color) {
                moves.push({ row: newRow, col: newCol });
              }
            }
          }
        }
        break;
        
      case 'queen':
        moves.push(...this.getSlidingMoves(board, position, piece.color, [
          [-1, 0], [1, 0], [0, -1], [0, 1],
          [-1, -1], [-1, 1], [1, -1], [1, 1],
        ], MAX_MOVE_DISTANCE));
        break;
        
      case 'rook':
        moves.push(...this.getSlidingMoves(board, position, piece.color, [
          [-1, 0], [1, 0], [0, -1], [0, 1],
        ], MAX_MOVE_DISTANCE));
        break;
        
      case 'bishop':
        moves.push(...this.getSlidingMoves(board, position, piece.color, [
          [-1, -1], [-1, 1], [1, -1], [1, 1],
        ], MAX_MOVE_DISTANCE));
        break;
        
      case 'knight':
        // Knight moves in L-shape and CAN leap over walls (traditional chess behavior)
        const knightMoves = [
          [-2, -1], [-2, 1], [-1, -2], [-1, 2],
          [1, -2], [1, 2], [2, -1], [2, 1],
        ];
        for (const [dr, dc] of knightMoves) {
          const newRow = position.row + dr;
          const newCol = position.col + dc;
          if (this.isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall) {
            // Knights can jump over walls - only destination must not be a wall
            const targetPiece = board[newRow][newCol].piece;
            if (!targetPiece || targetPiece.color !== piece.color) {
              moves.push({ row: newRow, col: newCol });
            }
          }
        }
        break;
    }
    
    return moves;
  }

  private getSlidingMoves(
    board: Board,
    position: Position,
    color: PlayerColor,
    directions: number[][],
    maxDistance: number
  ): Position[] {
    const moves: Position[] = [];
    
    for (const [dr, dc] of directions) {
      for (let dist = 1; dist <= maxDistance; dist++) {
        const newRow = position.row + dr * dist;
        const newCol = position.col + dc * dist;
        
        if (!this.isValidPosition(newRow, newCol) || board[newRow][newCol].isWall) break;
        
        const targetPiece = board[newRow][newCol].piece;
        if (!targetPiece) {
          moves.push({ row: newRow, col: newCol });
        } else if (targetPiece.color !== color) {
          moves.push({ row: newRow, col: newCol });
          break;
        } else {
          break;
        }
      }
    }
    
    return moves;
  }

  private isValidPosition(row: number, col: number): boolean {
    return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
  }

  private isInCheck(board: Board, color: PlayerColor): boolean {
    let kingPos: Position | null = null;
    
    for (let row = 0; row < BOARD_SIZE && !kingPos; row++) {
      for (let col = 0; col < BOARD_SIZE && !kingPos; col++) {
        const piece = board[row][col].piece;
        if (piece && piece.type === 'king' && piece.color === color) {
          kingPos = { row, col };
        }
      }
    }
    
    if (!kingPos) return false;
    
    return this.wouldBeInCheck(board, color, kingPos);
  }

  // Check if a king at the given position would be in check
  // This is used to prevent kings from moving into check
  private wouldBeInCheck(board: Board, color: PlayerColor, kingPos: Position): boolean {
    const opponentColor = color === 'white' ? 'black' : 'white';
    
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = board[row][col].piece;
        if (piece && piece.color === opponentColor) {
          // Get raw attack squares (without recursively checking for check)
          const attacks = this.getRawAttacks(board, { row, col }, piece);
          if (attacks.some(pos => pos.row === kingPos.row && pos.col === kingPos.col)) {
            return true;
          }
          
          // Check bishop arrow attacks (potential future attacks)
          if (piece.type === 'bishop') {
            const arrowTargets = this.getArrowTargets(board, { row, col }, opponentColor);
            if (arrowTargets.some(pos => pos.row === kingPos.row && pos.col === kingPos.col)) {
              return true;
            }
          }
        }
      }
    }
    
    return false;
  }

  // Get attack squares for a piece without check validation (to avoid infinite recursion)
  private getRawAttacks(board: Board, position: Position, piece: Piece): Position[] {
    const attacks: Position[] = [];
    
    switch (piece.type) {
      case 'king':
      case 'pawn':
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const newRow = position.row + dr;
            const newCol = position.col + dc;
            if (this.isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall) {
              const targetPiece = board[newRow][newCol].piece;
              if (!targetPiece || targetPiece.color !== piece.color) {
                attacks.push({ row: newRow, col: newCol });
              }
            }
          }
        }
        break;
        
      case 'queen':
        attacks.push(...this.getSlidingMoves(board, position, piece.color, [
          [-1, 0], [1, 0], [0, -1], [0, 1],
          [-1, -1], [-1, 1], [1, -1], [1, 1],
        ], MAX_MOVE_DISTANCE));
        break;
        
      case 'rook':
        attacks.push(...this.getSlidingMoves(board, position, piece.color, [
          [-1, 0], [1, 0], [0, -1], [0, 1],
        ], MAX_MOVE_DISTANCE));
        break;
        
      case 'bishop':
        attacks.push(...this.getSlidingMoves(board, position, piece.color, [
          [-1, -1], [-1, 1], [1, -1], [1, 1],
        ], MAX_MOVE_DISTANCE));
        break;
        
      case 'knight':
        // Knight moves in L-shape and CAN leap over walls (traditional chess behavior)
        const knightMovesAttack = [
          [-2, -1], [-2, 1], [-1, -2], [-1, 2],
          [1, -2], [1, 2], [2, -1], [2, 1],
        ];
        for (const [dr, dc] of knightMovesAttack) {
          const newRow = position.row + dr;
          const newCol = position.col + dc;
          if (this.isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall) {
            // Knights can jump over walls - only destination must not be a wall
            const targetPiece = board[newRow][newCol].piece;
            if (!targetPiece || targetPiece.color !== piece.color) {
              attacks.push({ row: newRow, col: newCol });
            }
          }
        }
        break;
    }
    
    return attacks;
  }

  private hasLegalMoves(board: Board, color: PlayerColor): boolean {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = board[row][col].piece;
        if (piece && piece.color === color) {
          const moves = this.getValidMoves(board, { row, col });
          for (const move of moves) {
            const newBoard = JSON.parse(JSON.stringify(board));
            newBoard[move.row][move.col].piece = piece;
            newBoard[row][col].piece = null;
            if (!this.isInCheck(newBoard, color)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  private checkGameEnd(state: GameState, movingColor: PlayerColor): void {
    if (state.phase === 'finished') return;
    const opponentColor = movingColor === 'white' ? 'black' : 'white';
    if (!this.hasLegalMoves(state.board, opponentColor)) {
      if (this.isInCheck(state.board, opponentColor)) {
        state.winner = movingColor;
      } else {
        state.winner = 'draw';
      }
      state.phase = 'finished';
    }
  }

  private isCheckmate(board: Board, color: PlayerColor): boolean {
    if (!this.isInCheck(board, color)) return false;
    
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = board[row][col].piece;
        if (piece && piece.color === color) {
          const moves = this.getValidMoves(board, { row, col });
          for (const move of moves) {
            const newBoard = JSON.parse(JSON.stringify(board));
            newBoard[move.row][move.col].piece = piece;
            newBoard[row][col].piece = null;
            
            if (!this.isInCheck(newBoard, color)) {
              return false;
            }
          }
        }
      }
    }
    
    return true;
  }

  private getMoveNotation(piece: Piece, from: Position, to: Position, captured?: Piece, diceRoll?: number, isArrowOrPromotion?: boolean | string): string {
    const pieceSymbol = piece.type === 'pawn' ? '' : piece.type[0].toUpperCase();
    const fromNotation = `${String.fromCharCode(97 + from.col)}${BOARD_SIZE - from.row}`;
    const toNotation = `${String.fromCharCode(97 + to.col)}${BOARD_SIZE - to.row}`;
    const captureSymbol = captured ? 'x' : '';
    const isArrow = isArrowOrPromotion === true;
    const promotionPiece = typeof isArrowOrPromotion === 'string' ? isArrowOrPromotion : undefined;
    const arrowSymbol = isArrow ? '→' : '';
    const dice = diceRoll ? `[${isArrow ? 'd4' : 'd6'}:${diceRoll}]` : '';
    const promotion = promotionPiece ? `=${promotionPiece[0].toUpperCase()}` : '';
    
    return `${pieceSymbol}${fromNotation}${captureSymbol}${arrowSymbol}${toNotation}${dice}${promotion}`;
  }
}

export const gameManager = new GameManager();
