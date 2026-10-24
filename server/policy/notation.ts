import type { Position } from './types.ts';

export const BOARD_SIZE = 12;

export function parseSquare(alg: string): Position {
  const m = String(alg).trim().toLowerCase().match(/^([a-l])(1[0-2]|[1-9])$/);
  if (!m) throw new Error(`Bad square '${alg}'. Use files a-l and ranks 1-12 (e.g. j2, k3).`);
  const col = m[1].charCodeAt(0) - 97;
  const rank = Number(m[2]);
  const row = BOARD_SIZE - rank;
  return { row, col };
}

export function squareName(pos: Position): string {
  return `${String.fromCharCode(97 + pos.col)}${BOARD_SIZE - pos.row}`;
}

export function parseSquareList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function parsePromo(raw: string | undefined): 'queen' | 'rook' | 'bishop' | 'knight' | undefined {
  if (!raw) return undefined;
  const c = raw.trim().toLowerCase();
  if (c === 'q' || c === 'queen') return 'queen';
  if (c === 'r' || c === 'rook') return 'rook';
  if (c === 'b' || c === 'bishop') return 'bishop';
  if (c === 'n' || c === 'knight') return 'knight';
  throw new Error(`Bad --promo '${raw}'. Use q|r|b|n.`);
}
