# Battle Chess — Complete Application Specification

**Version:** 1.20.0  
**Purpose:** This document is a detailed, self-contained specification of the Battle Chess web application, written so that an AI code-generation system could reproduce the app identically.

---

## 1. High-Level Overview

Battle Chess is a full-stack, real-time multiplayer chess variant playable in a browser. It differs from standard chess in the following ways:

- **12×12 board** (instead of 8×8), with 8 columns of pieces centered using a 2-column offset on each side (columns 2–9 hold pieces; columns 0–1 and 10–11 are initially empty).
- **Piece movement is capped at 8 squares** for all sliding pieces (queen, rook, bishop).
- **Wall tiles** block all movement. Players may place walls on their own half during a pre-game **setup phase**.
- **Three special attacks** replace or supplement standard captures:
  - **Bishop: Arrow Attack** — ranged attack in any of 8 directions, resolved by a dice roll.
  - **Knight: Axe Attack** — melee attack on adjacent squares, resolved by a dice roll.
  - **Rook: Bomb** — destroys an adjacent wall tile, resolved by a dice roll.
  - **Rook: Wall Build** — creates a wall on an adjacent empty square, resolved by a dice roll.
- **Pawn combat** requires a successful dice roll to capture.
- **Configurable attack probabilities** — each attack type has a percentage chance of success, configurable in the lobby.
- **Per-piece attack limits** — bishops and rooks each have an individual cap (0–75) on special attacks.
- **Three game modes**: Player vs Player (PvP), Player vs Computer (PvC), Computer vs Computer (CvC).
- **Per-player budget assignment** — in "Individual" mode each player secretly assigns attack percentages within a shared budget before the game starts.
- **AI with minimax + alpha-beta pruning** at configurable depth (0–8 plies).
- **Persistent game state** saved to JSON files; games survive server restarts and can be resumed.
- **Attack statistics** — per-game min/avg/max counts for each special attack type, stored persistently.
- **Wall layout save/load** — named wall configurations shared across all players.

---

## 2. Technology Stack

| Layer | Technology |
|---|---|
| Frontend framework | React 18, TypeScript |
| Routing | Wouter |
| Async state | TanStack React Query v5 |
| UI components | shadcn/ui (Radix UI + Tailwind CSS) |
| Icons | lucide-react |
| Build tool | Vite (with HMR) |
| Backend runtime | Node.js, Express, TypeScript (ESM) |
| Real-time | WebSocket (`ws` library) |
| ORM | Drizzle ORM + drizzle-zod |
| Database | PostgreSQL (for users table; games use JSON files) |
| Game persistence | JSON files in `server/data/games/` |
| Stats persistence | `server/data/attack_stats.json` |
| Layout persistence | `server/data/layouts.json` |

---

## 3. Project Directory Structure

```
├── client/
│   └── src/
│       ├── App.tsx                     # Route: "/" → <Game />
│       ├── main.tsx
│       ├── index.css                   # Tailwind base + CSS variables
│       ├── components/
│       │   ├── GameBoard.tsx           # 12×12 board rendering + animations
│       │   ├── GameControls.tsx        # Right-panel controls card
│       │   ├── GameRules.tsx           # Collapsible rules accordion
│       │   ├── GameStatus.tsx          # Phase/turn status bar
│       │   ├── MoveHistory.tsx         # Scrollable move log
│       │   └── PlayerPanel.tsx         # Per-player info card
│       ├── hooks/
│       │   ├── useWebSocket.ts         # All WebSocket logic + game state
│       │   └── use-toast.ts            # Toast notification hook
│       ├── lib/
│       │   ├── gameUtils.ts            # Board logic, move validation
│       │   ├── queryClient.ts          # TanStack Query setup + apiRequest
│       │   ├── sounds.ts               # Web Audio API sound effects
│       │   └── utils.ts                # `cn()` helper
│       └── pages/
│           └── Game.tsx                # Main page (lobby + game view)
├── server/
│   ├── index.ts                        # Express + WebSocket server startup
│   ├── routes.ts                       # REST API route registration
│   ├── gameManager.ts                  # GameManager class (all game logic)
│   ├── storage.ts                      # MemStorage (user CRUD)
│   ├── vite.ts                         # Vite dev middleware setup
│   └── data/                           # Auto-created at runtime
│       ├── games/                      # One JSON file per game
│       ├── attack_stats.json
│       └── layouts.json
├── shared/
│   └── schema.ts                       # Types, Zod schemas, Drizzle schema
├── drizzle.config.ts
├── tailwind.config.ts
├── vite.config.ts
└── package.json
```

---

## 4. Shared Type Definitions (`shared/schema.ts`)

