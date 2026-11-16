/**
 * Build one finished test game with setup walls and print its theater export.
 * Writes only under a temp GAMES_DIR. Does not touch saved games.
 *
 *   ./node_modules/.bin/tsx script/sample-walled-export.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'bc-sample-'));
const gamesDir = join(root, 'games');
const theaterDir = join(root, 'theater');
process.env.GAMES_DIR = gamesDir;
process.env.ANALYSIS_QUEUE_PATH = join(gamesDir, 'analysis-queue.jsonl');
process.env.ATTACK_STATS_PATH = join(root, 'attack_stats.json');
process.env.THEATER_ROOMS_DIR = theaterDir;
mkdirSync(theaterDir, { recursive: true });

const { gameManager } = await import('../server/gameManager.ts');

const whiteWalls = [
  { row: 8, col: 0 },
  { row: 8, col: 1 },
];
const blackWalls = [
  { row: 3, col: 0 },
  { row: 3, col: 1 },
];

const white = gameManager.createGame({} as never, 4, 'pvp');
const black = gameManager.joinGame({} as never, white.gameId);
if (!black) throw new Error('join failed');
if (!gameManager.handleLoadLayout(white.playerId, whiteWalls)) throw new Error('white layout failed');
if (!gameManager.handleLoadLayout(black.playerId, blackWalls)) throw new Error('black layout failed');
if (!gameManager.handleReady(white.playerId)) throw new Error('white ready failed');
const playing = gameManager.handleReady(black.playerId);
if (!playing || playing.phase !== 'playing') throw new Error('setup did not end');

const first = gameManager.handleMove(white.playerId, { row: 10, col: 2 }, { row: 9, col: 2 });
if (!first) throw new Error('white pawn move failed');
const second = gameManager.handleMove(black.playerId, { row: 1, col: 2 }, { row: 2, col: 2 });
if (!second) throw new Error('black pawn move failed');
const ended = gameManager.handleMove(white.playerId, { row: 0, col: 0 }, { row: 0, col: 0 }, true);
if (!ended || ended.state.phase !== 'finished') throw new Error('resign failed');

const roomDir = join(theaterDir, `bc3003-${white.gameId}`);
const room = JSON.parse(readFileSync(join(roomDir, 'room.json'), 'utf8'));
const snapshot = JSON.parse(readFileSync(join(roomDir, 'state.json'), 'utf8'));
const board = readFileSync(join(roomDir, 'board.txt'), 'utf8');
const gameJsonl = readFileSync(join(roomDir, 'game.jsonl'), 'utf8')
  .split(/\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

console.log(JSON.stringify({ room, snapshot, board, gameJsonl }, null, 2));
rmSync(root, { recursive: true, force: true });
