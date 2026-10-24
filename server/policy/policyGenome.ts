/**
 * Policy FILTER genome. Never a move chooser.
 * Runtime load of evolve/genomes/active.json (or POLICY_GENOME) with mtime cache.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PolicyWeights {
  w_escape: number;
  w_capture_unit: number;
  w_hanging: number;
  w_hanging_pawn: number;
  w_take_checker: number;
  w_axe_king: number;
  w_axe_valuable: number;
  w_axe_minor: number;
  w_arrow_king: number;
  w_arrow_hanging: number;
  w_fork: number;
  w_walk_off_fork: number;
  w_step_off_fork: number;
  w_gives_check: number;
  w_approach: number;
  w_develop_bishop_center: number;
  w_develop_heavy_center: number;
  w_develop_center_step: number;
  w_back_rank_shuffle_b: number;
  w_open_diagonal: number;
  w_bishop_aims_king: number;
  w_open_board_penalty: number;
  w_reversal: number;
  w_oscillation: number;
  w_pawn_takes_checker: number;
  w_take_forking_knight: number;
  w_pawn_capture: number;
  w_pawn_takes_knight: number;
  w_axe_home_snipe: number;
  w_arrow_pawn: number;
  w_arrow_checks_king: number;
  w_develop_center_step_queen: number;
  w_develop_center_step_rook: number;
  w_back_rank_shuffle_heavy: number;
  w_open_lane_bonus: number;
  w_king_wander: number;
  w_king_idle: number;
  w_hangs_self: number;
  w_king_exposed: number;
  w_bishop_snipe_hangs: number;
  w_power_hangs_idle: number;
  w_walks_into_snipe: number;
  w_arrow_enemy_bishop: number;
  w_bishop_home_idle: number;
  /** Late-conversion bonus/penalty. Unused while late_conv_enabled is false. */
  w_late_conv: number;
}

export interface PolicyGates {
  reject_axe_home_snipe: boolean;
  stuck_breaker_skips_home_snipe: boolean;
  bishop_aims_is_must_do: boolean;
  arrow_king_is_must_do: boolean;
  axe_king_is_must_do: boolean;
  reject_back_rank_when_develop_bishop: boolean;
  develop_bishop_is_must_do: boolean;
  reject_early_king_wander: boolean;
  reject_bishop_snipe_hangs: boolean;
  reject_power_hangs_idle: boolean;
  reject_walks_into_snipe: boolean;
  arrow_enemy_bishop_is_must_do: boolean;
}

export interface PolicyLoop {
  max_attempts: number;
  check_closer_from_attempt: number;
}

