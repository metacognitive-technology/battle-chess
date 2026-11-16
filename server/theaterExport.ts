import { randomBytes } from "crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { AttackSettings, GameState, Move, Piece, Position } from "@shared/schema";

const BOARD_SIZE = 12;
const FILES_HEADER = "    a  b  c  d  e  f  g  h  i  j  k  l";

const PIECE_LETTERS: Record<Piece["type"], string> = {
  king: "K",
  queen: "Q",
  rook: "R",
  bishop: "B",
  knight: "N",
  pawn: "P",
};

type DiceType = "d4" | "d6" | "2d6" | "d10";

/**
 * Write a finished game into the theater rooms directory.
 * Never throws. Missing target dir, an existing room, and IO errors are ignored.
 * Files are written to a temp directory and renamed into place once.
 */
export function exportToTheater(state: GameState): void {
  let tmp: string | null = null;
  try {
    if (!state?.id) return;
    const root = process.env.THEATER_ROOMS_DIR || "/theater-rooms";
    if (!existsSync(root)) return;
    if (!statSync(root).isDirectory()) return;

    const safeId = safeRoomToken(String(state.id));
    if (!safeId) return;
    const roomId = `bc3003-${safeId}`;
    const dest = join(root, roomId);
    if (existsSync(dest)) return;

    tmp = join(root, `.tmp-${roomId}-${randomBytes(6).toString("hex")}`);
    mkdirSync(tmp, { recursive: false });

    const exportedState = JSON.parse(JSON.stringify(state)) as GameState;
    exportedState.id = roomId;

    const room = {
      roomId,
      whitePlayerId: state.players?.white ?? null,
      blackPlayerId: state.players?.black ?? null,
      readyPlayers: readyPlayerIds(state),
      settings: buildSettings(state, roomId),
      state: exportedState,
    };

    const notations = (state.moveHistory ?? []).map((m) => m.notation);
    const last = state.moveHistory?.length ? state.moveHistory[state.moveHistory.length - 1] : undefined;
    const snap = {
      room: roomId,
      phase: "finished" as const,
      sideToMove: state.currentTurn,
      winner: state.winner ?? null,
      lastMove: last?.notation ?? null,
      lastDice: null,
      diceSucceeded: null,
      moveHistory: notations,
      endingAction: state.endingAction ?? null,
      endReason: state.endReason ?? null,
    };

    writeFileSync(join(tmp, "room.json"), JSON.stringify(room, null, 2), "utf-8");
    writeFileSync(join(tmp, "state.json"), JSON.stringify(snap, null, 2), "utf-8");
    writeFileSync(join(tmp, "board.txt"), renderBoard(state), "utf-8");
    writeFileSync(join(tmp, "game.jsonl"), renderGameJsonl(state), "utf-8");
    writeFileSync(
      join(tmp, "host.json"),
      JSON.stringify({ host: "metacog", machine: "battle-chess:3003", model: "server-ai/human" }) + "\n",
      "utf-8",
    );

    renameSync(tmp, dest);
    tmp = null;
  } catch {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // never throw
      }
    }
  }
}

function safeRoomToken(id: string): string {
  const trimmed = id.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(trimmed)) return trimmed;
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  return cleaned;
}

function readyPlayerIds(state: GameState): string[] {
  const ids: string[] = [];
  const push = (id: string | null | undefined) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  push(state.players?.white);
  push(state.players?.black);
  for (const id of state.budgetReadyPlayers ?? []) push(id);
  return ids;
}

function percentSplit(settings: AttackSettings | undefined) {
  if (!settings) return null;
  return {
    pawn: settings.pawnAttackPercent ?? null,
    bishop: settings.bishopAttackPercent ?? null,
    knight: settings.knightAttackPercent ?? null,
    bomb: settings.bombAttackPercent ?? null,
    wallBuild: settings.wallBuildPercent ?? null,
  };
}

function buildSettings(state: GameState, roomId: string) {
  const attack = state.attackSettings;
  return {
    room: roomId,
    attackSettings: attack ?? null,
    whiteAttackSettings: state.whiteAttackSettings ?? null,
    blackAttackSettings: state.blackAttackSettings ?? null,
    maxWalls: state.maxWallsPerPlayer,
    maxBishopAttacks: state.maxBishopAttacks ?? attack?.maxBishopAttacks ?? null,
    maxRookAttacks: state.maxRookAttacks ?? attack?.maxRookAttacks ?? null,
    budget: attack?.totalAttackBudget ?? null,
    budgetMode: state.budgetMode ?? null,
    whiteSplit: percentSplit(state.whiteAttackSettings ?? attack),
    blackSplit: percentSplit(state.blackAttackSettings ?? attack),
    gameMode: state.gameMode,
    whiteWalls: wallNames(state.setupWalls?.white),
    blackWalls: wallNames(state.setupWalls?.black),
    endingAction: state.endingAction ?? null,
    endReason: state.endReason ?? null,
  };
}

