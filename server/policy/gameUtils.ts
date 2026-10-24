/**
 * Client move-gen port (repo/client/src/lib/gameUtils.ts).
 * Used by `legal` so agents see live-site arrows (8-way, range 12).
 * The engine handleArrowAttack validates the same 8-way path.
 */
import type { Board, Piece, PieceType, PlayerColor, Position, Square } from './types.ts';
import { BOARD_SIZE } from './notation.ts';

export const MAX_MOVE_DISTANCE = 8;

export function createInitialBoard(): Board {
  const board: Board = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    const boardRow: Square[] = [];
    for (let col = 0; col < BOARD_SIZE; col++) {
      boardRow.push({ row, col, piece: null, isWall: false });
    }
    board.push(boardRow);
  }
  const offset = 2;
  const backRowPieces: PieceType[] = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
  for (let i = 0; i < 8; i++) {
    board[0][offset + i].piece = { type: backRowPieces[i], color: 'black', id: `b_${backRowPieces[i]}_${i}` };
    board[11][offset + i].piece = { type: backRowPieces[i], color: 'white', id: `w_${backRowPieces[i]}_${i}` };
    board[1][offset + i].piece = { type: 'pawn', color: 'black', id: `b_pawn_${i}` };
    board[10][offset + i].piece = { type: 'pawn', color: 'white', id: `w_pawn_${i}` };
  }
  return board;
}

export function isValidPosition(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function getSlidingMoves(
  board: Board,
  position: Position,
  color: PlayerColor,
  directions: number[][],
  maxDistance: number,
  includeAttacks: boolean,
): Position[] {
  const moves: Position[] = [];
  for (const [dr, dc] of directions) {
    for (let dist = 1; dist <= maxDistance; dist++) {
      const newRow = position.row + dr * dist;
      const newCol = position.col + dc * dist;
      if (!isValidPosition(newRow, newCol) || board[newRow][newCol].isWall) break;
      const targetPiece = board[newRow][newCol].piece;
      if (!targetPiece) {
        moves.push({ row: newRow, col: newCol });
      } else if (includeAttacks && targetPiece.color !== color) {
        moves.push({ row: newRow, col: newCol });
        break;
      } else {
        break;
      }
    }
  }
  return moves;
}

export function getValidMoves(board: Board, position: Position, includeAttacks = true): Position[] {
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
          if (isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall) {
            const targetPiece = board[newRow][newCol].piece;
            if (!targetPiece || (includeAttacks && targetPiece.color !== piece.color)) {
              moves.push({ row: newRow, col: newCol });
            }
          }
        }
      }
      if (!piece.hasMoved) {
        const row = position.row;
        const kingsideRookCol = 9;
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
          if (pathClear) moves.push({ row, col: 11 });
        }
        const queensideRookCol = 2;
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
          if (pathClear) moves.push({ row, col: 0 });
        }
      }
      break;
    case 'pawn':
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const newRow = position.row + dr;
          const newCol = position.col + dc;
          if (isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall) {
            const targetPiece = board[newRow][newCol].piece;
            if (!targetPiece || (includeAttacks && targetPiece.color !== piece.color)) {
              moves.push({ row: newRow, col: newCol });
            }
          }
        }
      }
      break;
    case 'queen':
      moves.push(...getSlidingMoves(board, position, piece.color, [
        [-1, 0], [1, 0], [0, -1], [0, 1],
        [-1, -1], [-1, 1], [1, -1], [1, 1],
      ], MAX_MOVE_DISTANCE, includeAttacks));
      break;
    case 'rook':
      moves.push(...getSlidingMoves(board, position, piece.color, [
        [-1, 0], [1, 0], [0, -1], [0, 1],
      ], MAX_MOVE_DISTANCE, includeAttacks));
      break;
    case 'bishop':
      moves.push(...getSlidingMoves(board, position, piece.color, [
        [-1, -1], [-1, 1], [1, -1], [1, 1],
      ], MAX_MOVE_DISTANCE, includeAttacks));
      break;
    case 'knight': {
      const knightMoves = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1],
      ];
      for (const [dr, dc] of knightMoves) {
        const newRow = position.row + dr;
        const newCol = position.col + dc;
        if (isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall) {
          const targetPiece = board[newRow][newCol].piece;
          if (!targetPiece || (includeAttacks && targetPiece.color !== piece.color)) {
            moves.push({ row: newRow, col: newCol });
          }
        }
      }
      break;
    }
  }
  return moves;
}

/** White g1 / black g12, never traveled. Axe on this king is illegal except only-check-escape (handleAxe). */
export function isUnmovedHomeKingAt(board: Board, pos: Position): boolean {
  const p = board[pos.row]?.[pos.col]?.piece;
  if (!p || p.type !== 'king' || p.hasMoved) return false;
  const homeRow = p.color === 'white' ? BOARD_SIZE - 1 : 0;
  const homeCol = 6; // file g
  return pos.row === homeRow && pos.col === homeCol;
}