export interface PolicyGenome {
  id: string;
  parent: string | null;
  generation: number;
  weights: PolicyWeights;
  gates: PolicyGates;
  loop: PolicyLoop;
  /** Quiet-king shelter window in half-moves (30 full moves = 60). Clamp [20, 120]. */
  early_king_plies: number;
  /**
   * After late_conv_ply plies are already in the history, if the side to move
   * leads by >= late_conv_margin (kings excluded), rank forcing moves up and
   * quiet shuffles / repetitions down. Default off so existing genomes match v4.
   */
  late_conv_enabled: boolean;
  late_conv_ply: number;
  late_conv_margin: number;
  /**
   * One-ply lookahead over the engine legal list. Scores the position after
   * each supplied move with the pawn-100 fitted material and king-exposure
   * weights. Off by default so v4 ranking is unchanged.
   */
  lookahead_enabled: boolean;
  /** Multiplier from fitted logit-per-raw-unit into the existing score scale. */
  lookahead_scale: number;
  /** When ahead, prefer equal-or-better captures and drop quiet alternatives. */
  trade_down_enabled: boolean;
  trade_down_margin: number;
  /** Reject non-escape king moves before this ply (score.py counts ply < 30). */
  king_guard_enabled: boolean;
  king_guard_plies: number;
  /** Drop moves that put our own king in check, and reject picks outside `legal`. */
  illegal_filter_enabled: boolean;
  /**
   * Capture-only extension of the one-ply fitted score. After each legal move,
   * stand on the worst enemy capture the engine can play (or the quiet
   * position if they have none). Off by default so v4 ranking is unchanged.
   * Not the strategy-4 static lookahead: that never applies a reply.
   */
  quiescence_enabled: boolean;
  /** Same score scale as lookahead_scale. A queen is about 460 points at 400. */
  quiescence_scale: number;
  /** Drop a move that leaves a queen or rook en prise when a safer legal move exists. */
  hang_shield_enabled: boolean;
  /**
   * Drop a move the enemy can answer by capturing our king, including while
   * already in check. Strategy-4 self-check does not run in check.
   */
  reply_safety_enabled: boolean;
  /**
   * When ahead by progress_margin, drop quiet shuffles if a winning capture,
   * a safe check, or a non-king step toward the enemy king is legal.
   * No ply gate. Does not force an equal queen or rook trade.
   */
  progress_enabled: boolean;
  progress_margin: number;
  /**
   * Strategy-6. Off on v4-seed so ranking stays v4.
   * Drop a bishop shot that neither wins material nor leaves the enemy king
   * worse after its best engine-legal step, when a capture, a mating-net
   * move, a king-hunt step, or a real escape remains.
   */
  shot_filter_enabled: boolean;
  /**
   * When ahead, score each legal move by the fitted material and king-exposure
   * value after the enemy king takes its best escape (or the quiet position
   * if the king is not in check). A check the king steps off does not keep
   * the exposure bonus.
   */
  mate_net_enabled: boolean;
  mate_net_margin: number;
  /** Same score scale as quiescence_scale. One flight square covered is 0.1 of this. */
  mate_net_scale: number;
  /**
   * In a simplified position (non-king material at or below king_hunt_max_material)
   * after ply 40, while ahead, a king step toward the enemy king is not rejected
   * as king-idle or king-home. Middlegame king safety is unchanged.
   */
  king_hunt_enabled: boolean;
  king_hunt_max_material: number;
  /**
   * While in check, drop an escape whose fitted value is worse than another
   * escape, so the play loop does not burn attempts on the worse king step.
   */
  escape_first_enabled: boolean;
  /**
   * Strategy-7. Off on v4-seed and on the promoted cand-r6 incumbent.
   * When ahead, after finish_ply, a non-capturing check that does not take
   * the king, mate, or raise the sticky fitted value is check-waste. An
   * in-check drop in the flight count is not enough: that is the queen or
   * rook check the king steps off. A quiet move that removes a flight still
   * counts. The waste check is dropped when a capture, a quiet flight cut,
   * a safe step toward the king, or a king-help step remains.
   */
  finish_enabled: boolean;
  /** history.length floor. 40 is after the ply-30 early-king count. */
  finish_ply: number;
  finish_margin: number;
  /**
   * When ahead, after king_help_ply, and only when the enemy's non-king
   * material is at or below king_help_max_enemy, a safe king step toward
   * their king is not rejected as king-idle or king-home. Does not fire
   * in the opening, so it cannot add an early king walk.
   */
  king_help_enabled: boolean;
  king_help_ply: number;
  king_help_max_enemy: number;
  /**
   * Strategy-8. Off on v4-seed and on the promoted cand-r6 incumbent.
   * Drop a king move whose Chebyshev distance is greater than 1. That
   * destination is the castling teleport gameUtils lists and the engine
   * rejected in round 8. The scorer does not move the rook.
   */
  span_filter_enabled: boolean;
  /**
   * When ahead, after convert_ply, keep a safe arrow or axe, or a capture
   * worth more than the mover, and drop a quiet step or an approach when
   * one of those remains. Equal queen and rook trades are not tagged.
   */
  convert_enabled: boolean;
  /** history.length floor. 40 is the same window as finish, after the early-king count. */
  convert_ply: number;
  convert_margin: number;
  /**
   * Strategy-9. Off on v4-seed and on the promoted cand-r6 incumbent.
   * Before shelter_plies, while in check, drop a king step when a non-king
   * escape remains. The early-king counter is ply < 30, so the default is 30.
   */
  shelter_enabled: boolean;
  shelter_plies: number;
  /**
   * Drop a capture of a queen or rook when an arrow that does not take a
   * queen or rook remains. An escape from check is not dropped. Not trade-down.
   */
  qr_spare_enabled: boolean;
  /**
   * Drop a wall or a bomb when any other legal move remains. The open-board
   * penalty is only a score; this is the reject.
   */
  rubble_enabled: boolean;
  /**
   * Strategy-10. Off on v4-seed and on the promoted cand-r6 incumbent.
   * When ahead, after volley_ply, tag a safe arrow that does not capture a
   * queen or rook. Drop a non-capture step (an approach, a king-help step)
   * when one of those arrows remains. The fallback plays that arrow before
   * a non-arrow convert capture. Not a weight change, and not lookahead.
   */
  volley_enabled: boolean;
  /** history.length floor. 40 is the same window as finish and convert. */
  volley_ply: number;
  volley_margin: number;
  /**
   * Strategy-11. Off on v4-seed and on the promoted cand-r6 incumbent.
   * Drop a move whose best enemy capture reply takes our queen or rook,
   * including a defended piece taken by an equal or heavier attacker.
   * Hang-shield misses those. A volley arrow with that reply is not volley,
   * so the fallback can play a safe non-queen non-rook capture instead.
   * The sole remaining move stays. Not a weight change and not lookahead.
   */
  cover_enabled: boolean;
  /**
   * Strategy-12. Off on v4-seed and on the promoted cand-r6 incumbent.
   * Drop a check when every sure king-safe reply leaves a queen or rook
   * to our next capture. Cover cannot delete that sole escape. A mate and
   * a sole move stay. Not a weight change and not lookahead.
   */
  seal_enabled: boolean;
  /**
   * After press_ply, even when behind, drop a non-capturing check that does
   * not step closer when a closer step, a safe capture, or a safe arrow
   * remains. Finish and volley only do this while ahead.
   */
  press_enabled: boolean;
  /** history.length floor. 100 is after the early-king window and before a ply-220 orbit. */
  press_ply: number;
  /**
   * Strategy-13. Off on v4-seed and on the promoted cand-r6 incumbent.
   * After reap_ply, with or without a lead, drop a non-capturing check or
   * step when a safe non-queen non-rook arrow or a safe capture of a pawn,
   * knight, or bishop remains. A king step is not tagged. Not lookahead,
   * not trade-down, and not a weight change.
   */
  reap_enabled: boolean;
  /** history.length floor. 40 is the same window as volley, without the lead. */
  reap_ply: number;
  /**
   * Strategy-14. Off on v4-seed and on the promoted cand-r6 incumbent.
   * From glean_ply, with or without a lead, a safe arrow that does not take
   * a queen or rook is kept and the other non-escapes are dropped. A king
   * capture and a last-flight check stay. A king step is not tagged.
   * Not lookahead, not trade-down, and not a weight change.
   */
  glean_enabled: boolean;
  /** history.length floor. 0 is the first move. The missing pawn arrows started there. */
  glean_ply: number;
  /**
   * Strategy-15. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From sheaf_ply, with or without a lead, a safe bishop arrow on a pawn
   * is kept ahead of a bishop duel. When none is legal, a safe bishop step
   * that opens one is kept and a quiet non-capture is dropped. A king step
   * is not tagged. Not lookahead, not trade-down, and not a weight change.
   */
  sheaf_enabled: boolean;
  /** history.length floor. 0 is the first move. The pawn-arrow gap started there. */
  sheaf_ply: number;
  /**
   * Strategy-16. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From keel_ply, with or without a lead, a quiet king step is dropped
   * when a safe non-king move remains. When no safe non-queen non-rook
   * arrow is legal, a quiet queen or rook step is dropped if a bishop
   * step opens a ray onto a pawn, knight, bishop, or king. Not lookahead,
   * not trade-down, and not a weight change.
   */
  keel_enabled: boolean;
  /** history.length floor. 30 is the first ply the early-king counter no longer counts. */
  keel_ply: number;
  /**
   * Strategy-17. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From sift_ply, with or without a lead, one safe non-king non-queen
   * non-rook move that raises the fitted material and king-exposure value
   * is ranked ahead of a quiet shuffle. A bishop step that opens a ray
   * onto a pawn, knight, bishop, or king wins that slot when the fitted
   * value rises. Nothing is dropped. A queen or rook capture is not the
   * move. Not lookahead, not trade-down, and not a weight change.
   */
  sift_enabled: boolean;
  /** history.length floor. 0 is the first move. The missing arrows started there. */
  sift_ply: number;
  /**
   * Strategy-18. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From prod_ply, with or without a lead, one safe pawn, knight, or bishop
   * move is ranked ahead of a quiet queen or rook and ahead of a queen or
   * rook capture. A check wins, then a minor or pawn capture, then a knight
   * step into the enemy king's two-square ring. Nothing is dropped. A bishop
   * ray is not the move. Not lookahead, not trade-down, and not a weight change.
   */
  prod_enabled: boolean;
  /** history.length floor. 30 is the first ply the early-king counter no longer counts. */
  prod_ply: number;
  /**
   * Strategy-19. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From nock_ply, with or without a lead, one safe bishop step that opens
   * a pawn arrow and does not open a queen arrow is ranked ahead of a quiet
   * shuffle. Only a pool with no capture, arrow, axe, or check is touched.
   * Nothing is dropped. A king step is not tagged. Not lookahead, not
   * trade-down, and not a weight change.
   */
  nock_enabled: boolean;
  /** history.length floor. 0 is the first move. The missing pawn arrows started there. */
  nock_ply: number;
  /**
   * Strategy-20. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From fletch_ply, with or without a lead, one quiet pawn step that steps
   * off a friendly bishop's ray is ranked ahead of a quiet shuffle. The
   * side's pawn-arrow count must rise and its queen-arrow count must not.
   * Only a pool with no capture, arrow, axe, or check is touched, and only
   * when no nock aim is already legal. Nothing is dropped. Not lookahead,
   * not trade-down, and not a weight change.
   */
  fletch_enabled: boolean;
  /** history.length floor. 0 is the first move. The blocking pawn is already there. */
  fletch_ply: number;
  /**
   * Strategy-21. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From pile_ply, with or without a lead, one safe bishop step that puts
   * the enemy king behind exactly one friendly pawn, knight, or bishop is
   * ranked ahead of a quiet shuffle. The screen blocks the arrow, so this
   * is not a check and bishop-aims-king does not pay. A queen behind the
   * screen is refused. Only a pool with no capture, arrow, axe, or check
   * is touched, and only when no nock aim is already legal. A step that
   * raises our king exposure is not tagged. Nothing is dropped. Not
   * lookahead, not trade-down, and not a weight change.
   */
  pile_enabled: boolean;
  /** history.length floor. 0 is the first move. The king is already there. */
  pile_ply: number;
  /**
   * Strategy-22. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From haft_ply, with or without a lead, one safe bishop step that opens
   * a longer firing lane, or that leaves the back rank toward the center
   * without losing a lane, is ranked ahead of a quiet shuffle. Only a pool
   * with no capture, arrow, axe, or check is touched, and only when no nock
   * aim is already legal. A queen on the new ray is refused. A step that
   * raises our king exposure is not tagged. Nothing is dropped. Not
   * lookahead, not trade-down, and not a weight change.
   */
  haft_enabled: boolean;
  /** history.length floor. 0 is the first move. The idle bishop is already there. */
  haft_ply: number;
  /**
   * Strategy-23. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From quarrel_ply, with or without a lead, the highest-scoring quiet
   * move is tagged when it is not already a hint and is not a king step.
   * Only a pool with no capture, arrow, axe, check, or escape is touched,
   * and only when no nock aim is already legal. Nothing is dropped. Not
   * lookahead, not trade-down, and not a weight change.
   */
  quarrel_enabled: boolean;
  /** history.length floor. 0 is the first move. The quiet stall is already there. */
  quarrel_ply: number;
  /**
   * Strategy-24. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From bodkin_ply, with or without a lead, one knight or bishop step that
   * reduces Chebyshev distance to the enemy king is ranked ahead of a quiet
   * queen or rook. Only a pool with no capture, arrow, axe, check, or escape
   * is touched, and only when no nock aim is already legal. Nothing is
   * dropped. Not a lower press_ply, not lookahead, not trade-down, and not
   * a weight change.
   */
  bodkin_enabled: boolean;
  /** history.length floor. 0 is the first move. The minor piece is already there. */
  bodkin_ply: number;
  /**
   * Strategy-25. Off on v4-seed and on the promoted cand-r16 incumbent.
   * From crest_ply, with or without a lead, one bishop step that reduces
   * Chebyshev distance to the nearest enemy pawn is ranked ahead of a quiet
   * shuffle that is not a knight fork. A step that opens a pawn ray is not
   * tagged. A step that opens a queen ray is not tagged. Only a pool with
   * no capture, arrow, axe, check, or escape is touched, and only when no
   * nock aim is already legal. Nothing is dropped. Not a bodkin retune, not
   * a haft retune, not lookahead, not trade-down, and not a weight change.
   */
  crest_enabled: boolean;
  /** history.length floor. 0 is the first move. The idle bishop is already there. */
  crest_ply: number;
  /**
   * Strategy-26. Off on v4-seed and on the promoted cand-r28 incumbent.
   * From brace_ply, with or without a lead, one quiet pawn step that
   * increases our bishops' legal steps is ranked ahead of a quiet shuffle
   * that is not a knight fork. Before ply 30 a step that keeps the king's
   * adjacent pawn shield is preferred when one exists. Only a pool with no
   * capture, arrow, axe, check, or escape is touched, and only when no nock
   * aim and no crest aim is already legal. Nothing is dropped. Not a crest
   * retune, not a nock retune, not a fletch retune, not lookahead, not
   * trade-down, and not a weight change.
   */
  brace_enabled: boolean;
  /** history.length floor. 0 is the first move. The blocking pawn is already there. */
  brace_ply: number;
  /**
   * Strategy-27. Off on v4-seed and on the promoted cand-r28 incumbent.
   * From mark_ply, with or without a lead, one knight step that reduces
   * Chebyshev distance to the nearest enemy pawn is ranked ahead of a quiet
   * shuffle that is not a knight fork. A step that adds an attack on a queen
   * or a rook, on either side, is not tagged. A step that opens a pawn ray
   * or a queen ray is not tagged. Only a pool with no capture, arrow, axe,
   * check, or escape is touched, and only when no nock aim, crest aim, or
   * brace aim is already legal. Nothing is dropped. Not a brace retune, not
   * a crest retune, not a bodkin retune, not lookahead, not trade-down, and
   * not a weight change.
   */
  mark_enabled: boolean;
  /** history.length floor. 0 is the first move. The knight is already there. */
  mark_ply: number;
  /**
   * Strategy-28. Off on v4-seed and on the promoted cand-r28 incumbent.
   * From flight_ply, with or without a lead, one pawn or knight step that
   * sets up a bishop pawn-shot is ranked ahead of a quiet shuffle. A pawn
   * counts only when the step creates a bishop step that would arrow an
   * enemy pawn, and only when the pawn step itself does not raise the
   * pawn-arrow count. A knight counts when it uncovers that arrow or
   * creates the same step. A step that adds an attack on a queen or a rook,
   * on either side, is not tagged. Only a pool with no capture, arrow, axe,
   * check, or escape is touched, and only when no nock aim is already
   * legal. A crest aim does not suppress it. Nothing is dropped. Not a
   * fletch retune, not a brace retune, not a mark retune, not lookahead,
   * not trade-down, and not a weight change.
   */
  flight_enabled: boolean;
  /** history.length floor. 0 is the first move. The blocking pawn is already there. */
  flight_ply: number;
  /**
   * Strategy-29. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From clout_ply, with or without a lead, one safe queen or rook check
   * that cuts the enemy king's flights is ranked ahead of a quiet shuffle.
   * If no such check is legal, one safe rook bomb of a wall on the king's
   * line is ranked instead, when that bomb cuts a flight or opens more of
   * those checks. Captures, arrows, axes, escapes, nock, flight, and forks
   * are not outranked. Nothing is dropped by this layer. Not a flight
   * retune, not a press retune, not lookahead, not trade-down, and not a
   * weight change.
   */
  clout_enabled: boolean;
  /** history.length floor. 40 is the late phase. Clamped 0..180. */
  clout_ply: number;
  /**
   * Strategy-30. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From barb_ply, with or without a lead, one safe pawn, knight, or bishop
   * capture of a pawn, knight, or bishop is ranked ahead of a quiet move and
   * ahead of a check that does not take more material. The capture has to
   * strip a piece within two squares of the enemy king, or it has to open a
   * bishop pawn-shot. A queen, a rook, and a king are not the mover and not
   * the victim. An arrow that is already legal is left alone. A nock aim
   * that is still in the pool is left alone. Nothing is dropped. Not a
   * flight retune, not a clout retune, not lookahead, not trade-down, and
   * not a weight change.
   */
  barb_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  barb_ply: number;
  /**
   * Strategy-31. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From vane_ply, with or without a lead, quiet knight steps and quiet
   * pawn steps are dropped when a flight setup, a nock aim, or an arrow is
   * already in the pool. The knight that uncovers the pawn arrow stays.
   * The pawn that is itself the flight setup stays. Bishops, rooks, queens,
   * kings, captures, checks, escapes, and axes stay. Nothing is dropped if
   * that would empty the pool. Not a flight retune, not a nock retune, not
   * a crest retune, not a barb retune, not lookahead, not trade-down, and
   * not a weight change.
   */
  vane_enabled: boolean;
  /** history.length floor. 0 is the first move. The knight is already there. */
  vane_ply: number;
  /**
   * Strategy-32. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From quill_ply, with or without a lead, one quiet queen or rook step
   * that steps off an attack is ranked ahead of a flight or nock shot.
   * Nothing is dropped. A quiet knight that is not itself the shot is
   * rejected with reason quill; the substitute is that step, or the shot
   * when no safe step exists. The play loop forces it on attempt 1.
   * Not a vane retune, not a flight retune, not lookahead, not trade-down,
   * and not a weight change.
   */
  quill_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  quill_ply: number;
  /**
   * Strategy-33. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From string_ply, with or without a lead, one safe bishop arrow at a
   * pawn or a king is ranked ahead of a quiet shuffle and ahead of a
   * queen or rook capture. Nothing is dropped. An illegal one-step slide
   * is replaced with that arrow before it is counted as NOT_LISTED. A
   * quiet bishop, and a queen or rook capture, are rejected with reason
   * string when that arrow is ranked. A repeating bomb or wall that the
   * opponent just undid is not treated as progress. Quiet knights are not
   * diverted. Not a quill retune, not a vane retune, not a flight retune,
   * not lookahead, not trade-down, and not a weight change.
   */
  string_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  string_ply: number;
  /**
   * Strategy-34. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From bolt_ply, with or without a lead, one safe knight or bishop
   * capture (a move or an axe, never an arrow, never a king step) is
   * ranked ahead of a pawn arrow and ahead of a quiet shuffle. Nothing
   * is dropped. Before ply 30 a checking capture is not tagged, so the
   * reply cannot add an early king walk. A pawn arrow, including an
   * early checking pawn arrow, is rejected with reason bolt. A quiet
   * knight is not. Not a string retune, not a quill retune, not a lower
   * press_ply, not lookahead, not trade-down, and not a weight change.
   */
  bolt_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  bolt_ply: number;
  /**
   * Strategy-35. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From spine_ply, with or without a lead, one quiet queen or rook step
   * that clears a cheap hang and leaves a safe pawn arrow is ranked ahead
   * of a quiet shuffle. Nothing is dropped. Before ply 30 that arrow must
   * not check. A quiet non-capture is rejected with reason spine. Not a
   * bolt retune, not a string retune, not a flight retune, not lookahead,
   * not trade-down, and not a weight change.
   */
  spine_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  spine_ply: number;
  /**
   * Strategy-36. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From broadhead_ply, with or without a lead, one capture of a pawn,
   * knight, or bishop that makes a safe pawn arrow exist is ranked ahead
   * of a quiet shuffle. A queen or rook capture is not tagged. Nothing is
   * dropped. Before ply 30 a checking capture is not tagged. A quiet
   * non-capture that is not nock, crest, or flight is rejected with reason
   * broadhead. Not a spine retune, not a bolt retune, not a flight retune,
   * not lookahead, not trade-down, and not a weight change.
   */
  broadhead_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  broadhead_ply: number;
  /**
   * Strategy-37. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From shaft_ply, with or without a lead, one quiet bishop, knight, or
   * pawn step that makes a safe pawn arrow exist is ranked ahead of a
   * quiet queen or rook step. A capture is not tagged. Nothing is dropped.
   * A quiet queen or rook step is rejected with reason shaft. Not a
   * broadhead retune, not a flight retune, not lookahead, not trade-down,
   * and not a weight change.
   */
  shaft_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  shaft_ply: number;
  /**
   * Strategy-38. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From anchor_ply, with or without a lead, one legal save that strictly
   * reduces the hanging-bishop count is ranked ahead of a quiet non-save.
   * A king step is not tagged. Before ply 30 a checking save is not tagged.
   * A queen or rook capture is not tagged. Nothing is dropped. A quiet
   * non-save is rejected with reason anchor. Not a shaft retune, not a
   * pawn-arrow setup, not a flight retune, not lookahead, not trade-down,
   * and not a weight change.
   */
  anchor_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  anchor_ply: number;
  /**
   * Strategy-39. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From max(cast_ply, 40), while ahead by at least a pawn and while no
   * pawn arrow exists, one quiet bishop step that opens a pawn ray is
   * ranked ahead of a quiet approach, including a finish approach. The
   * pool must not be a pure quiet stall. A king step is not tagged. A
   * capture is not tagged. Nothing is dropped. A quiet approach is
   * rejected with reason cast. Not an anchor retune, not a nock retune,
   * not a flight retune, not lookahead, not trade-down, and not a weight
   * change.
   */
  cast_enabled: boolean;
  /** history.length floor. The layer also waits until ply 40. Clamped 0..180. */
  cast_ply: number;
  /**
   * Strategy-40. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From max(quarry_ply, 40), while ahead by at least a pawn, one quiet
   * queen or rook step that gets closer to the enemy king is ranked ahead
   * of a quiet approach that is not already nock, crest, or flight. A
   * capture is not tagged. Nothing is dropped. A different quiet move is
   * rejected with reason quarry only when that step is already rank 0.
   * Not a cast retune, not a pawn-arrow setup, not a nock retune, not a
   * flight retune, not lookahead, not trade-down, and not a weight change.
   */
  quarry_enabled: boolean;
  /** history.length floor. The layer also waits until ply 40. Clamped 0..180. */
  quarry_ply: number;
  /**
   * Strategy-41. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From latch_ply, with or without a lead, one quiet pawn, knight, or
   * bishop step that stands on a clear enemy-bishop ray and lowers our
   * king exposure is ranked ahead of a quiet queen, rook, or king step.
   * A queen, a rook, and a king are not tagged. A capture is not tagged.
   * Nothing is dropped. A quiet queen, rook, or king step is rejected
   * with reason latch only when that block is already rank 0. Not a
   * quarry retune, not a pawn-arrow setup, not lookahead, not trade-down,
   * and not a weight change.
   */
  latch_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  latch_ply: number;
  /**
   * Strategy-42. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From sighter_ply, with or without a lead, one quiet rook or queen
   * slide that newly attacks an undefended enemy pawn is ranked ahead of
   * a quiet queen, rook, or king step. Orthogonal, at least two squares.
   * Nock, flight, and crest keep the stall when they have an aim. A
   * capture is not tagged. Nothing is dropped. A quiet queen, rook, or
   * king step is rejected with reason sighter only when that slide is
   * already rank 0. Not a flight retune, not a fletch retune, not a
   * quarry retune, not a latch retune, not lookahead, not trade-down,
   * and not a weight change.
   */
  sighter_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  sighter_ply: number;
  /**
   * Strategy-43. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From pluck_ply, with or without a lead, one quiet pawn, knight, or
   * bishop step that newly attacks an enemy piece is ranked ahead of a
   * quiet queen, rook, or king step. Only in a pure quiet stall that
   * nock, flight, and crest do not already own. A queen, a rook, and a
   * king are not tagged. A capture is not tagged. Nothing is dropped.
   * A quiet queen, rook, or king step is rejected with reason pluck only
   * when that step is already rank 0. Not a sighter retune, not a flight
   * retune, not a capture-over-arrow, not lookahead, not trade-down, and
   * not a weight change.
   */
  pluck_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  pluck_ply: number;
  /**
   * Strategy-44. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From fetch_ply until ply 30, with or without a lead, one safe arrow
   * that does not check, or else one safe capture of a pawn, knight, or
   * bishop by a pawn, knight, or bishop, is ranked ahead of a loose early
   * check. A loose check is not a king capture and does not take the last
   * flight. Nothing is dropped. A loose check is rejected with reason
   * fetch. A quiet non-capture is rejected only when the alternative is
   * already rank 0. Not a pluck retune, not a sighter retune, not a
   * pawn-arrow chase, not lookahead, not trade-down, and not a weight change.
   */
  fetch_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. Ply 30 still stops the layer. */
  fetch_ply: number;
  /**
   * Strategy-45. Off on v4-seed and on the promoted cand-r32 incumbent.
   * From grip_ply until ply 30, with or without a lead, one safe capture
   * of a pawn, knight, or bishop by a pawn, knight, or bishop is ranked
   * ahead of a checking pawn arrow or an arrow that captures a queen or
   * rook. The capture is never an arrow. If no such capture exists,
   * nothing is tagged. Nothing is dropped. The bad arrow is rejected with
   * reason grip. A quiet non-capture is not rejected. Not a fetch retune,
   * not a bolt retune, not lookahead, not trade-down, and not a weight change.
   */
  grip_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. Ply 30 still stops the layer. */
  grip_ply: number;
  /**
   * Abandoned Strategy-46 attempt ("blunt"). Default false. No genome turns
   * it on. The replacement layer is reply2_enabled. Do not reuse this key.
   */
  blunt_enabled: boolean;
  /** history.length floor. 0 is the first move. Clamped 0..180. No ply ceiling. */
  blunt_ply: number;
  /**
   * Strategy-46 replacement. Off on v4-seed and on the promoted cand-r32
   * incumbent. From reply2_ply, each ranked legal move is applied and the
   * opponent's legal replies are scored with the pawn-100 model: material
   * about +30 win-points per SD, king exposure about -18, mobility, king
   * cover, and tempo left at 0. Value is the minimum over replies. A move
   * whose reply wins our queen or rook at a net material loss is dropped
   * when another legal move avoids it. King captures and checks that win
   * stay. Not lookahead_enabled: that scores the position after our move
   * and never searches a reply. Not quiescence: that searches one capture
   * only. Not a weight change.
   */
  reply2_enabled: boolean;
  /** Multiplier from reply2 win-points into the existing score scale. */
  reply2_scale: number;
  /** history.length floor. 0 is the first move. Clamped 0..180. */
  reply2_ply: number;
  created: string;
  notes?: string;
}

