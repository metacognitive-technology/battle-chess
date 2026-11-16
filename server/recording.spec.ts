/**
 * Setup-wall recording, theater wall export, finish records, and the analysis queue.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import http from 'node:http';
import type { Board, GameState, Move, Position } from '@shared/schema';
import { gameManager } from './gameManager.ts';
import { readAnalysisQueue, resolveAnalysisQueuePath, resolveAttackStatsPath, resolveGamesDir } from './recording.ts';
import { registerRoutes } from './routes.ts';
import { parseSquare, squareName } from './policy/notation.ts';

const root = mkdtempSync(join(tmpdir(), 'bc-rec-'));
const gamesDir = join(root, 'games');
const theaterDir = join(root, 'theater');
process.env.GAMES_DIR = gamesDir;
process.env.ANALYSIS_QUEUE_PATH = join(gamesDir, 'analysis-queue.jsonl');
process.env.ATTACK_STATS_PATH = join(root, 'attack_stats.json');
process.env.THEATER_ROOMS_DIR = theaterDir;
mkdirSync(theaterDir, { recursive: true });

const created: string[] = [];
const cvcIds: string[] = [];
const realGamesDir = join(process.cwd(), 'server', 'data', 'games');
const statsPath = join(process.cwd(), 'server', 'data', 'attack_stats.json');
const statsBefore = existsSync(statsPath) ? readFileSync(statsPath, 'utf8') : null;

function ws() {
  return {} as never;
}

function track(id: string): string {
  created.push(id);
  return id;
}

function names(positions: Position[] | undefined): string[] {
  return (positions ?? []).map((pos) => squareName(pos)).sort();
}

function bySquare(a: Position, b: Position): number {
  return a.row - b.row || a.col - b.col;
}

function sameSquares(actual: Position[] | undefined, expected: Position[]): void {
  assert.deepEqual(names(actual), expected.map((pos) => squareName(pos)).sort());
}

function attack(partial: Record<string, number> = {}) {
  return {
    pawnSuccessRoll: 6,
    bishopMinRoll: 0,
    knightMinRoll: 4,
    bombSuccessRoll: 1,
    wallBuildRoll: 5,
    pawnAttackPercent: 100,
    bishopAttackPercent: 10,
    knightAttackPercent: 10,
    bombAttackPercent: 10,
    wallBuildPercent: 10,
    ...partial,
  };
}

function blankBoard(): Board {
  const board: Board = [];
  for (let row = 0; row < 12; row++) {
    const line = [];
    for (let col = 0; col < 12; col++) {
      line.push({ row, col, piece: null, isWall: false });
    }
    board.push(line);
  }
  return board;
}

function plyGrid() {
  return Array.from({ length: 12 }, () =>
    Array.from({ length: 12 }, () => ({ piece: null as { type: string; color: string; hasMoved?: boolean } | null, isWall: false })),
  );
}

function readExport(gameId: string) {
  const dir = join(theaterDir, `bc3003-${gameId}`);
  assert.equal(existsSync(join(dir, 'room.json')), true, `missing theater room for ${gameId}`);
  const room = JSON.parse(readFileSync(join(dir, 'room.json'), 'utf8')) as {
    settings: {
      whiteWalls: string[];
      blackWalls: string[];
      endingAction: GameState['endingAction'] | null;
      endReason: GameState['endReason'] | null;
    };
    state: GameState;
  };
  const snap = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
    endingAction: GameState['endingAction'] | null;
    endReason: GameState['endReason'] | null;
    moveHistory: string[];
  };
  const jsonl = readFileSync(join(dir, 'game.jsonl'), 'utf8');
  assert.ok(Array.isArray(room.settings.whiteWalls));
  assert.ok(Array.isArray(room.settings.blackWalls));
  return { room, snap, jsonl };
}

function queueRow(gameId: string) {
  return readAnalysisQueue().filter((row) => row.gameId === gameId);
}

async function waitUntil(label: string, pred: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function testDirs(): void {
  const savedGames = process.env.GAMES_DIR;
  const savedQueue = process.env.ANALYSIS_QUEUE_PATH;
  const savedStats = process.env.ATTACK_STATS_PATH;
  delete process.env.GAMES_DIR;
  delete process.env.ANALYSIS_QUEUE_PATH;
  delete process.env.ATTACK_STATS_PATH;
  try {
    const serverDir = dirname(fileURLToPath(import.meta.url));
    const expected = join(serverDir, 'data', 'games');
    assert.equal(resolveGamesDir(), expected);
    assert.equal(resolveAnalysisQueuePath(), join(expected, 'analysis-queue.jsonl'));
    assert.equal(resolveAttackStatsPath(), join(serverDir, 'data', 'attack_stats.json'));
  } finally {
    process.env.GAMES_DIR = savedGames;
    process.env.ANALYSIS_QUEUE_PATH = savedQueue;
    process.env.ATTACK_STATS_PATH = savedStats;
  }

  const other = join(root, 'games-other');
  process.env.GAMES_DIR = other;
  const made = gameManager.createGame(ws(), 0, 'pvc');
  track(made.gameId);
  assert.equal(existsSync(join(other, `${made.gameId}.json`)), true);
  assert.equal(existsSync(join(gamesDir, `${made.gameId}.json`)), false);
  assert.equal(existsSync(join(realGamesDir, `${made.gameId}.json`)), false);
  process.env.GAMES_DIR = gamesDir;

  delete process.env.ANALYSIS_QUEUE_PATH;
  try {
    assert.equal(resolveAnalysisQueuePath(), join(gamesDir, 'analysis-queue.jsonl'));
  } finally {
    process.env.ANALYSIS_QUEUE_PATH = savedQueue;
  }
}

/** Server flush (not the path helper alone) creates a missing ATTACK_STATS_PATH. */
function testAttackStatsMissingFile(): void {
  const saved = process.env.ATTACK_STATS_PATH;
  const nested = join(root, 'stats-missing', 'nested', 'attack_stats.json');
  assert.equal(existsSync(nested), false);
  assert.equal(existsSync(dirname(nested)), false);
  process.env.ATTACK_STATS_PATH = nested;
  try {
    assert.equal(resolveAttackStatsPath(), nested);
    const before = gameManager.getAttackStats();
    assert.equal(before.gamesPlayed, 0);
    assert.equal(existsSync(nested), false, 'reading a missing stats file must not throw or invent a row');

    const made = gameManager.createGame(ws(), 0, 'pvc');
    track(made.gameId);
    assert.equal(gameManager.getRoom(made.gameId)?.state.phase, 'playing');
    const ended = gameManager.handleMove(made.playerId, { row: 0, col: 0 }, { row: 0, col: 0 }, true);
    assert.ok(ended);
    assert.equal(ended.state.winner, 'black');
    assert.equal(existsSync(nested), true, 'flush creates a missing ATTACK_STATS_PATH, including parent directories');
    const body = JSON.parse(readFileSync(nested, 'utf8')) as {
      games: { bishopArrows: number; rookBombs: number; rookWallBuilds: number }[];
    };
    assert.equal(body.games.length, 1);
    assert.deepEqual(body.games[0], { bishopArrows: 0, rookBombs: 0, rookWallBuilds: 0 });
    assert.equal(gameManager.getAttackStats().gamesPlayed, 1);
    assert.equal(existsSync(statsPath) ? readFileSync(statsPath, 'utf8') : null, statsBefore);
  } finally {
    process.env.ATTACK_STATS_PATH = saved;
  }
}