```typescript
type PieceType = 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn';
type PlayerColor = 'white' | 'black';
type GamePhase = 'waiting' | 'budget_setup' | 'setup' | 'playing' | 'finished';
type GameMode = 'pvp' | 'pvc' | 'cvc';
type BudgetMode = 'shared' | 'individual';

interface Piece {
  type: PieceType;
  color: PlayerColor;
  hasMoved?: boolean;
  id?: string;           // format: "{color}_{type}_{index}", e.g. "w_bishop_2"
}

interface Square {
  row: number;
  col: number;
  piece: Piece | null;
  isWall: boolean;
}

type Board = Square[][];

interface Position { row: number; col: number; }

interface Move {
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

interface AttackSettings {
  pawnSuccessRoll: number;       // d6 roll-under threshold (1–6)
  bishopMinRoll: number;         // 2d6 sum threshold (deprecated; use percent)
  knightMinRoll: number;         // d6 roll-at-least threshold (1–7)
  bombSuccessRoll: number;       // d10 roll-under threshold (0–10)
  wallBuildRoll: number;         // d10 roll-under threshold (0–10)
  totalAttackBudget?: number;    // Total percentage points (default 250)
  pawnAttackPercent?: number;
  bishopAttackPercent?: number;
  knightAttackPercent?: number;
  bombAttackPercent?: number;
  wallBuildPercent?: number;
  maxBishopAttacks?: number;     // Per-piece limit 0–75
  maxRookAttacks?: number;       // Per-piece limit 0–75
}

interface GameState {
  id: string;
  board: Board;
  currentTurn: PlayerColor;
  phase: GamePhase;
  gameMode: GameMode;
  aiColor?: PlayerColor;
  aiControlled?: { white: boolean; black: boolean };
  aiDepth?: number;                        // 0–8
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
  specialAttackCounts?: { [pieceId: string]: number };
}

type GameMessage = {
  type: 'join' | 'setup_wall' | 'setup_random_walls' | 'setup_load_layout' | 'ready'
      | 'move' | 'arrow_attack' | 'axe_attack' | 'bomb_attack' | 'wall_attack' | 'state'
      | 'error' | 'player_joined' | 'player_left' | 'reconnect' | 'needsPromotion'
      | 'takeover' | 'games_updated' | 'watch_cvc' | 'stop_cvc' | 'pause_cvc'
      | 'offer_draw' | 'respond_draw' | 'draw_offered' | 'draw_response'
      | 'handoff' | 'take_control' | 'budget_submit';
  payload: any;
  playerId?: string;
};
```

---

## 5. Board Layout and Piece Placement

### 5.1 Board Dimensions
- 12 rows × 12 columns, indexed [0..11][0..11].
- Row 0 is at the top (Black's back row). Row 11 is at the bottom (White's back row).
- Column labels: a–l (a = col 0, l = col 11), displayed in bottom-right corners of row 11 cells.
- Row labels: 1–12 displayed in top-left corners of col 0 cells (label = 12 – rowIndex).

### 5.2 Initial Piece Placement (offset = 2)
```
Row 0:  [empty][empty][b_rook_0][b_knight_1][b_bishop_2][b_queen_3][b_king_4][b_bishop_5][b_knight_6][b_rook_7][empty][empty]
Row 1:  [empty][empty][b_pawn_0][b_pawn_1]...[b_pawn_7][empty][empty]
Rows 2–9: All empty (wall placement zone for both sides).
Row 10: [empty][empty][w_pawn_0]...[w_pawn_7][empty][empty]
Row 11: [empty][empty][w_rook_0][w_knight_1][w_bishop_2][w_queen_3][w_king_4][w_bishop_5][w_knight_6][w_rook_7][empty][empty]
```
Back row order (columns 2–9): `rook, knight, bishop, queen, king, bishop, knight, rook`

### 5.3 Piece IDs
Every piece gets a unique ID assigned at board creation:
- Format: `{colorInitial}_{type}_{indexInBackOrPawnRow}`
- Examples: `w_bishop_2`, `b_rook_7`, `w_pawn_0`
- IDs are used to track per-piece special attack usage counts.
- On promotion, the pawn keeps its original piece ID but its attack count resets to 0.

---

## 6. Movement Rules

### 6.1 General Rules
- **Walls** block all sliding movement and cannot be entered.
- **Maximum sliding distance**: 8 squares for queen, rook, bishop.
- **Captures**: Moving onto an enemy piece's square = capture (instant, no dice roll for non-pawn pieces).
- **King capture = game over** (not checkmate mechanics, though check/checkmate are also detected).

### 6.2 Piece Movement Details

| Piece | Movement |
|---|---|
| King | 1 square any direction. Supports **castling** (see §6.3). |
| Queen | Up to 8 squares in all 8 directions (sliding, blocked by walls/pieces). |
| Rook | Up to 8 squares horizontally or vertically (sliding). |
| Bishop | Up to 8 squares diagonally (sliding). |
| Knight | Standard L-shape (2+1). **Can leap over walls**. Only destination must be non-wall. |
| Pawn | 1 square in any of 8 directions (including diagonal). Captures require a dice roll (see §7.1). |

### 6.3 Castling
- King must not have moved (`hasMoved = false`).
- Rook must not have moved.
- Path between king and rook must be clear of pieces and walls.
- **Kingside**: King moves to column 11, rook (originally at col 9) moves to col 10.
- **Queenside**: King moves to column 0, rook (originally at col 2) moves to col 1.

### 6.4 Pawn Promotion
- A pawn reaching the opponent's back row (row 0 for white, row 11 for black) promotes.
- Human players see a promotion dialog; AI always promotes to queen.
- Promoted piece keeps the pawn's original piece ID; its special attack count resets to 0.

### 6.5 Check and Checkmate
- **Check**: King is attacked by an enemy piece (computed client-side and server-side).
- **Checkmate**: King is in check and no legal move escapes it.
- **Stalemate**: No legal moves available and king is not in check → draw.
- Moves that leave the king in check are filtered out (safe moves only shown as valid).

---

## 7. Special Attacks and Dice Mechanics

All attack probabilities are configured as **percentages** (0–100). When a percentage is set, the server rolls `Math.random() * 100 < percent` to determine success. The dice-roll fallback thresholds exist for legacy compatibility.

### 7.1 Pawn Attack
- **Trigger**: Pawn moves to a square occupied by an enemy piece.
- **Success**: Always (100%) for every player. The server still rolls a d6 for the animation and stores `pawnAttackPercent` 100 / `pawnSuccessRoll` 6. Pawn percent is not drawn from the attack budget.
- **Failure**: Does not occur. A failed pawn attack used to leave the pawn in place and pass the turn.
- **Animation**: Sword emoji (⚔️), yellow flash on attacker on failure; red flash on target on success.