/** Exact literals from src/computerPolicy.ts policy-v4 (not the design-table approximations). */
export const DEFAULT_V4_WEIGHTS: PolicyWeights = {
  w_escape: 1000,
  w_capture_unit: 10,
  w_hanging: 400,
  w_hanging_pawn: 80,
  w_take_checker: 800,
  w_axe_king: 800,
  w_axe_valuable: 350,
  w_axe_minor: 200,
  w_arrow_king: 800,
  w_arrow_hanging: 500,
  w_fork: 450,
  w_walk_off_fork: -450,
  w_step_off_fork: 200,
  w_gives_check: 120,
  w_approach: 20,
  w_develop_bishop_center: 220,
  w_develop_heavy_center: 80,
  w_develop_center_step: 45,
  w_back_rank_shuffle_b: -180,
  w_open_diagonal: 40,
  w_bishop_aims_king: 400,
  w_open_board_penalty: -300,
  w_reversal: -800,
  w_oscillation: -5000,
  w_pawn_takes_checker: 200,
  w_take_forking_knight: 400,
  w_pawn_capture: 250,
  w_pawn_takes_knight: 150,
  w_axe_home_snipe: -400,
  w_arrow_pawn: 150,
  w_arrow_checks_king: 250,
  w_develop_center_step_queen: 25,
  w_develop_center_step_rook: 18,
  w_back_rank_shuffle_heavy: -90,
  w_open_lane_bonus: 15,
  w_king_wander: -800,
  w_king_idle: -350,
  w_hangs_self: -600,
  w_king_exposed: -800,
  w_bishop_snipe_hangs: -800,
  w_power_hangs_idle: -800,
  w_walks_into_snipe: -800,
  w_arrow_enemy_bishop: 600,
  w_bishop_home_idle: -250,
  w_late_conv: 200,
};