function testLayoutReadyAndExport(): void {
  const whiteWalls = [{ row: 8, col: 0 }, { row: 7, col: 3 }];
  const blackWalls = [{ row: 4, col: 1 }, { row: 2, col: 5 }];
  const createdGame = gameManager.createGame(ws(), 4, 'pvp');
  const gameId = track(createdGame.gameId);
  const black = gameManager.joinGame(ws(), gameId);
  assert.ok(black);
  assert.equal(gameManager.handleLoadLayout(createdGame.playerId, whiteWalls)?.phase, 'setup');
  assert.equal(gameManager.handleLoadLayout(black.playerId, blackWalls)?.phase, 'setup');
  const oneReady = gameManager.handleReady(createdGame.playerId);
  assert.equal(oneReady?.phase, 'setup');
  assert.equal(oneReady?.setupWalls, undefined);

  const started = gameManager.handleReady(black.playerId);
  assert.equal(started?.phase, 'playing');
  sameSquares(started?.setupWalls?.white, whiteWalls);
  sameSquares(started?.setupWalls?.black, blackWalls);
  assert.equal(started?.moveHistory.length, 0);

  const whiteMove = gameManager.handleMove(createdGame.playerId, { row: 10, col: 2 }, { row: 9, col: 2 });
  assert.ok(whiteMove);
  const blackMove = gameManager.handleMove(black.playerId, { row: 1, col: 2 }, { row: 2, col: 2 });
  assert.ok(blackMove);
  assert.equal(blackMove.state.setupWalls?.white.length, 2);
  assert.equal(blackMove.state.moveHistory.length, 2);

  const ended = gameManager.handleMove(createdGame.playerId, { row: 0, col: 0 }, { row: 0, col: 0 }, true);
  assert.ok(ended);
  assert.equal(ended.state.endingAction?.kind, 'resignation');
  assert.equal(ended.state.endReason?.reason, 'resignation');
  assert.equal(ended.state.endReason?.by, createdGame.playerId);
  assert.equal(ended.state.endReason?.color, 'white');
  assert.equal(ended.state.endReason?.at, ended.state.endingAction?.at);
  assert.equal(ended.state.winner, 'black');
  assert.equal(ended.state.endingAction?.notation, null);
  assert.match(ended.state.endingAction?.at ?? '', /^\d{4}-\d{2}-\d{2}T/);

  const loaded = gameManager.loadGame(gameId);
  assert.ok(loaded);
  sameSquares(loaded.setupWalls?.white, whiteWalls);
  assert.equal(loaded.endingAction?.kind, 'resignation');
  assert.equal(loaded.endReason?.by, createdGame.playerId);

  const exported = readExport(gameId);
  assert.deepEqual([...exported.room.settings.whiteWalls].sort(), whiteWalls.map(squareName).sort());
  assert.deepEqual([...exported.room.settings.blackWalls].sort(), blackWalls.map(squareName).sort());
  assert.deepEqual(exported.room.settings.whiteWalls.map(parseSquare).sort(bySquare), [...whiteWalls].sort(bySquare));
  assert.deepEqual(exported.room.settings.blackWalls.map(parseSquare).sort(bySquare), [...blackWalls].sort(bySquare));
  assert.equal(exported.room.settings.endingAction?.kind, 'resignation');
  assert.equal(exported.room.settings.endReason?.reason, 'resignation');
  assert.equal(exported.snap.endingAction?.kind, 'resignation');
  assert.equal(exported.snap.endReason?.by, createdGame.playerId);
  const lines = exported.jsonl.trim().split(/\n/).filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(lines.some((line) => line.includes('setup')), false);

  const replay = gameManager.createGame(ws(), 4, 'pvp');
  track(replay.gameId);
  const replayBlack = gameManager.joinGame(ws(), replay.gameId);
  assert.ok(replayBlack);
  assert.ok(gameManager.handleLoadLayout(replay.playerId, exported.room.settings.whiteWalls.map(parseSquare)));
  assert.ok(gameManager.handleLoadLayout(replayBlack.playerId, exported.room.settings.blackWalls.map(parseSquare)));
  gameManager.handleReady(replay.playerId);
  const replayStarted = gameManager.handleReady(replayBlack.playerId);
  sameSquares(replayStarted?.setupWalls?.white, whiteWalls);
  sameSquares(replayStarted?.setupWalls?.black, blackWalls);

  const before = names(ended.state.setupWalls?.white);
  ended.state.board[8][11].isWall = true;
  gameManager.saveGame(ended.state);
  const again = gameManager.loadGame(gameId);
  assert.deepEqual(names(again?.setupWalls?.white), before);
  assert.equal(queueRow(gameId).length, 1);
  assert.equal(queueRow(gameId)[0].reason, 'resignation');
}