### 7.2 Bishop Arrow Attack
- **Trigger**: Player clicks selected bishop → clicks arrow button → clicks a highlighted target square.
- **Range**: Any of 8 directions, stopping at walls; unlimited range (up to 12 squares).
- **Target**: Must be an enemy piece in line of sight (no wall between).
- **Dice**: 2d6 (shown as d4 in code for animation). Success if `Math.random()*100 < bishopAttackPercent`.
- **Success**: Enemy piece removed.
- **Failure**: No movement; turn passes.
- **Limit**: Each individual bishop has a shared pool tracked by `specialAttackCounts[piece.id]`. Maximum = `maxBishopAttacks` (0–75, default 10).
- **Animation**: Arrow emoji (🏹), orange glow.

### 7.3 Knight Axe Attack
- **Trigger**: Player clicks selected knight → clicks axe button → clicks a highlighted adjacent square.
- **Target**: Any enemy piece in the 8 adjacent squares (not walls).
- **Dice**: d6. Success if `roll >= knightMinRoll` (or `Math.random()*100 < knightAttackPercent`).
- **Failure**: Turn passes.
- **Animation**: Axe emoji (🪓), purple glow.

### 7.4 Rook Bomb Attack
- **Trigger**: Player clicks selected rook → clicks bomb button → clicks a highlighted adjacent wall square.
- **Target**: Any of the 8 adjacent squares that are walls.
- **Dice**: d10. Success if `Math.random()*100 < bombAttackPercent`.
- **Success**: Target wall tile is removed (`isWall = false`).
- **Failure**: Wall stays; turn passes.
- **Limit**: Shared with wall build per piece. Each rook tracks `specialAttackCounts[piece.id]` against `maxRookAttacks` (0–75, default 10).
- **Animation**: Bomb emoji (💣), red glow.

### 7.5 Rook Wall Build Attack
- **Trigger**: Player clicks selected rook → clicks build button → clicks a highlighted adjacent empty square.
- **Target**: Any of the 8 adjacent squares that have no piece and no wall.
- **Dice**: d10. Success if `Math.random()*100 < wallBuildPercent`.
- **Success**: Target square becomes a wall (`isWall = true`).
- **Failure**: Turn passes.
- **Limit**: Same pool as bomb (`specialAttackCounts[piece.id]` vs `maxRookAttacks`).
- **Animation**: Brick emoji (🧱), cyan glow.

### 7.6 Attack Failure Popup
- When any special attack fails, after 600 ms a **red tooltip popup** appears above the target square.
- Text: `"Missed! ({roll})"` for arrow/axe, `"Failed! ({roll})"` for bomb/wall build/pawn.
- Popup disappears after 2 seconds.
- No toast notification is used for attack results (only the popup).

