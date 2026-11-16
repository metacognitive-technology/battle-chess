/**
 * Durable game recording: games directory, setup-wall snapshot, finish
 * records, and the file-backed analysis queue.
 *
 * Setup walls are stored on GameState and exported as square names. They are
 * not appended to moveHistory. Theater replay places settings.whiteWalls and
 * settings.blackWalls with handleLoadLayout before it replays game.jsonl, so
 * a setup ply would place the same walls a second time.
 */
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Board, EndReason, EndingAction, EndingKind, GameState, PlayerColor, Position } from "@shared/schema";

const BOARD_SIZE = 12;

export interface AnalysisQueueEntry {
  gameId: string;
  finishedAt: string;
  reason: string;
}

export interface FinishInput {
  kind: EndingKind;
  by?: PlayerColor | null;
  detail?: string;
  /** Pass null to force no notation even when the history is non-empty. */
  notation?: string | null;
  manual?: {
    reason: EndReason["reason"];
    by?: string | null;
    color?: PlayerColor | null;
  };
}

const PLY_KINDS = new Set<EndingKind>(["checkmate", "king_capture", "stalemate", "max_moves"]);

/** Directory of this module in dev, or the bundle directory in the CJS build. */
export function getCurrentDir(): string {
  try {
    if (typeof __dirname !== "undefined") {
      return __dirname;
    }
  } catch {
    // ESM has no __dirname.
  }
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** `GAMES_DIR` when set, otherwise `<server-or-dist>/data/games`. */
export function resolveGamesDir(): string {
  const fromEnv = process.env.GAMES_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return join(getCurrentDir(), "data", "games");
}

/**
 * `ANALYSIS_QUEUE_PATH` when set.
 * Otherwise the queue file sits inside the games directory so the games mount covers it.
 */
export function resolveAnalysisQueuePath(): string {
  const fromEnv = process.env.ANALYSIS_QUEUE_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return join(resolveGamesDir(), "analysis-queue.jsonl");
}

/** `ATTACK_STATS_PATH` when set, otherwise `<server-or-dist>/data/attack_stats.json`. */
export function resolveAttackStatsPath(): string {
  const fromEnv = process.env.ATTACK_STATS_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return join(getCurrentDir(), "data", "attack_stats.json");
}

/**
 * Walls present when setup ends.
 * White's half is rows 6–11. Black's half is rows 0–5. Same split as wall placement.
 */
export function collectSetupWalls(board: Board | undefined): { white: Position[]; black: Position[] } {
  const white: Position[] = [];
  const black: Position[] = [];
  if (!board) return { white, black };
  const mid = BOARD_SIZE / 2;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (!board[row]?.[col]?.isWall) continue;
      const pos = { row, col };
      if (row >= mid) white.push(pos);
      else black.push(pos);
    }
  }
  return { white, black };
}

/** Record setup walls once. Later play-phase walls stay out of this list. */
export function recordSetupWalls(state: GameState): void {
  if (state.setupWalls) return;
  state.setupWalls = collectSetupWalls(state.board);
}

export function markGameFinished(state: GameState, input: FinishInput): void {
  state.phase = "finished";
  if (!state.endingAction) {
    const history = state.moveHistory ?? [];
    const last = history.length ? history[history.length - 1] : undefined;
    const tieToPly = input.notation === undefined && PLY_KINDS.has(input.kind);
    const notation = input.notation !== undefined ? input.notation : tieToPly ? last?.notation ?? null : null;
    const ply =
      input.notation === null ? null : PLY_KINDS.has(input.kind) && history.length ? history.length : null;
    const winnerSide = state.winner === "white" || state.winner === "black" ? state.winner : null;
    const action: EndingAction = {
      kind: input.kind,
      by: input.by !== undefined ? input.by : winnerSide,
      at: new Date().toISOString(),
      notation,
      ply,
    };
    if (input.detail) action.detail = input.detail;
    state.endingAction = action;
  }
  if (input.manual && !state.endReason) {
    state.endReason = {
      reason: input.manual.reason,
      by: input.manual.by ?? null,
      color: input.manual.color ?? null,
      at: state.endingAction.at,
    };
  }
}

export function queueReason(state: GameState): string {
  if (state.endReason?.reason) return state.endReason.reason;
  if (state.endingAction?.kind) return state.endingAction.kind;
  if (state.winner === "draw") return "draw";
  if (state.winner) return "finished";
  return "finished";
}

export function readAnalysisQueue(): AnalysisQueueEntry[] {
  const path = resolveAnalysisQueuePath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const entries: AnalysisQueueEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<AnalysisQueueEntry>;
      if (!parsed || typeof parsed.gameId !== "string" || !parsed.gameId) continue;
      entries.push({
        gameId: parsed.gameId,
        finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : "",
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      });
    } catch {
      // Skip a torn or non-JSON line.
    }
  }
  return entries;
}

/** Append one queue row per game id. Rewrites the file via temp-file rename. */
export function enqueueAnalysis(entry: AnalysisQueueEntry): void {
  if (!entry.gameId) return;
  const path = resolveAnalysisQueuePath();
  mkdirSync(dirname(path), { recursive: true });
  const existing = readAnalysisQueue();
  if (existing.some((row) => row.gameId === entry.gameId)) return;
  const body = existing
    .concat(entry)
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n";
  const tmp = join(dirname(path), `.analysis-queue-${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
}

export function enqueueFinishedGame(state: GameState): void {
  if (!state?.id) return;
  const finishedAt = state.endingAction?.at || state.endReason?.at || new Date().toISOString();
  enqueueAnalysis({
    gameId: state.id,
    finishedAt,
    reason: queueReason(state),
  });
}