function testAiRandomMazeAndDirectPlaying(): void {
  const pvc = gameManager.createGame(ws(), 2, 'pvc');
  track(pvc.gameId);
  const beforeReady = gameManager.getRoom(pvc.gameId)?.state;
  assert.equal(beforeReady?.phase, 'setup');
  assert.equal(beforeReady?.setupWalls, undefined);
  assert.equal(beforeReady?.setupWallsRemaining.black, 0);
  assert.ok(gameManager.handleSetupWall(pvc.playerId, { row: 8, col: 0 }));
  const started = gameManager.handleReady(pvc.playerId);
  assert.equal(started?.phase, 'playing');
  assert.equal(started?.setupWalls?.black.length, 2);
  assert.ok(started?.setupWalls?.black.every((pos) => pos.row < 6));
  sameSquares(started?.setupWalls?.white, [{ row: 8, col: 0 }]);
  assert.equal(started?.moveHistory.length, 0);

  const randomWhite = gameManager.createGame(ws(), 3, 'pvp');
  track(randomWhite.gameId);
  const randomBlack = gameManager.joinGame(ws(), randomWhite.gameId);
  assert.ok(randomBlack);
  assert.equal(gameManager.handleRandomWalls(randomWhite.playerId)?.phase, 'setup');
  gameManager.handleReady(randomWhite.playerId);
  const randomStarted = gameManager.handleReady(randomBlack.playerId);
  assert.equal(randomStarted?.phase, 'playing');
  assert.equal(randomStarted?.setupWalls?.white.length, 3);
  assert.ok(randomStarted?.setupWalls?.white.every((pos) => pos.row >= 6));
  assert.deepEqual(randomStarted?.setupWalls?.black, []);
  assert.equal(randomStarted?.moveHistory.length, 0);

  const mazeWhite = gameManager.createGame(ws(), 4, 'pvp');
  track(mazeWhite.gameId);
  const mazeBlack = gameManager.joinGame(ws(), mazeWhite.gameId);
  assert.ok(mazeBlack);
  assert.ok(gameManager.handleMazeWalls(mazeBlack.playerId));
  gameManager.handleReady(mazeWhite.playerId);
  const mazeStarted = gameManager.handleReady(mazeBlack.playerId);
  assert.equal(mazeStarted?.setupWalls?.black.length, 4);
  assert.ok(mazeStarted?.setupWalls?.black.every((pos) => pos.row < 6));
  assert.equal(mazeStarted?.moveHistory.length, 0);

  const zeroPvc = gameManager.createGame(ws(), 0, 'pvc');
  track(zeroPvc.gameId);
  const zeroState = gameManager.getRoom(zeroPvc.gameId)?.state;
  assert.equal(zeroState?.phase, 'playing');
  assert.deepEqual(zeroState?.setupWalls, { white: [], black: [] });

  const zeroPvp = gameManager.createGame(ws(), 0, 'pvp');
  track(zeroPvp.gameId);
  assert.equal(gameManager.getRoom(zeroPvp.gameId)?.state.setupWalls, undefined);
  const joined = gameManager.joinGame(ws(), zeroPvp.gameId);
  assert.equal(joined && gameManager.getRoom(zeroPvp.gameId)?.state.phase, 'playing');
  assert.deepEqual(gameManager.getRoom(zeroPvp.gameId)?.state.setupWalls, { white: [], black: [] });

  const budget = gameManager.createGame(ws(), 0, 'pvp', undefined, 'individual');
  track(budget.gameId);
  const budgetBlack = gameManager.joinGame(ws(), budget.gameId);
  assert.ok(budgetBlack);
  assert.equal(gameManager.getRoom(budget.gameId)?.state.phase, 'budget_setup');
  assert.ok(gameManager.handleBudgetSubmit(budget.playerId, attack()));
  assert.equal(gameManager.getRoom(budget.gameId)?.state.phase, 'budget_setup');
  assert.equal(gameManager.getRoom(budget.gameId)?.state.setupWalls, undefined);
  const both = gameManager.handleBudgetSubmit(budgetBlack.playerId, attack());
  assert.equal(both?.phase, 'playing');
  assert.deepEqual(both?.setupWalls, { white: [], black: [] });
}

