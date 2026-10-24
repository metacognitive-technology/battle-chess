/**
 * Genome loader and cand-r32 policy checks.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gameManager } from '../gameManager.ts';
import { createInitialBoard } from './gameUtils.ts';
import { actionIsLegal, chooseComputerAction, loadChampionGenome } from './choose.ts';
import type { AttackSettings, GameState } from './types.ts';

const GENOME_PATH = join(process.cwd(), 'server', 'policy', 'genomes', 'cand-r32.json');
const created: string[] = [];

function attack(partial: Partial<AttackSettings> = {}): AttackSettings {
  return {
    pawnSuccessRoll: 1,
    bishopMinRoll: 0,
    knightMinRoll: 4,
    bombSuccessRoll: 1,
    wallBuildRoll: 5,
    totalAttackBudget: 250,
    ...partial,
  };
}

function openingState(): GameState {
  return {
    id: 'policy-spec',
    board: createInitialBoard(),
    currentTurn: 'white',
    phase: 'playing',
    gameMode: 'cvc',
    aiControlled: { white: true, black: true },
    setupWallsRemaining: { white: 0, black: 0 },
    maxWallsPerPlayer: 0,
    moveHistory: [],
    capturedPieces: { white: [], black: [] },
    players: { white: 'ai-player', black: 'ai-player' },
    winner: null,
    attackSettings: attack({ pawnAttackPercent: 100, pawnSuccessRoll: 6 }),
    computerPolicy: 'cand-r32',
    maxBishopAttacks: 10,
    maxRookAttacks: 10,
    specialAttackCounts: {},
  };
}

function testGenomeMatchesFile(): void {
  const raw = JSON.parse(readFileSync(GENOME_PATH, 'utf8')) as Record<string, unknown>;
  const genome = loadChampionGenome();
  assert.equal(genome.id, 'cand-r32');
  assert.equal(genome.parent, 'cand-r28');
  assert.equal(genome.generation, 4);
  assert.equal(genome.lookahead_enabled, false);
  assert.equal(raw.lookahead_enabled, false);

  const weights = raw.weights as Record<string, number>;
  for (const [key, value] of Object.entries(weights)) {
    assert.equal(genome.weights[key as keyof typeof genome.weights], value, key);
  }
  const gates = raw.gates as Record<string, boolean>;
  for (const [key, value] of Object.entries(gates)) {
    assert.equal(genome.gates[key as keyof typeof genome.gates], value, key);
  }
  const loop = raw.loop as { max_attempts: number; check_closer_from_attempt: number };
  assert.equal(genome.loop.max_attempts, loop.max_attempts);
  assert.equal(genome.loop.check_closer_from_attempt, loop.check_closer_from_attempt);

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'boolean' || typeof value === 'number') {
      assert.equal((genome as unknown as Record<string, unknown>)[key], value, key);
    }
  }

  assert.equal(genome.flight_enabled, true);
  assert.equal(genome.nock_enabled, true);
  assert.equal(genome.crest_enabled, true);
  assert.equal(genome.king_guard_enabled, true);
  assert.equal(genome.illegal_filter_enabled, true);
  assert.equal(genome.quiescence_enabled, true);
  for (const flag of [
    'late_conv_enabled',
    'trade_down_enabled',
    'sheaf_enabled',
    'keel_enabled',
    'sift_enabled',
    'prod_enabled',
    'fletch_enabled',
    'pile_enabled',
    'haft_enabled',
    'quarrel_enabled',
    'bodkin_enabled',
    'brace_enabled',
    'mark_enabled',
  ] as const) {
    assert.equal(genome[flag], false, flag);
  }
  assert.equal(genome.weights.w_escape, 1000);
  assert.equal(genome.weights.w_pawn_capture, 250);
  assert.equal(genome.weights.w_oscillation, -5000);
  assert.match(genome.notes ?? '', /Never a move chooser/);
}

function testPolicyChoiceIsLegalAndStable(): void {
  const state = openingState();
  const first = chooseComputerAction(state);
  const second = chooseComputerAction(state);
  assert.ok(first, 'opening has a cand-r32 move');
  assert.deepEqual(second, first);
  assert.ok(['move', 'arrow', 'axe', 'bomb', 'wall'].includes(first.kind));
  assert.equal(actionIsLegal(state, first), true);
}

function testGameDefaults(): void {
  const requested = attack({
    pawnAttackPercent: 17,
    pawnSuccessRoll: 1,
    bishopAttackPercent: 50,
    knightAttackPercent: 50,
    bombAttackPercent: 10,
    wallBuildPercent: 50,
  });
  const cvc = gameManager.createCvCGame(0, requested, 8, undefined, false);
  created.push(cvc.gameId);
  assert.equal(cvc.state.computerPolicy, 'cand-r32');
  assert.equal(cvc.state.attackSettings.pawnAttackPercent, 100);
  assert.equal(cvc.state.attackSettings.pawnSuccessRoll, 6);
  assert.equal(cvc.state.attackSettings.bishopAttackPercent, 50);
  assert.equal(cvc.state.moveHistory.length, 0);

  const legacy = gameManager.createCvCGame(0, requested, 3, 'legacy', false);
  created.push(legacy.gameId);
  assert.equal(legacy.state.computerPolicy, 'legacy');
  assert.equal(legacy.state.aiDepth, 3);

  const pvc = gameManager.createGame({} as never, 0, 'pvc', requested, 'individual', 4, 'cand-r32');
  created.push(pvc.gameId);
  const room = gameManager.getRoom(pvc.gameId);
  assert.ok(room);
  assert.equal(room.state.computerPolicy, 'cand-r32');
  assert.equal(room.state.attackSettings.pawnAttackPercent, 100);
  const ai = room.state.blackAttackSettings;
  assert.ok(ai);
  assert.equal(ai.pawnAttackPercent, 100);
  assert.equal(ai.pawnSuccessRoll, 6);
  assert.equal(ai.bishopAttackPercent, 75);
  assert.equal(ai.knightAttackPercent, 75);
  assert.equal(ai.bombAttackPercent, 25);
  assert.equal(ai.wallBuildPercent, 50);

  room.state.phase = 'budget_setup';
  const rejected = gameManager.handleBudgetSubmit(pvc.playerId, attack({
    pawnAttackPercent: 0,
    bishopAttackPercent: 100,
    knightAttackPercent: 100,
    bombAttackPercent: 100,
    wallBuildPercent: 100,
  }));
  assert.equal(rejected, null);
  assert.equal(room.state.phase, 'budget_setup');

  const accepted = gameManager.handleBudgetSubmit(pvc.playerId, attack({
    pawnAttackPercent: 17,
    bishopAttackPercent: 100,
    knightAttackPercent: 100,
    bombAttackPercent: 40,
    wallBuildPercent: 10,
  }));
  assert.ok(accepted);
  assert.equal(accepted.whiteAttackSettings?.pawnAttackPercent, 100);
  assert.equal(accepted.whiteAttackSettings?.pawnSuccessRoll, 6);
  assert.equal(accepted.whiteAttackSettings?.bishopAttackPercent, 100);
  assert.equal(accepted.whiteAttackSettings?.knightAttackPercent, 100);

  const fileCandidates = [
    join(process.cwd(), 'server', 'data', 'games', `${cvc.gameId}.json`),
    join(process.cwd(), 'data', 'games', `${cvc.gameId}.json`),
  ];
  const file = fileCandidates.find((path) => existsSync(path));
  assert.ok(file, 'saved game file');
  const saved = JSON.parse(readFileSync(file, 'utf8')) as GameState;
  saved.attackSettings.pawnAttackPercent = 17;
  saved.attackSettings.pawnSuccessRoll = 1;
  writeFileSync(file, JSON.stringify(saved));
  const loaded = gameManager.loadGame(cvc.gameId);
  assert.ok(loaded);
  assert.equal(loaded.attackSettings.pawnAttackPercent, 100);
  assert.equal(loaded.attackSettings.pawnSuccessRoll, 6);
}

function testPawnRolls(): void {
  const miss = attack({ pawnAttackPercent: 0, pawnSuccessRoll: 1, bishopAttackPercent: 0 });
  for (let i = 0; i < 200; i++) {
    assert.equal(gameManager.resolveAttack('pawn', miss), true);
  }
  for (let i = 0; i < 30; i++) {
    assert.equal(gameManager.resolveAttack('bishop', miss), false);
  }
}

function main(): void {
  try {
    testGenomeMatchesFile();
    testPawnRolls();
    testGameDefaults();
    testPolicyChoiceIsLegalAndStable();
    console.log('policy.spec: ok');
  } finally {
    for (const id of created) gameManager.deleteGame(id);
  }
}

main();
