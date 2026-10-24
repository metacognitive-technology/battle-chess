/**
 * Headless cand-r32 vs cand-r32 games.
 * Run: npm run cvc-smoke
 *
 * Each ply must be one of the policy legal actions. Pawn attacks must land.
 * Games stop at a finished position or at the ply cap. Walls are off so the
 * games stay on the opening policy and finish the check sooner.
 *
 * The cap is CVC_PLY_CAP (positive integer). Default 40. It only stops the
 * smoke loop. It does not change move choice or attack resolution.
 * Example: CVC_PLY_CAP=400 npm run cvc-smoke
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gameManager } from '../server/gameManager.ts';
import { collectLegalActions } from '../server/policy/computerPolicy.ts';
import { squareName } from '../server/policy/notation.ts';
import type { AttackSettings, Move } from '../shared/schema.ts';

const GAMES = 5;

function readPlyCap(): number {
  const raw = process.env.CVC_PLY_CAP;
  if (raw === undefined || raw.trim() === '') return 40;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    throw new Error(`CVC_PLY_CAP must be an integer from 1 to 10000, got ${JSON.stringify(raw)}`);
  }
  return n;
}

const PLY_CAP = readPlyCap();

function moveKey(move: Move): string {
  const kind = move.isArrowAttack ? 'arrow'
    : move.isAxeAttack ? 'axe'
    : move.isBombAttack ? 'bomb'
    : move.isWallBuild ? 'wall'
    : 'move';
  return `${kind}:${squareName(move.from)}:${squareName(move.to)}`;
}

const requested: AttackSettings = {
  pawnSuccessRoll: 1,
  bishopMinRoll: 0,
  knightMinRoll: 4,
  bombSuccessRoll: 1,
  wallBuildRoll: 5,
  totalAttackBudget: 250,
  pawnAttackPercent: 17,
  bishopAttackPercent: 50,
  knightAttackPercent: 50,
  bombAttackPercent: 10,
  wallBuildPercent: 50,
};

function snapshot(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function restore(path: string, previous: string | null): void {
  if (previous === null) return;
  if (existsSync(path) && readFileSync(path, 'utf8') !== previous) {
    writeFileSync(path, previous);
  }
}

async function main(): Promise<void> {
  const statsPaths = [
    join(process.cwd(), 'server', 'data', 'attack_stats.json'),
    join(process.cwd(), 'data', 'attack_stats.json'),
  ];
  const statsBefore = statsPaths.map((path) => ({ path, body: snapshot(path) }));
  const ids: string[] = [];
  const games: { game: number; gameId: string; plies: number; finished: boolean; winner: string | null; ms: number }[] = [];
  let illegalMoves = 0;
  let pawnAttacks = 0;
  let pawnHits = 0;

  try {
    for (let g = 0; g < GAMES; g++) {
      const started = Date.now();
      const { gameId, state } = gameManager.createCvCGame(0, requested, 0, 'cand-r32', false);
      ids.push(gameId);
      assert.equal(state.computerPolicy, 'cand-r32');
      assert.equal(state.attackSettings.pawnAttackPercent, 100);
      assert.equal(state.attackSettings.pawnSuccessRoll, 6);
      assert.equal(state.attackSettings.bishopAttackPercent, 50);
      let plies = 0;
      let finished = false;

      while (plies < PLY_CAP) {
        const room = gameManager.getRoom(gameId);
        if (!room || room.state.phase !== 'playing') {
          finished = room?.state.phase === 'finished';
          break;
        }
        const legalKeys = new Set(
          collectLegalActions(room.state).map((action) => `${action.kind}:${action.from}:${action.to}`),
        );
        const before = room.state.moveHistory.length;
        const t0 = Date.now();
        const result = await gameManager.makeAIMove(gameId);
        const dt = Date.now() - t0;
        const after = gameManager.getRoom(gameId)?.state;
        assert.ok(after);
        if (!result || after.moveHistory.length === before) {
          if (legalKeys.size > 0 && after.phase === 'playing') {
            illegalMoves += 1;
            throw new Error(`game ${g + 1} ply ${plies + 1}: no move applied (${legalKeys.size} legal)`);
          }
          finished = after.phase === 'finished';
          break;
        }
        const played = after.moveHistory[after.moveHistory.length - 1];
        const key = moveKey(played);
        if (!legalKeys.has(key)) {
          illegalMoves += 1;
          throw new Error(`game ${g + 1} ply ${plies + 1}: illegal ${key}`);
        }
        if (played.piece.type === 'pawn' && played.diceRoll !== undefined) {
          pawnAttacks += 1;
          if (played.success !== true) {
            throw new Error(`game ${g + 1}: pawn attack missed (${key})`);
          }
          pawnHits += 1;
        }
        plies += 1;
        console.log(`game ${g + 1} ply ${plies} ${key} ${dt}ms phase=${after.phase}`);
        if (after.phase === 'finished') {
          finished = true;
          break;
        }
      }

      const end = gameManager.getRoom(gameId)?.state;
      const winner = end?.phase === 'finished' ? (end.winner ?? null) : null;
      if (end?.phase === 'finished') finished = true;
      const row = { game: g + 1, gameId, plies, finished, winner, ms: Date.now() - started };
      games.push(row);
      console.log(`game ${g + 1} done ${JSON.stringify(row)}`);
    }

    let directPawnHits = 0;
    for (let i = 0; i < 200; i++) {
      const ok = gameManager.resolveAttack('pawn', {
        pawnSuccessRoll: 1,
        bishopMinRoll: 0,
        knightMinRoll: 4,
        bombSuccessRoll: 1,
        wallBuildRoll: 5,
        pawnAttackPercent: 0,
      });
      assert.equal(ok, true);
      directPawnHits += 1;
    }
    for (let i = 0; i < 30; i++) {
      assert.equal(gameManager.resolveAttack('bishop', {
        pawnSuccessRoll: 6,
        bishopMinRoll: 0,
        knightMinRoll: 4,
        bombSuccessRoll: 1,
        wallBuildRoll: 5,
        bishopAttackPercent: 0,
      }), false);
    }

    const report = {
      games: games.length,
      finished: games.filter((game) => game.finished).length,
      winners: games.map((game) => game.winner),
      plies: games.map((game) => game.plies),
      totalPlies: games.reduce((sum, game) => sum + game.plies, 0),
      illegalMoves,
      pawnAttacks,
      pawnHits,
      pawnHitRate: pawnAttacks === 0 ? null : pawnHits / pawnAttacks,
      directPawnRolls: directPawnHits,
      directPawnHitRate: 1,
      maxWalls: 0,
      plyCap: PLY_CAP,
      policy: 'cand-r32',
    };
    console.log(`CVC_SMOKE ${JSON.stringify(report)}`);
    writeFileSync('/tmp/bc-out/cvc-smoke.json', JSON.stringify(report, null, 2));
    assert.equal(report.games, GAMES);
    assert.equal(report.illegalMoves, 0);
    assert.ok(report.totalPlies >= GAMES);
  } finally {
    for (const id of ids) gameManager.deleteGame(id);
    for (const snap of statsBefore) restore(snap.path, snap.body);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