function testCvcAndPlyWalls(): void {
  const cvc = gameManager.createCvCGame(4, attack(), 0, 'cand-r32', false);
  track(cvc.gameId);
  assert.equal(cvc.state.phase, 'playing');
  assert.equal(cvc.state.setupWalls?.white.length, 4);
  assert.equal(cvc.state.setupWalls?.black.length, 4);
  assert.ok(cvc.state.setupWalls?.white.every((pos) => pos.row >= 6));
  assert.ok(cvc.state.setupWalls?.black.every((pos) => pos.row < 6));
  assert.equal(cvc.state.moveHistory.length, 0);

  const grid = plyGrid();
  grid[3][2].isWall = true;
  grid[9][4].isWall = true;
  grid[9][5].isWall = true;
  const ply = gameManager.createPvcFromPly({ board: grid, sideToMove: 'white' });
  track(ply.gameId);
  const plyState = gameManager.getRoom(ply.gameId)?.state;
  assert.equal(plyState?.phase, 'playing');
  sameSquares(plyState?.setupWalls?.black, [{ row: 3, col: 2 }]);
  sameSquares(plyState?.setupWalls?.white, [{ row: 9, col: 4 }, { row: 9, col: 5 }]);
  assert.equal(plyState?.moveHistory.length, 0);
}