export function getAxeTargets(board: Board, position: Position): Position[] {
  const square = board[position.row][position.col];
  if (!square.piece || square.piece.type !== 'knight') return [];
  const targets: Position[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const newRow = position.row + dr;
      const newCol = position.col + dc;
      if (isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall) {
        const targetPiece = board[newRow][newCol].piece;
        if (targetPiece && targetPiece.color !== square.piece.color && targetPiece.type !== 'rook') {
          if (isUnmovedHomeKingAt(board, { row: newRow, col: newCol })) continue;
          targets.push({ row: newRow, col: newCol });
        }
      }
    }
  }
  return targets;
}

export function getBombTargets(board: Board, position: Position): Position[] {
  const square = board[position.row][position.col];
  if (!square.piece || square.piece.type !== 'rook') return [];
  const targets: Position[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const newRow = position.row + dr;
      const newCol = position.col + dc;
      if (isValidPosition(newRow, newCol) && board[newRow][newCol].isWall) {
        targets.push({ row: newRow, col: newCol });
      }
    }
  }
  return targets;
}

export function getWallBuildTargets(board: Board, position: Position): Position[] {
  const square = board[position.row][position.col];
  if (!square.piece || square.piece.type !== 'rook') return [];
  const targets: Position[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const newRow = position.row + dr;
      const newCol = position.col + dc;
      if (isValidPosition(newRow, newCol) && !board[newRow][newCol].isWall && !board[newRow][newCol].piece) {
        targets.push({ row: newRow, col: newCol });
      }
    }
  }
  return targets;
}

/**
 * Empty 8-way arrow corridors from `pos` (ranks, files, and diagonals).
 * A lane counts if the ray is empty for dist ≥ 2, or hits an enemy at dist ≥ 2.
 * Adjacent-only rays (dist 1) do not count. Geometry only — does not pick a square.
 */
export function countBishopFiringLanes(board: Board, pos: Position, color: PlayerColor): number {
  const directions = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ];
  let lanes = 0;
  for (const [dr, dc] of directions) {
    let dist = 0;
    let r = pos.row + dr;
    let c = pos.col + dc;
    while (isValidPosition(r, c) && !board[r][c].isWall) {
      dist++;
      if (board[r][c].piece) {
        if (board[r][c].piece!.color !== color && dist >= 2) lanes++;
        break;
      }
      r += dr;
      c += dc;
    }
    if (dist >= 2 && !(isValidPosition(r, c) && board[r][c].piece)) lanes++;
  }
  return lanes;
}

/** Live-site arrows: 8-way, range 12, knights/rooks immune, blocked by any piece/wall. */
export function getArrowTargets(board: Board, position: Position): Position[] {
  const square = board[position.row][position.col];
  if (!square.piece || square.piece.type !== 'bishop') return [];
  const targets: Position[] = [];
  const directions = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ];
  for (const [dr, dc] of directions) {
    for (let dist = 1; dist <= 12; dist++) {
      const newRow = position.row + dr * dist;
      const newCol = position.col + dc * dist;
      if (!isValidPosition(newRow, newCol) || board[newRow][newCol].isWall) break;
      const targetPiece = board[newRow][newCol].piece;
      if (targetPiece && targetPiece.color !== square.piece.color) {
        if (targetPiece.type !== 'knight' && targetPiece.type !== 'rook') {
          targets.push({ row: newRow, col: newCol });
        }
        break;
      } else if (targetPiece) {
        break;
      }
    }
  }
  return targets;
}

export function isInCheck(board: Board, color: PlayerColor): boolean {
  let kingPos: Position | null = null;
  for (let row = 0; row < BOARD_SIZE && !kingPos; row++) {
    for (let col = 0; col < BOARD_SIZE && !kingPos; col++) {
      const piece = board[row][col].piece;
      if (piece && piece.type === 'king' && piece.color === color) kingPos = { row, col };
    }
  }
  if (!kingPos) return false;
  const opponentColor = color === 'white' ? 'black' : 'white';
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const piece = board[row][col].piece;
      if (piece && piece.color === opponentColor) {
        const attacks = getValidMoves(board, { row, col }, true);
        if (attacks.some((pos) => pos.row === kingPos!.row && pos.col === kingPos!.col)) return true;
        if (piece.type === 'bishop') {
          const arrowTargets = getArrowTargets(board, { row, col });
          if (arrowTargets.some((pos) => pos.row === kingPos!.row && pos.col === kingPos!.col)) return true;
        }
        if (piece.type === 'knight') {
          const axeTargets = getAxeTargets(board, { row, col });
          if (axeTargets.some((pos) => pos.row === kingPos!.row && pos.col === kingPos!.col)) return true;
        }
      }
    }
  }
  return false;
}

export function pieceLetter(type: PieceType): string {
  if (type === 'pawn') return 'P';
  if (type === 'knight') return 'N';
  return type[0].toUpperCase();
}

export function pieceGlyph(piece: Piece): string {
  const letters: Record<PieceType, string> = {
    king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: 'P',
  };
  const ch = letters[piece.type];
  return piece.color === 'white' ? ch : ch.toLowerCase();
}