/** Square names for replay. Missing or unreadable records export as an empty list. */
function wallNames(positions: Position[] | undefined | null): string[] {
  if (!positions?.length) return [];
  const names: string[] = [];
  for (const pos of positions) {
    if (!pos || typeof pos.row !== "number" || typeof pos.col !== "number") continue;
    if (!Number.isInteger(pos.row) || !Number.isInteger(pos.col)) continue;
    if (pos.row < 0 || pos.row >= BOARD_SIZE || pos.col < 0 || pos.col >= BOARD_SIZE) continue;
    names.push(squareName(pos));
  }
  return names;
}

function squareName(pos: Position): string {
  return `${String.fromCharCode(97 + pos.col)}${BOARD_SIZE - pos.row}`;
}

function pieceGlyph(piece: Piece): string {
  const ch = PIECE_LETTERS[piece.type] ?? "?";
  return piece.color === "white" ? ch : ch.toLowerCase();
}

function pieceLabel(piece: Piece): string {
  if (piece.id) return piece.id;
  const side = piece.color === "white" ? "w" : "b";
  return `${side}_${piece.type}`;
}

/** 12×12 grid. Board row 0 is rank 12. Ends with a newline. */
function renderBoard(state: GameState): string {
  const lines = [FILES_HEADER];
  const walls: string[] = [];
  const pieces: string[] = [];
  const board = state.board ?? [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    const rank = String(BOARD_SIZE - row).padStart(2, " ");
    const cells: string[] = [];
    for (let col = 0; col < BOARD_SIZE; col++) {
      const sq = board[row]?.[col];
      if (sq?.isWall) {
        cells.push("#");
        walls.push(squareName({ row, col }));
      } else if (sq?.piece) {
        cells.push(pieceGlyph(sq.piece));
        pieces.push(`${pieceLabel(sq.piece)}@${squareName({ row, col })}`);
      } else {
        cells.push(".");
      }
    }
    lines.push(`${rank} ${cells.map((c) => c.padStart(2, " ")).join(" ")}  ${rank}`);
  }
  lines.push(FILES_HEADER);
  lines.push("");
  lines.push(`Walls (${walls.length}): ${walls.length ? walls.join(" ") : "(none)"}`);
  lines.push(`Pieces: ${pieces.join(" ")}`);
  const winner = state.winner ?? "—";
  lines.push(`Turn: ${state.currentTurn}  Phase: finished  Winner: ${winner}`);
  return lines.join("\n") + "\n";
}

/** Human bombs and axes were stored without their kind flag. The notation still names them. */
function kindFromNotation(notation: string | null | undefined): "move" | "arrow" | "axe" | "bomb" | "wall" | null {
  const note = notation || "";
  if (note.includes("💣")) return "bomb";
  if (note.includes("🧱")) return "wall";
  if (note.includes("⚔") || note.includes("🪓")) return "axe";
  if (note.includes("→")) return "arrow";
  return null;
}

function kindFor(move: Move): "move" | "arrow" | "axe" | "bomb" | "wall" {
  if (move.isWallBuild) return "wall";
  if (move.isBombAttack) return "bomb";
  if (move.isAxeAttack) return "axe";
  if (move.isArrowAttack) return "arrow";
  return kindFromNotation(move.notation) ?? "move";
}

function diceTypeFor(move: Move): DiceType {
  const kind = kindFor(move);
  if (kind === "bomb" || kind === "wall") return "d10";
  if (kind === "axe") return "d6";
  if (kind === "arrow") {
    if (move.diceRequired != null && move.diceRequired <= 4) return "d4";
    if ((move.diceRoll ?? 0) > 4 || (move.diceRequired ?? 0) >= 12) return "2d6";
    return "d4";
  }
  return "d6";
}

function opposite(color: "white" | "black"): "white" | "black" {
  return color === "white" ? "black" : "white";
}

function renderGameJsonl(state: GameState): string {
  const moves = state.moveHistory ?? [];
  if (moves.length === 0) return "";
  const now = Date.now();
  const start = now - (moves.length - 1) * 1000;
  const lines = moves.map((move, index) => {
    const last = index === moves.length - 1;
    const side = move.piece?.color ?? (index % 2 === 0 ? "white" : "black");
    const dice =
      move.diceRoll == null
        ? null
        : {
            value: move.diceRoll,
            type: diceTypeFor(move),
            success: move.success ?? null,
          };
    return JSON.stringify({
      t: new Date(start + index * 1000).toISOString(),
      ply: index + 1,
      side,
      kind: kindFor(move),
      from: move.from ? squareName(move.from) : null,
      to: move.to ? squareName(move.to) : null,
      promo: move.promotionPiece ?? null,
      notation: move.notation ?? null,
      dice,
      success: move.success ?? null,
      winner: last ? (state.winner ?? null) : null,
      phase: last ? "finished" : "playing",
      sideToMove: last ? state.currentTurn : opposite(side),
    });
  });
  return lines.join("\n") + "\n";
}