export const WEIGHT_CLAMPS: Record<keyof PolicyWeights, [number, number]> = {
  w_escape: [200, 2000],
  w_capture_unit: [5, 20],
  w_hanging: [100, 800],
  w_hanging_pawn: [0, 200],
  w_take_checker: [200, 1200],
  w_axe_king: [200, 1200],
  w_axe_valuable: [50, 600],
  w_axe_minor: [0, 400],
  w_arrow_king: [200, 1200],
  w_arrow_hanging: [100, 800],
  w_fork: [100, 800],
  w_walk_off_fork: [-800, -50],
  w_step_off_fork: [0, 400],
  w_gives_check: [0, 400],
  w_approach: [0, 50],
  w_develop_bishop_center: [0, 500],
  w_develop_heavy_center: [0, 300],
  w_develop_center_step: [0, 80],
  w_back_rank_shuffle_b: [-400, 0],
  w_open_diagonal: [0, 80],
  w_bishop_aims_king: [50, 600],
  w_open_board_penalty: [-600, -50],
  w_reversal: [-2000, -100],
  w_oscillation: [-8000, -1000],
  w_pawn_takes_checker: [0, 400],
  w_take_forking_knight: [0, 800],
  w_pawn_capture: [0, 500],
  w_pawn_takes_knight: [0, 400],
  w_axe_home_snipe: [-800, 0],
  w_arrow_pawn: [0, 400],
  w_arrow_checks_king: [0, 600],
  w_develop_center_step_queen: [0, 80],
  w_develop_center_step_rook: [0, 80],
  w_back_rank_shuffle_heavy: [-400, 0],
  w_open_lane_bonus: [0, 80],
  w_king_wander: [-800, 0],
  w_king_idle: [-800, 0],
  w_hangs_self: [-1200, 0],
  w_king_exposed: [-800, 0],
  w_bishop_snipe_hangs: [-800, 0],
  w_power_hangs_idle: [-800, 0],
  w_walks_into_snipe: [-800, 0],
  w_arrow_enemy_bishop: [0, 1200],
  w_bishop_home_idle: [-400, 0],
  w_late_conv: [0, 800],
};

export const DEFAULT_V4_GATES: PolicyGates = {
  reject_axe_home_snipe: true,
  stuck_breaker_skips_home_snipe: true,
  bishop_aims_is_must_do: true,
  arrow_king_is_must_do: true,
  axe_king_is_must_do: true,
  reject_back_rank_when_develop_bishop: true,
  develop_bishop_is_must_do: true,
  reject_early_king_wander: true,
  reject_bishop_snipe_hangs: true,
  reject_power_hangs_idle: true,
  reject_walks_into_snipe: true,
  arrow_enemy_bishop_is_must_do: true,
};

export const DEFAULT_V4_LOOP: PolicyLoop = {
  max_attempts: 12,
  check_closer_from_attempt: 3,
};

export const DEFAULT_EARLY_KING_PLIES = 60;
export const EARLY_KING_PLIES_CLAMP: [number, number] = [20, 120];

/** Off in v4-seed / active / cand-r1 so a running round is unchanged. */
export const DEFAULT_LATE_CONV_ENABLED = false;
export const DEFAULT_LATE_CONV_PLY = 120;
export const DEFAULT_LATE_CONV_MARGIN = 3;
export const LATE_CONV_PLY_CLAMP: [number, number] = [80, 180];
export const LATE_CONV_MARGIN_CLAMP: [number, number] = [1, 9];

/** Strategy-4. All off on v4-seed so an unchanged genome ranks exactly as v4. */
export const DEFAULT_LOOKAHEAD_ENABLED = false;
export const DEFAULT_LOOKAHEAD_SCALE = 400;
export const LOOKAHEAD_SCALE_CLAMP: [number, number] = [0, 2000];
export const DEFAULT_TRADE_DOWN_ENABLED = false;
export const DEFAULT_TRADE_DOWN_MARGIN = 1;
export const TRADE_DOWN_MARGIN_CLAMP: [number, number] = [1, 9];
export const DEFAULT_KING_GUARD_ENABLED = false;
export const DEFAULT_KING_GUARD_PLIES = 30;
export const KING_GUARD_PLIES_CLAMP: [number, number] = [1, 60];
export const DEFAULT_ILLEGAL_FILTER_ENABLED = false;

/** Strategy-5. All off on v4-seed so an unchanged genome ranks exactly as v4. */
export const DEFAULT_QUIESCENCE_ENABLED = false;
export const DEFAULT_QUIESCENCE_SCALE = 400;
export const QUIESCENCE_SCALE_CLAMP: [number, number] = [0, 2000];
export const DEFAULT_HANG_SHIELD_ENABLED = false;
export const DEFAULT_REPLY_SAFETY_ENABLED = false;
export const DEFAULT_PROGRESS_ENABLED = false;
export const DEFAULT_PROGRESS_MARGIN = 1;
export const PROGRESS_MARGIN_CLAMP: [number, number] = [1, 9];

/** Strategy-6. All off on v4-seed. */
export const DEFAULT_SHOT_FILTER_ENABLED = false;
export const DEFAULT_MATE_NET_ENABLED = false;
export const DEFAULT_MATE_NET_MARGIN = 1;
export const MATE_NET_MARGIN_CLAMP: [number, number] = [1, 9];
export const DEFAULT_MATE_NET_SCALE = 400;
export const MATE_NET_SCALE_CLAMP: [number, number] = [0, 2000];
export const DEFAULT_KING_HUNT_ENABLED = false;
export const DEFAULT_KING_HUNT_MAX_MATERIAL = 14;
export const KING_HUNT_MAX_MATERIAL_CLAMP: [number, number] = [1, 40];
export const DEFAULT_ESCAPE_FIRST_ENABLED = false;

/** Strategy-7. All off on v4-seed and on the promoted incumbent. */
export const DEFAULT_FINISH_ENABLED = false;
export const DEFAULT_FINISH_PLY = 40;
export const FINISH_PLY_CLAMP: [number, number] = [40, 180];
export const DEFAULT_FINISH_MARGIN = 1;
export const FINISH_MARGIN_CLAMP: [number, number] = [1, 9];
export const DEFAULT_KING_HELP_ENABLED = false;
export const DEFAULT_KING_HELP_PLY = 80;
export const KING_HELP_PLY_CLAMP: [number, number] = [40, 180];
export const DEFAULT_KING_HELP_MAX_ENEMY = 12;
export const KING_HELP_MAX_ENEMY_CLAMP: [number, number] = [1, 40];
export const DEFAULT_SPAN_FILTER_ENABLED = false;
export const DEFAULT_CONVERT_ENABLED = false;
export const DEFAULT_CONVERT_PLY = 40;
export const CONVERT_PLY_CLAMP: [number, number] = [40, 180];
export const DEFAULT_CONVERT_MARGIN = 1;
export const CONVERT_MARGIN_CLAMP: [number, number] = [1, 9];

/** Strategy-9. All off on v4-seed and on the promoted incumbent. */
export const DEFAULT_SHELTER_ENABLED = false;
export const DEFAULT_SHELTER_PLIES = 30;
export const SHELTER_PLIES_CLAMP: [number, number] = [1, 30];
export const DEFAULT_QR_SPARE_ENABLED = false;
export const DEFAULT_RUBBLE_ENABLED = false;

/** Strategy-10. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_VOLLEY_ENABLED = false;
export const DEFAULT_VOLLEY_PLY = 40;
export const VOLLEY_PLY_CLAMP: [number, number] = [40, 180];
export const DEFAULT_VOLLEY_MARGIN = 1;
export const VOLLEY_MARGIN_CLAMP: [number, number] = [1, 9];

/** Strategy-11. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_COVER_ENABLED = false;

/** Strategy-12. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_SEAL_ENABLED = false;
export const DEFAULT_PRESS_ENABLED = false;
export const DEFAULT_PRESS_PLY = 100;
export const PRESS_PLY_CLAMP: [number, number] = [40, 180];

/** Strategy-13. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_REAP_ENABLED = false;
export const DEFAULT_REAP_PLY = 40;
export const REAP_PLY_CLAMP: [number, number] = [40, 180];

/** Strategy-14. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_GLEAN_ENABLED = false;
export const DEFAULT_GLEAN_PLY = 0;
export const GLEAN_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-15. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_SHEAF_ENABLED = false;
export const DEFAULT_SHEAF_PLY = 0;
export const SHEAF_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-16. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_KEEL_ENABLED = false;
export const DEFAULT_KEEL_PLY = 30;
export const KEEL_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-17. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_SIFT_ENABLED = false;
export const DEFAULT_SIFT_PLY = 0;
export const SIFT_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-18. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_PROD_ENABLED = false;
export const DEFAULT_PROD_PLY = 30;
export const PROD_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-19. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_NOCK_ENABLED = false;
export const DEFAULT_NOCK_PLY = 0;
export const NOCK_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-20. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_FLETCH_ENABLED = false;
export const DEFAULT_FLETCH_PLY = 0;
export const FLETCH_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-21. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_PILE_ENABLED = false;
export const DEFAULT_PILE_PLY = 0;
export const PILE_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-22. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_HAFT_ENABLED = false;
export const DEFAULT_HAFT_PLY = 0;
export const HAFT_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-23. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_QUARREL_ENABLED = false;
export const DEFAULT_QUARREL_PLY = 0;
export const QUARREL_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-24. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_BODKIN_ENABLED = false;
export const DEFAULT_BODKIN_PLY = 0;
export const BODKIN_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-25. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_CREST_ENABLED = false;
export const DEFAULT_CREST_PLY = 0;
export const CREST_PLY_CLAMP: [number, number] = [0, 180];
export const DEFAULT_BRACE_ENABLED = false;
export const DEFAULT_BRACE_PLY = 0;
export const BRACE_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-27. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_MARK_ENABLED = false;
export const DEFAULT_MARK_PLY = 0;
export const MARK_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-28. Off on v4-seed and on the promoted incumbent. */
export const DEFAULT_FLIGHT_ENABLED = false;
export const DEFAULT_FLIGHT_PLY = 0;
export const FLIGHT_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-29. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_CLOUT_ENABLED = false;
export const DEFAULT_CLOUT_PLY = 40;
export const CLOUT_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-30. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_BARB_ENABLED = false;
export const DEFAULT_BARB_PLY = 0;
export const BARB_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-31. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_VANE_ENABLED = false;
export const DEFAULT_VANE_PLY = 0;
export const VANE_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-32. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_QUILL_ENABLED = false;
export const DEFAULT_QUILL_PLY = 0;
export const QUILL_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-33. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_STRING_ENABLED = false;
export const DEFAULT_STRING_PLY = 0;
export const STRING_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-34. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_BOLT_ENABLED = false;
export const DEFAULT_BOLT_PLY = 0;
export const BOLT_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-35. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_SPINE_ENABLED = false;
export const DEFAULT_SPINE_PLY = 0;
export const SPINE_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-36. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_BROADHEAD_ENABLED = false;
export const DEFAULT_BROADHEAD_PLY = 0;
export const BROADHEAD_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-37. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_SHAFT_ENABLED = false;
export const DEFAULT_SHAFT_PLY = 0;
export const SHAFT_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-38. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_ANCHOR_ENABLED = false;
export const DEFAULT_ANCHOR_PLY = 0;
export const ANCHOR_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-39. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_CAST_ENABLED = false;
export const DEFAULT_CAST_PLY = 0;
export const CAST_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-40. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_QUARRY_ENABLED = false;
export const DEFAULT_QUARRY_PLY = 0;
export const QUARRY_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-41. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_LATCH_ENABLED = false;
export const DEFAULT_LATCH_PLY = 0;
export const LATCH_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-42. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_SIGHTER_ENABLED = false;
export const DEFAULT_SIGHTER_PLY = 0;
export const SIGHTER_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-43. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_PLUCK_ENABLED = false;
export const DEFAULT_PLUCK_PLY = 0;
export const PLUCK_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-44. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_FETCH_ENABLED = false;
export const DEFAULT_FETCH_PLY = 0;
export const FETCH_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-45. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_GRIP_ENABLED = false;
export const DEFAULT_GRIP_PLY = 0;
export const GRIP_PLY_CLAMP: [number, number] = [0, 180];