function testKingCaptureAndCheckmate(): void {
  const capture = plyGrid();
  capture[0][0].piece = { type: 'king', color: 'black', hasMoved: true };
  capture[0][2].piece = { type: 'rook', color: 'white', hasMoved: true };
  capture[11][4].piece = { type: 'king', color: 'white', hasMoved: true };
  const captureGame = gameManager.createPvcFromPly({ board: capture, sideToMove: 'white' });
  track(captureGame.gameId);
  assert.equal(gameManager.reconnectPlayer(ws(), captureGame.playerId, captureGame.gameId), true);
  const captured = gameManager.handleMove(captureGame.playerId, { row: 0, col: 2 }, { row: 0, col: 0 });
  assert.ok(captured, 'rook captures the king');
  assert.equal(captured.state.winner, 'white');
  assert.equal(captured.state.endingAction?.kind, 'king_capture');
  assert.equal(captured.state.endingAction?.by, 'white');
  assert.equal(captured.state.endingAction?.ply, 1);
  assert.match(captured.state.endingAction?.notation ?? '', /xa12/);
  assert.equal(captured.state.endReason, undefined);
  const captureExport = readExport(captureGame.gameId);
  assert.equal(captureExport.room.settings.endingAction?.kind, 'king_capture');
  assert.deepEqual(captureExport.room.settings.whiteWalls, []);
  assert.deepEqual(captureExport.room.settings.blackWalls, []);
  assert.equal(gameManager.loadGame(captureGame.gameId)?.endingAction?.kind, 'king_capture');

  const mate = plyGrid();
  mate[0][0].piece = { type: 'king', color: 'black', hasMoved: true };
  mate[0][2].piece = { type: 'queen', color: 'white', hasMoved: true };
  mate[1][1].piece = { type: 'king', color: 'white', hasMoved: true };
  const mateGame = gameManager.createPvcFromPly({ board: mate, sideToMove: 'white' });
  track(mateGame.gameId);
  assert.equal(gameManager.reconnectPlayer(ws(), mateGame.playerId, mateGame.gameId), true);
  const mated = gameManager.handleMove(mateGame.playerId, { row: 0, col: 2 }, { row: 0, col: 1 });
  assert.ok(mated, 'queen delivers mate');
  assert.equal(mated.state.winner, 'white');
  assert.equal(mated.state.phase, 'finished');
  assert.equal(mated.state.endingAction?.kind, 'checkmate');
  assert.equal(mated.state.endingAction?.notation, 'Qc12b12');
  assert.equal(mated.state.endingAction?.ply, 1);
  assert.equal(readExport(mateGame.gameId).snap.endingAction?.kind, 'checkmate');
}

