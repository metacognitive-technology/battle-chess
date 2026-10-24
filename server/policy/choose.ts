/**
 * Turn the FILTER champion into the computer's move.
 *
 * The lab ranks the legal list and rejects a bad proposal. There is no model
 * here, and lookahead_enabled is false, so the computer plays the top ranked
 * action. If the filter would reject that action, it plays the filter's
 * substitute. Every accepted action is one the lab legal-list builder returned.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import rawChampion from './genomes/cand-r32.json';
import {
  collectLegalActions,
  evaluateState,
  filterStatePick,
  type PolicyAction,
} from './computerPolicy.ts';
import { normalizeGenome, setPolicyGenome, type PolicyGenome } from './policyGenome.ts';
import type { GameState } from './types.ts';

export function championGenomePath(): string {
  const env = process.env.POLICY_GENOME?.trim();
  if (env) return isAbsolute(env) ? env : join(process.cwd(), env);
  return join(process.cwd(), 'server', 'policy', 'genomes', 'cand-r32.json');
}

function readChampion(): PolicyGenome {
  const env = process.env.POLICY_GENOME?.trim();
  if (env) {
    const path = isAbsolute(env) ? env : join(process.cwd(), env);
    return normalizeGenome(JSON.parse(readFileSync(path, 'utf8')), 'cand-r32');
  }
  const bundledPath = championGenomePath();
  if (existsSync(bundledPath)) {
    return normalizeGenome(JSON.parse(readFileSync(bundledPath, 'utf8')), 'cand-r32');
  }
  return normalizeGenome(rawChampion, 'cand-r32');
}

let cached: PolicyGenome | null = null;

export function loadChampionGenome(): PolicyGenome {
  if (!cached) {
    cached = readChampion();
    setPolicyGenome(cached);
  }
  return cached;
}

loadChampionGenome();

function actionKey(action: { kind: string; from: string; to: string }): string {
  return `${action.kind}:${action.from}:${action.to}`;
}

/** The move cand-r32 would commit from this position. Null when nothing is legal. */
export function chooseComputerAction(state: GameState, genome?: PolicyGenome): PolicyAction | null {
  const g = genome ?? loadChampionGenome();
  const legal = collectLegalActions(state);
  if (legal.length === 0) return null;
  const policy = evaluateState(state, legal, g);
  const first = policy.ranked[0] ?? policy.fallback;
  if (!first) return null;
  const proposal: PolicyAction = {
    from: first.from,
    to: first.to,
    kind: first.kind,
    type: first.type,
    promo: first.promo,
  };
  const verdict = filterStatePick(state, proposal, legal, g);
  const chosen = verdict.accept
    ? proposal
    : (verdict.fallback ?? verdict.retryHints[0] ?? policy.fallback);
  if (!chosen) return null;
  const key = actionKey(chosen);
  if (!legal.some((action) => actionKey(action) === key)) return null;
  return {
    from: chosen.from,
    to: chosen.to,
    kind: chosen.kind,
    type: chosen.type,
    promo: chosen.promo,
  };
}

export function actionIsLegal(state: GameState, action: PolicyAction): boolean {
  const key = actionKey(action);
  return collectLegalActions(state).some((candidate) => actionKey(candidate) === key);
}