/** Abandoned blunt hook. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_BLUNT_ENABLED = false;
export const DEFAULT_BLUNT_PLY = 0;
export const BLUNT_PLY_CLAMP: [number, number] = [0, 180];

/** Strategy-46 reply2. Off on v4-seed and on the promoted cand-r32 incumbent. */
export const DEFAULT_REPLY2_ENABLED = false;
export const DEFAULT_REPLY2_SCALE = 20;
export const DEFAULT_REPLY2_PLY = 0;
export const REPLY2_SCALE_CLAMP: [number, number] = [0, 2000];
export const REPLY2_PLY_CLAMP: [number, number] = [0, 180];

export const DEFAULT_V4_GENOME: PolicyGenome = {
  id: 'v4-seed',
  parent: null,
  generation: 0,
  weights: { ...DEFAULT_V4_WEIGHTS },
  gates: { ...DEFAULT_V4_GATES },
  loop: { ...DEFAULT_V4_LOOP },
  early_king_plies: DEFAULT_EARLY_KING_PLIES,
  late_conv_enabled: DEFAULT_LATE_CONV_ENABLED,
  late_conv_ply: DEFAULT_LATE_CONV_PLY,
  late_conv_margin: DEFAULT_LATE_CONV_MARGIN,
  lookahead_enabled: DEFAULT_LOOKAHEAD_ENABLED,
  lookahead_scale: DEFAULT_LOOKAHEAD_SCALE,
  trade_down_enabled: DEFAULT_TRADE_DOWN_ENABLED,
  trade_down_margin: DEFAULT_TRADE_DOWN_MARGIN,
  king_guard_enabled: DEFAULT_KING_GUARD_ENABLED,
  king_guard_plies: DEFAULT_KING_GUARD_PLIES,
  illegal_filter_enabled: DEFAULT_ILLEGAL_FILTER_ENABLED,
  quiescence_enabled: DEFAULT_QUIESCENCE_ENABLED,
  quiescence_scale: DEFAULT_QUIESCENCE_SCALE,
  hang_shield_enabled: DEFAULT_HANG_SHIELD_ENABLED,
  reply_safety_enabled: DEFAULT_REPLY_SAFETY_ENABLED,
  progress_enabled: DEFAULT_PROGRESS_ENABLED,
  progress_margin: DEFAULT_PROGRESS_MARGIN,
  shot_filter_enabled: DEFAULT_SHOT_FILTER_ENABLED,
  mate_net_enabled: DEFAULT_MATE_NET_ENABLED,
  mate_net_margin: DEFAULT_MATE_NET_MARGIN,
  mate_net_scale: DEFAULT_MATE_NET_SCALE,
  king_hunt_enabled: DEFAULT_KING_HUNT_ENABLED,
  king_hunt_max_material: DEFAULT_KING_HUNT_MAX_MATERIAL,
  escape_first_enabled: DEFAULT_ESCAPE_FIRST_ENABLED,
  finish_enabled: DEFAULT_FINISH_ENABLED,
  finish_ply: DEFAULT_FINISH_PLY,
  finish_margin: DEFAULT_FINISH_MARGIN,
  king_help_enabled: DEFAULT_KING_HELP_ENABLED,
  king_help_ply: DEFAULT_KING_HELP_PLY,
  king_help_max_enemy: DEFAULT_KING_HELP_MAX_ENEMY,
  span_filter_enabled: DEFAULT_SPAN_FILTER_ENABLED,
  convert_enabled: DEFAULT_CONVERT_ENABLED,
  convert_ply: DEFAULT_CONVERT_PLY,
  convert_margin: DEFAULT_CONVERT_MARGIN,
  shelter_enabled: DEFAULT_SHELTER_ENABLED,
  shelter_plies: DEFAULT_SHELTER_PLIES,
  qr_spare_enabled: DEFAULT_QR_SPARE_ENABLED,
  rubble_enabled: DEFAULT_RUBBLE_ENABLED,
  volley_enabled: DEFAULT_VOLLEY_ENABLED,
  volley_ply: DEFAULT_VOLLEY_PLY,
  volley_margin: DEFAULT_VOLLEY_MARGIN,
  cover_enabled: DEFAULT_COVER_ENABLED,
  seal_enabled: DEFAULT_SEAL_ENABLED,
  press_enabled: DEFAULT_PRESS_ENABLED,
  press_ply: DEFAULT_PRESS_PLY,
  reap_enabled: DEFAULT_REAP_ENABLED,
  reap_ply: DEFAULT_REAP_PLY,
  glean_enabled: DEFAULT_GLEAN_ENABLED,
  glean_ply: DEFAULT_GLEAN_PLY,
  sheaf_enabled: DEFAULT_SHEAF_ENABLED,
  sheaf_ply: DEFAULT_SHEAF_PLY,
  keel_enabled: DEFAULT_KEEL_ENABLED,
  keel_ply: DEFAULT_KEEL_PLY,
  sift_enabled: DEFAULT_SIFT_ENABLED,
  sift_ply: DEFAULT_SIFT_PLY,
  prod_enabled: DEFAULT_PROD_ENABLED,
  prod_ply: DEFAULT_PROD_PLY,
  nock_enabled: DEFAULT_NOCK_ENABLED,
  nock_ply: DEFAULT_NOCK_PLY,
  fletch_enabled: DEFAULT_FLETCH_ENABLED,
  fletch_ply: DEFAULT_FLETCH_PLY,
  pile_enabled: DEFAULT_PILE_ENABLED,
  pile_ply: DEFAULT_PILE_PLY,
  haft_enabled: DEFAULT_HAFT_ENABLED,
  haft_ply: DEFAULT_HAFT_PLY,
  quarrel_enabled: DEFAULT_QUARREL_ENABLED,
  quarrel_ply: DEFAULT_QUARREL_PLY,
  bodkin_enabled: DEFAULT_BODKIN_ENABLED,
  bodkin_ply: DEFAULT_BODKIN_PLY,
  crest_enabled: DEFAULT_CREST_ENABLED,
  crest_ply: DEFAULT_CREST_PLY,
  brace_enabled: DEFAULT_BRACE_ENABLED,
  brace_ply: DEFAULT_BRACE_PLY,
  mark_enabled: DEFAULT_MARK_ENABLED,
  mark_ply: DEFAULT_MARK_PLY,
  flight_enabled: DEFAULT_FLIGHT_ENABLED,
  flight_ply: DEFAULT_FLIGHT_PLY,
  clout_enabled: DEFAULT_CLOUT_ENABLED,
  clout_ply: DEFAULT_CLOUT_PLY,
  barb_enabled: DEFAULT_BARB_ENABLED,
  barb_ply: DEFAULT_BARB_PLY,
  vane_enabled: DEFAULT_VANE_ENABLED,
  vane_ply: DEFAULT_VANE_PLY,
  quill_enabled: DEFAULT_QUILL_ENABLED,
  quill_ply: DEFAULT_QUILL_PLY,
  string_enabled: DEFAULT_STRING_ENABLED,
  string_ply: DEFAULT_STRING_PLY,
  bolt_enabled: DEFAULT_BOLT_ENABLED,
  bolt_ply: DEFAULT_BOLT_PLY,
  spine_enabled: DEFAULT_SPINE_ENABLED,
  spine_ply: DEFAULT_SPINE_PLY,
  broadhead_enabled: DEFAULT_BROADHEAD_ENABLED,
  broadhead_ply: DEFAULT_BROADHEAD_PLY,
  shaft_enabled: DEFAULT_SHAFT_ENABLED,
  shaft_ply: DEFAULT_SHAFT_PLY,
  anchor_enabled: DEFAULT_ANCHOR_ENABLED,
  anchor_ply: DEFAULT_ANCHOR_PLY,
  cast_enabled: DEFAULT_CAST_ENABLED,
  cast_ply: DEFAULT_CAST_PLY,
  quarry_enabled: DEFAULT_QUARRY_ENABLED,
  quarry_ply: DEFAULT_QUARRY_PLY,
  latch_enabled: DEFAULT_LATCH_ENABLED,
  latch_ply: DEFAULT_LATCH_PLY,
  sighter_enabled: DEFAULT_SIGHTER_ENABLED,
  sighter_ply: DEFAULT_SIGHTER_PLY,
  pluck_enabled: DEFAULT_PLUCK_ENABLED,
  pluck_ply: DEFAULT_PLUCK_PLY,
  fetch_enabled: DEFAULT_FETCH_ENABLED,
  fetch_ply: DEFAULT_FETCH_PLY,
  grip_enabled: DEFAULT_GRIP_ENABLED,
  grip_ply: DEFAULT_GRIP_PLY,
  blunt_enabled: DEFAULT_BLUNT_ENABLED,
  blunt_ply: DEFAULT_BLUNT_PLY,
  reply2_enabled: DEFAULT_REPLY2_ENABLED,
  reply2_scale: DEFAULT_REPLY2_SCALE,
  reply2_ply: DEFAULT_REPLY2_PLY,
  created: '2026-09-04T00:00:00.000Z',
  notes: 'hello extra; extra weights are exact computerPolicy.ts literals not in the design-table approximates, so v4-seed ranking matches hardcoded v4. Early king shelter through ply 60; bishop-snipe-hang; power-hangs-idle; bishop develop/attack; walks-into-snipe; arrow-enemy-bishop must-do. FILTER genome; never a move chooser.',
};

export const V4_SEED_WEIGHTS = DEFAULT_V4_WEIGHTS;