### 7.7 Per-Piece Attack Limit Badges
- When a bishop or rook is selected AND arrow/bomb/wall-build mode is active, a **small circular badge** appears in the top-right corner of each bishop or rook square (for the current player's pieces).
- Badge color: **blue** (many remaining), **orange** (≤ 2 remaining), **red** (exhausted, 0 remaining).
- Badge shows the remaining count as a number.
- When exhausted, the attack buttons display "0" with gray background and cannot be clicked.

---

## 8. Game Phases and Flow

```
[Lobby] → createGame / joinGame
    │
    ├── budgetMode === 'individual' AND 2 players joined → 'budget_setup'
    │       ↓ both submit budgets
    │
    ├── maxWallsPerPlayer > 0 → 'setup'
    │       ↓ both players click Ready
    │
    └── → 'playing'
            ↓ king captured / checkmate / stalemate / resign / draw accepted
         → 'finished'
```

### 8.1 Waiting Phase
- Game is created. Creator sees Game ID and a "Share Game Link" button.
- Opponent joins via URL `/?game={gameId}` or by entering the ID.
- Creator is always White; joiner is always Black.

### 8.2 Budget Setup Phase (Individual Mode Only)
- Both players independently see a budget panel with 5 sliders:
  - Pawn Attack %, Bishop Arrow %, Knight Axe %, Rook Bomb %, Rook Wall Build %.
- **Total attack budget** is set by the game creator (default 250%).
- Sliders are clamped so the sum cannot exceed the budget.
- Used / Remaining counters shown in real time.
- Player clicks "Submit Budget". Server validates total ≤ budget, then stores `whiteAttackSettings` / `blackAttackSettings`.
- After both players (or AI) submit, game advances to setup or playing phase.

### 8.3 Setup Phase (Wall Placement)
- Each player places walls on their own half of the board.
- White's half: rows 6–11. Black's half: rows 0–5.
- Walls can be toggled (click placed wall to remove it and recover the count).
- **Controls available**:
  - "Place N Walls Randomly" button — fills remaining slots randomly on own half.
  - "Generate Maze Pattern" button — creates a maze-like pattern on own half.
  - "Wall Layouts" panel — save/load named wall configurations.
  - "Ready to Play" button — locks in the player's walls.
- During setup, only own-half squares are highlighted (ring highlight with `ring-4 ring-inset ring-gray-500`) to indicate clickable placement zones.
- Opponent's walls are hidden until the game starts (walls outside own half not shown in setup phase).

### 8.4 Playing Phase
- Standard turn-based play; `currentTurn` alternates.
- Turn indicator: a bold arrow (← or →) with color name slides to left (black's turn) or right (white's turn).
- AI thinking indicator: pulsing Brain icon with "Thinking... Ply X/Y" text.
- CvC takeover buttons: "Play White" / "Play Black" appear during CvC games.

### 8.5 Finished Phase
- Winner banner displayed.
- Sound effect played (victory fanfare for winner, defeat sound for loser).
- "New Game" button returns to lobby.

---

## 9. Game Modes

### 9.1 Player vs Player (PvP)
- Two human players. Creator = white, joiner = black.
- Black player's board is **visually flipped** (rotated 180°) so both players see their pieces at the bottom.
- Board flip is applied to: board rendering, attack animation overlay positions, click handling (logical positions always row/col 0–11 regardless of flip).
- Shareable URL: `{origin}/?game={gameId}`.

### 9.2 Player vs Computer (PvC)
- Creator plays White; AI plays Black automatically.
- AI places its walls randomly in its half during setup.
- After human clicks "Ready", game starts (AI is always ready).
- AI uses minimax with alpha-beta pruning at configured depth.
- Player can hand off their turn to the AI ("Hand Off to AI" button), then reclaim ("Take Control" button).
- In individual budget mode, AI auto-generates budget settings using weighted distribution.

### 9.3 Computer vs Computer (CvC)
- Created via REST POST `/api/games/cvc`.
- Both sides played by AI; moves happen every 500 ms (1500 ms for special attacks).
- Human observers watch the game in real time via WebSocket.
- "Pause" / "Resume" button available.
- "Play White" / "Play Black" takeover buttons convert CvC → PvC or PvP.
- CvC games in the saved games list show "White" and "Black" takeover buttons.

---

## 10. AI System

### 10.1 Architecture
- Runs server-side in `GameManager`.
- **A* pathfinding** with Chebyshev distance heuristic (8-directional) for navigating around walls.
  - Results cached per wall configuration (cache invalidated when walls change).
  - Max iterations: `BOARD_SIZE * BOARD_SIZE * 2 = 288`.
- **Minimax with alpha-beta pruning** for depths 1–8.
  - Depth 0: heuristic scoring only (original fast behavior).
  - Each ply: server emits `aiThinkingPly` / `aiThinkingMaxPly` to clients.
- **Board evaluation heuristic**:
  - Material values: pawn=1, knight/bishop=3, rook=5, queen=9, king=100.
  - Central control bonus, pawn advancement scoring.
  - A* path distance to enemy king (shorter = better).

### 10.2 AI Move Selection
1. Gather all legal moves for current color.
2. Score each move.
3. Sort descending by score; pick randomly from top 3.
4. If in check, filter to check-escaping moves only.

### 10.3 AI Special Attack Scoring
- **Arrow**: Score based on material value of target × 10 × 0.5 + random noise; only when bishop attack limit not reached.
- **Axe**: Same material-value scoring.
- **Bomb**: Base score 350. Bonuses: heavily walled (+150), 3+ blocked pieces (+200), opens path to enemy king (+25 per step, +500 if was Infinity), helps other pieces (+40–150 each).
- AI does **not** use wall build (only bomb and arrow/axe).

### 10.4 AI Wall Placement
- **PvC**: AI places walls randomly in its half during `createGame`.
- **CvC**: Walls placed randomly for both sides via `placeCvCWalls`.
- **Maze generation**: Server-side algorithm for human players (handles `setup_random_walls` with maze option).

### 10.5 AI Budget (Individual Mode)
- AI budget is auto-generated using fixed weights: `[1, 3, 3, 1, 2]` for `[pawn, bishop, knight, bomb, wallBuild]`.
- Weights divide the total budget proportionally, capped at 100% each.

---

## 11. WebSocket Protocol

### 11.1 Connection
- Client connects to `ws://{host}/ws`.
- No auth token; `playerId` is sent in message payloads.
- Player IDs stored in `localStorage` as `playerId_{gameId}`.

### 11.2 Client → Server Messages

| `type` | `payload` | Description |
|---|---|---|
| `join` | `{ gameId, maxWalls, attackSettings, budgetMode, aiDepth }` | Create new game |
| `join` | `{ gameId }` | Join existing game as Black |
| `reconnect` | `{ gameId, playerId }` | Reconnect to game |
| `takeover` | `{ gameId, color }` | Human takes over AI role in CvC/PvC |
| `watch_cvc` | `{ gameId }` | Observer watches a CvC game |
| `pause_cvc` | `{ gameId }` | Toggle pause/resume CvC game |
| `setup_wall` | `{ position }` | Toggle wall during setup phase |
| `setup_random_walls` | `{}` | Place remaining walls randomly |
| `setup_load_layout` | `{ walls: Position[] }` | Apply saved wall layout |
| `ready` | `{}` | Player declares ready (ends setup) |
| `move` | `{ from, to }` | Standard move |
| `arrow_attack` | `{ from, to }` | Bishop arrow attack |
| `axe_attack` | `{ from, to }` | Knight axe attack |
| `bomb_attack` | `{ from, to }` | Rook bomb attack |
| `wall_attack` | `{ from, to }` | Rook wall build attack |
| `offer_draw` | `{}` | Offer a draw |
| `respond_draw` | `{ accept: boolean }` | Accept or decline draw |
| `handoff` | `{}` | Hand current player's turn to AI |
| `take_control` | `{}` | Reclaim turn from AI |
| `budget_submit` | `{ pawnAttackPercent, bishopAttackPercent, knightAttackPercent, bombAttackPercent, wallBuildPercent }` | Submit individual budget |

### 11.3 Server → Client Messages

| `type` | `payload` | When |
|---|---|---|
| `state` | Full `GameState` (filtered for player) | After every mutation |
| `error` | `{ message: string }` | Validation failures |
| `player_joined` | — | Second player joins (PvP) |
| `player_left` | — | Player disconnects |
| `needsPromotion` | `{ position }` | Pawn reaches promotion row |
| `games_updated` | — | Broadcast to all when game list changes |
| `draw_offered` | — | Opponent offered draw |
| `draw_response` | `{ accepted: boolean }` | Response to draw offer |

### 11.4 State Filtering
In **individual budget mode**, `filterStateForPlayer()` is called before sending state to each player:
- Hides opponent's `whiteAttackSettings` / `blackAttackSettings`.
- Merges the player's own per-player settings into the top-level `attackSettings` field.
- Ensures each player only sees their own attack percentages.

---

## 12. REST API

Base path: `/api`

| Method | Path | Description |
|---|---|---|
| GET | `/api/games` | List all saved games (sorted by `updatedAt` descending) |
| GET | `/api/games/:id` | Load specific game state |
| DELETE | `/api/games/:id?playerId=` | Delete game (validates ownership) |
| DELETE | `/api/games` | Delete all saved games |
| POST | `/api/games/cvc` | Create CvC game `{ maxWalls, attackSettings, aiDepth }` |
| GET | `/api/attack-stats` | Get attack statistics (min/avg/max per type) |
| GET | `/api/layouts` | List all saved wall layouts |
| POST | `/api/layouts` | Upsert layout `{ name, walls: Position[] }` |
| DELETE | `/api/layouts/:name` | Delete layout by name |

### 12.1 SavedGameInfo Response Shape
```typescript
{
  id: string;
  phase: GamePhase;
  currentTurn: PlayerColor;
  moveCount: number;
  whitePlayer: string | null;
  blackPlayer: string | null;
  winner: PlayerColor | 'draw' | null;
  updatedAt: string;    // ISO timestamp of file mtime
  gameMode?: GameMode;
}
```

### 12.2 Attack Stats Response Shape
```typescript
{
  gamesPlayed: number;
  bishopArrows: { min: number; avg: number; max: number };
  rookBombs: { min: number; avg: number; max: number };
  rookWallBuilds: { min: number; avg: number; max: number };
}
```

---

## 13. Persistence

### 13.1 Game Files
- Location: `server/data/games/{gameId}.json`
- Full `GameState` serialized as JSON with 2-space indentation.
- Written after every mutation (create, join, wall placement, ready, move, attack, resign, draw).
- Read on reconnect if game not in memory.

### 13.2 Attack Statistics
- Location: `server/data/attack_stats.json`
- Format: `{ games: PerGameStats[] }` where `PerGameStats = { bishopArrows, rookBombs, rookWallBuilds }`.
- Each `GameRoom` has an in-memory `attackCounts` counter.
- When a game ends (`state.winner` is set), `flushGameStats()` is called exactly once (tracked by `flushedGameIds` Set).
- Stats are computed on-the-fly from the array: min, avg (rounded to 1 decimal), max.

### 13.3 Wall Layouts
- Location: `server/data/layouts.json`
- Format: `Array<{ name: string; walls: Position[] }>`.
- Shared across all users (any user can see, save, or delete any layout).
- Upsert by name (POST creates or replaces existing layout with same name).

---

## 14. Frontend Architecture

### 14.1 Single Route
- `App.tsx` registers one route: `/` → `<Game />`.
- No navigation sidebar; the entire app is a single page.

### 14.2 `useWebSocket` Hook
Central hook managing:
- WebSocket connection, reconnect logic (exponential backoff).
- `gameState: GameState | null`
- `playerId: string | null` — persisted in localStorage.
- `playerColor: PlayerColor | null`
- `connectionStatus: 'connected' | 'connecting'`
- `isObserver: boolean` — true when watching a CvC game without player role.
- `pendingPromotion: Position | null` — set when server sends `needsPromotion`.
- Functions: `createGame`, `joinGame`, `reconnectGame`, `takeoverGame`, `watchCvCGame`, `pauseCvCGame`, `offerDraw`, `respondToDraw`, `submitBudget`, `sendMessage`.
- Callbacks: `onDrawOffered`, `onDrawResponse`.

### 14.3 `Game.tsx` — Lobby View
Shown when `!gameState`.

**Layout**: Single card centered on screen, max-width `md`.

**Card Header**:
- Title: "Battle Chess ♟" with version badge (e.g. `v1.20.0`).
- Attack stats table shown when `attackStats.gamesPlayed > 0`:
  - 4-column table: Attack Type | Low | Avg | High
  - Rows: Bishop Arrows, Rook Bombs, Rook Wall Builds.

**Card Content** (vertical stack):

1. **Game Settings Section**
   - *Number of walls* slider: 0–32, step 4, default 8.
   - *Total Attack Budget* slider: 0–500%, default 250%.
   - *Budget Mode* toggle: Shared / Individual.
   - Attack percentage sliders (shown in shared mode):
     - Pawn Attack %: fixed at 100. Not part of the budget sum.
     - Bishop Arrow %: 0–100, default 50.
     - Knight Axe %: 0–100, default 50.
     - Rook Bomb %: 0–100, default 10.
     - Rook Wall Build %: 0–100, default 50.
     - Sliders are **clamped** so total cannot exceed budget.
     - "Used: X% / Remaining: Y%" shown.
   - *Max Bishop Attacks* slider: 0–75, default 10.
   - *Max Rook Attacks* slider: 0–75, default 10.
   - *AI Depth* slider: 0–8, default 0.

2. **Action Buttons**
   - "Play vs Computer" (Bot icon) — creates PvC game.
   - "Create Multiplayer Game" (Users icon) — creates PvP game.
   - "Computer vs Computer" (MonitorPlay icon) — creates CvC game (via REST POST then WebSocket watch).

3. **Divider**: "Or join existing"

4. **Join Game** input + button.

5. **Saved Games** section (only if `savedGames.length > 0`):
   - "Clear All" ghost button.
   - ScrollArea (height 12rem / 48px × 4) listing games.
   - Each game row shows:
     - History icon + game ID (monospaced, truncated).
     - Badge "vs AI" (primary tint) for PvC games.
     - Badge "CvC" (secondary) for CvC games.
     - Status text: `"{white/black} won"` or `"Draw"` or `"{color}'s turn"`.
     - Move count and time ago.
     - CvC games: "White" and "Black" takeover buttons.
     - PvP/PvC: "Resume" (if `localStorage` has playerId) or "Join" button.
     - Trash icon delete button (only for own games or CvC games).

6. **Game Rules** collapsible at bottom.

### 14.4 `Game.tsx` — In-Game View
Shown when `gameState` is set.

**Layout**: Full-width (`min-h-screen`), max-width `7xl`, three-column flex (lg) or stacked (mobile).

**Column order on mobile**: Board (order-1), Black panel (order-2), White/Controls panel (order-3).
**Column order on desktop**: Black panel (order-1), Board (order-2), White/Controls panel (order-3).

**Left Panel** (Black player, `lg:w-64`):
- `<PlayerPanel color="black" />`
- Game rules (hidden on mobile, shown on desktop).

**Center** (Board):
- `<GameStatus />` — status bar at top.
- Turn indicator arrow (animated left/right).
- AI thinking indicator (when `aiThinkingPly` is set).
- CvC takeover buttons (during CvC playing phase).
- **Budget Setup Panel** (if `phase === 'budget_setup' && !budgetSubmitted`):
  - Card with 5 sliders and "Submit Budget" button.
  - After submit: "Waiting for opponent to submit their budget..." spinner card.
- **Game Board** (`<GameBoard />`).
- **Promotion Dialog** (when `pendingPromotion` is set): 4 buttons (queen, rook, bishop, knight) with Unicode symbols.
- Connection status (Wifi icon + "Connected" or Loader2 + "Reconnecting...").

**Right Panel** (White player, `lg:w-64`):
- `<PlayerPanel color="white" />`
- `<GameControls />`
- **Your Attack Chances** card (shown during playing and setup phases):
  - 2-column grid: label | percentage
  - Pawn, Bishop, Knight, Bomb, Wall Build
  - Values come from `gameState.attackSettings` (which is filtered per-player in individual mode).
- **Move History** card.

---

## 15. `GameBoard` Component

### 15.1 Board Rendering
- Grid: 12×12 CSS grid.
- Board width: `min(90vw, calc(100vh - 280px), 560px)`.
- Board height: `aspect-ratio: 1/1`.
- Overflow scroll when zoomed.
- `select-none` and `caretColor: transparent` on board container (prevents text cursor).

### 15.2 Square Colors
- Light squares: `bg-green-400 dark:bg-green-500`.
- Dark squares: `bg-green-500 dark:bg-green-600`.
- (Light/dark determined by `(row + col) % 2 === 1`.)

### 15.3 Wall Rendering
- Wall squares: gray background `#6b7280` with a brick-pattern CSS background using `linear-gradient`.
  ```css
  backgroundColor: '#6b7280',
  backgroundImage: `
    linear-gradient(to right, #4b5563 1px, transparent 1px),
    linear-gradient(to bottom, #4b5563 1px, transparent 1px),
    linear-gradient(to right, #4b5563 1px, transparent 1px)
  `,
  backgroundSize: '50% 33%, 50% 33%, 50% 33%',
  backgroundPosition: '0 0, 0 33%, 25% 66%',
  ```

### 15.4 Square Highlight States (ring-based, via `cn()`)
| Condition | Style |
|---|---|
| Selected piece | `ring-2 ring-inset ring-blue-500` |
| Valid move (empty) | `after:absolute after:w-1/3 after:h-1/3 after:rounded-full after:bg-black/20` |
| Valid move (capture) | `ring-2 ring-inset ring-red-500` |
| Arrow target | `ring-2 ring-inset ring-orange-500 bg-orange-400/30` |
| Axe target | `ring-2 ring-inset ring-purple-500 bg-purple-400/30` |
| Bomb target | `ring-2 ring-inset ring-red-600 bg-red-400/30` |
| Wall build target | `ring-2 ring-inset ring-cyan-500 bg-cyan-400/30` |
| Hanging piece | `ring-2 ring-inset ring-yellow-400` |
| Attack flash (success) | `animate-pulse bg-red-500` |
| Attack flash (failure) | `animate-pulse bg-yellow-400` |
| Move flash | `move-flash-animation` (CSS keyframe: 3 alternating highlight flashes over 1.5s) |
| Wall placement available (setup) | `ring-4 ring-inset ring-gray-500` |

### 15.5 Piece Rendering
- **Pawn**: Custom inline SVG `<PawnIcon>` with `fill` and `stroke` based on color.
- **Other pieces**: Unicode chess symbols using variation selector `\uFE0E` to force text mode.
  - White pieces: white fill with black `-webkit-text-stroke: 1px black`.
  - Black pieces: black fill with white stroke.
- Piece size: `min(calc(560px / 12 * 0.85), calc((min(90vw, calc(100vh - 280px)) / 12) * 0.85))`.

**Unicode symbols used:**
| Piece | White | Black |
|---|---|---|
| King | ♔ | ♚ |
| Queen | ♛ | ♛ |
| Rook | ♜ | ♜ |
| Bishop | ♗ | ♝ |
| Knight | ♞ | ♞ |
| Pawn | SVG | SVG |

### 15.6 Attack Buttons (Appear on Selected Piece)
When a piece is selected and NOT already in an attack mode:
- **Bishop**: Orange circle with `<Target>` icon (center overlay, 28×28px). Gray with "0" if exhausted.
- **Knight**: Purple circle with `<Axe>` icon.
- **Rook**: Two small circles side by side: red `<Bomb>` and cyan `<Blocks>`. Both gray with "0" if exhausted.

### 15.7 Zoom Controls
- ZoomOut (−) / percentage display / ZoomIn (+) / Reset (shown only when zoom ≠ 1).
- Range: 0.6× to 2.0×, step 0.2.
- Board scales with `transform: scale(zoom); transform-origin: top left`.

### 15.8 Board Flip (PvP Black Player)
- When `gameMode === 'pvp' && playerColor === 'black'`, board is rendered with rows reversed and each row's columns reversed.
- Logical positions (row/col) are always 0–11; the flip is purely visual.
- Click handler translates display index back to logical index.
- `AttackAnimationOverlay` also accounts for flip when computing pixel positions.

### 15.9 Attack Animation Overlay
- Rendered as a fixed-position element on top of the page (portal-like).
- Uses CSS animation `@keyframes attackTravel`:
  - Starts at `from` cell center, moves to `to` cell center over ~600ms.
  - Large emoji character (🏹/🪓/💣/⚔️/🧱) with drop shadow glow.
- After 1000ms, overlay unmounts.
- On success: red flash on target square for 600ms.
- On failure: yellow flash on attacker square for 600ms.

---

## 16. `PlayerPanel` Component

A card shown for each player (one for white, one for black).

**Content**:
- Player color label ("White" / "Black") with `●` dot in that color.
- "(You)" badge if this is the current player's color.
- "AI" badge if controlled by computer.
- "(Turn)" indicator if it's this player's current turn.
- **Captured pieces**: Listed as Unicode symbols in a wrapping flex container.
  - White's captured pieces = pieces Black has taken from White.
  - Black's captured pieces = pieces White has taken from Black.
  - Caption: "Captured by {color}".

---

## 17. `GameStatus` Component

A status bar centered above the board.

**Content by phase**:
- `waiting`: "Waiting for opponent..." (muted text).
- `budget_setup`: "Assign your attack budget" (blue badge).
- `setup`: "Place your walls" with remaining count.
- `playing`:
  - If in check: "Check!" (red badge + alert icon).
  - If in checkmate: "Checkmate!" (red badge).
  - Otherwise: "{White/Black}'s turn".
- `finished`:
  - Winner: "{Color} wins!" (green badge).
  - Draw: "Draw!" (yellow badge).

---

## 18. `GameControls` Component

A card in the right panel.

**Sections shown by phase**:

**All phases with gameId**:
- Game ID display with copy button.
- "Share Game Link" button (in waiting phase only).

**Waiting phase (host only)**:
- "Walls per player" Select: values 0, 4, 8, 12, 16, 24, 32.

**Setup phase**:
- "Place N Walls Randomly" button (Shuffle icon).
- "Generate Maze Pattern" button (Grid3X3 icon).
- "Wall Layouts" toggle button (FolderOpen icon).
  - Layout manager panel when open:
    - Name input + Save button (disabled if no walls placed).
    - Scrollable list (max-height 8rem) of saved layouts.
    - Each layout: name, wall count badge, Load button, Delete button.
- "Ready to Play" button (CheckCircle icon). Disabled after clicked; shows "Waiting for opponent...".

**Playing phase**:
- "Hand Off to AI" / "Take Control" button (Bot/User icon), not shown in CvC mode.
- Draw offer handling:
  - If opponent has offered: "Accept" and "Decline" buttons.
  - Otherwise: "Offer Draw" button (disabled after offering).
- "Resign" button (Flag icon, destructive).
- For CvC: "End Game" instead of "Resign".
- For CvC: "Pause" / "Resume" button at top of controls.

**Finished phase**:
- "New Game" button (RotateCcw icon).

---

## 19. `MoveHistory` Component

A card with a scrollable list of moves in algebraic-like notation.

- Last move highlighted.
- Each entry shows: move number, White's move, Black's move (side by side in a grid).
- Emoji appended to notations: `🏹` (arrow), `🪓` (axe), `💣` (bomb), `🧱` (wall build).
- Success/failure suffix: `✓` or `✗` with dice roll in parentheses.

---

## 20. `GameRules` Component

An accordion (collapsible) panel explaining the game rules. Shown in the left panel during play, and at the bottom of the lobby card.

Sections:
1. **Board & Pieces** — 12×12 board, standard piece placement.
2. **Movement** — Standard chess movement with 8-square cap and wall blocking.
3. **Pawn Combat** — Dice roll requirement.
4. **Bishop Arrows** — Ranged attack in 8 directions.
5. **Knight Axe** — Melee attack on adjacent squares.
6. **Rook Bomb** — Destroy adjacent wall.
7. **Rook Wall Build** — Create wall on adjacent empty square.
8. **Walls** — Placement during setup phase.

---

## 21. Sound Effects (`client/src/lib/sounds.ts`)

Sounds are generated using the **Web Audio API** (no external audio files).

| Function | Trigger | Description |
|---|---|---|
| `playAttackSound(type)` | When attack animation starts | Type-specific tone |
| `playSuccessSound()` | 600ms after successful attack | Upward tone |
| `playFailSound()` | 600ms after failed attack | Downward/dissonant tone |
| `playVictoryFanfare()` | On winner = playerColor | Ascending fanfare |
| `playDefeatSound()` | On winner ≠ playerColor | Descending sound |

---

## 22. Lobby Configuration Details

### 22.1 Attack Budget System
- **Total Attack Budget**: A pool of percentage points (e.g. 250) shared across bishop, knight, bomb, and wall-build attacks.
- Pawn attacks are fixed at 100% and are excluded from that sum.
- Each budgeted attack type has an independent percentage (0–100).
- Sum of the budgeted percentages must not exceed the budget.
- **Shared mode**: Creator sets percentages; both players use same settings.
- **Individual mode**: Both players configure secretly during `budget_setup` phase.

### 22.2 Conversion from Percentage to Roll Thresholds
```
pawnSuccessRoll = round(pawnAttackPercent / 100 * 6)    // d6, roll-under
knightMinRoll   = 7 - round(knightAttackPercent / 100 * 6)   // d6, roll-at-least
bombSuccessRoll = round(bombAttackPercent / 100 * 10)   // d10, roll-under
wallBuildRoll   = round(wallBuildPercent / 100 * 10)    // d10, roll-under
```

### 22.3 Configurable Defaults
| Setting | Default | Range |
|---|---|---|
| Max walls per player | 8 | 0–32 |
| Total attack budget | 250% | 0–500% |
| Pawn attack % | 100% (fixed) | 100% |
| Bishop arrow % | 50% | 0–100% |
| Knight axe % | 50% | 0–100% |
| Rook bomb % | 10% | 0–100% |
| Rook wall build % | 50% | 0–100% |
| Max bishop attacks | 10 | 0–75 |
| Max rook attacks | 10 | 0–75 |
| AI depth | 0 | 0–8 |
| Budget mode | shared | shared / individual |

---

## 23. Dark Mode

- Implemented via Tailwind's `darkMode: ['class']` + `.dark` class on `<html>`.
- All colors use CSS variables defined in `index.css` under `:root` and `.dark`.
- Board uses explicit dark variants: `dark:bg-green-600` / `dark:bg-green-500`.
- No toggle in the UI; follows system preference or manual class.

---

## 24. Responsive / Mobile Support

- Single-column stacked layout on screens narrower than `lg` (1024px).
- On mobile: board appears first (order-1), then black panel (order-2), then white/controls (order-3).
- Game Rules accordion hidden on desktop (shown in left panel); visible at bottom of center column on mobile.
- Board width: `min(90vw, calc(100vh - 280px), 560px)` adapts to viewport.
- Zoom controls allow manual zoom from 60% to 200%.
- Card padding uses `p-2 sm:p-4` / `p-3 sm:p-6` responsive variants.

---

## 25. Data Flow Summary

```
User Action (click square / button)
    │
    ▼
Game.tsx handler (handleSquareClick, handleArrowModeToggle, etc.)
    │
    ▼
sendMessage({ type, payload }) via useWebSocket
    │
    ▼
WebSocket → server routes.ts → GameManager method
    │         (e.g. handleArrowAttack, handleMove, handleSetupWall)
    ▼
GameState mutated; saveGame() writes to JSON file
    │
    ▼
Broadcast updated state to all players in room
  (filterStateForPlayer() applied per recipient in individual budget mode)
    │
    ▼
Client receives 'state' message → setGameState()
    │
    ▼
React re-renders all subscribed components
    │
    ▼
useEffect detects new dice roll / new move → triggers animations/sounds
```

---

## 26. Key Implementation Notes

1. **No database for games**: All game state uses JSON files. The PostgreSQL database only stores the `users` table (not currently used in active features).

2. **Piece ID stability**: IDs are assigned at board creation and never change (even through promotion). This is critical for the per-piece attack count tracking.

3. **AI concurrency**: CvC games use `setInterval` style scheduling (scheduleNext recursively calls setTimeout). The interval is stored in `cvcIntervals` map and cleaned up on game end or takeover.

4. **A* cache invalidation**: The cache key is a stringified wall-position hash. Cache clears whenever a wall is added or removed (bomb, wall build, or new wall during setup).

5. **Special attack counting**: Both bomb and wall build use the same `maxRookAttacks` limit and the same `specialAttackCounts[piece.id]` counter per rook. So a rook's combined bomb + wall build attempts are counted together.

6. **`flushedGameIds` Set**: Prevents double-recording stats if `saveGame` is called multiple times after a winner is set (e.g., from both the game-ending move handler and a subsequent reconnect save).

7. **Board flip and attack animations**: The `AttackAnimationOverlay` uses `boardRef.current.getBoundingClientRect()` to compute pixel positions. It flips logical row/col to display row/col when `shouldFlipBoard` is true.

8. **`select-none` + `caretColor: transparent`**: Applied to the board container to prevent text selection highlight and blinking cursor artifact on mobile/desktop browsers.

9. **Reconnection flow**: If a player navigates away and returns, `localStorage` contains `playerId_{gameId}`. The client sends a `reconnect` message; the server loads the game from file if not in memory and re-associates the WebSocket.

10. **`GAME_VERSION` constant**: Located at the top of `Game.tsx`. Must be updated on every code change. Displayed in the lobby card header as a small badge (`v{GAME_VERSION}`).

---

## 27. File-by-File Quick Reference

| File | Purpose |
|---|---|
| `shared/schema.ts` | All TypeScript types, Zod schemas, Drizzle `users` table |
| `server/gameManager.ts` | `GameManager` class: all game logic, A*, minimax, CvC loop, file I/O |
| `server/routes.ts` | Express REST routes + WebSocket upgrade handler |
| `server/storage.ts` | `MemStorage` class (in-memory user CRUD implementing `IStorage`) |
| `server/index.ts` | Start Express + WebSocket server on port from `PORT` env var |
| `client/src/pages/Game.tsx` | Main page component; lobby view + in-game view |
| `client/src/hooks/useWebSocket.ts` | All WebSocket state management |
| `client/src/components/GameBoard.tsx` | Board grid, piece rendering, attack buttons, animations |
| `client/src/components/GameControls.tsx` | Right-panel controls card with layout manager |
| `client/src/components/PlayerPanel.tsx` | Per-player info + captured pieces |
| `client/src/components/GameStatus.tsx` | Phase/turn status bar |
| `client/src/components/MoveHistory.tsx` | Scrollable notation log |
| `client/src/components/GameRules.tsx` | Collapsible rules accordion |
| `client/src/lib/gameUtils.ts` | `getValidMoves`, `getCheckSafeMoves`, `getArrowTargets`, `getAxeTargets`, `getBombTargets`, `getWallBuildTargets`, `findHangingPieces`, `isInCheck`, `isCheckmate`, `createInitialBoard`, `PIECE_SYMBOLS` |
| `client/src/lib/sounds.ts` | Web Audio API sound generation |
| `client/src/lib/queryClient.ts` | TanStack Query client + `apiRequest` helper |
