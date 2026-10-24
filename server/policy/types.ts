/**
 * Board and state types for the ported lab policy.
 * The policy modules keep their lab names. The shapes are the app's.
 */
export type {
  AttackSettings,
  Board,
  GameState,
  Move,
  Piece,
  PieceType,
  PlayerColor,
  Position,
  Square,
} from '../../shared/schema.ts';

export type ActionKind = 'move' | 'arrow' | 'axe' | 'bomb' | 'wall';