export function defaultV4Genome(): PolicyGenome {
  return {
    id: DEFAULT_V4_GENOME.id,
    parent: DEFAULT_V4_GENOME.parent,
    generation: DEFAULT_V4_GENOME.generation,
    weights: { ...DEFAULT_V4_WEIGHTS },
    gates: { ...DEFAULT_V4_GATES },
    loop: { ...DEFAULT_V4_LOOP },
    early_king_plies: DEFAULT_EARLY_KING_PLIES,
    late_conv_enabled: DEFAULT_LATE_CONV_ENABLED,
    late_conv_ply: DEFAULT_LATE_CONV_PLY,
    late_conv_margin: DEFAULT_LATE_CONV_MARGIN,
    lookahead_enabled: DEFAULT_LOOKAHEAD_ENABLED,
    lookahead_scale: DEFAULT_LOOKAHEAD_SCALE,
    trade_down_enabled: DEFAULT_TRADE_DOWN_ENABLED,
    trade_down_margin: DEFAULT_TRADE_DOWN_MARGIN,
    king_guard_enabled: DEFAULT_KING_GUARD_ENABLED,
    king_guard_plies: DEFAULT_KING_GUARD_PLIES,
    illegal_filter_enabled: DEFAULT_ILLEGAL_FILTER_ENABLED,
    quiescence_enabled: DEFAULT_QUIESCENCE_ENABLED,
    quiescence_scale: DEFAULT_QUIESCENCE_SCALE,
    hang_shield_enabled: DEFAULT_HANG_SHIELD_ENABLED,
    reply_safety_enabled: DEFAULT_REPLY_SAFETY_ENABLED,
    progress_enabled: DEFAULT_PROGRESS_ENABLED,
    progress_margin: DEFAULT_PROGRESS_MARGIN,
    shot_filter_enabled: DEFAULT_SHOT_FILTER_ENABLED,
    mate_net_enabled: DEFAULT_MATE_NET_ENABLED,
    mate_net_margin: DEFAULT_MATE_NET_MARGIN,
    mate_net_scale: DEFAULT_MATE_NET_SCALE,
    king_hunt_enabled: DEFAULT_KING_HUNT_ENABLED,
    king_hunt_max_material: DEFAULT_KING_HUNT_MAX_MATERIAL,
    escape_first_enabled: DEFAULT_ESCAPE_FIRST_ENABLED,
    finish_enabled: DEFAULT_FINISH_ENABLED,
    finish_ply: DEFAULT_FINISH_PLY,
    finish_margin: DEFAULT_FINISH_MARGIN,
    king_help_enabled: DEFAULT_KING_HELP_ENABLED,
    king_help_ply: DEFAULT_KING_HELP_PLY,
    king_help_max_enemy: DEFAULT_KING_HELP_MAX_ENEMY,
    span_filter_enabled: DEFAULT_SPAN_FILTER_ENABLED,
    convert_enabled: DEFAULT_CONVERT_ENABLED,
    convert_ply: DEFAULT_CONVERT_PLY,
    convert_margin: DEFAULT_CONVERT_MARGIN,
    shelter_enabled: DEFAULT_SHELTER_ENABLED,
    shelter_plies: DEFAULT_SHELTER_PLIES,
    qr_spare_enabled: DEFAULT_QR_SPARE_ENABLED,
    rubble_enabled: DEFAULT_RUBBLE_ENABLED,
    volley_enabled: DEFAULT_VOLLEY_ENABLED,
    volley_ply: DEFAULT_VOLLEY_PLY,
    volley_margin: DEFAULT_VOLLEY_MARGIN,
    cover_enabled: DEFAULT_COVER_ENABLED,
    seal_enabled: DEFAULT_SEAL_ENABLED,
    press_enabled: DEFAULT_PRESS_ENABLED,
    press_ply: DEFAULT_PRESS_PLY,
    reap_enabled: DEFAULT_REAP_ENABLED,
    reap_ply: DEFAULT_REAP_PLY,
    glean_enabled: DEFAULT_GLEAN_ENABLED,
    glean_ply: DEFAULT_GLEAN_PLY,
    sheaf_enabled: DEFAULT_SHEAF_ENABLED,
    sheaf_ply: DEFAULT_SHEAF_PLY,
    keel_enabled: DEFAULT_KEEL_ENABLED,
    keel_ply: DEFAULT_KEEL_PLY,
    sift_enabled: DEFAULT_SIFT_ENABLED,
    sift_ply: DEFAULT_SIFT_PLY,
    prod_enabled: DEFAULT_PROD_ENABLED,
    prod_ply: DEFAULT_PROD_PLY,
    nock_enabled: DEFAULT_NOCK_ENABLED,
    nock_ply: DEFAULT_NOCK_PLY,
    fletch_enabled: DEFAULT_FLETCH_ENABLED,
    fletch_ply: DEFAULT_FLETCH_PLY,
    pile_enabled: DEFAULT_PILE_ENABLED,
    pile_ply: DEFAULT_PILE_PLY,
    haft_enabled: DEFAULT_HAFT_ENABLED,
    haft_ply: DEFAULT_HAFT_PLY,
    quarrel_enabled: DEFAULT_QUARREL_ENABLED,
    quarrel_ply: DEFAULT_QUARREL_PLY,
    bodkin_enabled: DEFAULT_BODKIN_ENABLED,
    bodkin_ply: DEFAULT_BODKIN_PLY,
    crest_enabled: DEFAULT_CREST_ENABLED,
    crest_ply: DEFAULT_CREST_PLY,
    brace_enabled: DEFAULT_BRACE_ENABLED,
    brace_ply: DEFAULT_BRACE_PLY,
    mark_enabled: DEFAULT_MARK_ENABLED,
    mark_ply: DEFAULT_MARK_PLY,
    flight_enabled: DEFAULT_FLIGHT_ENABLED,
    flight_ply: DEFAULT_FLIGHT_PLY,
    clout_enabled: DEFAULT_CLOUT_ENABLED,
    clout_ply: DEFAULT_CLOUT_PLY,
    barb_enabled: DEFAULT_BARB_ENABLED,
    barb_ply: DEFAULT_BARB_PLY,
    vane_enabled: DEFAULT_VANE_ENABLED,
    vane_ply: DEFAULT_VANE_PLY,
    quill_enabled: DEFAULT_QUILL_ENABLED,
    quill_ply: DEFAULT_QUILL_PLY,
    string_enabled: DEFAULT_STRING_ENABLED,
    string_ply: DEFAULT_STRING_PLY,
    bolt_enabled: DEFAULT_BOLT_ENABLED,
    bolt_ply: DEFAULT_BOLT_PLY,
    spine_enabled: DEFAULT_SPINE_ENABLED,
    spine_ply: DEFAULT_SPINE_PLY,
    broadhead_enabled: DEFAULT_BROADHEAD_ENABLED,
    broadhead_ply: DEFAULT_BROADHEAD_PLY,
    shaft_enabled: DEFAULT_SHAFT_ENABLED,
    shaft_ply: DEFAULT_SHAFT_PLY,
    anchor_enabled: DEFAULT_ANCHOR_ENABLED,
    anchor_ply: DEFAULT_ANCHOR_PLY,
    cast_enabled: DEFAULT_CAST_ENABLED,
    cast_ply: DEFAULT_CAST_PLY,
    quarry_enabled: DEFAULT_QUARRY_ENABLED,
    quarry_ply: DEFAULT_QUARRY_PLY,
    latch_enabled: DEFAULT_LATCH_ENABLED,
    latch_ply: DEFAULT_LATCH_PLY,
    sighter_enabled: DEFAULT_SIGHTER_ENABLED,
    sighter_ply: DEFAULT_SIGHTER_PLY,
    pluck_enabled: DEFAULT_PLUCK_ENABLED,
    pluck_ply: DEFAULT_PLUCK_PLY,
    fetch_enabled: DEFAULT_FETCH_ENABLED,
    fetch_ply: DEFAULT_FETCH_PLY,
    grip_enabled: DEFAULT_GRIP_ENABLED,
    grip_ply: DEFAULT_GRIP_PLY,
    blunt_enabled: DEFAULT_BLUNT_ENABLED,
    blunt_ply: DEFAULT_BLUNT_PLY,
    reply2_enabled: DEFAULT_REPLY2_ENABLED,
    reply2_scale: DEFAULT_REPLY2_SCALE,
    reply2_ply: DEFAULT_REPLY2_PLY,
    created: DEFAULT_V4_GENOME.created,
    notes: DEFAULT_V4_GENOME.notes,
  };
}

