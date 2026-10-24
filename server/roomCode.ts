import { randomBytes } from "crypto";

// 3–4 letter words for memorable room codes (word-word)
const ROOM_WORDS = [
  // chess-themed
  "ace", "arc", "axe", "bay", "bow", "cat", "dew", "dice", "elm", "fig",
  "fog", "fox", "gem", "ice", "ivy", "jam", "jet", "kin", "kit", "king",
  "kite", "lane", "log", "map", "mate", "mist", "move", "net", "oak", "orb",
  "pawn", "peg", "pin", "play", "plum", "rank", "ray", "rim", "rook", "rust",
  "sage", "shot", "sky", "sun", "tan", "teal", "tie", "trap", "urn", "vine",
  "wall", "war", "wit", "wolf", "wood", "zap", "bomb", "cast", "coin", "dawn",
  "dusk", "fire", "fork", "game", "gate", "helm", "jade", "maze", "neon", "opal",
  "roll", "skew", "turn", "zeal",
] as const;

export function generateRoomCode(): string {
  const bytes = randomBytes(2);
  const word1 = ROOM_WORDS[bytes[0] % ROOM_WORDS.length];
  const word2 = ROOM_WORDS[bytes[1] % ROOM_WORDS.length];
  return `${word1}-${word2}`;
}