function testManualEndsAndQueue(): void {
  const drawGame = gameManager.createGame(ws(), 0, 'pvp');
  track(drawGame.gameId);
  const drawBlack = gameManager.joinGame(ws(), drawGame.gameId);
  assert.ok(drawBlack);
  const drawn = gameManager.acceptDraw(drawGame.gameId, drawBlack.playerId);
  assert.ok(drawn);
  assert.equal(drawn.winner, 'draw');
  assert.equal(drawn.endingAction?.kind, 'draw_agreed');
  assert.equal(drawn.endReason?.reason, 'draw_agreed');
  assert.equal(drawn.endReason?.by, drawBlack.playerId);
  assert.equal(drawn.endReason?.color, 'black');
  assert.equal(readExport(drawGame.gameId).room.settings.endReason?.reason, 'draw_agreed');
  assert.equal(queueRow(drawGame.gameId).length, 1);
  gameManager.saveGame(drawn);
  assert.equal(queueRow(drawGame.gameId).length, 1);

  const stopped = gameManager.createCvCGame(0, attack(), 0, 'cand-r32', false);
  track(stopped.gameId);
  const stoppedState = gameManager.stopCvCGame(stopped.gameId, 'operator-1');
  assert.equal(stoppedState?.phase, 'finished');
  assert.equal(stoppedState?.winner, null);
  assert.equal(stoppedState?.endingAction?.kind, 'stopped');
  assert.equal(stoppedState?.endReason?.reason, 'stopped');
  assert.equal(stoppedState?.endReason?.by, 'operator-1');
  assert.equal(queueRow(stopped.gameId)[0]?.reason, 'stopped');
  gameManager.stopCvCGame(stopped.gameId, 'operator-2');
  assert.equal(gameManager.loadGame(stopped.gameId)?.endReason?.by, 'operator-1');

  const live = gameManager.createGame(ws(), 0, 'pvp');
  track(live.gameId);
  const stranger = gameManager.deleteGame(live.gameId, 'not-a-player');
  assert.equal(stranger, false);
  assert.equal(existsSync(join(gamesDir, `${live.gameId}.json`)), true);
  assert.equal(queueRow(live.gameId).length, 0);
  assert.equal(gameManager.deleteGame(live.gameId, live.playerId), true);
  assert.equal(existsSync(join(gamesDir, `${live.gameId}.json`)), false);
  assert.equal(queueRow(live.gameId)[0]?.reason, 'deleted');
  const deletedExport = readExport(live.gameId);
  assert.equal(deletedExport.room.settings.endReason?.reason, 'deleted');
  assert.equal(deletedExport.room.settings.endReason?.by, live.playerId);
  assert.equal(deletedExport.room.settings.endingAction?.kind, 'deleted');

  const finished = gameManager.createGame(ws(), 0, 'pvp');
  track(finished.gameId);
  const finishedBlack = gameManager.joinGame(ws(), finished.gameId);
  assert.ok(finishedBlack);
  gameManager.handleMove(finished.playerId, { row: 0, col: 0 }, { row: 0, col: 0 }, true);
  assert.equal(gameManager.deleteGame(finished.gameId, finished.playerId), true);
  assert.equal(queueRow(finished.gameId).length, 1);
  assert.equal(queueRow(finished.gameId)[0]?.reason, 'resignation');

  const listed = gameManager.listSavedGames().map((game) => game.id);
  assert.equal(listed.includes('analysis-queue'), false);
  const raw = readFileSync(process.env.ANALYSIS_QUEUE_PATH!, 'utf8');
  const fromDisk = raw.trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line) as { gameId: string });
  assert.deepEqual(fromDisk.map((row) => row.gameId), readAnalysisQueue().map((row) => row.gameId));
  assert.equal(fromDisk.filter((row) => row.gameId === drawGame.gameId).length, 1);
}