export function labRoot(): string {
  return findLabRoot();
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function findLabRoot(): string {
  const envRoot = process.env.BATTLE_CHESS_LAB;
  if (envRoot && existsSync(join(envRoot, 'src', 'computerPolicy.ts'))) return envRoot;
  let here = process.cwd();
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  const candidates = [
    process.cwd(),
    join(process.cwd(), '..'),
    here,
    join(here, '..'),
    join(here, '..', '..'),
    '/Users/ssadams/battle-chess-lab',
  ];
  for (const c of candidates) {
    if (
      existsSync(join(c, 'evolve', 'genomes'))
      || existsSync(join(c, 'src', 'computerPolicy.ts'))
    ) {
      return c;
    }
  }
  return process.cwd();
}

export function defaultActivePath(): string {
  const env = process.env.POLICY_GENOME;
  if (env && env.trim()) {
    return isAbsolute(env) ? env : resolve(process.cwd(), env);
  }
  const champion = join(process.cwd(), 'server', 'policy', 'genomes', 'cand-r32.json');
  if (existsSync(champion)) return champion;
  return join(findLabRoot(), 'evolve', 'genomes', 'active.json');
}

export function resolveGenomePath(p: string): string {
  if (!p) return defaultActivePath();
  if (isAbsolute(p)) return p;
  return resolve(findLabRoot(), p);
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  return fallback;
}

function asNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeGenome(raw: unknown, fallbackId = 'anonymous'): PolicyGenome {
  const src = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const wIn = (src.weights && typeof src.weights === 'object') ? src.weights as Record<string, unknown> : {};
  const gIn = (src.gates && typeof src.gates === 'object') ? src.gates as Record<string, unknown> : {};
  const lIn = (src.loop && typeof src.loop === 'object') ? src.loop as Record<string, unknown> : {};

  const weights = { ...DEFAULT_V4_WEIGHTS };
  (Object.keys(WEIGHT_CLAMPS) as (keyof PolicyWeights)[]).forEach((k) => {
    const [lo, hi] = WEIGHT_CLAMPS[k];
    weights[k] = clamp(asNum(wIn[k], DEFAULT_V4_WEIGHTS[k]), lo, hi);
  });

  const gates: PolicyGates = {
    reject_axe_home_snipe: true,
    stuck_breaker_skips_home_snipe: true,
    bishop_aims_is_must_do: asBool(gIn.bishop_aims_is_must_do, DEFAULT_V4_GATES.bishop_aims_is_must_do),
    arrow_king_is_must_do: asBool(gIn.arrow_king_is_must_do, DEFAULT_V4_GATES.arrow_king_is_must_do),
    axe_king_is_must_do: asBool(gIn.axe_king_is_must_do, DEFAULT_V4_GATES.axe_king_is_must_do),
    reject_back_rank_when_develop_bishop: asBool(
      gIn.reject_back_rank_when_develop_bishop,
      DEFAULT_V4_GATES.reject_back_rank_when_develop_bishop,
    ),
    develop_bishop_is_must_do: asBool(gIn.develop_bishop_is_must_do, DEFAULT_V4_GATES.develop_bishop_is_must_do),
    reject_early_king_wander: asBool(gIn.reject_early_king_wander, DEFAULT_V4_GATES.reject_early_king_wander),
    reject_bishop_snipe_hangs: asBool(gIn.reject_bishop_snipe_hangs, DEFAULT_V4_GATES.reject_bishop_snipe_hangs),
    reject_power_hangs_idle: asBool(gIn.reject_power_hangs_idle, DEFAULT_V4_GATES.reject_power_hangs_idle),
    reject_walks_into_snipe: asBool(gIn.reject_walks_into_snipe, DEFAULT_V4_GATES.reject_walks_into_snipe),
    arrow_enemy_bishop_is_must_do: asBool(
      gIn.arrow_enemy_bishop_is_must_do,
      DEFAULT_V4_GATES.arrow_enemy_bishop_is_must_do,
    ),
  };

  const loop: PolicyLoop = {
    max_attempts: Math.round(clamp(asNum(lIn.max_attempts, DEFAULT_V4_LOOP.max_attempts), 6, 20)),
    check_closer_from_attempt: Math.round(
      clamp(asNum(lIn.check_closer_from_attempt, DEFAULT_V4_LOOP.check_closer_from_attempt), 2, 8),
    ),
  };

  const earlyKing = Math.round(
    clamp(asNum(src.early_king_plies, DEFAULT_EARLY_KING_PLIES), EARLY_KING_PLIES_CLAMP[0], EARLY_KING_PLIES_CLAMP[1]),
  );
  const lateConvPly = Math.round(
    clamp(asNum(src.late_conv_ply, DEFAULT_LATE_CONV_PLY), LATE_CONV_PLY_CLAMP[0], LATE_CONV_PLY_CLAMP[1]),
  );
  const lateConvMargin = Math.round(
    clamp(
      asNum(src.late_conv_margin, DEFAULT_LATE_CONV_MARGIN),
      LATE_CONV_MARGIN_CLAMP[0],
      LATE_CONV_MARGIN_CLAMP[1],
    ),
  );
  const lookaheadScale = Math.round(
    clamp(
      asNum(src.lookahead_scale, DEFAULT_LOOKAHEAD_SCALE),
      LOOKAHEAD_SCALE_CLAMP[0],
      LOOKAHEAD_SCALE_CLAMP[1],
    ),
  );
  const tradeDownMargin = Math.round(
    clamp(
      asNum(src.trade_down_margin, DEFAULT_TRADE_DOWN_MARGIN),
      TRADE_DOWN_MARGIN_CLAMP[0],
      TRADE_DOWN_MARGIN_CLAMP[1],
    ),
  );
  const kingGuardPlies = Math.round(
    clamp(
      asNum(src.king_guard_plies, DEFAULT_KING_GUARD_PLIES),
      KING_GUARD_PLIES_CLAMP[0],
      KING_GUARD_PLIES_CLAMP[1],
    ),
  );
  const quiescenceScale = Math.round(
    clamp(
      asNum(src.quiescence_scale, DEFAULT_QUIESCENCE_SCALE),
      QUIESCENCE_SCALE_CLAMP[0],
      QUIESCENCE_SCALE_CLAMP[1],
    ),
  );
  const progressMargin = Math.round(
    clamp(
      asNum(src.progress_margin, DEFAULT_PROGRESS_MARGIN),
      PROGRESS_MARGIN_CLAMP[0],
      PROGRESS_MARGIN_CLAMP[1],
    ),
  );
  const mateNetMargin = Math.round(
    clamp(
      asNum(src.mate_net_margin, DEFAULT_MATE_NET_MARGIN),
      MATE_NET_MARGIN_CLAMP[0],
      MATE_NET_MARGIN_CLAMP[1],
    ),
  );
  const mateNetScale = Math.round(
    clamp(
      asNum(src.mate_net_scale, DEFAULT_MATE_NET_SCALE),
      MATE_NET_SCALE_CLAMP[0],
      MATE_NET_SCALE_CLAMP[1],
    ),
  );
  const kingHuntMaxMaterial = Math.round(
    clamp(
      asNum(src.king_hunt_max_material, DEFAULT_KING_HUNT_MAX_MATERIAL),
      KING_HUNT_MAX_MATERIAL_CLAMP[0],
      KING_HUNT_MAX_MATERIAL_CLAMP[1],
    ),
  );
  const finishPly = Math.round(
    clamp(asNum(src.finish_ply, DEFAULT_FINISH_PLY), FINISH_PLY_CLAMP[0], FINISH_PLY_CLAMP[1]),
  );
  const finishMargin = Math.round(
    clamp(
      asNum(src.finish_margin, DEFAULT_FINISH_MARGIN),
      FINISH_MARGIN_CLAMP[0],
      FINISH_MARGIN_CLAMP[1],
    ),
  );
  const kingHelpPly = Math.round(
    clamp(asNum(src.king_help_ply, DEFAULT_KING_HELP_PLY), KING_HELP_PLY_CLAMP[0], KING_HELP_PLY_CLAMP[1]),
  );
  const kingHelpMaxEnemy = Math.round(
    clamp(
      asNum(src.king_help_max_enemy, DEFAULT_KING_HELP_MAX_ENEMY),
      KING_HELP_MAX_ENEMY_CLAMP[0],
      KING_HELP_MAX_ENEMY_CLAMP[1],
    ),
  );
  const convertPly = Math.round(
    clamp(asNum(src.convert_ply, DEFAULT_CONVERT_PLY), CONVERT_PLY_CLAMP[0], CONVERT_PLY_CLAMP[1]),
  );
  const convertMargin = Math.round(
    clamp(
      asNum(src.convert_margin, DEFAULT_CONVERT_MARGIN),
      CONVERT_MARGIN_CLAMP[0],
      CONVERT_MARGIN_CLAMP[1],
    ),
  );
  const shelterPlies = Math.round(
    clamp(
      asNum(src.shelter_plies, DEFAULT_SHELTER_PLIES),
      SHELTER_PLIES_CLAMP[0],
      SHELTER_PLIES_CLAMP[1],
    ),
  );
  const volleyPly = Math.round(
    clamp(asNum(src.volley_ply, DEFAULT_VOLLEY_PLY), VOLLEY_PLY_CLAMP[0], VOLLEY_PLY_CLAMP[1]),
  );
  const volleyMargin = Math.round(
    clamp(
      asNum(src.volley_margin, DEFAULT_VOLLEY_MARGIN),
      VOLLEY_MARGIN_CLAMP[0],
      VOLLEY_MARGIN_CLAMP[1],
    ),
  );
  const pressPly = Math.round(
    clamp(asNum(src.press_ply, DEFAULT_PRESS_PLY), PRESS_PLY_CLAMP[0], PRESS_PLY_CLAMP[1]),
  );
  const reapPly = Math.round(
    clamp(asNum(src.reap_ply, DEFAULT_REAP_PLY), REAP_PLY_CLAMP[0], REAP_PLY_CLAMP[1]),
  );
  const gleanPly = Math.round(
    clamp(asNum(src.glean_ply, DEFAULT_GLEAN_PLY), GLEAN_PLY_CLAMP[0], GLEAN_PLY_CLAMP[1]),
  );
  const sheafPly = Math.round(
    clamp(asNum(src.sheaf_ply, DEFAULT_SHEAF_PLY), SHEAF_PLY_CLAMP[0], SHEAF_PLY_CLAMP[1]),
  );
  const keelPly = Math.round(
    clamp(asNum(src.keel_ply, DEFAULT_KEEL_PLY), KEEL_PLY_CLAMP[0], KEEL_PLY_CLAMP[1]),
  );
  const siftPly = Math.round(
    clamp(asNum(src.sift_ply, DEFAULT_SIFT_PLY), SIFT_PLY_CLAMP[0], SIFT_PLY_CLAMP[1]),
  );
  const prodPly = Math.round(
    clamp(asNum(src.prod_ply, DEFAULT_PROD_PLY), PROD_PLY_CLAMP[0], PROD_PLY_CLAMP[1]),
  );
  const nockPly = Math.round(
    clamp(asNum(src.nock_ply, DEFAULT_NOCK_PLY), NOCK_PLY_CLAMP[0], NOCK_PLY_CLAMP[1]),
  );
  const fletchPly = Math.round(
    clamp(asNum(src.fletch_ply, DEFAULT_FLETCH_PLY), FLETCH_PLY_CLAMP[0], FLETCH_PLY_CLAMP[1]),
  );
  const pilePly = Math.round(
    clamp(asNum(src.pile_ply, DEFAULT_PILE_PLY), PILE_PLY_CLAMP[0], PILE_PLY_CLAMP[1]),
  );
  const haftPly = Math.round(
    clamp(asNum(src.haft_ply, DEFAULT_HAFT_PLY), HAFT_PLY_CLAMP[0], HAFT_PLY_CLAMP[1]),
  );
  const quarrelPly = Math.round(
    clamp(asNum(src.quarrel_ply, DEFAULT_QUARREL_PLY), QUARREL_PLY_CLAMP[0], QUARREL_PLY_CLAMP[1]),
  );
  const bodkinPly = Math.round(
    clamp(asNum(src.bodkin_ply, DEFAULT_BODKIN_PLY), BODKIN_PLY_CLAMP[0], BODKIN_PLY_CLAMP[1]),
  );
  const crestPly = Math.round(
    clamp(asNum(src.crest_ply, DEFAULT_CREST_PLY), CREST_PLY_CLAMP[0], CREST_PLY_CLAMP[1]),
  );
  const bracePly = Math.round(
    clamp(asNum(src.brace_ply, DEFAULT_BRACE_PLY), BRACE_PLY_CLAMP[0], BRACE_PLY_CLAMP[1]),
  );
  const markPly = Math.round(
    clamp(asNum(src.mark_ply, DEFAULT_MARK_PLY), MARK_PLY_CLAMP[0], MARK_PLY_CLAMP[1]),
  );
  const flightPly = Math.round(
    clamp(asNum(src.flight_ply, DEFAULT_FLIGHT_PLY), FLIGHT_PLY_CLAMP[0], FLIGHT_PLY_CLAMP[1]),
  );
  const cloutPly = Math.round(
    clamp(asNum(src.clout_ply, DEFAULT_CLOUT_PLY), CLOUT_PLY_CLAMP[0], CLOUT_PLY_CLAMP[1]),
  );
  const barbPly = Math.round(
    clamp(asNum(src.barb_ply, DEFAULT_BARB_PLY), BARB_PLY_CLAMP[0], BARB_PLY_CLAMP[1]),
  );
  const vanePly = Math.round(
    clamp(asNum(src.vane_ply, DEFAULT_VANE_PLY), VANE_PLY_CLAMP[0], VANE_PLY_CLAMP[1]),
  );
  const quillPly = Math.round(
    clamp(asNum(src.quill_ply, DEFAULT_QUILL_PLY), QUILL_PLY_CLAMP[0], QUILL_PLY_CLAMP[1]),
  );
  const stringPly = Math.round(
    clamp(asNum(src.string_ply, DEFAULT_STRING_PLY), STRING_PLY_CLAMP[0], STRING_PLY_CLAMP[1]),
  );
  const boltPly = Math.round(
    clamp(asNum(src.bolt_ply, DEFAULT_BOLT_PLY), BOLT_PLY_CLAMP[0], BOLT_PLY_CLAMP[1]),
  );
  const spinePly = Math.round(
    clamp(asNum(src.spine_ply, DEFAULT_SPINE_PLY), SPINE_PLY_CLAMP[0], SPINE_PLY_CLAMP[1]),
  );
  const broadheadPly = Math.round(
    clamp(asNum(src.broadhead_ply, DEFAULT_BROADHEAD_PLY), BROADHEAD_PLY_CLAMP[0], BROADHEAD_PLY_CLAMP[1]),
  );
  const shaftPly = Math.round(
    clamp(asNum(src.shaft_ply, DEFAULT_SHAFT_PLY), SHAFT_PLY_CLAMP[0], SHAFT_PLY_CLAMP[1]),
  );
  const anchorPly = Math.round(
    clamp(asNum(src.anchor_ply, DEFAULT_ANCHOR_PLY), ANCHOR_PLY_CLAMP[0], ANCHOR_PLY_CLAMP[1]),
  );
  const castPly = Math.round(
    clamp(asNum(src.cast_ply, DEFAULT_CAST_PLY), CAST_PLY_CLAMP[0], CAST_PLY_CLAMP[1]),
  );
  const quarryPly = Math.round(
    clamp(asNum(src.quarry_ply, DEFAULT_QUARRY_PLY), QUARRY_PLY_CLAMP[0], QUARRY_PLY_CLAMP[1]),
  );
  const latchPly = Math.round(
    clamp(asNum(src.latch_ply, DEFAULT_LATCH_PLY), LATCH_PLY_CLAMP[0], LATCH_PLY_CLAMP[1]),
  );
  const sighterPly = Math.round(
    clamp(asNum(src.sighter_ply, DEFAULT_SIGHTER_PLY), SIGHTER_PLY_CLAMP[0], SIGHTER_PLY_CLAMP[1]),
  );
  const pluckPly = Math.round(
    clamp(asNum(src.pluck_ply, DEFAULT_PLUCK_PLY), PLUCK_PLY_CLAMP[0], PLUCK_PLY_CLAMP[1]),
  );
  const fetchPly = Math.round(
    clamp(asNum(src.fetch_ply, DEFAULT_FETCH_PLY), FETCH_PLY_CLAMP[0], FETCH_PLY_CLAMP[1]),
  );
  const gripPly = Math.round(
    clamp(asNum(src.grip_ply, DEFAULT_GRIP_PLY), GRIP_PLY_CLAMP[0], GRIP_PLY_CLAMP[1]),
  );
  const bluntPly = Math.round(
    clamp(asNum(src.blunt_ply, DEFAULT_BLUNT_PLY), BLUNT_PLY_CLAMP[0], BLUNT_PLY_CLAMP[1]),
  );
  const reply2Scale = Math.round(
    clamp(asNum(src.reply2_scale, DEFAULT_REPLY2_SCALE), REPLY2_SCALE_CLAMP[0], REPLY2_SCALE_CLAMP[1]),
  );
  const reply2Ply = Math.round(
    clamp(asNum(src.reply2_ply, DEFAULT_REPLY2_PLY), REPLY2_PLY_CLAMP[0], REPLY2_PLY_CLAMP[1]),
  );

  return {
    id: typeof src.id === 'string' && src.id ? src.id : fallbackId,
    parent: typeof src.parent === 'string' ? src.parent : (src.parent === null ? null : null),
    generation: Math.max(0, Math.round(asNum(src.generation, 0))),
    weights,
    gates,
    loop,
    early_king_plies: earlyKing,
    late_conv_enabled: src.late_conv_enabled === true,
    late_conv_ply: lateConvPly,
    late_conv_margin: lateConvMargin,
    lookahead_enabled: src.lookahead_enabled === true,
    lookahead_scale: lookaheadScale,
    trade_down_enabled: src.trade_down_enabled === true,
    trade_down_margin: tradeDownMargin,
    king_guard_enabled: src.king_guard_enabled === true,
    king_guard_plies: kingGuardPlies,
    illegal_filter_enabled: src.illegal_filter_enabled === true,
    quiescence_enabled: src.quiescence_enabled === true,
    quiescence_scale: quiescenceScale,
    hang_shield_enabled: src.hang_shield_enabled === true,
    reply_safety_enabled: src.reply_safety_enabled === true,
    progress_enabled: src.progress_enabled === true,
    progress_margin: progressMargin,
    shot_filter_enabled: src.shot_filter_enabled === true,
    mate_net_enabled: src.mate_net_enabled === true,
    mate_net_margin: mateNetMargin,
    mate_net_scale: mateNetScale,
    king_hunt_enabled: src.king_hunt_enabled === true,
    king_hunt_max_material: kingHuntMaxMaterial,
    escape_first_enabled: src.escape_first_enabled === true,
    finish_enabled: src.finish_enabled === true,
    finish_ply: finishPly,
    finish_margin: finishMargin,
    king_help_enabled: src.king_help_enabled === true,
    king_help_ply: kingHelpPly,
    king_help_max_enemy: kingHelpMaxEnemy,
    span_filter_enabled: src.span_filter_enabled === true,
    convert_enabled: src.convert_enabled === true,
    convert_ply: convertPly,
    convert_margin: convertMargin,
    shelter_enabled: src.shelter_enabled === true,
    shelter_plies: shelterPlies,
    qr_spare_enabled: src.qr_spare_enabled === true,
    rubble_enabled: src.rubble_enabled === true,
    volley_enabled: src.volley_enabled === true,
    volley_ply: volleyPly,
    volley_margin: volleyMargin,
    cover_enabled: src.cover_enabled === true,
    seal_enabled: src.seal_enabled === true,
    press_enabled: src.press_enabled === true,
    press_ply: pressPly,
    reap_enabled: src.reap_enabled === true,
    reap_ply: reapPly,
    glean_enabled: src.glean_enabled === true,
    glean_ply: gleanPly,
    sheaf_enabled: src.sheaf_enabled === true,
    sheaf_ply: sheafPly,
    keel_enabled: src.keel_enabled === true,
    keel_ply: keelPly,
    sift_enabled: src.sift_enabled === true,
    sift_ply: siftPly,
    prod_enabled: src.prod_enabled === true,
    prod_ply: prodPly,
    nock_enabled: src.nock_enabled === true,
    nock_ply: nockPly,
    fletch_enabled: src.fletch_enabled === true,
    fletch_ply: fletchPly,
    pile_enabled: src.pile_enabled === true,
    pile_ply: pilePly,
    haft_enabled: src.haft_enabled === true,
    haft_ply: haftPly,
    quarrel_enabled: src.quarrel_enabled === true,
    quarrel_ply: quarrelPly,
    bodkin_enabled: src.bodkin_enabled === true,
    bodkin_ply: bodkinPly,
    crest_enabled: src.crest_enabled === true,
    crest_ply: crestPly,
    brace_enabled: src.brace_enabled === true,
    brace_ply: bracePly,
    mark_enabled: src.mark_enabled === true,
    mark_ply: markPly,
    flight_enabled: src.flight_enabled === true,
    flight_ply: flightPly,
    clout_enabled: src.clout_enabled === true,
    clout_ply: cloutPly,
    barb_enabled: src.barb_enabled === true,
    barb_ply: barbPly,
    vane_enabled: src.vane_enabled === true,
    vane_ply: vanePly,
    quill_enabled: src.quill_enabled === true,
    quill_ply: quillPly,
    string_enabled: src.string_enabled === true,
    string_ply: stringPly,
    bolt_enabled: src.bolt_enabled === true,
    bolt_ply: boltPly,
    spine_enabled: src.spine_enabled === true,
    spine_ply: spinePly,
    broadhead_enabled: src.broadhead_enabled === true,
    broadhead_ply: broadheadPly,
    shaft_enabled: src.shaft_enabled === true,
    shaft_ply: shaftPly,
    anchor_enabled: src.anchor_enabled === true,
    anchor_ply: anchorPly,
    cast_enabled: src.cast_enabled === true,
    cast_ply: castPly,
    quarry_enabled: src.quarry_enabled === true,
    quarry_ply: quarryPly,
    latch_enabled: src.latch_enabled === true,
    latch_ply: latchPly,
    sighter_enabled: src.sighter_enabled === true,
    sighter_ply: sighterPly,
    pluck_enabled: src.pluck_enabled === true,
    pluck_ply: pluckPly,
    fetch_enabled: src.fetch_enabled === true,
    fetch_ply: fetchPly,
    grip_enabled: src.grip_enabled === true,
    grip_ply: gripPly,
    blunt_enabled: src.blunt_enabled === true,
    blunt_ply: bluntPly,
    reply2_enabled: src.reply2_enabled === true,
    reply2_scale: reply2Scale,
    reply2_ply: reply2Ply,
    created: typeof src.created === 'string' ? src.created : new Date().toISOString(),
    notes: typeof src.notes === 'string' ? src.notes : undefined,
  };
}

export function loadGenome(path: string): PolicyGenome {
  const resolved = resolveGenomePath(path);
  const raw = JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
  return normalizeGenome(raw, resolved);
}

interface CacheEntry {
  path: string;
  mtimeMs: number;
  genome: PolicyGenome;
}

const fileCache = new Map<string, CacheEntry>();
let override: PolicyGenome | null = null;
let lastActivePath = '';

export function setPolicyGenome(genome: PolicyGenome | null): void {
  override = genome;
}

export function getActiveGenomePath(): string {
  return lastActivePath || defaultActivePath();
}

export function loadGenomeCached(path: string): PolicyGenome {
  const resolved = resolveGenomePath(path);
  try {
    const mtimeMs = statSync(resolved).mtimeMs;
    const hit = fileCache.get(resolved);
    if (hit && hit.mtimeMs === mtimeMs) return hit.genome;
    const genome = loadGenome(resolved);
    fileCache.set(resolved, { path: resolved, mtimeMs, genome });
    return genome;
  } catch {
    return {
      ...DEFAULT_V4_GENOME,
      weights: { ...DEFAULT_V4_WEIGHTS },
      gates: { ...DEFAULT_V4_GATES },
      loop: { ...DEFAULT_V4_LOOP },
    };
  }
}

/** Active genome: POLICY_GENOME or evolve/genomes/active.json. Mtime-cached. */
export function getActiveGenome(): PolicyGenome {
  const p = defaultActivePath();
  lastActivePath = p;
  return loadGenomeCached(p);
}

export function getPolicyGenome(): PolicyGenome {
  if (override) return override;
  return getActiveGenome();
}