function testAdminWipe(): void {
  const dir = join(root, 'wipe');
  const queue = join(dir, 'queue.jsonl');
  const prevGames = process.env.GAMES_DIR;
  const prevQueue = process.env.ANALYSIS_QUEUE_PATH;
  process.env.GAMES_DIR = dir;
  process.env.ANALYSIS_QUEUE_PATH = queue;
  try {
    const live = gameManager.createGame(ws(), 0, 'pvp');
    const done = gameManager.createGame(ws(), 0, 'pvp');
    const doneBlack = gameManager.joinGame(ws(), done.gameId);
    assert.ok(doneBlack);
    gameManager.handleMove(done.playerId, { row: 0, col: 0 }, { row: 0, col: 0 }, true);
    const removed = gameManager.deleteAllGames();
    assert.equal(removed, 2);
    assert.equal(existsSync(join(dir, `${live.gameId}.json`)), false);
    const rows = readAnalysisQueue();
    assert.equal(rows.find((row) => row.gameId === live.gameId)?.reason, 'deleted');
    assert.equal(rows.find((row) => row.gameId === done.gameId)?.reason, 'resignation');
    const liveExport = JSON.parse(readFileSync(join(theaterDir, `bc3003-${live.gameId}`, 'room.json'), 'utf8')) as {
      settings: { endReason: { by: string } };
    };
    assert.equal(liveExport.settings.endReason.by, 'admin');
  } finally {
    process.env.GAMES_DIR = prevGames;
    process.env.ANALYSIS_QUEUE_PATH = prevQueue;
  }
}

function testOldSave(): void {
  const oldId = 'oldsave01';
  const board = blankBoard();
  board[11][4].piece = { type: 'king', color: 'white', id: 'wk' };
  board[0][4].piece = { type: 'king', color: 'black', id: 'bk' };
  const old: Record<string, unknown> = {
    id: oldId,
    board,
    currentTurn: 'black',
    phase: 'finished',
    gameMode: 'pvp',
    setupWallsRemaining: { white: 0, black: 0 },
    maxWallsPerPlayer: 3,
    moveHistory: [{
      from: { row: 10, col: 2 },
      to: { row: 9, col: 2 },
      piece: { type: 'pawn', color: 'white' },
      notation: 'c2c3',
    }],
    capturedPieces: { white: [], black: [] },
    players: { white: 'old-white', black: 'old-black' },
    winner: 'white',
    attackSettings: attack(),
  };
  mkdirSync(gamesDir, { recursive: true });
  writeFileSync(join(gamesDir, `${oldId}.json`), JSON.stringify(old));
  const loaded = gameManager.loadGame(oldId);
  assert.ok(loaded);
  assert.equal(loaded.setupWalls, undefined);
  assert.equal(loaded.endingAction, undefined);
  assert.equal(loaded.endReason, undefined);
  assert.equal(loaded.moveHistory.length, 1);
  assert.equal(loaded.winner, 'white');
  gameManager.saveGame(loaded);
  const exported = readExport(oldId);
  assert.deepEqual(exported.room.settings.whiteWalls, []);
  assert.deepEqual(exported.room.settings.blackWalls, []);
  assert.equal(exported.room.settings.endingAction, null);
  assert.equal(exported.room.settings.endReason, null);
  assert.equal(exported.snap.endingAction, null);
  assert.equal(exported.snap.endReason, null);
  assert.equal(queueRow(oldId)[0]?.reason, 'finished');
  gameManager.saveGame(loaded);
  assert.equal(queueRow(oldId).length, 1);
  const listed = gameManager.listSavedGames();
  assert.ok(listed.some((game) => game.id === oldId));
}

async function testNoMoveAndMoveCap(): Promise<void> {
  const stalemate = gameManager.createCvCGame(0, attack(), 0, 'cand-r32', true);
  track(stalemate.gameId);
  cvcIds.push(stalemate.gameId);
  const boxed = blankBoard();
  boxed[6][6].piece = { type: 'king', color: 'black', hasMoved: true, id: 'bk' };
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      boxed[6 + dr][6 + dc].isWall = true;
    }
  }
  boxed[0][0].piece = { type: 'king', color: 'white', hasMoved: true, id: 'wk' };
  stalemate.state.board = boxed;
  stalemate.state.currentTurn = 'black';
  stalemate.state.moveHistory = [];
  await waitUntil('stalemate', () => gameManager.getRoom(stalemate.gameId)?.state.phase === 'finished');
  const stale = gameManager.getRoom(stalemate.gameId)?.state;
  assert.equal(stale?.winner, 'draw');
  assert.equal(stale?.endingAction?.kind, 'stalemate');
  assert.equal(stale?.endingAction?.notation, null);
  assert.equal(stale?.endingAction?.detail, 'no legal move');
  assert.equal(queueRow(stalemate.gameId)[0]?.reason, 'stalemate');

  const capped = gameManager.createCvCGame(0, attack(), 0, 'cand-r32', true);
  track(capped.gameId);
  cvcIds.push(capped.gameId);
  const filler: Move = {
    from: { row: 10, col: 2 },
    to: { row: 9, col: 2 },
    piece: { type: 'pawn', color: 'white' },
    notation: 'c2c3',
  };
  for (let i = 0; i < 499; i++) capped.state.moveHistory.push({ ...filler, piece: { ...filler.piece } });
  await waitUntil('max moves', () => gameManager.getRoom(capped.gameId)?.state.endingAction?.kind === 'max_moves', 12000);
  const capState = gameManager.getRoom(capped.gameId)?.state;
  assert.equal(capState?.winner, 'draw');
  assert.equal(capState?.endingAction?.kind, 'max_moves');
  assert.ok((capState?.moveHistory.length ?? 0) >= 500);
  assert.equal(capState?.endReason, undefined);
  assert.equal(gameManager.loadGame(capped.gameId)?.endingAction?.kind, 'max_moves');
  assert.equal(queueRow(capped.gameId)[0]?.reason, 'max_moves');
}

async function testQueueApi(): Promise<void> {
  const app = express();
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/analysis-queue`);
    assert.equal(res.status, 200);
    const body = await res.json() as { gameId: string; finishedAt: string; reason: string }[];
    assert.ok(Array.isArray(body));
    assert.ok(body.some((row) => row.reason === 'resignation' && row.finishedAt));
    assert.ok(body.some((row) => row.reason === 'king_capture'));
    assert.equal(body.some((row) => row.gameId === 'analysis-queue'), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function main(): Promise<void> {
  try {
    testDirs();
    testAttackStatsMissingFile();
    testLayoutReadyAndExport();
    testAiRandomMazeAndDirectPlaying();
    testCvcAndPlyWalls();
    testKingCaptureAndCheckmate();
    testManualEndsAndQueue();
    testAdminWipe();
    testOldSave();
    await testNoMoveAndMoveCap();
    await testQueueApi();
    if (statsBefore !== null) {
      assert.equal(readFileSync(statsPath, 'utf8'), statsBefore);
    }
    const redirected = JSON.parse(readFileSync(process.env.ATTACK_STATS_PATH!, 'utf8')) as { games: unknown[] };
    assert.ok(redirected.games.length >= 1, 'finished games flush attack stats to ATTACK_STATS_PATH');
    console.log('recording.spec: ok');
  } finally {
    for (const id of cvcIds) {
      try { gameManager.stopCvCGame(id); } catch { /* already stopped */ }
    }
    process.env.GAMES_DIR = gamesDir;
    for (const id of created) {
      try { gameManager.deleteGame(id); } catch { /* already removed */ }
    }
    if (statsBefore === null) {
      if (existsSync(statsPath)) unlinkSync(statsPath);
    } else if (!existsSync(statsPath) || readFileSync(statsPath, 'utf8') !== statsBefore) {
      writeFileSync(statsPath, statsBefore);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
