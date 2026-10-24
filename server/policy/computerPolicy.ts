/**
 * Computer-player policy for Battle Chess (lab).
 *
 * The lab referee is apply-only and MUST stay apply-only. This module never
 * runs inside GameManager.handle* / applyAction. LAB-W0-* rooms are agent PvP
 * (ChessOne / ChessTwo); the referee does not pick their moves.
 *
 * Gemma / Blaze / Metamac play-loops should call this as a FILTER:
 *   1. Build the legal list as today.
 *   2. Call evaluateComputerPolicy / filterModelPick.
 *   3. If the model picks a thrash, leaves its king in check when an escape
 *      exists, or misses a must-do, REJECT and retry (`retryHints` first).
 *   4. Do NOT silently replace a missed tactic on the first attempt.
 *   5. Play-loop may force `fallback` after repeated rejects, or when stuck.
 *
 * Must-dos (see RULES.md Computer player):
 *   check escape, take-checker, hanging take knight+, axe king/QR,
 *   arrow king / hanging Q|R / enemy bishop, keep knight forks, no two-square bounce,
 *   prefer pressure, never rank wall/bomb over a take/check/arrow,
 *   early king shelter through ply 60, no hanging snipes, save hanging Q/R.
 *   late conversion (off unless late_conv_enabled): after late_conv_ply, when
 *   ahead by late_conv_margin, prefer captures, checks, safe steps toward the
 *   enemy king, and trades; penalize quiet shuffles and repetitions.
 *   strategy-4 (each flag off unless the genome says true):
 *     lookahead — one-ply material + king-exposure value of each legal move
 *     trade-down — when ahead, keep equal-or-better captures and drop quiets
 *     king-guard — drop non-escape king moves before king_guard_plies
 *     illegal-filter — drop moves that put our king in check; reject a pick
 *       that is not in the supplied legal list
 *   strategy-5 (each flag off unless the genome says true; not a re-enable
 *   of the strategy-4 flags):
 *     quiescence — one-ply fitted score, then the worst enemy capture reply
 *     hang-shield — drop a move that leaves a queen or rook en prise
 *     reply-safety — drop a move the enemy can answer by taking our king,
 *       including while already in check
 *     progress — when ahead, drop quiet shuffles if a winning capture, a
 *       safe check, or a non-king step toward the enemy king is legal
 *   strategy-6 (each flag off unless the genome says true; strategy-5 stays
 *   available and is not turned on by these flags):
 *     shot-filter — drop a bishop shot that does not win material and does
 *       not leave the enemy king worse after its best legal step, when a
 *       capture, mating-net move, king-hunt step, or real escape remains
 *     mate-net — when ahead, score the fitted material and king-exposure
 *       value after the enemy king's best escape, and drop a check that
 *       does not improve that value when a mating-net move remains
 *     king-hunt — after ply 40, in a simplified position, while ahead, a
 *       king step toward the enemy king is not rejected as king-idle or
 *       king-home
 *     escape-first — while in check, drop an escape whose fitted value is
 *       worse than another escape
 *   strategy-7 (each flag off unless the genome says true; strategy-5 and
 *   strategy-6 stay available and are not turned on by these flags):
 *     finish — when ahead, after finish_ply, drop a non-capturing check that
 *       does not mate and does not raise the sticky fitted value. A check
 *       the king steps off is waste even if the in-check flight count drops.
 *       A quiet move that covers a flight still counts. The waste check is
 *       dropped only when a capture, a quiet flight cut, a safe approach,
 *       or a king-help step remains.
 *     king-help — after king_help_ply, while ahead, and only when the enemy
 *       has little non-king material left, a safe king step toward their
 *       king is not rejected as king-idle or king-home. It does not fire
 *       before ply 30, so it cannot add an early king walk.
 *     illegal-filter, already gated, also stops a second unlisted or
 *       unparsed attempt by playing the legal fallback. Trade-down stays off.
 *   strategy-8 (each flag off unless the genome says true; strategy-5,
 *   strategy-6, and strategy-7 stay available and are not turned on by these):
 *     span-filter — drop a king move farther than one square. That square is
 *       the castling teleport gameUtils lists and handleMove rejected in
 *       every round-8 attempt (g1-l1, 0 applied). The scorer does not move
 *       the rook, so the fitted value is not a real escape.
 *     convert — when ahead, after convert_ply, a safe arrow or axe, or a
 *       capture worth more than the mover, is kept. A quiet step or an
 *       approach is dropped when one of those remains. Equal queen and rook
 *       trades are not tagged, so this is not strategy-4 trade-down.
 *   strategy-9 (each flag off unless the genome says true; strategy-5
 *   through strategy-8 stay available and are not turned on by these):
 *     shelter — before shelter_plies (30, the early-king counter), while in
 *       check, drop a king step when a non-king escape remains. The king
 *       step stays when it is the only escape. King-guard, span-filter, and
 *       escape-first stay as they are.
 *     qr-spare — drop a capture of a queen or rook when an arrow that does
 *       not take a queen or rook remains, unless that capture is itself an
 *       escape. This is not trade-down: quiet moves are not dropped, and the
 *       capture stays when it is the only arrow.
 *     rubble — drop a wall or a bomb when any other legal move remains.
 *       The open-board score penalty did not stop the model from playing them.
 *   strategy-10 (each flag off unless the genome says true; strategy-5
 *   through strategy-9 stay available and are not turned on by these):
 *     volley — when ahead, after volley_ply, a safe arrow that does not
 *       capture a queen or rook is kept. A non-capture step (an approach or
 *       a king-help walk) is dropped when one of those arrows remains.
 *       The fallback plays that arrow before a non-arrow convert capture.
 *       Shot-waste, a queen or rook capture, and an escape stay as they are.
 *       This is not lookahead and not a weight change.
 *   strategy-11 (off unless the genome says true; strategy-5 through
 *   strategy-10 stay available and are not turned on by this flag):
 *     cover — drop a move whose best enemy capture reply takes our queen
 *       or rook, including a defended piece taken by an equal or heavier
 *       attacker. Hang-shield only flags an undefended piece or a cheaper
 *       attacker, and that is the hole round 12's hung-QR count fell
 *       through. A volley arrow with that reply is not tagged volley, so
 *       a safe capture of a pawn, knight, or bishop is the fallback instead.
 *       A sole move stays, including the only real check escape. Not
 *       lookahead, not trade-down, and not a weight change.
 *   strategy-12 (each flag off unless the genome says true; strategy-5
 *   through strategy-11 stay available and are not turned on by these):
 *     seal — drop a check when every sure king-safe reply leaves a queen
 *       or rook to our next capture. Cover cannot delete that sole escape,
 *       and the capture on the next ply is what round 13 counted as hung
 *       QR. A mate, a check the king can step off without losing a queen
 *       or rook, and a sole move stay.
 *     press — after press_ply, even when behind, drop a non-capturing
 *       check that does not step closer and does not take away the king's
 *       last flight, when a closer step, a safe capture, or a safe arrow
 *       remains. Finish, volley, and convert only do this while ahead, and
 *       round 13's cap-220 draw was the side that was behind.
 *       Not lookahead, not trade-down, and not a weight change.
 *   strategy-13 (off unless the genome says true; strategy-5 through
 *   strategy-12 stay available and are not turned on by this flag):
 *     reap — after reap_ply, with or without a lead, keep a safe arrow that
 *       does not take a queen or rook (a pawn shot or a king-aim the king
 *       cannot walk off), a safe capture of a pawn, knight, or bishop, and
 *       a capture of the enemy king or a check that takes its last flight.
 *       Drop the other non-escapes. Press still keeps a closer non-capturing
 *       check beside that arrow; reap is what removes the check. A queen or
 *       rook capture is not kept, a king step is not tagged, and a shot the
 *       king walks off stays shot-waste. Not lookahead, not trade-down, and
 *       not a weight change.
 *   strategy-14 (off unless the genome says true; strategy-5 through
 *   strategy-13 stay available and are not turned on by this flag):
 *     glean — from glean_ply (0, so the opening counts), with or without a
 *       lead, a safe arrow that does not take a queen or rook is the move.
 *       Drop the other non-escapes, including the minor capture and the
 *       closer step reap kept beside that arrow. A king capture and a check
 *       that takes the last flight stay. A queen or rook capture is not the
 *       arrow, and a king step is not tagged. The score does not change.
 *       Not lookahead, not trade-down, and not a weight change.
 *   strategy-15 (off unless the genome says true; strategy-5 through
 *   strategy-14 stay available and are not turned on by this flag):
 *     sheaf — from sheaf_ply (0), with or without a lead. A safe bishop
 *       arrow on a pawn is kept ahead of a bishop duel. A king-target arrow,
 *       a king capture, and a check that takes the last flight stay. When
 *       no safe pawn arrow is legal, a safe bishop step that opens one is
 *       kept and a quiet non-capture is dropped. Captures stay. A king step
 *       is not tagged. The score does not change. Not lookahead, not
 *       trade-down, and not a weight change.
 *   strategy-16 (off unless the genome says true; strategy-5 through
 *   strategy-15 stay available and are not turned on by this flag):
 *     keel — from keel_ply (30, the ply after the early-king window), with
 *       or without a lead. A quiet king step is dropped when any safe
 *       non-king move remains. An escape, a king-hunt step, a king-help
 *       step, and a capture stay. When no safe non-queen non-rook arrow is
 *       legal, a quiet queen or rook step is dropped if a safe bishop step
 *       opens an arrow onto a pawn, knight, bishop, or king. That step is
 *       not a pawn-over-duel choice: an arrow that is already legal is left
 *       to glean. A queen or rook capture stays. The score does not change.
 *       Not lookahead, not trade-down, and not a weight change.
 *   strategy-17 (off unless the genome says true; strategy-5 through
 *   strategy-16 stay available and are not turned on by this flag):
 *     sift — from sift_ply (0, so the opening counts), with or without a
 *       lead. Nothing is dropped. When no safe non-queen non-rook arrow is
 *       already legal, one safe move that raises the fitted material and
 *       king-exposure value is ranked ahead of a quiet shuffle. A bishop
 *       step that opens a ray onto a pawn, knight, bishop, or king takes
 *       that slot when the fitted value rises. A king step is not tagged.
 *       A queen or rook step is not tagged. A queen or rook capture is not
 *       the move. The pool stays intact, so a quiet king or queen the model
 *       still names is not an illegal. The score does not change.
 *       Not lookahead, not trade-down, and not a weight change.
 *   strategy-18 (off unless the genome says true; strategy-5 through
 *   strategy-17 stay available and are not turned on by this flag):
 *     prod — from prod_ply (30, the ply after the early-king window), with
 *       or without a lead. Nothing is dropped. When no safe non-queen
 *       non-rook arrow is already legal, and a quiet queen or rook step or
 *       a queen or rook capture is still in the pool, one safe pawn, knight,
 *       or bishop move is ranked ahead of that shuffle and ahead of that
 *       capture. A check comes first, then a capture of a pawn, knight, or
 *       bishop, then a knight step that ends within two squares of the enemy
 *       king and strictly closer. A bishop ray is not the move. A king step
 *       is not tagged. A queen or rook step is not tagged. A queen or rook
 *       capture is not the move. The pool stays intact. The score does not
 *       change. Not lookahead, not trade-down, and not a weight change.
 *   strategy-19 (off unless the genome says true; strategy-5 through
 *   strategy-18 stay available and are not turned on by this flag):
 *     nock — from nock_ply (0, so the opening counts), with or without a
 *       lead. Nothing is dropped. Only a pure quiet pool is touched: no
 *       capture, no arrow, no axe, and no check. One safe bishop step that
 *       adds a pawn to that bishop's arrow rays, and does not add a queen,
 *       is ranked ahead of the quiet shuffle. A king step is not tagged.
 *       A knight step is not tagged. A queen or rook step is not tagged.
 *       The score does not change. Not lookahead, not trade-down, and not
 *       a weight change.
 *   strategy-20 (off unless the genome says true; strategy-5 through
 *   strategy-19 stay available and are not turned on by this flag):
 *     fletch — from fletch_ply (0, so the opening counts), with or without
 *       a lead. Nothing is dropped. Only a pure quiet pool is touched: no
 *       capture, no arrow, no axe, and no check. If any legal move is
 *       already a nock aim, fletch does nothing, so it cannot steal the
 *       bishop step nock ranks. Otherwise one quiet pawn step that raises
 *       the side's pawn-arrow count, and does not raise its queen-arrow
 *       count, is ranked ahead of a quiet shuffle. A king, a knight, a
 *       bishop, a queen, and a rook are not tagged. A capture is not
 *       tagged. A step that newly hangs a queen or rook is not tagged.
 *       The score does not change. Not lookahead, not trade-down, and not
 *       a weight change.
 *   strategy-21 (off unless the genome says true; strategy-5 through
 *   strategy-20 stay available and are not turned on by this flag):
 *     pile — from pile_ply (0, so the opening counts), with or without a
 *       lead. Nothing is dropped. Only a pure quiet pool is touched: no
 *       capture, no arrow, no axe, and no check. If any legal move is
 *       already a nock aim, pile does nothing, so it cannot steal the pawn
 *       ray nock ranks. Otherwise one safe bishop step that puts the enemy
 *       king behind exactly one friendly pawn, knight, or bishop is ranked
 *       ahead of a quiet shuffle. The king is not an arrow target yet, so
 *       this is not a check and the score does not pay bishop-aims-king.
 *       A clear king ray is already that check and stays a must-do. A clear
 *       enemy-bishop ray is refused: the bishop just stepped can be arrowed
 *       back. A queen beyond the screen is refused. A step that raises our
 *       king exposure is not tagged. A pawn step is not tagged. A king, a
 *       knight, a queen, and a rook are not tagged. The score does not
 *       change. Not lookahead, not trade-down, and not a weight change.
 *   strategy-22 (off unless the genome says true; strategy-5 through
 *   strategy-21 stay available and are not turned on by this flag):
 *     haft — from haft_ply (0, so the opening counts), with or without a
 *       lead. Nothing is dropped. Only a pure quiet pool is touched: no
 *       capture, no arrow, no axe, and no check. If any legal move is
 *       already a nock aim, haft does nothing, so it cannot steal the pawn
 *       ray nock ranks. Otherwise one safe bishop step that opens a longer
 *       firing lane, or that leaves the back rank toward the center without
 *       losing a lane, is ranked ahead of a quiet shuffle. A queen on the
 *       new ray is not tagged. A step the enemy can already arrow is not
 *       tagged. A step that raises our king exposure is not tagged. A step
 *       that newly hangs a queen or rook is not tagged. A pawn, a knight,
 *       a king, a queen, and a rook are not tagged. The score does not
 *       change. Not lookahead, not trade-down, and not a weight change.
 *   strategy-23 (off unless the genome says true; strategy-5 through
 *   strategy-22 stay available and are not turned on by this flag):
 *     quarrel — from quarrel_ply (0, so the opening counts), with or
 *       without a lead. Nothing is dropped. Only a pure quiet pool is
 *       touched: no capture, no arrow, no axe, no check, and no escape.
 *       If any legal move is already a nock aim, quarrel does nothing.
 *       If the highest-scoring move is already a hint, or is a king
 *       step, quarrel does nothing. Otherwise that move is tagged so
 *       the model list shows it first. A step that newly hangs a queen
 *       or rook is not tagged. A step that raises our king exposure is
 *       not tagged. The score does not change. Not lookahead, not
 *       trade-down, and not a weight change. Not a king step.
 *   strategy-24 (off unless the genome says true; strategy-5 through
 *   strategy-23 stay available and are not turned on by this flag):
 *     bodkin — from bodkin_ply (0, so the opening counts), with or
 *       without a lead. Nothing is dropped. Only a pure quiet pool is
 *       touched: no capture, no arrow, no axe, no check, and no escape.
 *       If any legal move is already a nock aim, bodkin does nothing,
 *       so it cannot steal the pawn ray. Otherwise one knight or bishop
 *       step that reduces Chebyshev distance to the enemy king is tagged
 *       and ranked ahead of a quiet queen or rook. A king, a queen, a
 *       rook, and a pawn are not tagged. A step that newly hangs a queen
 *       or rook, raises our king exposure, or lands where an enemy
 *       bishop can arrow or an enemy knight can axe is not tagged. The
 *       score does not change. Not a lower press_ply, not a quarrel
 *       retune, not lookahead, not trade-down, and not a weight change.
 *   strategy-25 (off unless the genome says true; strategy-5 through
 *   strategy-24 stay available and are not turned on by this flag):
 *     crest — from crest_ply (0, so the opening counts), with or
 *       without a lead. Nothing is dropped. Only a pure quiet pool is
 *       touched: no capture, no arrow, no axe, no check, and no escape.
 *       If any legal move is already a nock aim, crest does nothing,
 *       so it cannot steal the pawn ray. Otherwise one bishop step that
 *       reduces Chebyshev distance to the nearest enemy pawn is tagged
 *       and ranked ahead of a quiet shuffle that is not already a
 *       knight fork. A step that opens a pawn ray is nock's, not this.
 *       A step that opens a queen ray is not tagged. A king, a queen,
 *       a rook, a knight, and a pawn are not tagged. A step that newly
 *       hangs a queen or rook, raises our king exposure, or lands where
 *       an enemy bishop can arrow or an enemy knight can axe is not
 *       tagged. The score does not change. Not a bodkin retune, not a
 *       haft retune, not a lower press_ply, not lookahead, not
 *       trade-down, and not a weight change.
 *   strategy-26 (off unless the genome says true; strategy-5 through
 *   strategy-25 stay available and are not turned on by this flag):
 *     brace — from brace_ply (0, so the opening counts), with or
 *       without a lead. Nothing is dropped. Only a pure quiet pool is
 *       touched: no capture, no arrow, no axe, no check, and no escape.
 *       If any legal move is already a nock aim or a crest aim, brace
 *       does nothing, so it cannot steal the pawn ray or the bishop
 *       step that won round 28. Otherwise one quiet pawn step that
 *       strictly increases the number of legal bishop steps is tagged
 *       and ranked ahead of a quiet shuffle that is not already a
 *       knight fork. A step that opens a pawn ray is fletch's, not this.
 *       A step that opens a queen ray is not tagged. A king, a knight,
 *       a bishop, a queen, and a rook are not tagged. A step that newly
 *       hangs a queen or rook, raises our king exposure, or lands where
 *       an enemy bishop can arrow or an enemy knight can axe is not
 *       tagged. Before ply 30, a step that pulls a pawn off the king's
 *       adjacent shield is not tagged when another unblock keeps that
 *       shield. The layer does not turn off at ply 30. The score does
 *       not change. Not a crest retune, not a nock retune, not a fletch
 *       retune, not a lower press_ply, not lookahead, not trade-down,
 *       and not a weight change.
 *   strategy-27 (off unless the genome says true; strategy-5 through
 *   strategy-26 stay available and are not turned on by this flag):
 *     mark — from mark_ply (0, so the opening counts), with or
 *       without a lead. Nothing is dropped. Only a pure quiet pool is
 *       touched: no capture, no arrow, no axe, no check, and no escape.
 *       If any legal move is already a nock aim, a crest aim, or a
 *       brace aim, mark does nothing, so it cannot steal the pawn ray,
 *       the bishop step that won round 28, or the pawn unblock that
 *       hung queens in round 30. Otherwise one knight step that reduces
 *       Chebyshev distance to the nearest enemy pawn is tagged and
 *       ranked ahead of a quiet shuffle that is not a knight fork.
 *       Closer to the enemy king is not the test. A step that raises
 *       the number of attacks on our queens or rooks, or on theirs, is
 *       not tagged. A step that opens a pawn ray or a queen ray is not
 *       tagged. A king, a bishop, a pawn, a queen, and a rook are not
 *       tagged. A step that raises our king exposure, pulls a friendly
 *       piece off the king's adjacent shield, or lands where an enemy
 *       bishop can arrow or an enemy knight can axe is not tagged. The
 *       score does not change. Not a brace retune, not a crest retune,
 *       not a bodkin retune, not a lower press_ply, not lookahead, not
 *       trade-down, and not a weight change.
 *   strategy-28 (off unless the genome says true; strategy-5 through
 *   strategy-27 stay available and are not turned on by this flag):
 *     flight — from flight_ply (0, so the opening counts), with or
 *       without a lead. Nothing is dropped. Only a pure quiet pool is
 *       touched: no capture, no arrow, no axe, no check, and no escape.
 *       If any legal move is already a nock aim, flight does nothing,
 *       so the bishop that can already step onto a pawn shot keeps it.
 *       It does not defer to a crest aim or a brace aim. Otherwise one
 *       pawn or knight step is tagged. A pawn is tagged only when the
 *       step creates a new bishop step that would arrow an enemy pawn,
 *       and only when the pawn step itself does not already raise the
 *       pawn-arrow count (that is fletch). A knight is tagged when it
 *       steps off a bishop ray and the pawn-arrow count rises, or when
 *       it creates that same bishop shot. A step that raises attacks on
 *       a queen or a rook, on either side, opens a queen ray, raises our
 *       king exposure, or pulls a piece off the king's adjacent shield
 *       is not tagged. A king, a bishop, a queen, and a rook are not
 *       tagged. The score does not change. Not a fletch retune, not a
 *       brace retune, not a mark retune, not a crest retune, not a lower
 *       press_ply, not lookahead, not trade-down, and not a weight change.
 *   strategy-29 (off unless the genome says true; strategy-5 through
 *   strategy-28 stay available and are not turned on by this flag):
 *     clout — from clout_ply (40), with or without a lead. One safe
 *       queen or rook check that strictly reduces the enemy king's
 *       flight squares is ranked ahead of a quiet shuffle and ahead of
 *       a check that does not cut a flight. If no such check is in the
 *       legal list, one safe rook bomb of a wall on the enemy king's
 *       file, rank, or diagonal is tagged when that bomb cuts a flight
 *       or opens more of those checks. The pool is not shrunk by clout.
 *       Progress, finish, convert, rubble, and press keep the tagged
 *       move so a bomb is not deleted before it can rank. Finish's
 *       check-waste tag is not a refusal: that is how a non-mating
 *       flight cut is marked. Volley, glean,
 *       and reap still prefer an arrow or a reap capture. A capture, an
 *       arrow, an axe, an escape, a nock, a flight, or a fork is not
 *       outranked. A bomb does not outrank a check. The score does not
 *       change. Not a flight retune, not a press retune, not lookahead,
 *       not trade-down, and not a weight change.
 *   strategy-30 (off unless the genome says true; strategy-5 through
 *   strategy-29 stay available and are not turned on by this flag):
 *     barb — from barb_ply (0, so the opening counts), with or without a
 *       lead. Nothing is dropped. One safe capture by a pawn, a knight, or
 *       a bishop of an enemy pawn, knight, or bishop is tagged when that
 *       capture takes a piece within two squares of the enemy king, or when
 *       the capture opens a bishop pawn-shot. A queen, a rook, and a king
 *       are not tagged, as mover or as victim. An arrow that is already
 *       legal is left to glean, and a nock aim still in the pool is left to
 *       nock. The tag jumps a quiet move, a non-capturing check, and a
 *       capture of less material. It does not jump an arrow, an axe, an
 *       escape, a nock, a flight, a fork, or a capture of a king, a queen,
 *       or a rook, or a capture of strictly more material, or a free hanging
 *       piece of equal value. Finish is not a hold: finish marks every safe
 *       capture once ahead. The score does not change.
 *       Not a flight retune, not a clout retune, not a crest retune, not a
 *       lower press_ply, not lookahead, not trade-down, and not a weight
 *       change.
 *   strategy-31 (off unless the genome says true; strategy-5 through
 *   strategy-30 stay available and are not turned on by this flag):
 *     vane — from vane_ply (0, so the opening counts), with or without a
 *       lead. Flight already ranks the pawn or knight shot first, and nock
 *       already ranks the bishop aim first. Reordering does not change the
 *       move the model commits: on champion games that shot was already
 *       first and the model played a quiet knight. When the ranked pool
 *       contains a flight tag, a nock tag, or an arrow, vane drops quiet
 *       knight steps and quiet pawn steps that are not themselves that
 *       shot. A knight that uncovers the pawn arrow stays. A pawn that is
 *       itself a flight setup stays, including a lesser one. A quiet pawn
 *       that does not set up a shot does not. Bishops, rooks, queens, kings,
 *       captures, checks, escapes, and axes stay. If the drop would empty the pool, nothing
 *       is dropped. The kept shot is not tagged vane. The dropped move is
 *       rejected with reason vane, which is not an illegal move. The score
 *       does not change. Not a flight retune, not a nock retune, not a
 *       crest retune, not a barb retune, not a lower press_ply, not
 *       lookahead, not trade-down, and not a weight change.
 *   strategy-32 (off unless the genome says true; strategy-5 through
 *   strategy-31 stay available and are not turned on by this flag):
 *     quill — from quill_ply (0, so the opening counts), with or without a
 *       lead. Nothing is dropped. When a flight setup or a nock aim is
 *       already tagged, one quiet queen or rook step that steps off an
 *       attack is ranked ahead of that shot and ahead of a quiet knight.
 *       A capture, a check, an escape, a fork, an arrow, and an axe are
 *       not outranked. The step must lower the attacks on that piece and
 *       must not raise queen or rook attacks on either side, open a queen
 *       ray, raise our king exposure, or pull the king's shelter. If the
 *       model still picks a quiet knight that is not itself the shot,
 *       filterModelPick rejects it with reason quill and points at that
 *       tuck, or at the shot when no tuck exists. The knight stays in the
 *       legal list. The play loop forces the substitute on attempt 1, so
 *       there is no retry. Cover and power-hangs already drop a flight
 *       pawn that leaves a loose queen or rook, so on the champion stack
 *       the tuck is rare and the live effect is that shot substitute.
 *       vane_enabled is a different path and stays off.
 *       The score does not change. Not a vane retune, not a flight retune,
 *       not a nock retune, not a lower press_ply, not lookahead, not
 *       trade-down, and not a weight change.
 *   strategy-33 (off unless the genome says true; strategy-5 through
 *   strategy-32 stay available and are not turned on by this flag):
 *     string — from string_ply (0, so the opening counts), with or without
 *       a lead. One safe bishop arrow at a pawn or a king (a king first,
 *       otherwise the pawn closest to the enemy king) is ranked ahead of a
 *       quiet shuffle and ahead of a queen or rook capture. A non-QR
 *       capture, an escape, an axe, and a check that is not a bomb or a
 *       wall keep their order. Nothing is dropped. The legal pool stays
 *       the size flight left it. Quiet knights are not diverted: quill
 *       already did that and the games got longer. A quiet bishop that is
 *       not a nock or crest aim, and a queen or rook capture that is not
 *       an escape, are rejected with reason string when that arrow is
 *       ranked. The play loop forces the substitute on attempt 1. An
 *       unlisted diagonal or orthogonal slide (including a knight named
 *       onto an adjacent square) is replaced with that same arrow before
 *       NOT_LISTED is printed, so the illegal line is not counted. A bomb
 *       or wall that repeats the previous special after the opponent just
 *       undid it on that square loses its progress tags, so the check loop
 *       cannot be the only ranked move. quill_enabled and vane_enabled
 *       stay off. The score does not change. Not a quill retune, not a
 *       vane retune, not a flight retune, not a lower press_ply, not
 *       lookahead, not trade-down, and not a weight change.
 *   strategy-34 (off unless the genome says true; strategy-5 through
 *   strategy-33 stay available and are not turned on by this flag):
 *     bolt — from bolt_ply (0, so the opening counts), with or without a
 *       lead. One safe capture of a knight or a bishop, by a move or an
 *       axe, is ranked ahead of a pawn arrow and ahead of a quiet shuffle.
 *       A king step is not tagged. An arrow is not tagged: knights and
 *       rooks are immune, and a bishop arrow is string's job. Before ply
 *       30 a capture that gives check is not tagged, so the king reply
 *       cannot be counted as an early king walk. The capture is also
 *       refused when our king exposure rises, when queen or rook attacks
 *       rise on either side, when a queen ray opens on either side, when
 *       the king's shelter falls before ply 30, or when the fitted value
 *       does not rise. Nothing is dropped. A pawn arrow is rejected with
 *       reason bolt, including an early checking pawn arrow that is
 *       already a must-do. After ply 30 a must-do checking pawn arrow is
 *       left alone. Quiet knights, flight, nock, crest, king moves, and
 *       other captures are not diverted. A quiet bishop that is still
 *       ranked and is not a must-do is rejected with reason bolt, so
 *       bishop-shoots cannot retry into the pawn arrow. The play loop
 *       forces the capture on attempt 1. An unlisted slide snaps to that
 *       capture only when string has no arrow. Glean would otherwise delete
 *       that capture once a pawn arrow is legal; the bolt tag keeps it.
 *       Flag off, glean drops it as before. string_enabled stays off.
 *       The score does not change. Not a string retune, not a quill
 *       retune, not a vane retune, not a lower press_ply, not lookahead,
 *       not trade-down, and not a weight change.
 *   strategy-35 (off unless the genome says true; strategy-5 through
 *   strategy-34 stay available and are not turned on by this flag):
 *     spine — from spine_ply (0, so the opening counts), with or without
 *       a lead. When a queen or rook hangs cheaply and no safe pawn arrow
 *       is already ranked, one quiet queen or rook step that clears that
 *       hang is ranked ahead of a quiet shuffle, including a flight step.
 *       The step has to leave a pawn arrow that is still safe: the bishop
 *       does not hang, the queen or rook does not hang again, and the
 *       reply does not take a queen, a rook, or the king. Before ply 30
 *       that arrow must not check, so the king reply is not an early king
 *       walk. The step is refused when queen or rook attacks rise on
 *       either side, a queen ray opens, our king exposure rises, shelter
 *       falls, or the landing square is on an enemy arrow or axe. A nock
 *       aim, a capture, a check, an escape, a fork, an arrow, and an axe
 *       keep their order. Nothing is dropped. A quiet non-capture that is
 *       not that step is rejected with reason spine. The play loop forces
 *       the step on attempt 1. An unlisted slide snaps to it only when
 *       string and bolt have nothing to snap to. bolt_enabled stays off.
 *       The score does not change. Not a bolt retune, not a string retune,
 *       not a quill retune, not a flight retune, not a lower press_ply,
 *       not lookahead, not trade-down, and not a weight change.
 *   strategy-36 (off unless the genome says true; strategy-5 through
 *   strategy-35 stay available and are not turned on by this flag):
 *     broadhead — from broadhead_ply (0, so the opening counts), with or
 *       without a lead. When no safe pawn arrow exists yet, one capture
 *       of a pawn, knight, or bishop (a move or an axe, never a queen or
 *       a rook, never the king) that makes a safe pawn arrow appear is
 *       ranked ahead of a quiet shuffle. It does not jump a capture, a
 *       check, an escape, an arrow, an axe, or a nock, crest, or flight
 *       tag. Before ply 30 a capture that gives check is not tagged, so
 *       the king reply cannot be an early king walk. Nothing is dropped.
 *       A quiet non-capture that is not nock, crest, or flight is rejected
 *       with reason broadhead. The play loop forces the capture on attempt
 *       1. An unlisted slide snaps to it only when string, bolt, and spine
 *       have nothing to snap to. spine_enabled stays off. The score does
 *       not change. Not a spine retune, not a bolt retune, not a flight
 *       retune, not a lower press_ply, not lookahead, not trade-down, and
 *       not a weight change.
 *   strategy-37 (off unless the genome says true; strategy-5 through
 *   strategy-36 stay available and are not turned on by this flag):
 *     shaft — from shaft_ply (0, so the opening counts), with or without
 *       a lead. When no safe pawn arrow exists yet and flight, nock, and
 *       crest are silent, one quiet bishop, knight, or pawn step that
 *       makes a safe pawn arrow appear is ranked ahead of a quiet queen
 *       or rook step. It does not jump a capture, a check, an escape, an
 *       arrow, an axe, a fork, a nock, crest, or flight tag, or any other
 *       quiet. The step is refused when queen or rook attacks rise on
 *       either side, a queen ray opens, our king exposure rises, shelter
 *       falls, the landing square is on an enemy arrow or axe, or a queen
 *       or rook would hang. A check is not tagged. Nothing is dropped.
 *       A quiet queen or rook step that is still ranked is rejected with
 *       reason shaft. The play loop forces that step on attempt 1. There
 *       is no unlisted-slide snap. broadhead_enabled stays off. The score
 *       does not change. Not a broadhead retune, not a flight retune, not
 *       a lower press_ply, not lookahead, not trade-down, and not a weight
 *       change.
 *   strategy-38 (off unless the genome says true; strategy-5 through
 *   strategy-37 stay available and are not turned on by this flag):
 *     anchor — from anchor_ply (0, so the opening counts), with or without
 *       a lead. When a friendly bishop hangs cheaply, one legal save that
 *       strictly reduces that count is ranked ahead of a quiet non-saving
 *       move. An arrow that captures the attacker counts. A shot that
 *       leaves the bishop hanging does not. A king step is never the save.
 *       Before ply 30 a save that gives check is not tagged, so the king
 *       reply cannot be an early king walk. A queen or rook capture is not
 *       tagged. The save is refused when queen or rook attacks rise on
 *       either side, a queen ray opens, our king exposure rises, shelter
 *       falls, a moved piece lands on an enemy arrow or axe, or a queen or
 *       rook would hang. The save is tagged before progress, so a quiet
 *       step off the bishop is not deleted when the side is ahead. Finish,
 *       convert, volley, press, reap, and glean keep that one move and no
 *       other. It does not jump an arrow, an axe, a capture, a check, an
 *       escape, a fork, a finish, a mate-net, or a flight, nock, or crest
 *       tag. A quiet non-save that is still ranked is rejected with reason
 *       anchor. The play loop forces that save on attempt 1. There is no
 *       unlisted-slide snap. shaft_enabled stays off. The score does not
 *       change. Not a shaft retune, not a pawn-arrow setup, not a flight
 *       retune, not a lower press_ply, not lookahead, not trade-down, and
 *       not a weight change.
 *   strategy-39 (off unless the genome says true; strategy-5 through
 *   strategy-38 stay available and are not turned on by this flag):
 *     cast — from max(cast_ply, 40), and only while ahead by at least a
 *       pawn. When no friendly bishop can already arrow a pawn, and the
 *       pool is not a pure quiet stall, one quiet bishop step that adds a
 *       pawn ray and does not add a queen ray is ranked ahead of a quiet
 *       approach. Finish approaches are included: that is the walk the
 *       late game keeps. It does not jump a capture, an arrow, an axe, a
 *       check, an escape, a fork, a mate-net, a king step, or a flight,
 *       nock, crest, or anchor tag. Nock and flight still own the pure
 *       stall. The step is refused when queen or rook attacks rise on
 *       either side, our king exposure rises, shelter falls, the bishop
 *       lands on an enemy arrow or axe, the landing square hangs, or a
 *       queen or rook would hang. The step is tagged before progress, so
 *       finish, convert, volley, press, reap, and glean keep that one
 *       move and no other. A quiet approach that is still ranked is
 *       rejected with reason cast. The play loop forces that step on
 *       attempt 1. There is no unlisted-slide snap. anchor_enabled stays
 *       off. The score does not change. Not an anchor retune, not a nock
 *       retune, not a flight retune, not a shaft retune, not a lower
 *       press_ply, not lookahead, not trade-down, and not a weight change.
 *   strategy-40 (off unless the genome says true; strategy-5 through
 *   strategy-39 stay available and are not turned on by this flag):
 *     quarry — from max(quarry_ply, 40), and only while ahead by at least
 *       a pawn. One quiet queen or rook step that strictly reduces
 *       Chebyshev distance to the enemy king is ranked ahead of a quiet
 *       approach that is not already nock, crest, or flight. Largest
 *       distance reduction wins, then a queen over a rook, then the
 *       existing score. It does not jump an arrow, an axe, a capture, a
 *       check, an escape, a fork, a king-hunt, a king-help, or a flight,
 *       nock, or crest tag. It does jump a quiet bishop, knight, pawn, or
 *       king, and a quieter queen or rook step, including a finish
 *       approach. The step is refused when a queen or rook already hangs,
 *       queen or rook attacks rise on either side, shelter falls, the
 *       landing square hangs, or the landing square sits on an enemy
 *       arrow or axe. The step is tagged after the drops, so a safe pawn
 *       arrow that glean kept removes the queen and this layer stays
 *       quiet. Nothing is dropped and nothing is exempted.
 *       filterModelPick rejects a different quiet move only when this
 *       step is already rank 0. A lower quarry step is never forced over
 *       nock, crest, or flight. The play loop forces that step on attempt
 *       1. There is no unlisted-slide snap. cast_enabled stays off. The
 *       score does not change. Not a cast retune, not a pawn-arrow setup,
 *       not a nock, crest, or flight retune, not a lower press_ply, not
 *       lookahead, not trade-down, and not a weight change.
 *   strategy-41 (off unless the genome says true; strategy-5 through
 *   strategy-40 stay available and are not turned on by this flag):
 *     latch — from latch_ply (0, so a ray on the first move counts). When
 *       an enemy bishop already has a clear arrow ray on our king, one
 *       quiet pawn, knight, or bishop step that lands strictly between
 *       that bishop and our king, and that strictly lowers our king
 *       exposure, is ranked ahead of a quiet queen, rook, or king step.
 *       A queen, a rook, and a king are never the mover. A capture is not
 *       tagged. Largest exposure drop wins, then a knight over a bishop
 *       over a pawn, then the existing score. A knight is arrow-immune, so
 *       it does not hand the bishop a new shot. A clearly worse fitted
 *       escape is already marked loose-escape and is not tagged. It does
 *       not jump an arrow, an
 *       axe, a capture, a check, a fork, a flight, nock, or crest tag, or
 *       a quiet bishop, knight, or pawn. It does jump a quiet queen, rook,
 *       or king step, including the step that only escapes the ray. The
 *       block itself is an escape: a bishop ray is check, and the step
 *       clears it. The step is tagged before progress, so a finish rook
 *       walk does not delete it. A clearly worse fitted escape is still
 *       dropped as loose-escape, and this layer does not exempt that.
 *       Progress, finish, convert, press, and reap keep that one move.
 *       The block is an escape, so volley and glean keep it beside an
 *       arrow that also gets out of check. A non-escaping arrow is already
 *       gone, and this layer does not override the arrow that stays. The
 *       landing square may sit on the ray being closed. Another enemy
 *       arrow, an axe, or a move-attack still refuses it.
 *       filterModelPick rejects a quiet queen, rook, or king step only
 *       when this block is already rank 0. The play loop forces that step
 *       on attempt 1. There is no unlisted-slide snap.
 *       quarry_enabled stays off. The score does not change. Not a quarry
 *       retune, not a pawn-arrow setup, not a piece-save, not a nock,
 *       crest, or flight retune, not a lower press_ply, not lookahead,
 *       not trade-down, and not a weight change.
 *   strategy-42 (off unless the genome says true; strategy-5 through
 *   strategy-41 stay available and are not turned on by this flag):
 *     sighter — from sighter_ply (0, so the first move counts). No lead.
 *       One quiet rook or queen slide, orthogonal and at least two squares,
 *       that newly attacks an undefended enemy pawn. The landing square
 *       is not attacked. Queen rays do not rise, and attacks on either
 *       side's queens and rooks do not rise. A one-square step is not
 *       this, and a diagonal is not this. A capture, a check, and a fork
 *       are not tagged. Nothing is dropped. It runs only in a pure quiet
 *       stall, and only when nock, flight, and crest have no aim, so it
 *       does not retune those layers and does not take a tactic. It jumps
 *       a quiet queen, rook, or king step. It does not jump a bishop, a
 *       knight, a pawn, a capture, an arrow, an axe, a check, an escape,
 *       a fork, or a flight, nock, or crest tag. filterModelPick rejects
 *       a quiet queen, rook, or king step only when this slide is already
 *       rank 0. The play loop forces that listed slide on attempt 1.
 *       There is no unlisted-slide snap. latch_enabled and fletch_enabled
 *       stay off. The score does not change. Not a latch retune, not a
 *       fletch or cast retune, not a quarry retune, not a flight retune,
 *       not a lower press_ply, not lookahead, not trade-down, and not a
 *       weight change.
 *   strategy-43 (off unless the genome says true; strategy-5 through
 *   strategy-42 stay available and are not turned on by this flag):
 *     pluck — from pluck_ply (0, so the first move counts). No lead.
 *       One quiet pawn, knight, or bishop step that newly attacks an
 *       enemy piece this mover did not already attack. A queen, a rook,
 *       and a king are not the mover. A capture is not tagged. A check
 *       is not tagged. Bishop arrows are not the attack: that is the
 *       pawn-arrow chase. Knight axes count, because an axe is a capture
 *       on the next ply. Nothing is dropped. It runs only in a pure quiet
 *       stall, and only when nock, flight, and crest have no aim, so it
 *       does not retune those layers and does not take a tactic. It jumps
 *       a quiet queen, rook, or king step. It does not jump a bishop, a
 *       knight, a pawn, a capture, an arrow, an axe, a check, an escape,
 *       a fork, or a flight, nock, or crest tag. The largest new attack
 *       count wins, then a knight over a bishop over a pawn, then the
 *       existing score. filterModelPick rejects a quiet queen, rook, or
 *       king step only when this step is already rank 0. The play loop
 *       forces that listed step on attempt 1. There is no unlisted-slide
 *       snap. sighter_enabled stays off. The score does not change. Not a
 *       sighter retune, not a flight retune, not a capture ranked over an
 *       arrow, not a lower press_ply, not lookahead, not trade-down, and
 *       not a weight change.
 *   strategy-44 (off unless the genome says true; strategy-5 through
 *   strategy-43 stay available and are not turned on by this flag):
 *     fetch — from fetch_ply (0, so the first move counts) until ply 30.
 *       No lead. One safe arrow that does not check, or else one safe
 *       capture of a pawn, knight, or bishop by a pawn, knight, or bishop,
 *       is ranked ahead of a loose early check. A loose check gives check,
 *       is not a king capture, and is not mate. Mate means no sure reply.
 *       A check the king cannot step out of is still loose when a pawn or
 *       a bishop can answer it: that is the g-file arrow ahead of the
 *       king walks in rounds 47 and 48. The other arrow is preferred so
 *       the 0.4 arrow term stays and the king is not walked. A queen or
 *       rook is not the mover and is not the victim. A true mate is left
 *       alone. Flight, nock, and crest are left alone. Nothing is dropped.
 *       The loose check is sorted last while the tag exists, so a glean
 *       fallback does not substitute it back in. It does not run on ply 30
 *       or later. It does not tag a quiet step. filterModelPick rejects
 *       that loose check, and a quiet non-capture when the tag is already
 *       rank 0. The play loop forces the listed alternative on attempt 1.
 *       There is no unlisted-slide snap. pluck_enabled stays off. The
 *       score does not change. Not a pluck retune, not a sighter retune,
 *       not a pawn-arrow chase, not a lower press_ply, not lookahead, not
 *       trade-down, and not a weight change.
 *   strategy-45 (off unless the genome says true; strategy-5 through
 *   strategy-44 stay available and are not turned on by this flag):
 *     grip — from grip_ply (0, so the first move counts) until ply 30.
 *       No lead. When a checking pawn arrow or an arrow that captures a
 *       queen or rook is legal, and it is not mate and not a king capture,
 *       rank one safe capture of a pawn, knight, or bishop by a pawn,
 *       knight, or bishop. The capture is a move or an axe, never an arrow.
 *       If that capture does not exist, tag nothing and leave the arrow:
 *       a second arrow is what lengthened the fetch games. The bad arrow
 *       stays legal and sorts last. Flight, nock, and crest are left alone
 *       when they have already tagged. Nothing is dropped. It does not run
 *       on ply 30 or later. It is not placed first in the generic fallback,
 *       so a hangs-piece or finish reject does not become this capture.
 *       filterModelPick rejects only the bad arrow. The play loop forces
 *       the listed capture on attempt 1. There is no unlisted-slide snap.
 *       fetch_enabled stays off. The score does not change. Not a fetch
 *       retune, not a bolt retune, not a lower press_ply, not lookahead,
 *       not trade-down, and not a weight change.
 *   strategy-46 (off unless the genome says true; strategy-5 through
 *   strategy-45 stay available and are not turned on by this flag):
 *     reply2 — from reply2_ply (0, so the first move counts). After the
 *       other filters, apply each ranked legal move and score the
 *       opponent's legal replies with the pawn-100 model (material about
 *       +30 win-points per SD, king exposure about -18, mobility / king
 *       cover / tempo at 0). Value is the min over replies. Drop a move
 *       whose reply wins our queen or rook at a net material loss when
 *       another legal move avoids it. King captures and checks that win
 *       stay. The search is capped and deterministic. It does not invent
 *       a move. Not lookahead_enabled (that never searches a reply) and
 *       not the abandoned blunt hook, which stays off.
 *   Ranks and filters the legal list only. Never invents a move.
 *
 * Score weights and reject/must-do gates come from PolicyGenome
 * (default v4-seed / evolve/genomes/active.json). FILTER only.
 */
import type { ActionKind, Board, GameState, Move, Piece, PieceType, PlayerColor, Position } from './types.ts';
import {
  countBishopFiringLanes,
  getArrowTargets,
  getAxeTargets,
  getBombTargets,
  getValidMoves,
  getWallBuildTargets,
  isInCheck,
} from './gameUtils.ts';
import { squareName } from './notation.ts';
import {
  DEFAULT_EARLY_KING_PLIES,
  DEFAULT_LATE_CONV_MARGIN,
  DEFAULT_LATE_CONV_PLY,
  EARLY_KING_PLIES_CLAMP,
  LATE_CONV_MARGIN_CLAMP,
  LATE_CONV_PLY_CLAMP,
  getPolicyGenome,
  type PolicyGates,
  type PolicyGenome,
} from './policyGenome.ts';

/** Quiet-king shelter window (30 full moves) when genome field is missing. */
const EARLY_KING_PLIES = DEFAULT_EARLY_KING_PLIES;

export type { PolicyGates, PolicyGenome, PolicyWeights } from './policyGenome.ts';
export {
  DEFAULT_V4_GENOME,
  defaultV4Genome,
  getActiveGenome,
  getActiveGenomePath,
  getPolicyGenome,
  loadGenome,
  loadGenomeCached,
  setPolicyGenome,
} from './policyGenome.ts';

const PIECE_VALUE: Record<PieceType, number> = {
  pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100,
};

/**
 * Pawn-100 decisive fit (reports/strategy-model-v1.md), unstandardized.
 * material coef +1.40564 / SD 10.96287, king_exposure coef -0.73491 / SD 0.63592.
 * King is 0, matching model/features.ts. Bishop arrow-target count is part of material.
 */
const FIT_MAT_COEF = 1.405640347136539;
const FIT_MAT_SD = 10.962874412516792;
const FIT_EXP_COEF = -0.7349105509703833;
const FIT_EXP_SD = 0.6359210677400179;
export const FIT_MATERIAL_PER = FIT_MAT_COEF / FIT_MAT_SD;
export const FIT_EXPOSURE_PER = FIT_EXP_COEF / FIT_EXP_SD;
/** Position value when the enemy king is already gone (the game is over). */
const FIT_KING_GONE = 50;

const MODEL_VALUE: Record<PieceType, number> = {
  pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0,
};

const VALUABLE: ReadonlySet<PieceType> = new Set<PieceType>(['king', 'queen', 'rook']);
const HANGING_REQUIRED: ReadonlySet<PieceType> = new Set<PieceType>(['knight', 'bishop', 'rook', 'queen', 'king']);

export interface PolicyAction {
  from: string;
  to: string;
  kind: ActionKind;
  type?: string;
  promo?: string;
}

export interface RankedAction extends PolicyAction {
  score: number;
  tags: string[];
  rejectReason?: string;
}

export interface PolicyResult {
  inCheck: boolean;
  /** After hard filters, best first. */
  ranked: RankedAction[];
  /** Obvious one-ply tactics — put these first in the model prompt. */
  hints: RankedAction[];
  /** Hard-rejected (non-escape while an escape exists, or thrash with an alternative). */
  rejected: RankedAction[];
  /** Use only when no legal non-thrash escape remains, or as play-loop stuck fallback. */
  fallback: RankedAction | null;
}

export interface FilterPickResult {
  accept: boolean;
  reason?: string;
  retryHints: RankedAction[];
  fallback?: PolicyAction;
}

interface Scored {
  action: PolicyAction;
  from: Position;
  to: Position;
  piece: Piece | null;
  target: Piece | null;
  escapesCheck: boolean;
  /** Pawn capture: dice can miss, so this is not a sure check escape. */
  diceCapture: boolean;
  boardEscapes: boolean;
  isCapture: boolean;
  isThrash: boolean;
  isOscillation: boolean;
  isWalkOffFork: boolean;
  isBlindHang: boolean;
  score: number;
  tags: string[];
  /** Fitted value after this move. Set only while escape_first_enabled and in check. */
  escapeValue?: number;
}

function mustDoTagSet(gates: PolicyGates): Set<string> {
  const tags = new Set([
    'take-checker', 'axe-checker', 'hanging', 'axe-valuable', 'fork', 'arrow-hanging', 'arrow-checks-king',
  ]);
  if (gates.axe_king_is_must_do) tags.add('axe-king');
  if (gates.arrow_king_is_must_do) tags.add('arrow-king');
  if (gates.bishop_aims_is_must_do) tags.add('bishop-aims-king');
  if (gates.develop_bishop_is_must_do) tags.add('develop-bishop');
  if (gates.arrow_enemy_bishop_is_must_do) {
    tags.add('arrow-enemy-bishop');
    tags.add('bishop-duel');
  }
  return tags;
}

const UNSAFE_SELF_TAGS = new Set([
  'hangs-self',
  'bishop-snipe-hangs',
  'arrow-exposes-counter',
  'walks-into-snipe',
  'power-into-arrow-lane',
  'power-hangs-idle',
  'leaves-power-hanging',
]);

const MUST_DO_TAKE_TAGS = new Set([
  'take-checker', 'hanging', 'axe-valuable', 'arrow-hanging', 'axe-king', 'arrow-king',
]);

function hasUnsafeSelfTags(tags: string[]): boolean {
  return tags.some((t) => UNSAFE_SELF_TAGS.has(t));
}

function earlyKingPliesOf(g: PolicyGenome): number {
  const n = g.early_king_plies;
  if (typeof n === 'number' && Number.isFinite(n)) {
    return Math.min(EARLY_KING_PLIES_CLAMP[1], Math.max(EARLY_KING_PLIES_CLAMP[0], Math.round(n)));
  }
  return EARLY_KING_PLIES;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Non-king material. A lead of 3 is a knight, or three pawns. */
function sideMaterial(board: Board, color: PlayerColor): number {
  let total = 0;
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const piece = board[row]?.[col]?.piece;
      if (!piece || piece.color !== color || piece.type === 'king') continue;
      total += PIECE_VALUE[piece.type];
    }
  }
  return total;
}

/**
 * Gate for the late-conversion rank/filter.
 * history.length is plies already played, so 120 means the move after ply 120
 * (play-loop logs that decision as ply 121).
 * Returns false immediately when the flag is off — scores stay on the v4 path.
 */
function lateConvFiring(g: PolicyGenome, board: Board, color: PlayerColor, history: Move[]): boolean {
  if (g.late_conv_enabled !== true) return false;
  const ply = clampInt(g.late_conv_ply, LATE_CONV_PLY_CLAMP[0], LATE_CONV_PLY_CLAMP[1], DEFAULT_LATE_CONV_PLY);
  if (history.length < ply) return false;
  const margin = clampInt(
    g.late_conv_margin,
    LATE_CONV_MARGIN_CLAMP[0],
    LATE_CONV_MARGIN_CLAMP[1],
    DEFAULT_LATE_CONV_MARGIN,
  );
  const lead = sideMaterial(board, color) - sideMaterial(board, enemyOf(color));
  return lead >= margin;
}

/** Late window only. Flag-off genomes never reach the drop. Does not require a lead. */
function pressFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.press_enabled !== true) return false;
  const ply = clampInt(g.press_ply, 40, 180, 100);
  return history.length >= ply;
}

/**
 * Same window as volley, but no lead. Flag-off genomes never reach the drop.
 * Fires while behind, which is the hole volley, finish, and convert leave.
 */
function reapFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.reap_enabled !== true) return false;
  const ply = clampInt(g.reap_ply, 40, 180, 40);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never reach the drop. Ply 0 is the first move:
 * the missing pawn arrows were before ply 40 as well as after it.
 */
function gleanFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.glean_enabled !== true) return false;
  const ply = clampInt(g.glean_ply, 0, 180, 0);
  return history.length >= ply;
}

/** No lead. Flag-off genomes never reach the drop. Ply 0 counts the opening. */
function sheafFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.sheaf_enabled !== true) return false;
  const ply = clampInt(g.sheaf_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never reach the drop. Ply 30 is the first ply
 * the early-king counter no longer counts, which is where round 18 walked.
 */
function keelFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.keel_enabled !== true) return false;
  const ply = clampInt(g.keel_ply, 0, 180, 30);
  return history.length >= ply;
}

/** No lead. Flag-off genomes never tag. Ply 0 is the first move. */
function siftFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.sift_enabled !== true) return false;
  const ply = clampInt(g.sift_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 30 is the first ply the
 * early-king counter no longer counts.
 */
function prodFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.prod_enabled !== true) return false;
  const ply = clampInt(g.prod_ply, 0, 180, 30);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The
 * incumbent's missing bishop steps, and the pawn arrows those steps open,
 * started in the opening.
 */
function nockFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.nock_enabled !== true) return false;
  const ply = clampInt(g.nock_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The pawn
 * that sits on a bishop's ray is already there in the opening.
 */
function fletchFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.fletch_enabled !== true) return false;
  const ply = clampInt(g.fletch_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The enemy
 * king is already a target the score does not always put first.
 */
function pileFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.pile_enabled !== true) return false;
  const ply = clampInt(g.pile_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The bishops
 * that never left home in the round-24 losses were already idle then.
 */
function haftFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.haft_enabled !== true) return false;
  const ply = clampInt(g.haft_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. A quiet
 * stall whose best move is not already a hint is already there.
 */
function quarrelFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.quarrel_enabled !== true) return false;
  const ply = clampInt(g.quarrel_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The minor
 * piece that can step toward the enemy king is already on the board.
 */
function bodkinFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.bodkin_enabled !== true) return false;
  const ply = clampInt(g.bodkin_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The bishop
 * that never left home when no pawn sat on a new ray is already there.
 */
function crestFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.crest_enabled !== true) return false;
  const ply = clampInt(g.crest_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The pawn
 * sitting on the bishop's diagonal is already there. Ply 30 does not turn
 * this off; that window only prefers the king's pawn shield.
 */
function braceFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.brace_enabled !== true) return false;
  const ply = clampInt(g.brace_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The knight
 * that can step toward an enemy pawn is already on the board. Ply 30 does
 * not turn this off.
 */
function markFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.mark_enabled !== true) return false;
  const ply = clampInt(g.mark_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The pawn
 * in front of the bishop, or the knight standing on the ray, is already
 * there. Ply 30 does not turn this off.
 */
function flightFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.flight_enabled !== true) return false;
  const ply = clampInt(g.flight_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. The pawn
 * on the bishop ray is already there while a capture or a check is legal.
 * Ply 30 does not turn this off.
 */
function sighterFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.sighter_enabled !== true) return false;
  const ply = clampInt(g.sighter_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. A knight
 * that can step onto a new attack is already on the board. Ply 30 does
 * not turn this off.
 */
function pluckFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.pluck_enabled !== true) return false;
  const ply = clampInt(g.pluck_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. Ply 30 is
 * the first ply that is not an early king walk, and this layer is off then.
 * The ceiling is not a genome field.
 */
const FETCH_KING_PLY = 30;

function fetchFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.fetch_enabled !== true) return false;
  const ply = clampInt(g.fetch_ply, 0, 180, 0);
  if (history.length < ply) return false;
  return history.length + 1 < FETCH_KING_PLY;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. Ply 30 is
 * the first ply that is not an early king walk, and this layer is off then.
 * The ceiling is not a genome field. A second arrow is not this layer.
 */
const GRIP_KING_PLY = 30;

function gripFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.grip_enabled !== true) return false;
  const ply = clampInt(g.grip_ply, 0, 180, 0);
  if (history.length < ply) return false;
  return history.length + 1 < GRIP_KING_PLY;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. There is
 * no ply-30 ceiling: the queen and rook captures grip missed were later.
 */
function bluntFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.blunt_enabled !== true) return false;
  const ply = clampInt(g.blunt_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 40 is the late phase, where a
 * long game is close to the ply cap. Ply 0 does not turn this on.
 */
function cloutFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.clout_enabled !== true) return false;
  const ply = clampInt(g.clout_ply, 0, 180, 40);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. A shelter
 * piece next to the enemy king is already there, and so is a pawn standing
 * on a bishop ray. Ply 40 does not turn this off.
 */
function barbFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.barb_enabled !== true) return false;
  const ply = clampInt(g.barb_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never drop. Ply 0 is the first move. The knight
 * the model plays instead of a flight pawn is already on the board. Ply 30
 * does not turn this off.
 */
function vaneFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.vane_enabled !== true) return false;
  const ply = clampInt(g.vane_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. A queen
 * or rook that is already under attack is already on the board. Ply 30
 * does not turn this off.
 */
function quillFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.quill_enabled !== true) return false;
  const ply = clampInt(g.quill_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. A bishop
 * that can already arrow a pawn or a king is already on the board. Ply 30
 * does not turn this off.
 */
function stringFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.string_enabled !== true) return false;
  const ply = clampInt(g.string_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. A knight
 * or bishop that can already be taken is already on the board. Ply 30
 * does not turn this off.
 */
function boltFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.bolt_enabled !== true) return false;
  const ply = clampInt(g.bolt_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. A queen
 * or rook that already hangs is already on the board. Ply 30 does not
 * turn this off.
 */
function spineFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.spine_enabled !== true) return false;
  const ply = clampInt(g.spine_ply, 0, 180, 0);
  return history.length >= ply;
}

/** Knight or bishop capture by a move or an axe. Not an arrow. Not a king step. */
function isBoltKind(s: Scored): boolean {
  if (!s.isCapture || !s.piece || !s.target) return false;
  if (s.piece.type === 'king') return false;
  if (s.action.kind !== 'move' && s.action.kind !== 'axe') return false;
  return s.target.type === 'knight' || s.target.type === 'bishop';
}

/** Bishop arrow whose target is a pawn. A king arrow is not this. */
function isPawnArrow(s: Scored): boolean {
  return s.action.kind === 'arrow' && s.target?.type === 'pawn';
}

/** Quiet step bolt may outrank. Captures, checks, escapes, arrows, and axes stay. */
function isQuietNonCapture(s: Scored): boolean {
  if (s.isCapture) return false;
  if (s.tags.includes('escape') || s.tags.includes('escape-best')) return false;
  if (s.tags.includes('gives-check')) return false;
  if (s.action.kind === 'axe' || s.action.kind === 'arrow') return false;
  return true;
}

/** Safe bishop arrow at a pawn or a king. Queen and rook captures are not this. */
function isStringArrow(s: Scored): boolean {
  if (!isVolleyArrow(s) || !s.target) return false;
  return s.target.type === 'pawn' || s.target.type === 'king';
}

/**
 * The one pawn or king arrow string ranks ahead of a quiet shuffle.
 * A king arrow wins over a pawn arrow. Otherwise the target closest to
 * the enemy king wins. Nothing here appends a square.
 */
function stringChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  const arrows = pool.filter((s) => isStringArrow(s));
  if (arrows.length === 0) return null;
  const kings = arrows.filter((s) => s.target?.type === 'king');
  const cands = kings.length > 0 ? kings : arrows;
  const enemy = findPieces(board, enemyOf(color), 'king');
  const king = enemy[0];
  let best = cands[0];
  const dist = (s: Scored) => (king ? chebyshev(s.to, king) : 0);
  for (const s of cands) {
    const d = dist(s);
    const bd = dist(best);
    if (d < bd || (d === bd && s.score > best.score)) best = s;
  }
  return best;
}

/**
 * The one knight or bishop capture bolt ranks ahead of a pawn arrow.
 * Larger fitted gain wins. An axe wins a tie within noise. Then the
 * existing score. A flat trade is not tagged. An early check is not
 * tagged: the king reply would land before ply 30 and the gate counts it.
 * Nothing here appends a square. The score does not change.
 */
function boltChoice(pool: Scored[], board: Board, color: PlayerColor, history: Move[]): Scored | null {
  const early = history.length < 30;
  const enemy = enemyOf(color);
  const beforeFit = fittedValue(board, color);
  const beforeExp = ourKingExposure(board, color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeEnemyQueen = friendlyQueenRays(board, enemy);
  const beforeShelter = kingShelter(board, color);
  let best: Scored | null = null;
  let bestDelta = -Infinity;
  for (const s of pool) {
    if (!isBoltKind(s) || !s.piece) continue;
    if (pressUnsafe(s) || s.tags.includes('qr-force')) continue;
    if (prodHangsPower(s, board, color)) continue;
    if (early && s.tags.includes('gives-check')) continue;
    const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
    if (ourKingExposure(next, color) > beforeExp) continue;
    if (qrAttackCount(next, color) > beforeOurs) continue;
    if (qrAttackCount(next, enemy) > beforeTheirs) continue;
    if (friendlyQueenRays(next, color) > beforeQueen) continue;
    if (friendlyQueenRays(next, enemy) > beforeEnemyQueen) continue;
    if (early && kingShelter(next, color) < beforeShelter) continue;
    const delta = fittedValue(next, color) - beforeFit;
    if (delta <= NET_EPS) continue;
    if (!best) {
      best = s;
      bestDelta = delta;
      continue;
    }
    const close = Math.abs(delta - bestDelta) <= NET_EPS;
    const axeWin = close && s.action.kind === 'axe' && best.action.kind !== 'axe';
    const scoreWin = close && s.action.kind === best.action.kind && s.score > best.score;
    if (delta > bestDelta + NET_EPS || axeWin || scoreWin) {
      best = s;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Pawn arrows on this board that stay safe. A checking arrow does not
 * count before ply 30: the king reply would be an early king walk.
 * Queen and rook targets are not counted. Nothing here appends a square.
 */
function safePawnShotCount(board: Board, color: PlayerColor, early: boolean): number {
  const enemy = enemyOf(color);
  let n = 0;
  for (const from of findPieces(board, color, 'bishop')) {
    const bishop = board[from.row]?.[from.col]?.piece;
    if (!bishop) continue;
    for (const to of getArrowTargets(board, from)) {
      const target = board[to.row]?.[to.col]?.piece;
      if (!target || target.color !== enemy || target.type !== 'pawn') continue;
      const after = applyAction(board, 'arrow', from, to, bishop);
      if (findPieces(after, color, 'king').length === 0) continue;
      if (isInCheck(after, color)) continue;
      if (early && isInCheck(after, enemy)) continue;
      if (pieceHangsCheaply(after, from, color, 'bishop')) continue;
      if (powerEnPrise(after, color)) continue;
      const reply = worstCaptureReply(after, color);
      if (reply && reply.victim >= PIECE_VALUE.rook) continue;
      n++;
    }
  }
  return n;
}

/** Queen or rook step spine may rank. A capture, a check, and an escape are not this. Mate-net stays: that tag is any flight loss, not a check. */
function isSpineStep(s: Scored): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'queen' && s.piece.type !== 'rook') return false;
  if (s.isCapture) return false;
  if (s.tags.includes('escape') || s.tags.includes('escape-best')) return false;
  if (s.tags.includes('gives-check') || s.tags.includes('finish')) return false;
  if (takesEnemyKing(s)) return false;
  return true;
}

/**
 * The one queen or rook step that clears a cheap hang and leaves a safe
 * pawn arrow. A safe pawn arrow that is already ranked is glean's. A
 * capture, a check, and an escape are not this. Nothing here appends a
 * square. The score does not change. Does not call evaluateComputerPolicy.
 */
function spineChoice(pool: Scored[], board: Board, color: PlayerColor, history: Move[]): Scored | null {
  if (pool.some((s) => isVolleyArrow(s) && (s.tags.includes('arrow-pawn') || s.target?.type === 'pawn'))) {
    return null;
  }
  if (!powerEnPrise(board, color)) return null;
  const early = history.length < 30;
  const enemy = enemyOf(color);
  const beforeHangs = hangingPowerPieces(board, color).length;
  const beforeExp = ourKingExposure(board, color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeEnemyQueen = friendlyQueenRays(board, enemy);
  const beforeShelter = kingShelter(board, color);
  let best: Scored | null = null;
  let bestHangs = Infinity;
  let bestShots = 0;
  for (const s of pool) {
    if (!isSpineStep(s) || !s.piece) continue;
    if (pressUnsafe(s) || s.tags.includes('qr-force')) continue;
    const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
    const hangs = hangingPowerPieces(next, color).length;
    if (hangs >= beforeHangs) continue;
    if (isInCheck(next, color)) continue;
    if (ourKingExposure(next, color) > beforeExp) continue;
    if (qrAttackCount(next, color) > beforeOurs) continue;
    if (qrAttackCount(next, enemy) > beforeTheirs) continue;
    if (friendlyQueenRays(next, color) > beforeQueen) continue;
    if (friendlyQueenRays(next, enemy) > beforeEnemyQueen) continue;
    if (kingShelter(next, color) < beforeShelter) continue;
    if (enemyCanArrowPos(next, s.to, enemy) || enemyCanAxePos(next, s.to, enemy)) continue;
    const shots = safePawnShotCount(next, color, early);
    if (shots <= 0) continue;
    const better = !best
      || hangs < bestHangs
      || (hangs === bestHangs && shots > bestShots)
      || (hangs === bestHangs && shots === bestShots && s.score > best.score);
    if (better) {
      best = s;
      bestHangs = hangs;
      bestShots = shots;
    }
  }
  return best;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. A pawn
 * a knight is standing on is already on the board. Ply 30 does not turn
 * this off.
 */
function broadheadFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.broadhead_enabled !== true) return false;
  const ply = clampInt(g.broadhead_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * Capture of a pawn, knight, or bishop by a move or an axe. A queen or
 * rook capture is not this: hung_qr counts both sides. A king step and a
 * king capture are not this.
 */
function isBroadheadCapture(s: Scored): boolean {
  if (!s.isCapture || !s.piece || !s.target) return false;
  if (s.piece.type === 'king') return false;
  if (s.action.kind !== 'move' && s.action.kind !== 'axe') return false;
  return s.target.type === 'pawn' || s.target.type === 'knight' || s.target.type === 'bishop';
}

/**
 * The one capture that makes a safe pawn arrow exist. Glean already plays
 * a pawn arrow that is safe now, and a knight or rook blocking the ray is
 * immune to the arrow. Nothing here appends a square. The score does not
 * change. Does not call evaluateComputerPolicy.
 */
function broadheadChoice(pool: Scored[], board: Board, color: PlayerColor, history: Move[]): Scored | null {
  if (pool.some((s) => isVolleyArrow(s) && (s.tags.includes('arrow-pawn') || s.target?.type === 'pawn'))) {
    return null;
  }
  const early = history.length < 30;
  const before = safePawnShotCount(board, color, early);
  if (before > 0) return null;
  const beforeFit = fittedValue(board, color);
  let best: Scored | null = null;
  let bestShots = 0;
  let bestDelta = -Infinity;
  for (const s of pool) {
    if (!isBroadheadCapture(s) || !s.piece) continue;
    if (s.tags.includes('escape') || s.tags.includes('escape-best')) continue;
    if (early && s.tags.includes('gives-check')) continue;
    if (pressUnsafe(s) || s.tags.includes('qr-force')) continue;
    if (prodHangsPower(s, board, color)) continue;
    const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
    if (isInCheck(next, color)) continue;
    const shots = safePawnShotCount(next, color, early);
    if (shots <= before) continue;
    const delta = fittedValue(next, color) - beforeFit;
    const better = !best
      || shots > bestShots
      || (shots === bestShots && delta > bestDelta + NET_EPS)
      || (shots === bestShots && Math.abs(delta - bestDelta) <= NET_EPS && s.score > best.score);
    if (better) {
      best = s;
      bestShots = shots;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. A pawn
 * a knight is standing on is already on the board. Ply 30 does not turn
 * this off.
 */
function shaftFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.shaft_enabled !== true) return false;
  const ply = clampInt(g.shaft_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * Quiet bishop, knight, or pawn step. A capture, a check, an escape, a
 * fork, a king, a queen, and a rook are not this.
 */
function isShaftStep(s: Scored): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'bishop' && s.piece.type !== 'knight' && s.piece.type !== 'pawn') return false;
  if (s.isCapture) return false;
  if (s.tags.includes('gives-check') || s.tags.includes('fork')) return false;
  if (s.tags.includes('escape') || s.tags.includes('escape-best')) return false;
  return true;
}

/**
 * The one quiet step that makes a safe pawn arrow exist. Flight, nock, and
 * crest already own a quiet stall, so this stays silent when any of those
 * tags is present. A capture is not a candidate: that was broadhead, and
 * it raised hung_qr and illegal_rate. Nothing here appends a square. The
 * score does not change. Does not call evaluateComputerPolicy.
 */
function shaftChoice(pool: Scored[], board: Board, color: PlayerColor, history: Move[]): Scored | null {
  if (pool.some((s) => s.tags.includes('flight') || s.tags.includes('nock') || s.tags.includes('crest'))) {
    return null;
  }
  const early = history.length < 30;
  const before = safePawnShotCount(board, color, early);
  if (before > 0) return null;
  const enemy = enemyOf(color);
  const beforeExp = ourKingExposure(board, color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeEnemyQueen = friendlyQueenRays(board, enemy);
  const beforeShelter = kingShelter(board, color);
  let best: Scored | null = null;
  let bestShots = 0;
  for (const s of pool) {
    if (!isShaftStep(s) || !s.piece) continue;
    if (pressUnsafe(s) || s.tags.includes('qr-force')) continue;
    if (prodHangsPower(s, board, color)) continue;
    if (
      s.tags.includes('walks-into-snipe')
      || s.tags.includes('hangs-self')
      || s.tags.includes('bishop-snipe-hangs')
    ) continue;
    const next = applyAction(board, 'move', s.from, s.to, s.piece);
    if (isInCheck(next, color)) continue;
    if (qrAttackCount(next, color) > beforeOurs) continue;
    if (qrAttackCount(next, enemy) > beforeTheirs) continue;
    if (friendlyQueenRays(next, color) > beforeQueen) continue;
    if (friendlyQueenRays(next, enemy) > beforeEnemyQueen) continue;
    if (ourKingExposure(next, color) > beforeExp) continue;
    if (kingShelter(next, color) < beforeShelter) continue;
    if (enemyCanArrowPos(next, s.to, enemy) || enemyCanAxePos(next, s.to, enemy)) continue;
    const shots = safePawnShotCount(next, color, early);
    if (shots <= before) continue;
    const better = !best
      || shots > bestShots
      || (shots === bestShots && s.score > best.score);
    if (better) {
      best = s;
      bestShots = shots;
    }
  }
  return best;
}

/**
 * No lead. Flag-off genomes never tag. Ply 0 is the first move. Ply 30
 * does not turn this off; it only refuses a checking save before then.
 */
function anchorFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.anchor_enabled !== true) return false;
  const ply = clampInt(g.anchor_ply, 0, 180, 0);
  return history.length >= ply;
}

/** Friendly bishops an enemy can take for less than a bishop, or for free. */
function hangingBishopCount(board: Board, color: PlayerColor): number {
  let n = 0;
  for (const pos of findPieces(board, color, 'bishop')) {
    if (pieceHangsCheaply(board, pos, color, 'bishop')) n++;
  }
  return n;
}

/**
 * Quiet non-save anchor may pass. An arrow, an axe, a capture, a check,
 * an escape, a fork, a finish, a mate-net, a king step, and a flight,
 * nock, or crest tag are not this. The score does not change.
 */
function anchorJumps(s: Scored): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.isCapture || s.piece.type === 'king') return false;
  if (
    s.tags.includes('gives-check')
    || s.tags.includes('escape')
    || s.tags.includes('escape-best')
    || s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
    || s.tags.includes('mate-net')
    || s.tags.includes('finish')
    || s.tags.includes('fork')
  ) return false;
  return true;
}

/**
 * The one legal save that strictly reduces the hanging-bishop count. An
 * arrow that removes the attacker counts. A shot that leaves the bishop
 * hanging does not. A king step never does. Nothing here appends a square.
 * The score does not change. Does not call evaluateComputerPolicy.
 */
function anchorChoice(pool: Scored[], board: Board, color: PlayerColor, history: Move[]): Scored | null {
  const before = hangingBishopCount(board, color);
  if (before <= 0) return null;
  // A hanging queen or rook is the hung_qr gate. Do not spend the move on a
  // bishop while that capture is still available. Spine already tried to
  // clear those hangs and lost.
  if (powerEnPrise(board, color)) return null;
  const early = history.length < 30;
  const enemy = enemyOf(color);
  const beforeExp = ourKingExposure(board, color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeEnemyQueen = friendlyQueenRays(board, enemy);
  const beforeShelter = kingShelter(board, color);
  let best: Scored | null = null;
  let bestHangs = Infinity;
  let bestCapture = false;
  let bestArrow = false;
  for (const s of pool) {
    if (!s.piece || s.piece.type === 'king') continue;
    if (capturesQr(s)) continue;
    if (early && s.tags.includes('gives-check')) continue;
    if (s.tags.includes('escape') || s.tags.includes('escape-best')) continue;
    if (s.tags.includes('finish') || s.tags.includes('mate-net') || s.tags.includes('fork')) continue;
    if (pressUnsafe(s) || s.tags.includes('qr-force')) continue;
    if (prodHangsPower(s, board, color)) continue;
    if (
      s.tags.includes('walks-into-snipe')
      || s.tags.includes('hangs-self')
      || s.tags.includes('bishop-snipe-hangs')
    ) continue;
    const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
    const hangs = hangingBishopCount(next, color);
    if (hangs >= before) continue;
    if (isInCheck(next, color)) continue;
    if (qrAttackCount(next, color) > beforeOurs) continue;
    if (qrAttackCount(next, enemy) > beforeTheirs) continue;
    if (friendlyQueenRays(next, color) > beforeQueen) continue;
    if (friendlyQueenRays(next, enemy) > beforeEnemyQueen) continue;
    if (ourKingExposure(next, color) > beforeExp) continue;
    if (kingShelter(next, color) < beforeShelter) continue;
    if (s.action.kind === 'move' && (enemyCanArrowPos(next, s.to, enemy) || enemyCanAxePos(next, s.to, enemy))) {
      continue;
    }
    const isCap = s.isCapture;
    const isArrow = s.action.kind === 'arrow';
    const better = !best
      || hangs < bestHangs
      || (hangs === bestHangs && isCap && !bestCapture)
      || (hangs === bestHangs && isCap === bestCapture && isArrow && !bestArrow)
      || (hangs === bestHangs && isCap === bestCapture && isArrow === bestArrow && s.score > best.score);
    if (better) {
      best = s;
      bestHangs = hangs;
      bestCapture = isCap;
      bestArrow = isArrow;
    }
  }
  return best;
}

/**
 * Ahead, and not before ply 40. cast_ply can only push that floor later.
 * Flag-off genomes never tag. Ply 0 does not turn this on.
 */
function castFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.cast_enabled !== true) return false;
  const ply = clampInt(g.cast_ply, 0, 180, 0);
  return history.length >= Math.max(ply, 40);
}

/**
 * Quiet non-checking non-capture cast may pass, including a finish-tagged
 * approach. An arrow, an axe, a capture, a check, an escape, a fork, a
 * mate-net, a king step, and a flight, nock, crest, or anchor tag are not
 * this. The score does not change.
 */
function castJumps(s: Scored): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.isCapture || s.piece.type === 'king') return false;
  if (
    s.tags.includes('gives-check')
    || s.tags.includes('escape')
    || s.tags.includes('escape-best')
    || s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
    || s.tags.includes('mate-net')
    || s.tags.includes('fork')
    || s.tags.includes('anchor')
  ) return false;
  return true;
}

/**
 * The one quiet bishop step that adds a pawn ray while no pawn arrow exists
 * yet. Null on a pure quiet stall: nock and flight already own that pool.
 * Null when the side is not ahead, when a pawn arrow is already legal, or
 * when a queen or rook hangs. A capture is not this. A check is not this.
 * A king step is not this. Nothing here appends a square. The score does
 * not change. Does not call evaluateComputerPolicy.
 */
function castChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (nockStall(pool)) return null;
  if (friendlyPawnRays(board, color) !== 0) return null;
  if (powerEnPrise(board, color)) return null;
  const lead = sideMaterial(board, color) - sideMaterial(board, enemyOf(color));
  if (lead < 1) return null;
  const enemy = enemyOf(color);
  const beforeExp = ourKingExposure(board, color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeShelter = kingShelter(board, color);
  let best: Scored | null = null;
  let bestGain = 0;
  for (const s of pool) {
    if (!isNockAim(s, board, color) || !s.piece) continue;
    if (
      s.tags.includes('walks-into-snipe')
      || s.tags.includes('hangs-self')
      || s.tags.includes('bishop-snipe-hangs')
    ) continue;
    const next = applyAction(board, 'move', s.from, s.to, s.piece);
    if (isInCheck(next, color)) continue;
    if (qrAttackCount(next, color) > beforeOurs) continue;
    if (qrAttackCount(next, enemy) > beforeTheirs) continue;
    if (ourKingExposure(next, color) > beforeExp) continue;
    if (kingShelter(next, color) < beforeShelter) continue;
    if (enemyCanArrowPos(next, s.to, enemy) || enemyCanAxePos(next, s.to, enemy)) continue;
    if (pieceHangsCheaply(next, s.to, color, 'bishop')) continue;
    const gain = pawnArrowsFrom(next, s.to) - pawnArrowsFrom(board, s.from);
    if (gain <= 0) continue;
    const better = !best || gain > bestGain || (gain === bestGain && s.score > best.score);
    if (better) {
      best = s;
      bestGain = gain;
    }
  }
  return best;
}

/**
 * Ahead, and not before ply 40. quarry_ply can only push that floor later.
 * Flag-off genomes never tag. Ply 0 does not turn this on before ply 40.
 */
function quarryFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.quarry_enabled !== true) return false;
  const ply = clampInt(g.quarry_ply, 0, 180, 0);
  return history.length >= Math.max(ply, 40);
}

/**
 * Quiet non-checking non-capture quarry may pass. A finish approach is
 * included. An arrow, an axe, a capture, a check, an escape, a fork, a
 * king-hunt, a king-help, and a flight, nock, or crest tag are not this.
 * The score does not change.
 */
function quarryJumps(s: Scored): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.isCapture) return false;
  if (
    s.tags.includes('gives-check')
    || s.tags.includes('escape')
    || s.tags.includes('escape-best')
    || s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
    || s.tags.includes('fork')
    || s.tags.includes('king-hunt')
    || s.tags.includes('king-help')
  ) return false;
  return true;
}

/**
 * The one quiet queen or rook step that gets closer to the enemy king.
 * Null when the side is not ahead, when a queen or rook already hangs, or
 * when no safe closer step is still in the pool. A capture is not this.
 * A check is not this. Nothing here appends a square. The score does not
 * change. Does not call evaluateComputerPolicy.
 */
function quarryChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (powerEnPrise(board, color)) return null;
  const enemy = enemyOf(color);
  const lead = sideMaterial(board, color) - sideMaterial(board, enemy);
  if (lead < 1) return null;
  const king = findPieces(board, enemy, 'king')[0];
  if (!king) return null;
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeShelter = kingShelter(board, color);
  let best: Scored | null = null;
  let bestGain = 0;
  let bestQueen = false;
  for (const s of pool) {
    if (s.action.kind !== 'move' || !s.piece) continue;
    if (s.piece.type !== 'queen' && s.piece.type !== 'rook') continue;
    if (s.isCapture) continue;
    if (
      s.tags.includes('gives-check')
      || s.tags.includes('escape')
      || s.tags.includes('escape-best')
    ) continue;
    if (
      s.tags.includes('walks-into-snipe')
      || s.tags.includes('hangs-self')
      || s.tags.includes('bishop-snipe-hangs')
    ) continue;
    const gain = chebyshev(s.from, king) - chebyshev(s.to, king);
    if (gain <= 0) continue;
    const next = applyAction(board, 'move', s.from, s.to, s.piece);
    if (isInCheck(next, color)) continue;
    if (qrAttackCount(next, color) > beforeOurs) continue;
    if (qrAttackCount(next, enemy) > beforeTheirs) continue;
    if (kingShelter(next, color) < beforeShelter) continue;
    if (enemyCanArrowPos(next, s.to, enemy) || enemyCanAxePos(next, s.to, enemy)) continue;
    if (pieceHangsCheaply(next, s.to, color, s.piece.type)) continue;
    const isQueen = s.piece.type === 'queen';
    const better = !best
      || gain > bestGain
      || (gain === bestGain && isQueen && !bestQueen)
      || (gain === bestGain && isQueen === bestQueen && s.score > (best.score));
    if (better) {
      best = s;
      bestGain = gain;
      bestQueen = isQueen;
    }
  }
  return best;
}

/**
 * From latch_ply. Ply 0 counts. Flag-off genomes never tag. There is no
 * extra floor: a king already on a ray does not wait until ply 40.
 */
function latchFiring(g: PolicyGenome, history: Move[]): boolean {
  if (g.latch_enabled !== true) return false;
  const ply = clampInt(g.latch_ply, 0, 180, 0);
  return history.length >= ply;
}

/**
 * Quiet queen, rook, or king steps the block may pass, including a step that
 * only escapes the bishop ray. A bishop ray is check, so the rook and the
 * king that step off it are escapes. A capture, a check, a fork, a
 * king-hunt, a king-help, and a flight, nock, or crest tag are not this.
 * A bishop, a knight, and a pawn are not this. The score does not change.
 */
function latchJumps(s: Scored): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'queen' && s.piece.type !== 'rook' && s.piece.type !== 'king') return false;
  if (s.isCapture) return false;
  if (
    s.tags.includes('gives-check')
    || s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
    || s.tags.includes('fork')
    || s.tags.includes('king-hunt')
    || s.tags.includes('king-help')
  ) return false;
  return true;
}

/** Empty squares strictly between two aligned squares. The endpoints are not included. */
function squaresStrictlyBetween(a: Position, b: Position): Position[] {
  const dr = b.row - a.row;
  const dc = b.col - a.col;
  const adr = Math.abs(dr);
  const adc = Math.abs(dc);
  const steps = Math.max(adr, adc);
  if (steps < 2) return [];
  if (adr !== 0 && adc !== 0 && adr !== adc) return [];
  const sr = dr === 0 ? 0 : dr / adr;
  const sc = dc === 0 ? 0 : dc / adc;
  const out: Position[] = [];
  for (let i = 1; i < steps; i++) out.push({ row: a.row + sr * i, col: a.col + sc * i });
  return out;
}

/**
 * Squares on a clear enemy-bishop arrow ray that currently hits our king.
 * The bishop squares are returned so the block may stand on that ray
 * without counting the same bishop's arrow as a new hang.
 */
function kingRayBlocks(board: Board, color: PlayerColor): { squares: Position[]; bishops: Position[] } {
  const king = findPieces(board, color, 'king')[0];
  const squares: Position[] = [];
  const bishops: Position[] = [];
  if (!king) return { squares, bishops };
  for (const from of findPieces(board, enemyOf(color), 'bishop')) {
    if (!getArrowTargets(board, from).some((t) => samePos(t, king))) continue;
    bishops.push(from);
    for (const sq of squaresStrictlyBetween(from, king)) {
      if (!squares.some((s) => samePos(s, sq))) squares.push(sq);
    }
  }
  return { squares, bishops };
}

/**
 * Knight, then bishop, then pawn. A knight on the closed ray is immune to
 * the arrow. A pawn or a bishop standing there is the bishop's next shot,
 * and that shot is a worse escape, so it loses the tie. A queen or a rook
 * is not a block.
 */
function latchMoverRank(type: PieceType): number {
  if (type === 'knight') return 0;
  if (type === 'bishop') return 1;
  if (type === 'pawn') return 2;
  return 9;
}

/**
 * A hang that is not the arrow of a bishop whose ray this square just closed.
 * Knights and rooks are already immune to arrows. An undefended pawn on the
 * closed ray is allowed: that is the block. An axe, a different bishop's
 * arrow, or a piece that can step onto the square is not.
 */
function hangsBesidesBlockedBishops(
  board: Board,
  pos: Position,
  color: PlayerColor,
  type: PieceType,
  ignore: Position[],
): boolean {
  const enemy = enemyOf(color);
  let cheapest: number | null = null;
  const consider = (v: number) => {
    if (cheapest == null || v < cheapest) cheapest = v;
  };
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const p = board[row][col].piece;
      if (!p || p.color !== enemy) continue;
      const from = { row, col };
      if (getValidMoves(board, from, true).some((a) => samePos(a, pos))) {
        consider(PIECE_VALUE[p.type] ?? 0);
      }
      if (p.type === 'knight' && type !== 'rook') {
        if (getAxeTargets(board, from).some((a) => samePos(a, pos))) consider(PIECE_VALUE.knight);
      }
      if (
        p.type === 'bishop'
        && type !== 'knight'
        && type !== 'rook'
        && !ignore.some((b) => samePos(b, from))
      ) {
        if (getArrowTargets(board, from).some((a) => samePos(a, pos))) consider(PIECE_VALUE.bishop);
      }
    }
  }
  if (cheapest == null) return false;
  if (!isDefendedBy(board, pos, color)) return true;
  return cheapest < (PIECE_VALUE[type] ?? 0);
}

/**
 * The one quiet pawn, knight, or bishop step that stands on a clear bishop
 * ray and lowers our king exposure. Null when no such ray exists, when a
 * queen or rook already hangs, or when no safe block is still in the pool.
 * A capture is not this. A move that also gives check is not this. The
 * block is itself an escape: the ray is check, and this step clears it, so
 * the escape tag is not a reason to skip it. A queen, a rook, and a king
 * are not this. Nothing here appends a square. The score does not change.
 * Does not call evaluateComputerPolicy.
 */
function latchChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (powerEnPrise(board, color)) return null;
  const beforeExp = ourKingExposure(board, color);
  if (beforeExp <= 0) return null;
  const { squares, bishops } = kingRayBlocks(board, color);
  if (squares.length === 0 || bishops.length === 0) return null;
  const enemy = enemyOf(color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeShelter = kingShelter(board, color);
  let best: Scored | null = null;
  let bestDrop = 0;
  let bestMover = 9;
  for (const s of pool) {
    if (s.action.kind !== 'move' || !s.piece) continue;
    const ptype = s.piece.type;
    if (ptype !== 'pawn' && ptype !== 'knight' && ptype !== 'bishop') continue;
    if (s.isCapture) continue;
    // The ray is check. The block clears it, so it is already tagged escape.
    // Skipping that tag would leave the layer with nothing to rank. A
    // loose-escape is a worse fitted get-out and is deleted after this
    // tag. Tagging it would throw the block away and leave the king walk.
    if (s.tags.includes('gives-check') || s.tags.includes('loose-escape')) continue;
    if (pressUnsafe(s) || s.tags.includes('qr-force')) continue;
    if (
      s.tags.includes('walks-into-snipe')
      || s.tags.includes('hangs-self')
      || s.tags.includes('bishop-snipe-hangs')
    ) continue;
    if (!squares.some((sq) => samePos(sq, s.to))) continue;
    const next = applyAction(board, 'move', s.from, s.to, s.piece);
    if (isInCheck(next, color)) continue;
    const drop = beforeExp - ourKingExposure(next, color);
    if (drop <= 0) continue;
    if (qrAttackCount(next, color) > beforeOurs) continue;
    if (qrAttackCount(next, enemy) > beforeTheirs) continue;
    if (kingShelter(next, color) < beforeShelter) continue;
    if (enemyCanAxePos(next, s.to, enemy)) continue;
    if (hangsBesidesBlockedBishops(next, s.to, color, ptype, bishops)) continue;
    const mover = latchMoverRank(ptype);
    const better = !best
      || drop > bestDrop
      || (drop === bestDrop && mover < bestMover)
      || (drop === bestDrop && mover === bestMover && s.score > best.score);
    if (better) {
      best = s;
      bestDrop = drop;
      bestMover = mover;
    }
  }
  return best;
}

function historyKind(m: Move): 'move' | 'arrow' | 'axe' | 'bomb' | 'wall' {
  if (m.isBombAttack) return 'bomb';
  if (m.isWallBuild) return 'wall';
  if (m.isArrowAttack) return 'arrow';
  if (m.isAxeAttack) return 'axe';
  return 'move';
}

/**
 * Our previous special and the opponent's last special are the same square
 * with the opposite kind (bomb then wall, or wall then bomb). Escapes stay
 * escapes: the side in check still has to answer.
 */
function isImmediateSpecialLoop(s: Scored, history: Move[]): boolean {
  if (history.length < 2) return false;
  if (s.action.kind !== 'bomb' && s.action.kind !== 'wall') return false;
  if (s.tags.includes('escape') || s.tags.includes('escape-best')) return false;
  const ours = history[history.length - 2];
  const theirs = history[history.length - 1];
  if (historyKind(ours) !== s.action.kind) return false;
  if (!samePos(ours.from, s.from) || !samePos(ours.to, s.to)) return false;
  const opp = s.action.kind === 'bomb' ? 'wall' : 'bomb';
  if (historyKind(theirs) !== opp) return false;
  return samePos(theirs.to, s.to);
}

const STRING_REPEAT_TAGS = [
  'progress', 'finish', 'mate-net', 'press', 'reap', 'gives-check', 'king-hunt', 'king-help',
];

/** Stop a bomb/wall loop from being the only move progress will keep. */
function markStringRepeats(pool: Scored[], history: Move[]): void {
  for (const s of pool) {
    if (!isImmediateSpecialLoop(s, history)) continue;
    s.tags = s.tags.filter((t) => !STRING_REPEAT_TAGS.includes(t));
    if (!s.tags.includes('string-repeat')) s.tags.push('string-repeat');
  }
}

/** Enemy pawns a bishop on `from` can currently arrow. Knights and rooks are immune. */
function pawnArrowsFrom(board: Board, from: Position): number {
  const piece = board[from.row]?.[from.col]?.piece;
  if (!piece || piece.type !== 'bishop') return 0;
  let n = 0;
  for (const to of getArrowTargets(board, from)) {
    if (board[to.row]?.[to.col]?.piece?.type === 'pawn') n++;
  }
  return n;
}

/** Queens a bishop on `from` can currently arrow. Rooks are immune to arrows. */
function queenArrowsFrom(board: Board, from: Position): number {
  const piece = board[from.row]?.[from.col]?.piece;
  if (!piece || piece.type !== 'bishop') return 0;
  let n = 0;
  for (const to of getArrowTargets(board, from)) {
    if (board[to.row]?.[to.col]?.piece?.type === 'queen') n++;
  }
  return n;
}

/** Pawn arrows every friendly bishop can currently fire. */
function friendlyPawnRays(board: Board, color: PlayerColor): number {
  let n = 0;
  for (const pos of findPieces(board, color, 'bishop')) n += pawnArrowsFrom(board, pos);
  return n;
}

/** Queen arrows every friendly bishop can currently fire. Rooks are immune. */
function friendlyQueenRays(board: Board, color: PlayerColor): number {
  let n = 0;
  for (const pos of findPieces(board, color, 'bishop')) n += queenArrowsFrom(board, pos);
  return n;
}

/**
 * Enemy king, or enemy queen, sitting on a bishop ray behind exactly one
 * friendly pawn, knight, or bishop. The screen blocks the arrow, so the
 * king is not in check and bishop-aims-king does not pay. A queen or rook
 * is not a screen: lining one up is the hung-queen setup. A clear ray is
 * not this.
 */
function screenedRoyaltyFrom(board: Board, from: Position): { king: number; queen: number } {
  const piece = board[from.row]?.[from.col]?.piece;
  const none = { king: 0, queen: 0 };
  if (!piece || piece.type !== 'bishop') return none;
  const color = piece.color;
  const enemy = enemyOf(color);
  const dirs = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ];
  const out = { king: 0, queen: 0 };
  for (const [dr, dc] of dirs) {
    let r = from.row + dr;
    let c = from.col + dc;
    let screened = false;
    while (r >= 0 && r < 12 && c >= 0 && c < 12 && !board[r][c].isWall) {
      const occ = board[r][c].piece;
      if (!occ) {
        r += dr;
        c += dc;
        continue;
      }
      if (!screened) {
        if (occ.color !== color) break;
        if (occ.type !== 'pawn' && occ.type !== 'knight' && occ.type !== 'bishop') break;
        screened = true;
        r += dr;
        c += dc;
        continue;
      }
      if (occ.color === enemy && occ.type === 'king') out.king++;
      else if (occ.color === enemy && occ.type === 'queen') out.queen++;
      break;
    }
  }
  return out;
}

/**
 * Enemy bishops that arrow our king, plus enemy knights within two squares.
 * The same exposure the model treats as a cost. A pile step must not raise it.
 */
function ourKingExposure(board: Board, color: PlayerColor): number {
  const king = findPieces(board, color, 'king')[0];
  if (!king) return 0;
  const enemy = enemyOf(color);
  let n = 0;
  for (const pos of findPieces(board, enemy, 'bishop')) {
    if (getArrowTargets(board, pos).some((t) => samePos(t, king))) n++;
  }
  for (const pos of findPieces(board, enemy, 'knight')) {
    const d = chebyshev(pos, king);
    if (d > 0 && d <= 2) n++;
  }
  return n;
}

/** Arrow targets that are not a queen or a rook. A queen or rook shot is not the ray keel opens. */
function keelRaysFrom(board: Board, from: Position): number {
  const piece = board[from.row]?.[from.col]?.piece;
  if (!piece || piece.type !== 'bishop') return 0;
  let n = 0;
  for (const to of getArrowTargets(board, from)) {
    const kind = board[to.row]?.[to.col]?.piece?.type;
    if (kind === 'pawn' || kind === 'knight' || kind === 'bishop' || kind === 'king') n++;
  }
  return n;
}

/** Same window as finish and convert. Flag-off genomes never reach the drop. */
function volleyFiring(g: PolicyGenome, board: Board, color: PlayerColor, history: Move[]): boolean {
  if (g.volley_enabled !== true) return false;
  const ply = clampInt(g.volley_ply, 40, 180, 40);
  if (history.length < ply) return false;
  const margin = clampInt(g.volley_margin, 1, 9, 1);
  const lead = sideMaterial(board, color) - sideMaterial(board, enemyOf(color));
  return lead >= margin;
}

function lateRepeat(history: Move[], piece: Piece | null, from: Position, to: Position, tags: string[]): boolean {
  if (tags.includes('oscillation') || tags.includes('reversal')) return true;
  if (!piece) return false;
  const trail = pieceMoves(history, piece, from);
  if (trail.length < 2) return false;
  return trail.some((m) => samePos(m.from, to) || samePos(m.to, to));
}

/** Capture, check, or a safe step toward the enemy king. Not a king wander and not a hang. */
function lateForcing(kind: ActionKind, isCapture: boolean, isThrash: boolean, tags: string[]): boolean {
  if (tags.includes('axe-home-snipe')) return false;
  if (hasUnsafeSelfTags(tags)) return false;
  if (tags.includes('king-wander') || tags.includes('king-exposed') || tags.includes('king-idle')) return false;
  if (isCapture) return true;
  if (tags.includes('gives-check')) return true;
  if (kind === 'move' && tags.includes('approach') && !isThrash) return true;
  return false;
}

function lateQuiet(kind: ActionKind, isCapture: boolean, tags: string[]): boolean {
  if (tags.includes('oscillation') || tags.includes('reversal')) return true;
  if (kind === 'wall' || kind === 'bomb') return true;
  if (kind === 'move' && !isCapture && !tags.includes('gives-check')) return true;
  return false;
}

/** Fitted side-minus-opponent value. Same material and king-exposure definitions as the model. */
function fittedValue(board: Board, color: PlayerColor): number {
  const enemy = enemyOf(color);
  if (findPieces(board, enemy, 'king').length === 0) return FIT_KING_GONE;
  if (findPieces(board, color, 'king').length === 0) return -FIT_KING_GONE;
  let ourMat = 0;
  let theirMat = 0;
  let ourExp = 0;
  let theirExp = 0;
  const ourKing = findPieces(board, color, 'king')[0];
  const theirKing = findPieces(board, enemy, 'king')[0];
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const piece = board[row]?.[col]?.piece;
      if (!piece) continue;
      const pos = { row, col };
      const points = MODEL_VALUE[piece.type] ?? 0;
      const arrows = piece.type === 'bishop' ? getArrowTargets(board, pos).length : 0;
      if (piece.color === color) ourMat += points + arrows;
      else theirMat += points + arrows;
      if (piece.type === 'bishop' && piece.color !== color && ourKing) {
        if (getArrowTargets(board, pos).some((t) => samePos(t, ourKing))) ourExp++;
      }
      if (piece.type === 'bishop' && piece.color === color && theirKing) {
        if (getArrowTargets(board, pos).some((t) => samePos(t, theirKing))) theirExp++;
      }
      if (piece.type === 'knight' && piece.color !== color && ourKing) {
        if (chebyshev(pos, ourKing) > 0 && chebyshev(pos, ourKing) <= 2) ourExp++;
      }
      if (piece.type === 'knight' && piece.color === color && theirKing) {
        if (chebyshev(pos, theirKing) > 0 && chebyshev(pos, theirKing) <= 2) theirExp++;
      }
    }
  }
  const mat = ourMat - theirMat;
  const exp = ourExp - theirExp;
  return FIT_MATERIAL_PER * mat + FIT_EXPOSURE_PER * exp;
}

interface CaptureReply {
  from: Position;
  to: Position;
  kind: ActionKind;
  victim: number;
  attacker: number;
}

/**
 * Worst enemy capture on `board` for `victimColor`.
 * Destinations come only from getValidMoves, getArrowTargets, and getAxeTargets.
 * Quiet replies are not generated. Highest victim value wins; a cheaper attacker
 * breaks the tie. King is 100, so a king capture outranks a queen.
 */
function worstCaptureReply(board: Board, victimColor: PlayerColor): CaptureReply | null {
  const enemy = enemyOf(victimColor);
  let best: CaptureReply | null = null;
  const consider = (reply: CaptureReply) => {
    if (
      !best
      || reply.victim > best.victim
      || (reply.victim === best.victim && reply.attacker < best.attacker)
    ) {
      best = reply;
    }
  };
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const piece = board[row][col].piece;
      if (!piece || piece.color !== enemy) continue;
      const from = { row, col };
      const attacker = PIECE_VALUE[piece.type] ?? 0;
      const add = (to: Position, kind: ActionKind) => {
        const occ = board[to.row]?.[to.col]?.piece;
        if (!occ || occ.color !== victimColor) return;
        consider({ from, to, kind, victim: PIECE_VALUE[occ.type] ?? 0, attacker });
      };
      for (const to of getValidMoves(board, from, true)) add(to, 'move');
      if (piece.type === 'bishop') {
        for (const to of getArrowTargets(board, from)) add(to, 'arrow');
      }
      if (piece.type === 'knight') {
        for (const to of getAxeTargets(board, from)) add(to, 'axe');
      }
    }
  }
  return best;
}

/** True when a friendly queen or rook can be taken for less than it is worth. */
function powerEnPrise(board: Board, color: PlayerColor): boolean {
  for (const type of ['queen', 'rook'] as const) {
    for (const pos of findPieces(board, color, type)) {
      if (pieceHangsCheaply(board, pos, color, type)) return true;
    }
  }
  return false;
}

/** Shuffle / wall / bomb. Captures, arrows, axes, checks, and real escapes stay. */
function progressDrop(s: Scored): boolean {
  if (s.tags.includes('progress') || s.tags.includes('escape')) return false;
  // Clout is tagged before this drop. A rook bomb is not a check, so
  // progress would delete it whenever a closer step is legal.
  if (s.tags.includes('clout')) return false;
  // Anchor is tagged before this drop. A quiet step off a hanging bishop
  // is not a closer step, so progress would delete the save whenever the
  // side is ahead. The tag exists only while anchor is firing.
  if (s.tags.includes('anchor')) return false;
  // Cast is tagged before this drop. A quiet bishop step that opens a
  // pawn ray is not itself a closer step, so progress would delete it
  // whenever the side is ahead. The tag exists only while cast is firing.
  if (s.tags.includes('cast')) return false;
  // Latch is tagged before this drop. A quiet pawn, knight, or bishop
  // step onto a bishop ray is not itself a closer step, so progress would
  // delete the block whenever a finish rook is legal. The tag exists only
  // while latch is firing.
  if (s.tags.includes('latch')) return false;
  // Sighter is tagged before this drop. The rook or queen slide that
  // attacks a loose pawn is not itself a closer step, so progress would
  // delete it whenever the side is ahead. The tag exists only while
  // sighter is firing.
  if (s.tags.includes('sighter')) return false;
  // Pluck is tagged before this drop. The pawn, knight, or bishop step that
  // newly attacks a piece is not itself a closer step, so progress would
  // delete it whenever a finish rook is legal. The tag exists only while
  // pluck is firing.
  if (s.tags.includes('pluck')) return false;
  // Fetch is tagged before this drop. The non-checking arrow or the minor
  // capture is not itself a closer step, so progress would delete the
  // capture whenever a finish rook is legal. The tag exists only while
  // fetch is firing. An arrow is already kept below.
  if (s.tags.includes('fetch')) return false;
  // Grip is tagged before this drop. The minor capture is already kept
  // because it is a capture. The tag exists only while grip is firing.
  if (s.tags.includes('grip')) return false;
  // Blunt is tagged before this drop. The minor shot is already kept
  // because it is an arrow or a capture. The tag exists only while blunt
  // is firing.
  if (s.tags.includes('blunt')) return false;
  if (
    s.tags.includes('mate-net')
    || s.tags.includes('king-hunt')
    || s.tags.includes('king-help')
    || s.tags.includes('finish')
  ) return false;
  if (s.isCapture || s.action.kind === 'arrow' || s.action.kind === 'axe') return false;
  if (s.tags.includes('gives-check')) return false;
  return true;
}

/** A fitted-value gap below this is noise, not a pawn or an exposure step. */
const NET_EPS = 0.05;

interface KingReply {
  /** Fitted value for the side that just moved, after the forced king reply. */
  value: number;
  flights: number;
  inCheck: boolean;
}

/**
 * Adjacent king steps from getValidMoves. Castling is a teleport in that
 * list and applyAction does not move the rook, so it is not an escape square.
 */
function adjacentKingSteps(board: Board, kingPos: Position): Position[] {
  return getValidMoves(board, kingPos, true).filter((dest) => chebyshev(kingPos, dest) === 1);
}

/** Those steps that do not leave the king in check. Covering a square removes it. */
function safeKingSteps(board: Board, kingPos: Position, kingPiece: Piece): Position[] {
  const safe: Position[] = [];
  for (const dest of adjacentKingSteps(board, kingPos)) {
    const after = applyAction(board, 'move', kingPos, dest, kingPiece);
    if (!isInCheck(after, kingPiece.color)) safe.push(dest);
  }
  return safe;
}

/**
 * Enemy king's safe escape squares and the fitted value if the king is forced
 * to move. Quiet replies are not searched. getValidMoves is the only generator.
 * A square the king can step onto only by staying in check is not a flight.
 */
function kingReply(board: Board, color: PlayerColor): KingReply {
  const enemy = enemyOf(color);
  if (findPieces(board, enemy, 'king').length === 0) {
    return { value: FIT_KING_GONE, flights: 0, inCheck: false };
  }
  if (findPieces(board, color, 'king').length === 0) {
    return { value: -FIT_KING_GONE, flights: 0, inCheck: false };
  }
  const kingPos = findPieces(board, enemy, 'king')[0];
  const kingPiece = board[kingPos.row][kingPos.col].piece;
  const flights = kingPiece ? safeKingSteps(board, kingPos, kingPiece) : [];
  const checked = isInCheck(board, enemy);
  const stand = fittedValue(board, color);
  if (!checked || flights.length === 0 || !kingPiece) {
    return { value: stand, flights: flights.length, inCheck: checked };
  }
  let worst = Infinity;
  for (const dest of flights) {
    const after = applyAction(board, 'move', kingPos, dest, kingPiece);
    const v = fittedValue(after, color);
    if (v < worst) worst = v;
  }
  return { value: worst, flights: flights.length, inCheck: true };
}

/**
 * Fitted value if the enemy king steps to the legal square that is best for
 * them. Unlike kingReply, this applies even when the king is not in check, so
 * a bishop aim the king can walk off does not keep its exposure bonus.
 */
function stickyKingValue(board: Board, color: PlayerColor): number {
  const enemy = enemyOf(color);
  const kingPos = findPieces(board, enemy, 'king')[0];
  const kingPiece = kingPos ? board[kingPos.row]?.[kingPos.col]?.piece : null;
  const stand = fittedValue(board, color);
  if (!kingPos || !kingPiece) return stand;
  const flights = safeKingSteps(board, kingPos, kingPiece);
  if (flights.length === 0) return stand;
  let worst = stand;
  for (const dest of flights) {
    const after = applyAction(board, 'move', kingPos, dest, kingPiece);
    const v = fittedValue(after, color);
    if (v < worst) worst = v;
  }
  return worst;
}

function nonKingMaterial(board: Board): number {
  let total = 0;
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const piece = board[row]?.[col]?.piece;
      if (!piece || piece.type === 'king') continue;
      total += PIECE_VALUE[piece.type] ?? 0;
    }
  }
  return total;
}

function nonEscapeReason(s: Scored, g: PolicyGenome, inCheck: boolean): string {
  if (g.reply_safety_enabled === true && (inCheck || s.tags.includes('reply-unsafe'))) return 'reply-unsafe';
  if (g.illegal_filter_enabled === true && !inCheck && s.tags.includes('self-check')) return 'self-check';
  return 'leaves-king-in-check';
}

function tradeQuiet(s: Scored): boolean {
  // `escapesCheck` is true for any move that does not leave the king in check,
  // including when the side was not in check. Only a real escape is exempt.
  if (s.tags.includes('escape') || s.tags.includes('gives-check')) return false;
  if (s.isCapture) return false;
  if (s.action.kind === 'arrow' || s.action.kind === 'axe') return false;
  return true;
}

function capturesQr(s: Scored): boolean {
  return !!(
    s.isCapture
    && s.target
    && (s.target.type === 'queen' || s.target.type === 'rook')
  );
}

/** A safe arrow that is not a queen or rook capture. Shot-waste stays out. */
function isVolleyArrow(s: Scored): boolean {
  if (s.action.kind !== 'arrow') return false;
  if (capturesQr(s)) return false;
  if (s.tags.includes('shot-waste') || s.tags.includes('check-waste')) return false;
  if (
    s.tags.includes('reply-unsafe')
    || s.tags.includes('hang-shield')
    || s.tags.includes('qr-loose')
    || s.tags.includes('self-check')
    || s.tags.includes('king-span')
  ) return false;
  if (hasUnsafeSelfTags(s.tags) || s.isBlindHang) return false;
  return true;
}

/** Safe bishop arrow whose target is a pawn. Same safety as a glean arrow. */
function isSheafArrow(s: Scored): boolean {
  return isVolleyArrow(s) && s.tags.includes('arrow-pawn');
}

/**
 * Safe bishop step that adds at least one pawn to that bishop's arrow rays.
 * A capture is not this: captures stay in the pool on their own. A king step
 * is not this.
 */
function isSheafAim(s: Scored, board: Board): boolean {
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'bishop') return false;
  if (s.isCapture) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  const before = pawnArrowsFrom(board, s.from);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  return pawnArrowsFrom(next, s.to) > before;
}

/** Quiet king step. Escapes, hunts, help-steps, and captures are not this. */
function isQuietKingStep(s: Scored): boolean {
  if (s.action.kind !== 'move' || s.piece?.type !== 'king') return false;
  if (s.isCapture) return false;
  if (s.tags.includes('escape') || s.tags.includes('escape-best')) return false;
  if (s.tags.includes('king-hunt') || s.tags.includes('king-help') || s.tags.includes('mate-net')) return false;
  return true;
}

/** A non-king move keel will keep in place of a king step. Unsafe moves do not count. */
function keelAlternative(s: Scored): boolean {
  if (s.action.kind === 'move' && s.piece?.type === 'king') return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  return true;
}

/**
 * Safe bishop step that adds an arrow onto a pawn, knight, bishop, or king.
 * A capture is not this. A queen or rook on the new ray does not count.
 */
function isKeelRay(s: Scored, board: Board): boolean {
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'bishop') return false;
  if (s.isCapture) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  const before = keelRaysFrom(board, s.from);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  return keelRaysFrom(next, s.to) > before;
}

/**
 * Fitted gain for a move sift may hint. King, queen, and rook steps never
 * qualify, and neither does a capture of a queen or rook. A step that newly
 * leaves a queen or rook en prise does not qualify.
 */
function siftDelta(s: Scored, board: Board, color: PlayerColor): number | null {
  if (!s.piece) return null;
  if (s.piece.type === 'king' || s.piece.type === 'queen' || s.piece.type === 'rook') return null;
  if (capturesQr(s)) return null;
  if (s.action.kind === 'wall' || s.action.kind === 'bomb') return null;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return null;
  const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
  if (powerEnPrise(next, color) && !powerEnPrise(board, color)) return null;
  const before = fittedValue(board, color);
  const after = fittedValue(next, color);
  if (!(after > before)) return null;
  return after - before;
}

/**
 * The one move sift ranks ahead of a quiet shuffle. A bishop ray that raises
 * the fitted value wins over a capture, because the arrow that ray opens is
 * what the losing pairs failed to play. Returns null when a safe non-queen
 * non-rook arrow is already legal: glean owns that position.
 */
function siftChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (pool.some(isVolleyArrow)) return null;
  let bestRay: Scored | null = null;
  let bestRayDelta = 0;
  let bestOther: Scored | null = null;
  let bestOtherDelta = 0;
  for (const s of pool) {
    const delta = siftDelta(s, board, color);
    if (delta === null) continue;
    if (isKeelRay(s, board)) {
      if (delta > bestRayDelta) {
        bestRay = s;
        bestRayDelta = delta;
      }
    } else if (delta > bestOtherDelta) {
      bestOther = s;
      bestOtherDelta = delta;
    }
  }
  return bestRay ?? bestOther;
}

/** Quiet queen or rook step. A check, a capture, and an escape are not this. */
function isQuietQrStep(s: Scored): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'queen' && s.piece.type !== 'rook') return false;
  if (s.isCapture) return false;
  if (s.tags.includes('escape') || s.tags.includes('escape-best')) return false;
  if (s.tags.includes('gives-check') || s.tags.includes('mate-net') || s.tags.includes('finish')) return false;
  if (takesEnemyKing(s)) return false;
  return true;
}

function prodHangsPower(s: Scored, board: Board, color: PlayerColor): boolean {
  if (!s.piece) return true;
  const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
  return powerEnPrise(next, color) && !powerEnPrise(board, color);
}

/** Pawn, knight, or bishop move prod may hint. King, queen, and rook steps never qualify. */
function prodSafe(s: Scored, board: Board, color: PlayerColor): boolean {
  if (!s.piece) return false;
  if (s.piece.type === 'king' || s.piece.type === 'queen' || s.piece.type === 'rook') return false;
  if (capturesQr(s)) return false;
  if (s.action.kind === 'wall' || s.action.kind === 'bomb') return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (s.tags.includes('check-waste') || s.tags.includes('shot-waste')) return false;
  if (prodHangsPower(s, board, color)) return false;
  return true;
}

/** Capture of a pawn, knight, or bishop. A queen or rook capture is not this. */
function isProdCapture(s: Scored): boolean {
  if (!s.isCapture || !s.target) return false;
  return s.target.type === 'pawn' || s.target.type === 'knight' || s.target.type === 'bishop';
}

/**
 * The one move prod ranks ahead of a quiet queen or rook and ahead of a
 * queen or rook capture. A check wins, then a minor or pawn capture, then a
 * knight step into the enemy king's two-square ring. A bishop ray is not a
 * candidate. Returns null when a safe non-queen non-rook arrow is already
 * legal, or when nothing in the pool is the stall or the trade prod exists
 * to outrank.
 */
function prodChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (pool.some(isVolleyArrow)) return null;
  if (!pool.some((s) => isQuietQrStep(s) || capturesQr(s))) return null;
  const ok = pool.filter((s) => prodSafe(s, board, color));
  const byVictim = (a: Scored, b: Scored) =>
    (PIECE_VALUE[b.target?.type ?? 'pawn'] ?? 0) - (PIECE_VALUE[a.target?.type ?? 'pawn'] ?? 0);
  const checks = ok.filter((s) => s.tags.includes('gives-check'));
  if (checks.length > 0) {
    const capturing = checks.filter(isProdCapture);
    const pick = (capturing.length > 0 ? capturing : checks).slice().sort(byVictim);
    return pick[0];
  }
  const caps = ok.filter(isProdCapture);
  if (caps.length > 0) return caps.slice().sort(byVictim)[0];
  const king = findPieces(board, enemyOf(color), 'king')[0];
  if (!king) return null;
  let best: Scored | null = null;
  let bestDist = Infinity;
  for (const s of ok) {
    if (s.action.kind !== 'move' || s.piece?.type !== 'knight' || s.isCapture) continue;
    const before = chebyshev(s.from, king);
    const after = chebyshev(s.to, king);
    if (after <= 2 && after < before && after < bestDist) {
      best = s;
      bestDist = after;
    }
  }
  return best;
}

/**
 * A capture, an arrow, an axe, a check, or a real escape means this is not
 * the quiet stall. Glean, finish, and prod already own those pools. Nock
 * must not reorder them: that is how rounds 19–21 added queen and rook
 * captures.
 */
function nockStall(pool: Scored[]): boolean {
  if (pool.some(isVolleyArrow)) return false;
  for (const s of pool) {
    if (s.isCapture) return false;
    if (s.action.kind === 'arrow' || s.action.kind === 'axe') return false;
    if (s.tags.includes('gives-check')) return false;
    if (s.tags.includes('escape') || s.tags.includes('escape-best')) return false;
  }
  return true;
}

/**
 * Safe bishop step that adds at least one pawn to that bishop's arrow rays
 * and does not add a queen. A capture is not this. A check is not this.
 * A step that newly leaves a queen or rook en prise is not this. Rooks are
 * immune to arrows, so a rook on the new ray does not count as a shot.
 */
function isNockAim(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'bishop') return false;
  if (s.isCapture || s.tags.includes('gives-check')) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  const beforePawn = pawnArrowsFrom(board, s.from);
  const beforeQueen = queenArrowsFrom(board, s.from);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  if (queenArrowsFrom(next, s.to) > beforeQueen) return false;
  return pawnArrowsFrom(next, s.to) > beforePawn;
}

/**
 * The one bishop step nock ranks ahead of a quiet shuffle. Null when the
 * pool is not a pure quiet stall, or when no safe pawn-ray step exists.
 * Nothing is removed. A knight, a king, a queen, and a rook are not tagged.
 */
function nockChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  let best: Scored | null = null;
  let bestGain = 0;
  for (const s of pool) {
    if (!isNockAim(s, board, color)) continue;
    const before = pawnArrowsFrom(board, s.from);
    const next = applyAction(board, s.action.kind, s.from, s.to, s.piece as Piece);
    const gain = pawnArrowsFrom(next, s.to) - before;
    if (gain > bestGain) {
      best = s;
      bestGain = gain;
    }
  }
  return best;
}

/**
 * Quiet pawn step that steps off a friendly bishop's ray. The side's pawn
 * arrows must rise. Queen arrows must not. A capture is not this. A check
 * is not this. A step that newly leaves a queen or rook en prise is not this.
 */
function isFletchAim(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'pawn') return false;
  if (s.isCapture || s.tags.includes('gives-check')) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  const beforePawn = friendlyPawnRays(board, color);
  const beforeQueen = friendlyQueenRays(board, color);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  if (friendlyQueenRays(next, color) > beforeQueen) return false;
  return friendlyPawnRays(next, color) > beforePawn;
}

/**
 * The one pawn step fletch ranks ahead of a quiet shuffle. Null when the
 * pool is not a pure quiet stall, when a nock aim is already legal, or when
 * no safe pawn-clearing step exists. Nothing is removed. A bishop, a knight,
 * a king, a queen, and a rook are not tagged.
 */
function fletchChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  let best: Scored | null = null;
  let bestGain = 0;
  for (const s of pool) {
    if (!isFletchAim(s, board, color)) continue;
    const before = friendlyPawnRays(board, color);
    const next = applyAction(board, s.action.kind, s.from, s.to, s.piece as Piece);
    const gain = friendlyPawnRays(next, color) - before;
    if (gain > bestGain) {
      best = s;
      bestGain = gain;
    }
  }
  return best;
}

/**
 * Quiet queen, rook, or king step the loose-pawn slide may pass. A bishop,
 * a knight, and a pawn stay put: those are flight, nock, and crest. A
 * capture, an arrow, an axe, a check, an escape, a fork, and a flight,
 * nock, or crest tag are not this. The score does not change.
 */
function sighterJumps(s: Scored): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'queen' && s.piece.type !== 'rook' && s.piece.type !== 'king') return false;
  if (s.isCapture) return false;
  if (
    s.tags.includes('gives-check')
    || s.tags.includes('escape')
    || s.tags.includes('escape-best')
    || s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
    || s.tags.includes('fletch')
    || s.tags.includes('fork')
    || s.tags.includes('king-hunt')
    || s.tags.includes('king-help')
    || s.tags.includes('mate-net')
  ) return false;
  return true;
}

/** Undefended enemy pawns this rook or queen already attacks by a move. */
function loosePawnsFrom(board: Board, from: Position, color: PlayerColor): number {
  const piece = board[from.row]?.[from.col]?.piece;
  if (!piece || piece.color !== color) return 0;
  if (piece.type !== 'rook' && piece.type !== 'queen') return 0;
  const enemy = enemyOf(color);
  let n = 0;
  for (const to of getValidMoves(board, from, true)) {
    const occ = board[to.row]?.[to.col]?.piece;
    if (!occ || occ.color === color || occ.type !== 'pawn') continue;
    if (enemyAttackersOf(board, to, enemy, 'pawn').length === 0) n++;
  }
  return n;
}

/**
 * The one quiet rook or queen slide that newly attacks an undefended enemy
 * pawn. Null when the pool is not a pure quiet stall, when nock, flight, or
 * crest already has an aim, or when no safe slide exists. Nothing is
 * removed. A bishop, a knight, a king, and a pawn are not tagged. A
 * one-square step and a diagonal are not tagged. Does not call
 * evaluateComputerPolicy.
 */
function sighterChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) =>
    s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
    || s.tags.includes('fletch')
  )) return null;
  if (nockChoice(pool, board, color)) return null;
  if (flightChoice(pool, board, color)) return null;
  if (crestChoice(pool, board, color)) return null;
  const enemy = enemyOf(color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeExposure = ourKingExposure(board, color);
  let best: Scored | null = null;
  let bestGain = 0;
  let bestRook = false;
  let bestScore = -Infinity;
  for (const s of pool) {
    if (s.action.kind !== 'move' || !s.piece) continue;
    if (s.piece.type !== 'rook' && s.piece.type !== 'queen') continue;
    if (s.isCapture || s.tags.includes('gives-check') || s.tags.includes('fork')) continue;
    if (pressUnsafe(s) || s.tags.includes('qr-force')) continue;
    if (prodHangsPower(s, board, color)) continue;
    const dr = Math.abs(s.from.row - s.to.row);
    const dc = Math.abs(s.from.col - s.to.col);
    if (dr !== 0 && dc !== 0) continue;
    if (Math.max(dr, dc) < 2) continue;
    const before = loosePawnsFrom(board, s.from, color);
    const next = applyAction(board, 'move', s.from, s.to, s.piece);
    if (isInCheck(next, color)) continue;
    if (friendlyQueenRays(next, color) > beforeQueen) continue;
    if (qrAttackCount(next, color) > beforeOurs) continue;
    if (qrAttackCount(next, enemy) > beforeTheirs) continue;
    if (ourKingExposure(next, color) > beforeExposure) continue;
    if (enemyCanArrowPos(next, s.to, enemy)) continue;
    if (enemyCanAxePos(next, s.to, enemy)) continue;
    if (pieceHangsCheaply(next, s.to, color, s.piece.type)) continue;
    const gain = loosePawnsFrom(next, s.to, color) - before;
    if (gain <= 0) continue;
    const rook = s.piece.type === 'rook';
    if (
      gain > bestGain
      || (gain === bestGain && rook && !bestRook)
      || (gain === bestGain && rook === bestRook && s.score > bestScore)
    ) {
      best = s;
      bestGain = gain;
      bestRook = rook;
      bestScore = s.score;
    }
  }
  return best;
}

/**
 * Quiet queen, rook, or king step the new-attack step may pass. A bishop,
 * a knight, and a pawn stay put. A capture, an arrow, an axe, a check, an
 * escape, a fork, and a flight, nock, or crest tag are not this.
 */
function pluckJumps(s: Scored): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'queen' && s.piece.type !== 'rook' && s.piece.type !== 'king') return false;
  if (s.isCapture) return false;
  if (
    s.tags.includes('gives-check')
    || s.tags.includes('escape')
    || s.tags.includes('escape-best')
    || s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
    || s.tags.includes('fletch')
    || s.tags.includes('fork')
    || s.tags.includes('king-hunt')
    || s.tags.includes('king-help')
    || s.tags.includes('mate-net')
  ) return false;
  return true;
}

/** Enemy pieces this pawn, knight, or bishop already attacks by a move, plus a knight axe. Bishop arrows are not counted. */
function pluckAttacksFrom(board: Board, from: Position, color: PlayerColor): number {
  const piece = board[from.row]?.[from.col]?.piece;
  if (!piece || piece.color !== color) return 0;
  if (piece.type !== 'pawn' && piece.type !== 'knight' && piece.type !== 'bishop') return 0;
  const seen = new Set<string>();
  let n = 0;
  const add = (sq: Position) => {
    const key = `${sq.row},${sq.col}`;
    if (seen.has(key)) return;
    seen.add(key);
    const occ = board[sq.row]?.[sq.col]?.piece;
    if (!occ || occ.color === color || occ.type === 'king') return;
    n++;
  };
  for (const sq of getValidMoves(board, from, true)) add(sq);
  if (piece.type === 'knight') {
    for (const sq of getAxeTargets(board, from)) add(sq);
  }
  return n;
}

function pluckMoverRank(type: PieceType): number {
  if (type === 'knight') return 0;
  if (type === 'bishop') return 1;
  if (type === 'pawn') return 2;
  return 9;
}

/**
 * The one quiet pawn, knight, or bishop step that newly attacks an enemy
 * piece. Null when the pool is not a pure quiet stall, when nock, flight,
 * or crest already has an aim, or when no safe step exists. Nothing is
 * removed. A queen, a rook, and a king are not tagged. A capture is not
 * tagged. A bishop arrow is not the attack. Does not call
 * evaluateComputerPolicy.
 */
function pluckChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) =>
    s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
    || s.tags.includes('fletch')
  )) return null;
  if (nockChoice(pool, board, color)) return null;
  if (flightChoice(pool, board, color)) return null;
  if (crestChoice(pool, board, color)) return null;
  const enemy = enemyOf(color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeExposure = ourKingExposure(board, color);
  const beforePawn = friendlyPawnRays(board, color);
  const beforeNock = nockAimCount(board, color);
  let best: Scored | null = null;
  let bestGain = 0;
  let bestRank = 9;
  let bestScore = -Infinity;
  for (const s of pool) {
    if (s.action.kind !== 'move' || !s.piece) continue;
    if (s.piece.type !== 'pawn' && s.piece.type !== 'knight' && s.piece.type !== 'bishop') continue;
    if (s.isCapture || s.tags.includes('gives-check') || s.tags.includes('fork')) continue;
    if (pressUnsafe(s) || s.tags.includes('qr-force')) continue;
    if (prodHangsPower(s, board, color)) continue;
    if (isNockAim(s, board, color)) continue;
    if (flightGain(s, board, color, beforePawn, beforeNock)) continue;
    const before = pluckAttacksFrom(board, s.from, color);
    const next = applyAction(board, 'move', s.from, s.to, s.piece);
    if (isInCheck(next, color)) continue;
    if (friendlyQueenRays(next, color) > beforeQueen) continue;
    if (qrAttackCount(next, color) > beforeOurs) continue;
    if (qrAttackCount(next, enemy) > beforeTheirs) continue;
    if (ourKingExposure(next, color) > beforeExposure) continue;
    if (enemyCanArrowPos(next, s.to, enemy)) continue;
    if (enemyCanAxePos(next, s.to, enemy)) continue;
    if (pieceHangsCheaply(next, s.to, color, s.piece.type)) continue;
    const gain = pluckAttacksFrom(next, s.to, color) - before;
    if (gain <= 0) continue;
    const rank = pluckMoverRank(s.piece.type);
    if (
      gain > bestGain
      || (gain === bestGain && rank < bestRank)
      || (gain === bestGain && rank === bestRank && s.score > bestScore)
    ) {
      best = s;
      bestGain = gain;
      bestRank = rank;
      bestScore = s.score;
    }
  }
  return best;
}

/**
 * A sure reply to check. A pawn capture is dice, so it is not sure.
 * Zero means the check is mate. A king with no adjacent step is not
 * enough: rounds 47 and 48 answered those checks with a pawn or a
 * bishop, and the king walked only after that screen was shot away.
 */
function enemyHasSureReply(board: Board, color: PlayerColor): boolean {
  const enemy = enemyOf(color);
  if (findPieces(board, enemy, 'king').length === 0) return false;
  if (!isInCheck(board, enemy)) return true;
  const scan = (from: Position, to: Position, kind: ActionKind, piece: Piece): boolean => {
    if (kind === 'move' && piece.type === 'pawn') {
      const occ = board[to.row]?.[to.col]?.piece;
      if (occ && occ.color !== piece.color) return false;
    }
    const after = applyAction(board, kind, from, to, piece);
    return !isInCheck(after, enemy);
  };
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const piece = board[row][col].piece;
      if (!piece || piece.color !== enemy) continue;
      const from = { row, col };
      for (const to of getValidMoves(board, from, true)) {
        if (scan(from, to, 'move', piece)) return true;
      }
      if (piece.type === 'bishop') {
        for (const to of getArrowTargets(board, from)) {
          if (scan(from, to, 'arrow', piece)) return true;
        }
      }
      if (piece.type === 'knight') {
        for (const to of getAxeTargets(board, from)) {
          if (scan(from, to, 'axe', piece)) return true;
        }
      }
    }
  }
  return false;
}

/** Check, and the enemy has no sure reply. A king capture is separate. */
function fetchMate(s: Scored, board: Board, color: PlayerColor): boolean {
  if (!s.tags.includes('gives-check') || !s.piece || s.piece.type === 'king') return false;
  if (s.target?.type === 'king') return true;
  const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
  return !enemyHasSureReply(next, color);
}

/**
 * A check that is not the end of the game. A king capture is not this.
 * A check with no sure reply is not this. A check the king cannot step
 * out of, while a pawn or a bishop still can, is this: that is the
 * g-file arrow that preceded the king walks.
 */
function fetchLoose(s: Scored, board: Board, color: PlayerColor): boolean {
  if (!s.tags.includes('gives-check')) return false;
  if (takesEnemyKing(s)) return false;
  if (fetchMate(s, board, color)) return false;
  if (s.tags.includes('flight') || s.tags.includes('nock') || s.tags.includes('crest')) return false;
  return true;
}

/** Safe arrow that does not check and does not take a king, queen, or rook. */
function fetchArrow(s: Scored): boolean {
  if (!isVolleyArrow(s)) return false;
  if (s.tags.includes('gives-check')) return false;
  if (takesEnemyKing(s)) return false;
  if (s.target?.type === 'king') return false;
  return true;
}

function fetchMoverRank(type: PieceType): number {
  if (type === 'knight') return 0;
  if (type === 'bishop') return 1;
  if (type === 'pawn') return 2;
  return 9;
}

/**
 * Capture of a pawn, knight, or bishop by a pawn, knight, or bishop.
 * Not a check. Not a queen or rook on either side of the capture. An axe
 * counts: the knight stays where it is. A landing the enemy can arrow or
 * axe, a cheap hang, a self-check, a new queen ray, a new attack on a
 * queen or rook, and a rise in our king exposure are refused.
 */
function fetchCapture(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' && s.action.kind !== 'axe') return false;
  if (!s.isCapture || !s.piece || !s.target) return false;
  if (s.piece.type !== 'pawn' && s.piece.type !== 'knight' && s.piece.type !== 'bishop') return false;
  if (s.target.type !== 'pawn' && s.target.type !== 'knight' && s.target.type !== 'bishop') return false;
  if (s.tags.includes('gives-check') || s.tags.includes('fork')) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  const enemy = enemyOf(color);
  const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
  if (isInCheck(next, color)) return false;
  if (friendlyQueenRays(next, color) > friendlyQueenRays(board, color)) return false;
  if (qrAttackCount(next, color) > qrAttackCount(board, color)) return false;
  if (qrAttackCount(next, enemy) > qrAttackCount(board, enemy)) return false;
  if (ourKingExposure(next, color) > ourKingExposure(board, color)) return false;
  if (s.action.kind === 'move') {
    if (enemyCanArrowPos(next, s.to, enemy)) return false;
    if (enemyCanAxePos(next, s.to, enemy)) return false;
    if (pieceHangsCheaply(next, s.to, color, s.piece.type)) return false;
  }
  return true;
}

/**
 * The one safe non-checking arrow, or else the one safe minor capture,
 * on a ply that already has a loose check. Null when flight, nock, or
 * crest already tagged, when a king capture or a true mate is legal,
 * or when no safe alternative exists. A check the king cannot step out
 * of is still loose when a piece can answer it. Nothing is removed.
 * The loose checks are marked fetch-skip so they sort last and a glean
 * fallback cannot put them back first. Does not call evaluateComputerPolicy.
 */
function fetchChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (pool.some((s) =>
    s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
  )) return null;
  if (pool.some((s) => takesEnemyKing(s) || fetchMate(s, board, color))) return null;
  const loose = pool.filter((s) => fetchLoose(s, board, color));
  if (loose.length === 0) return null;
  let best: Scored | null = null;
  let bestScore = -Infinity;
  for (const s of pool) {
    if (!fetchArrow(s)) continue;
    if (s.score > bestScore) {
      best = s;
      bestScore = s.score;
    }
  }
  if (!best) {
    let bestRank = 9;
    for (const s of pool) {
      if (!fetchCapture(s, board, color) || !s.piece) continue;
      const rank = fetchMoverRank(s.piece.type);
      if (rank < bestRank || (rank === bestRank && s.score > bestScore)) {
        best = s;
        bestRank = rank;
        bestScore = s.score;
      }
    }
  }
  if (!best) return null;
  for (const s of loose) {
    if (s !== best && !s.tags.includes('fetch-skip')) s.tags.push('fetch-skip');
  }
  return best;
}

/**
 * Loose check, or a quiet queen, rook, or king step, that the alternative
 * may pass. A non-checking arrow stays. A capture stays. A king capture
 * stays. Flight, nock, and crest stay. A true mate is not in this pool:
 * fetchChoice returned null when one was legal.
 */
function fetchJumps(s: Scored): boolean {
  if (s.tags.includes('flight') || s.tags.includes('nock') || s.tags.includes('crest')) return false;
  if (takesEnemyKing(s)) return false;
  if (s.tags.includes('gives-check') || s.tags.includes('fetch-skip')) return true;
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'queen' && s.piece.type !== 'rook' && s.piece.type !== 'king') return false;
  if (s.isCapture) return false;
  if (
    s.tags.includes('escape')
    || s.tags.includes('escape-best')
    || s.tags.includes('fork')
    || s.tags.includes('king-hunt')
    || s.tags.includes('king-help')
    || s.tags.includes('mate-net')
  ) return false;
  return true;
}

function minorVictim(s: Scored): boolean {
  const kind = s.target?.type;
  return kind === 'pawn' || kind === 'knight' || kind === 'bishop';
}

/**
 * The capture hung_qr counts, or the checking pawn arrow grip stood down
 * on. A king capture is not this. A true mate is not this. An escape is
 * not this. A quiet move is not this.
 */
function bluntBad(s: Scored, board: Board, color: PlayerColor): boolean {
  if (takesEnemyKing(s)) return false;
  if (fetchMate(s, board, color)) return false;
  if (s.tags.includes('escape') || s.tags.includes('escape-best')) return false;
  if (s.tags.includes('flight') || s.tags.includes('nock') || s.tags.includes('crest')) return false;
  if (capturesQr(s)) return true;
  if (s.action.kind !== 'arrow') return false;
  if (!s.tags.includes('gives-check') && !s.tags.includes('arrow-checks-king')) return false;
  return s.tags.includes('arrow-pawn') || s.target?.type === 'pawn';
}

/**
 * An already-legal arrow or capture of a pawn, knight, or bishop. Not a
 * check, so a g-file check is not replaced with another check. Not a
 * queen, rook, or king. An arrow counts: that is the move that was legal
 * when grip required a non-arrow capture and returned null. A landing
 * that raises queen or rook attacks, or our king exposure, is refused.
 * Does not call fetchCapture.
 */
function bluntAlt(s: Scored, board: Board, color: PlayerColor): boolean {
  if (takesEnemyKing(s) || capturesQr(s)) return false;
  if (s.tags.includes('gives-check') || s.tags.includes('arrow-checks-king')) return false;
  if (s.tags.includes('flight') || s.tags.includes('nock') || s.tags.includes('crest')) return false;
  const arrow = s.action.kind === 'arrow';
  const capture = (s.action.kind === 'move' || s.action.kind === 'axe') && s.isCapture;
  if (!arrow && !capture) return false;
  if (!minorVictim(s) || !s.piece) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  const enemy = enemyOf(color);
  const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
  if (isInCheck(next, color)) return false;
  if (qrAttackCount(next, color) > qrAttackCount(board, color)) return false;
  if (qrAttackCount(next, enemy) > qrAttackCount(board, enemy)) return false;
  if (ourKingExposure(next, color) > ourKingExposure(board, color)) return false;
  if (s.action.kind === 'move') {
    if (enemyCanArrowPos(next, s.to, enemy)) return false;
    if (enemyCanAxePos(next, s.to, enemy)) return false;
  }
  return true;
}

/**
 * One safe minor shot on a ply that already captures a queen or rook, or
 * that already has a checking pawn arrow. Null when flight, nock, or crest
 * already tagged, when a king capture or a true mate is legal, or when no
 * safe minor tactic exists. Null is the point: a quiet substitute is not
 * this layer, and neither is a second check. Nothing is removed. The bad
 * tactics are marked blunt-skip so they sort last. Does not call gripChoice
 * or fetchChoice.
 */
function bluntChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (pool.some((s) =>
    s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
  )) return null;
  if (pool.some((s) => takesEnemyKing(s) || fetchMate(s, board, color))) return null;
  const bad = pool.filter((s) => bluntBad(s, board, color));
  if (bad.length === 0) return null;
  let best: Scored | null = null;
  let bestArrow = false;
  let bestScore = -Infinity;
  for (const s of pool) {
    if (!bluntAlt(s, board, color)) continue;
    const arrow = s.action.kind === 'arrow';
    if (!best || (arrow && !bestArrow) || (arrow === bestArrow && s.score > bestScore)) {
      best = s;
      bestArrow = arrow;
      bestScore = s.score;
    }
  }
  if (!best) return null;
  for (const s of bad) {
    if (s !== best && !s.tags.includes('blunt-skip')) s.tags.push('blunt-skip');
  }
  return best;
}

/**
 * The bad tactic, or a quiet non-capture, that the minor shot may pass.
 * Another capture stays. A non-checking arrow stays. A king capture stays.
 * Flight, nock, and crest stay. A check that is not the bad tactic stays.
 */
function bluntJumps(s: Scored): boolean {
  if (s.tags.includes('flight') || s.tags.includes('nock') || s.tags.includes('crest')) return false;
  if (takesEnemyKing(s)) return false;
  if (s.tags.includes('blunt-skip')) return true;
  if (s.isCapture) return false;
  if (s.action.kind === 'arrow' || s.action.kind === 'axe') return false;
  if (
    s.tags.includes('gives-check')
    || s.tags.includes('escape')
    || s.tags.includes('escape-best')
    || s.tags.includes('fork')
    || s.tags.includes('king-hunt')
    || s.tags.includes('king-help')
    || s.tags.includes('mate-net')
  ) return false;
  return true;
}

/**
 * The arrow fetch would have replaced, and the arrow fetch never blocked.
 * A checking pawn arrow is the g-file shot ahead of the king walks. An
 * arrow that takes a queen or a rook is a hung_qr event even when it does
 * not check. A king capture is not this. A true mate is not this. A
 * non-checking pawn arrow is not this: ranking a different arrow there is
 * what lengthened round 49.
 */
function gripThreat(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'arrow') return false;
  if (takesEnemyKing(s)) return false;
  if (fetchMate(s, board, color)) return false;
  if (s.tags.includes('flight') || s.tags.includes('nock') || s.tags.includes('crest')) return false;
  if (capturesQr(s)) return true;
  if (!s.tags.includes('gives-check')) return false;
  return s.tags.includes('arrow-pawn') || s.target?.type === 'pawn';
}

/**
 * One safe non-arrow capture on a ply that already has a checking pawn
 * arrow or a queen/rook arrow. Null when flight, nock, or crest already
 * tagged, when a king capture or a true mate is legal, or when no safe
 * minor capture exists. Null is the point: fetch would then play another
 * arrow, and that arrow is the length. Nothing is removed. The bad arrows
 * are marked grip-skip so they sort last. Does not call fetchChoice.
 */
function gripChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (pool.some((s) =>
    s.tags.includes('flight')
    || s.tags.includes('nock')
    || s.tags.includes('crest')
  )) return null;
  if (pool.some((s) => takesEnemyKing(s) || fetchMate(s, board, color))) return null;
  const threats = pool.filter((s) => gripThreat(s, board, color));
  if (threats.length === 0) return null;
  let best: Scored | null = null;
  let bestRank = 9;
  let bestScore = -Infinity;
  for (const s of pool) {
    if (!fetchCapture(s, board, color) || !s.piece) continue;
    const rank = fetchMoverRank(s.piece.type);
    if (rank < bestRank || (rank === bestRank && s.score > bestScore)) {
      best = s;
      bestRank = rank;
      bestScore = s.score;
    }
  }
  if (!best) return null;
  for (const s of threats) {
    if (s !== best && !s.tags.includes('grip-skip')) s.tags.push('grip-skip');
  }
  return best;
}

/**
 * The bad arrow, or a quiet king step, that the minor capture may pass.
 * A non-checking arrow stays. A capture stays. A king capture stays.
 * Flight, nock, and crest stay. Does not pass every check: a queen check
 * is fetch's trigger, and fetch is off.
 */
function gripJumps(s: Scored): boolean {
  if (s.tags.includes('flight') || s.tags.includes('nock') || s.tags.includes('crest')) return false;
  if (takesEnemyKing(s)) return false;
  if (s.tags.includes('grip-skip')) return true;
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'king') return false;
  if (s.isCapture) return false;
  if (
    s.tags.includes('escape')
    || s.tags.includes('escape-best')
    || s.tags.includes('fork')
    || s.tags.includes('king-hunt')
    || s.tags.includes('king-help')
    || s.tags.includes('mate-net')
    || s.tags.includes('gives-check')
  ) return false;
  return true;
}

/**
 * Safe bishop step that puts the enemy king behind exactly one friendly
 * pawn, knight, or bishop. A capture is not this. A check is not this: a
 * clear king ray is already bishop-aims-king. A queen behind that screen,
 * or a new clear queen arrow, is not this. A step the enemy can arrow, a
 * step that newly leaves a queen or rook en prise, and a step that raises
 * our king exposure are not this. An enemy pawn on the new ray is nock's
 * aim, and pileChoice defers when any nock aim is legal.
 */
function isPileAim(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'bishop') return false;
  if (s.isCapture || s.tags.includes('gives-check')) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  if (
    s.tags.includes('walks-into-snipe')
    || s.tags.includes('hangs-self')
    || s.tags.includes('bishop-snipe-hangs')
  ) return false;
  const before = screenedRoyaltyFrom(board, s.from);
  const beforeQueen = queenArrowsFrom(board, s.from);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  const after = screenedRoyaltyFrom(next, s.to);
  if (after.queen > before.queen) return false;
  if (queenArrowsFrom(next, s.to) > beforeQueen) return false;
  if (ourKingExposure(next, color) > ourKingExposure(board, color)) return false;
  if (enemyCanArrowPos(next, s.to, enemyOf(color))) return false;
  return after.king > before.king;
}

/**
 * The one bishop step pile ranks ahead of a quiet shuffle. Null when the
 * pool is not a pure quiet stall, when a nock aim is already legal, or when
 * no safe screened king ray exists. Nothing is removed. A pawn, a knight,
 * a king, a queen, and a rook are not tagged.
 */
function pileChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  let best: Scored | null = null;
  let bestKing = 0;
  for (const s of pool) {
    if (!isPileAim(s, board, color)) continue;
    const before = screenedRoyaltyFrom(board, s.from);
    const next = applyAction(board, s.action.kind, s.from, s.to, s.piece as Piece);
    const gain = screenedRoyaltyFrom(next, s.to).king - before.king;
    if (gain > bestKing) {
      best = s;
      bestKing = gain;
    }
  }
  return best;
}

/**
 * Safe bishop step that opens a longer firing lane, or that leaves the back
 * rank toward the center without losing a lane. A capture is not this. A
 * check is not this. A new queen arrow is not this. A step the enemy can
 * already arrow, a step that newly hangs a queen or rook, and a step that
 * raises our king exposure are not this. A pawn on the new ray is nock's
 * aim, and haftChoice defers when any nock aim is legal.
 */
function isHaftAim(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'bishop') return false;
  if (s.isCapture || s.tags.includes('gives-check')) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  if (
    s.tags.includes('walks-into-snipe')
    || s.tags.includes('hangs-self')
    || s.tags.includes('bishop-snipe-hangs')
  ) return false;
  const beforeQueen = queenArrowsFrom(board, s.from);
  const beforeLanes = countBishopFiringLanes(board, s.from, color);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  if (queenArrowsFrom(next, s.to) > beforeQueen) return false;
  if (ourKingExposure(next, color) > ourKingExposure(board, color)) return false;
  if (enemyCanArrowPos(next, s.to, enemyOf(color))) return false;
  const laneGain = countBishopFiringLanes(next, s.to, color) - beforeLanes;
  if (laneGain > 0) return true;
  if (laneGain < 0) return false;
  if (!isBackRank(s.from, color) || isBackRank(s.to, color)) return false;
  return chebyshev(s.to, CENTER) < chebyshev(s.from, CENTER);
}

/**
 * The one bishop step haft ranks ahead of a quiet shuffle. Null when the
 * pool is not a pure quiet stall, when a nock aim is already legal, or when
 * no safe lane-opening step exists. Nothing is removed. A pawn, a knight,
 * a king, a queen, and a rook are not tagged.
 */
function haftChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  let best: Scored | null = null;
  let bestLanes = -1;
  let bestCenter = Infinity;
  for (const s of pool) {
    if (!isHaftAim(s, board, color)) continue;
    const before = countBishopFiringLanes(board, s.from, color);
    const next = applyAction(board, s.action.kind, s.from, s.to, s.piece as Piece);
    const gain = countBishopFiringLanes(next, s.to, color) - before;
    const center = chebyshev(s.to, CENTER);
    if (gain > bestLanes || (gain === bestLanes && center < bestCenter)) {
      best = s;
      bestLanes = gain;
      bestCenter = center;
    }
  }
  return best;
}

function hasHintTag(s: Scored): boolean {
  return s.tags.some((t) => HINT_TAGS.has(t));
}

/**
 * The highest-scoring quiet move, when the model would not otherwise see it
 * first. Null when the pool is not a pure quiet stall, when a nock aim is
 * already legal, when that move is already a hint, or when it is a king
 * step. A step that newly hangs a queen or rook, or that raises our king
 * exposure, is not tagged. Nothing is removed.
 */
function quarrelChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  let best: Scored | null = null;
  for (const s of pool) {
    if (!best || s.score > best.score) best = s;
  }
  if (!best || best.action.kind !== 'move' || !best.piece) return null;
  if (best.piece.type === 'king') return null;
  if (hasHintTag(best)) return null;
  if (pressUnsafe(best) || best.tags.includes('qr-force')) return null;
  if (prodHangsPower(best, board, color)) return null;
  if (
    best.tags.includes('walks-into-snipe')
    || best.tags.includes('hangs-self')
    || best.tags.includes('bishop-snipe-hangs')
  ) return null;
  const next = applyAction(board, 'move', best.from, best.to, best.piece);
  if (ourKingExposure(next, color) > ourKingExposure(board, color)) return null;
  return best;
}

/**
 * Knight or bishop step that gets closer to the enemy king. A capture is
 * not this. A check is not this. A king, a queen, a rook, and a pawn are
 * not this. A step that newly hangs a queen or rook, raises our king
 * exposure, or lands on an enemy arrow or axe is not this.
 */
function isBodkinAim(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'knight' && s.piece.type !== 'bishop') return false;
  if (s.isCapture || s.tags.includes('gives-check')) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  if (
    s.tags.includes('walks-into-snipe')
    || s.tags.includes('hangs-self')
    || s.tags.includes('bishop-snipe-hangs')
  ) return false;
  const king = findPieces(board, enemyOf(color), 'king')[0];
  if (!king) return false;
  if (!(chebyshev(s.to, king) < chebyshev(s.from, king))) return false;
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  if (ourKingExposure(next, color) > ourKingExposure(board, color)) return false;
  const enemy = enemyOf(color);
  if (enemyCanArrowPos(next, s.to, enemy)) return false;
  if (enemyCanAxePos(next, s.to, enemy)) return false;
  return true;
}

/**
 * The one knight or bishop step bodkin ranks ahead of a quiet queen or
 * rook. Null when the pool is not a pure quiet stall, when a nock aim is
 * already legal, or when no safe closer step exists. Nothing is removed.
 * A king, a queen, a rook, and a pawn are not tagged.
 */
function bodkinChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  const king = findPieces(board, enemyOf(color), 'king')[0];
  if (!king) return null;
  let best: Scored | null = null;
  let bestGain = 0;
  let bestScore = -Infinity;
  for (const s of pool) {
    if (!isBodkinAim(s, board, color)) continue;
    const gain = chebyshev(s.from, king) - chebyshev(s.to, king);
    if (gain > bestGain || (gain === bestGain && s.score > bestScore)) {
      best = s;
      bestGain = gain;
      bestScore = s.score;
    }
  }
  return best;
}

/** Chebyshev distance from a square to the nearest enemy pawn. Infinity if none. */
function nearestEnemyPawnDistance(board: Board, pos: Position, color: PlayerColor): number {
  let best = Infinity;
  for (const pawn of findPieces(board, enemyOf(color), 'pawn')) {
    const d = chebyshev(pos, pawn);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Bishop step that gets closer to the nearest enemy pawn and does not open
 * a pawn ray or a queen ray. A capture is not this. A check is not this.
 * A king, a queen, a rook, a knight, and a pawn are not this. A step that
 * newly hangs a queen or rook, raises our king exposure, or lands on an
 * enemy arrow or axe is not this. A nock aim is not this.
 */
function isCrestAim(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'bishop') return false;
  if (s.isCapture || s.tags.includes('gives-check')) return false;
  if (s.tags.includes('fork')) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  if (
    s.tags.includes('walks-into-snipe')
    || s.tags.includes('hangs-self')
    || s.tags.includes('bishop-snipe-hangs')
  ) return false;
  if (isNockAim(s, board, color)) return false;
  const beforeQueen = friendlyQueenRays(board, color);
  const beforePawn = friendlyPawnRays(board, color);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  if (friendlyQueenRays(next, color) > beforeQueen) return false;
  if (friendlyPawnRays(next, color) > beforePawn) return false;
  if (ourKingExposure(next, color) > ourKingExposure(board, color)) return false;
  const enemy = enemyOf(color);
  if (enemyCanArrowPos(next, s.to, enemy)) return false;
  if (enemyCanAxePos(next, s.to, enemy)) return false;
  const before = nearestEnemyPawnDistance(board, s.from, color);
  const after = nearestEnemyPawnDistance(next, s.to, color);
  if (!Number.isFinite(before) || !(after < before)) return false;
  return true;
}

/**
 * The one bishop step crest ranks ahead of a quiet shuffle. Null when the
 * pool is not a pure quiet stall, when a nock aim is already legal, or when
 * no safe closer-to-pawn step exists. Nothing is removed. A knight fork is
 * not the tagged move. A king, a queen, a rook, a knight, and a pawn are
 * not tagged.
 */
function crestChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  let best: Scored | null = null;
  let bestGain = 0;
  let bestScore = -Infinity;
  for (const s of pool) {
    if (!isCrestAim(s, board, color)) continue;
    const gain = nearestEnemyPawnDistance(board, s.from, color) - nearestEnemyPawnDistance(board, s.to, color);
    if (gain > bestGain || (gain === bestGain && s.score > bestScore)) {
      best = s;
      bestGain = gain;
      bestScore = s.score;
    }
  }
  return best;
}

/** Legal steps our bishops can take. Captures count. A blocked bishop adds nothing. */
function bishopStepCount(board: Board, color: PlayerColor): number {
  let n = 0;
  for (const from of findPieces(board, color, 'bishop')) {
    n += getValidMoves(board, from).length;
  }
  return n;
}

/** Adjacent friendly pieces around our king. 0 when the king is already gone. */
function kingShelter(board: Board, color: PlayerColor): number {
  const king = findPieces(board, color, 'king')[0];
  if (!king) return 0;
  return countAdjacentFriendly(board, king, color);
}

/**
 * Quiet pawn step that strictly increases our bishops' legal steps and does
 * not open a pawn ray or a queen ray. A capture is not this. A check is not
 * this. A fork is not this. A king, a knight, a bishop, a queen, and a rook
 * are not this. A step that newly hangs a queen or rook, raises our king
 * exposure, or lands on an enemy arrow or axe is not this. A fletch aim is
 * not this.
 */
function isBraceAim(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'pawn') return false;
  if (s.isCapture || s.tags.includes('gives-check') || s.tags.includes('fork')) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  if (
    s.tags.includes('walks-into-snipe')
    || s.tags.includes('hangs-self')
    || s.tags.includes('bishop-snipe-hangs')
  ) return false;
  if (isFletchAim(s, board, color)) return false;
  const beforePawn = friendlyPawnRays(board, color);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeSteps = bishopStepCount(board, color);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  if (friendlyPawnRays(next, color) > beforePawn) return false;
  if (friendlyQueenRays(next, color) > beforeQueen) return false;
  if (ourKingExposure(next, color) > ourKingExposure(board, color)) return false;
  const enemy = enemyOf(color);
  if (enemyCanArrowPos(next, s.to, enemy)) return false;
  if (enemyCanAxePos(next, s.to, enemy)) return false;
  return bishopStepCount(next, color) > beforeSteps;
}

/**
 * The one pawn step brace ranks ahead of a quiet shuffle. Null when the
 * pool is not a pure quiet stall, when a nock aim or a crest aim is already
 * legal, or when no safe bishop-unblock exists. Before ply 30, a step that
 * pulls a pawn off the king's shield loses to one that keeps the shield.
 * Nothing is removed. A king, a knight, a bishop, a queen, and a rook are
 * not tagged. The layer still runs after ply 30.
 */
function braceChoice(pool: Scored[], board: Board, color: PlayerColor, history: Move[]): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  if (pool.some((s) => isCrestAim(s, board, color))) return null;
  const early = history.length + 1 < 30;
  const shelterNow = kingShelter(board, color);
  let aims: { s: Scored; gain: number; shelter: number }[] = [];
  for (const s of pool) {
    if (!isBraceAim(s, board, color) || !s.piece) continue;
    const before = bishopStepCount(board, color);
    const next = applyAction(board, 'move', s.from, s.to, s.piece);
    const gain = bishopStepCount(next, color) - before;
    if (gain <= 0) continue;
    aims.push({ s, gain, shelter: kingShelter(next, color) });
  }
  if (aims.length === 0) return null;
  if (early) {
    const keep = aims.filter((a) => a.shelter >= shelterNow);
    if (keep.length > 0) aims = keep;
  }
  let best = aims[0];
  for (const a of aims.slice(1)) {
    if (a.gain > best.gain || (a.gain === best.gain && a.s.score > best.s.score)) best = a;
  }
  return best.s;
}

/** Enemy pawns our knights can currently capture. An axe is not this. */
function knightPawnAttacks(board: Board, color: PlayerColor): number {
  const enemy = enemyOf(color);
  let n = 0;
  for (const from of findPieces(board, color, 'knight')) {
    for (const to of getValidMoves(board, from, true)) {
      const occ = board[to.row]?.[to.col]?.piece;
      if (occ && occ.color === enemy && occ.type === 'pawn') n++;
    }
  }
  return n;
}

/**
 * Attacks on this side's queens and rooks. Rooks are immune to arrows and
 * axes, so only a real move attack counts for them. Both sides use this:
 * a rise on our pieces is a hang, and a rise on theirs is a capture the
 * hung-queen gate still counts.
 */
function qrAttackCount(board: Board, color: PlayerColor): number {
  const enemy = enemyOf(color);
  let n = 0;
  for (const type of ['queen', 'rook'] as const) {
    for (const pos of findPieces(board, color, type)) {
      n += enemyAttackersOf(board, pos, enemy, type).length;
    }
  }
  return n;
}

/**
 * Knight step that gets closer to the nearest enemy pawn and does not add
 * an attack on any queen or rook. A capture is not this. A check is not
 * this. A fork is not this. A king, a bishop, a pawn, a queen, and a rook
 * are not this. A step that opens a pawn ray or a queen ray is not this.
 * A step that raises our king exposure, pulls the king's shield, or lands
 * on an enemy arrow or axe is not this.
 */
function isMarkAim(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece || s.piece.type !== 'knight') return false;
  if (s.isCapture || s.tags.includes('gives-check') || s.tags.includes('fork')) return false;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  if (prodHangsPower(s, board, color)) return false;
  if (
    s.tags.includes('walks-into-snipe')
    || s.tags.includes('hangs-self')
    || s.tags.includes('bishop-snipe-hangs')
  ) return false;
  const beforeDist = nearestEnemyPawnDistance(board, s.from, color);
  const beforeOurs = qrAttackCount(board, color);
  const enemy = enemyOf(color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforePawn = friendlyPawnRays(board, color);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeExposure = ourKingExposure(board, color);
  const beforeShelter = kingShelter(board, color);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  if (qrAttackCount(next, color) > beforeOurs) return false;
  if (qrAttackCount(next, enemy) > beforeTheirs) return false;
  if (friendlyPawnRays(next, color) > beforePawn) return false;
  if (friendlyQueenRays(next, color) > beforeQueen) return false;
  if (ourKingExposure(next, color) > beforeExposure) return false;
  if (kingShelter(next, color) < beforeShelter) return false;
  if (enemyCanArrowPos(next, s.to, enemy)) return false;
  if (enemyCanAxePos(next, s.to, enemy)) return false;
  const afterDist = nearestEnemyPawnDistance(next, s.to, color);
  if (!Number.isFinite(beforeDist) || !(afterDist < beforeDist)) return false;
  return true;
}

/**
 * The one knight step mark ranks ahead of a quiet shuffle. Null when the
 * pool is not a pure quiet stall, when a nock aim, a crest aim, or a brace
 * aim is already legal, or when no safe closer step exists. Nothing is
 * removed. A king, a bishop, a pawn, a queen, and a rook are not tagged.
 */
function markChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  if (pool.some((s) => isCrestAim(s, board, color))) return null;
  if (pool.some((s) => isBraceAim(s, board, color))) return null;
  let best: Scored | null = null;
  let bestGain = 0;
  let bestAttacks = -Infinity;
  let bestScore = -Infinity;
  for (const s of pool) {
    if (!isMarkAim(s, board, color) || !s.piece) continue;
    const beforeDist = nearestEnemyPawnDistance(board, s.from, color);
    const beforeAttacks = knightPawnAttacks(board, color);
    const next = applyAction(board, 'move', s.from, s.to, s.piece);
    const gain = beforeDist - nearestEnemyPawnDistance(next, s.to, color);
    if (gain <= 0) continue;
    const attacks = knightPawnAttacks(next, color) - beforeAttacks;
    if (
      gain > bestGain
      || (gain === bestGain && (attacks > bestAttacks || (attacks === bestAttacks && s.score > bestScore)))
    ) {
      best = s;
      bestGain = gain;
      bestAttacks = attacks;
      bestScore = s.score;
    }
  }
  return best;
}

/**
 * Quiet bishop steps that would add a pawn to that bishop's arrows and
 * would not add a queen. A capture is not counted. A step that checks is
 * not counted. This is the geometry nock would tag, with or without the
 * nock flag.
 */
function nockAimCount(board: Board, color: PlayerColor): number {
  const enemy = enemyOf(color);
  let n = 0;
  for (const from of findPieces(board, color, 'bishop')) {
    const piece = board[from.row]?.[from.col]?.piece;
    if (!piece) continue;
    const beforePawn = pawnArrowsFrom(board, from);
    const beforeQueen = queenArrowsFrom(board, from);
    for (const to of getValidMoves(board, from, true)) {
      if (board[to.row]?.[to.col]?.piece) continue;
      const next = applyAction(board, 'move', from, to, piece);
      if (queenArrowsFrom(next, to) > beforeQueen) continue;
      if (pawnArrowsFrom(next, to) <= beforePawn) continue;
      if (isInCheck(next, enemy)) continue;
      n++;
    }
  }
  return n;
}

/**
 * Pawn or knight step that sets up a bishop pawn-shot. A pawn counts only
 * when it creates a new nock aim and does not itself raise the pawn-arrow
 * count. A knight counts when the pawn-arrow count rises or a nock aim
 * appears. A capture is not this. A check is not this. A fork is not this.
 * A king, a bishop, a queen, and a rook are not this. A step that adds an
 * attack on any queen or rook, opens a queen ray, raises our king exposure,
 * drops the king's shelter, or lands on an enemy arrow or axe is not this.
 */
function flightGain(
  s: Scored,
  board: Board,
  color: PlayerColor,
  beforePawn: number,
  beforeNock: number,
): { rays: number; nocks: number } | null {
  if (s.action.kind !== 'move' || !s.piece) return null;
  if (s.piece.type !== 'pawn' && s.piece.type !== 'knight') return null;
  if (s.isCapture || s.tags.includes('gives-check') || s.tags.includes('fork')) return null;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return null;
  if (prodHangsPower(s, board, color)) return null;
  if (
    s.tags.includes('walks-into-snipe')
    || s.tags.includes('hangs-self')
    || s.tags.includes('bishop-snipe-hangs')
  ) return null;
  if (s.piece.type === 'pawn' && isFletchAim(s, board, color)) return null;
  const enemy = enemyOf(color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeExposure = ourKingExposure(board, color);
  const beforeShelter = kingShelter(board, color);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  if (qrAttackCount(next, color) > beforeOurs) return null;
  if (qrAttackCount(next, enemy) > beforeTheirs) return null;
  if (friendlyQueenRays(next, color) > beforeQueen) return null;
  if (ourKingExposure(next, color) > beforeExposure) return null;
  if (kingShelter(next, color) < beforeShelter) return null;
  if (enemyCanArrowPos(next, s.to, enemy)) return null;
  if (enemyCanAxePos(next, s.to, enemy)) return null;
  const rays = friendlyPawnRays(next, color) - beforePawn;
  const nocks = nockAimCount(next, color) - beforeNock;
  if (s.piece.type === 'pawn') {
    if (rays !== 0 || nocks <= 0) return null;
    return { rays: 0, nocks };
  }
  if (rays < 0 || (rays <= 0 && nocks <= 0)) return null;
  return { rays, nocks };
}

/**
 * The one pawn or knight step flight ranks ahead of a quiet shuffle. Null
 * when the pool is not a pure quiet stall, when a nock aim is already
 * legal, or when no safe shot-setup exists. A crest aim and a brace aim do
 * not suppress it. Nothing is removed. A king, a bishop, a queen, and a
 * rook are not tagged.
 */
function flightChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (!nockStall(pool)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  const beforePawn = friendlyPawnRays(board, color);
  const beforeNock = nockAimCount(board, color);
  let best: Scored | null = null;
  let bestRays = -1;
  let bestNocks = -1;
  let bestScore = -Infinity;
  for (const s of pool) {
    const gain = flightGain(s, board, color, beforePawn, beforeNock);
    if (!gain) continue;
    if (
      gain.rays > bestRays
      || (gain.rays === bestRays && (gain.nocks > bestNocks || (gain.nocks === bestNocks && s.score > bestScore)))
    ) {
      best = s;
      bestRays = gain.rays;
      bestNocks = gain.nocks;
      bestScore = s.score;
    }
  }
  return best;
}

/** Safe adjacent squares the enemy king can step to. 0 when that king is gone. */
function enemyFlightCount(board: Board, color: PlayerColor): number {
  const enemy = enemyOf(color);
  const kingPos = findPieces(board, enemy, 'king')[0];
  if (!kingPos) return 0;
  const kingPiece = board[kingPos.row]?.[kingPos.col]?.piece;
  if (!kingPiece) return 0;
  return safeKingSteps(board, kingPos, kingPiece).length;
}

/** Queen takes queen, or rook takes rook. A rook take of a queen is not this. */
function isEqualQrCapture(piece: Piece, target: Piece | null | undefined): boolean {
  if (!target) return false;
  if (target.type !== 'queen' && target.type !== 'rook') return false;
  const victim = PIECE_VALUE[target.type] ?? 0;
  const mover = PIECE_VALUE[piece.type] ?? 0;
  return victim > 0 && victim === mover;
}

/**
 * The move adds an attack on a queen or rook, raises our king's exposure,
 * drops the king's shelter, or lands on an enemy arrow or axe. A bomb has
 * no landing square: the rook stays where it is.
 */
function cloutGeometryBad(
  board: Board,
  next: Board,
  color: PlayerColor,
  land: Position | null,
): boolean {
  const enemy = enemyOf(color);
  if (qrAttackCount(next, color) > qrAttackCount(board, color)) return true;
  if (qrAttackCount(next, enemy) > qrAttackCount(board, enemy)) return true;
  if (ourKingExposure(next, color) > ourKingExposure(board, color)) return true;
  if (kingShelter(next, color) < kingShelter(board, color)) return true;
  if (land && enemyCanArrowPos(next, land, enemy)) return true;
  if (land && enemyCanAxePos(next, land, enemy)) return true;
  return false;
}

/** pressUnsafe without check-waste. Finish marks a non-mating check that way, including a flight cut. */
function cloutUnsafe(s: Scored): boolean {
  return hasUnsafeSelfTags(s.tags)
    || s.tags.includes('hang-shield')
    || s.tags.includes('reply-unsafe')
    || s.tags.includes('qr-loose')
    || s.tags.includes('self-check')
    || s.tags.includes('king-span')
    || s.tags.includes('shot-waste')
    || s.isBlindHang;
}

function cloutRefuses(s: Scored, board: Board, color: PlayerColor): boolean {
  if (!s.piece) return true;
  if (cloutUnsafe(s) || s.tags.includes('qr-force')) return true;
  if (prodHangsPower(s, board, color)) return true;
  if (s.isCapture && isEqualQrCapture(s.piece, s.target)) return true;
  const land = s.action.kind === 'move' ? s.to : null;
  const next = applyAction(board, s.action.kind, s.from, s.to, s.piece);
  return cloutGeometryBad(board, next, color, land);
}

/**
 * Queen or rook step that gives check and leaves the enemy king fewer
 * safe adjacent squares than it has now. A capture of an equal queen or
 * rook is not this. An unsafe step is not this.
 */
function tighteningQrGain(
  s: Scored,
  board: Board,
  color: PlayerColor,
  beforeFlights: number,
): { cut: number; after: number } | null {
  if (s.action.kind !== 'move' || !s.piece) return null;
  if (s.piece.type !== 'queen' && s.piece.type !== 'rook') return null;
  if (!s.tags.includes('gives-check')) return null;
  if (cloutRefuses(s, board, color)) return null;
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  const after = enemyFlightCount(next, color);
  if (after >= beforeFlights) return null;
  return { cut: beforeFlights - after, after };
}

/** Engine-legal queen or rook steps that would cut the enemy king's flights. */
function tighteningQrMoveCount(board: Board, color: PlayerColor): number {
  const before = enemyFlightCount(board, color);
  const enemy = enemyOf(color);
  let n = 0;
  for (const type of ['queen', 'rook'] as const) {
    for (const from of findPieces(board, color, type)) {
      const piece = board[from.row]?.[from.col]?.piece;
      if (!piece) continue;
      for (const to of getValidMoves(board, from, true)) {
        const occ = board[to.row]?.[to.col]?.piece ?? null;
        if (occ && isEqualQrCapture(piece, occ)) continue;
        const next = applyAction(board, 'move', from, to, piece);
        if (!isInCheck(next, enemy)) continue;
        if (enemyFlightCount(next, color) >= before) continue;
        if (powerEnPrise(next, color) && !powerEnPrise(board, color)) continue;
        if (cloutGeometryBad(board, next, color, to)) continue;
        n++;
      }
    }
  }
  return n;
}

/**
 * The one move clout ranks. A safe queen or rook check that cuts the enemy
 * king's flights wins. Otherwise one safe rook bomb of a wall on that
 * king's file, rank, or diagonal, when the bomb itself cuts a flight or
 * the open line adds a tightening check. Null when neither exists. Nothing
 * is removed. A bishop, a knight, a pawn, and a king are not tagged.
 */
function cloutChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  const enemy = enemyOf(color);
  const king = findPieces(board, enemy, 'king')[0];
  if (!king) return null;
  const beforeFlights = enemyFlightCount(board, color);
  let best: Scored | null = null;
  let bestCut = 0;
  let bestAfter = Infinity;
  let bestScore = -Infinity;
  for (const s of pool) {
    const gain = tighteningQrGain(s, board, color, beforeFlights);
    if (!gain) continue;
    if (
      gain.cut > bestCut
      || (gain.cut === bestCut && (gain.after < bestAfter || (gain.after === bestAfter && s.score > bestScore)))
    ) {
      best = s;
      bestCut = gain.cut;
      bestAfter = gain.after;
      bestScore = s.score;
    }
  }
  if (best) return best;
  const beforeTight = tighteningQrMoveCount(board, color);
  let bestBomb: Scored | null = null;
  let bestBombCut = 0;
  let bestAdded = 0;
  let bestBombScore = -Infinity;
  for (const s of pool) {
    if (s.action.kind !== 'bomb' || !s.piece || s.piece.type !== 'rook') continue;
    if (!aligned8(s.to, king)) continue;
    if (cloutRefuses(s, board, color)) continue;
    const next = applyAction(board, 'bomb', s.from, s.to, s.piece);
    const afterFlights = enemyFlightCount(next, color);
    const cut = beforeFlights - afterFlights;
    const added = tighteningQrMoveCount(next, color) - beforeTight;
    if (cut <= 0 && added <= 0) continue;
    const better = cut > bestBombCut
      || (cut === bestBombCut && (added > bestAdded || (added === bestAdded && s.score > bestBombScore)));
    if (!better) continue;
    bestBomb = s;
    bestBombCut = Math.max(0, cut);
    bestAdded = added;
    bestBombScore = s.score;
  }
  return bestBomb;
}

const BARB_MINOR = new Set<PieceType>(['pawn', 'knight', 'bishop']);

/**
 * The capture adds an attack on a queen or rook, opens a queen ray, raises
 * our king's exposure, drops the king's shelter, or lands on an enemy arrow
 * or axe. A queen or rook capture is not this function's job: the mover and
 * the victim are both a pawn, a knight, or a bishop.
 */
function barbRefuses(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece || !s.isCapture || !s.target) return true;
  if (!BARB_MINOR.has(s.piece.type) || !BARB_MINOR.has(s.target.type)) return true;
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return true;
  if (prodHangsPower(s, board, color)) return true;
  if (
    s.tags.includes('walks-into-snipe')
    || s.tags.includes('hangs-self')
    || s.tags.includes('bishop-snipe-hangs')
  ) return true;
  const enemy = enemyOf(color);
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeExposure = ourKingExposure(board, color);
  const beforeShelter = kingShelter(board, color);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  if (qrAttackCount(next, color) > beforeOurs) return true;
  if (qrAttackCount(next, enemy) > beforeTheirs) return true;
  if (friendlyQueenRays(next, color) > beforeQueen) return true;
  if (ourKingExposure(next, color) > beforeExposure) return true;
  if (kingShelter(next, color) < beforeShelter) return true;
  if (enemyCanArrowPos(next, s.to, enemy)) return true;
  if (enemyCanAxePos(next, s.to, enemy)) return true;
  return false;
}

/**
 * Capture that strips a piece within two squares of the enemy king, or that
 * opens a bishop pawn-shot. Flight cannot tag this: flight refuses captures.
 * A queen ray does not count. Null when the capture is unsafe.
 */
function barbGain(
  s: Scored,
  board: Board,
  color: PlayerColor,
  beforePawn: number,
  beforeNock: number,
): { victim: number; near: number; dist: number; rays: number; nocks: number } | null {
  if (barbRefuses(s, board, color) || !s.piece || !s.target) return null;
  const king = findPieces(board, enemyOf(color), 'king')[0];
  const dist = king ? chebyshev(s.to, king) : 99;
  const near = dist <= 2 ? 1 : 0;
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  const rays = Math.max(0, friendlyPawnRays(next, color) - beforePawn);
  const nocks = Math.max(0, nockAimCount(next, color) - beforeNock);
  if (near <= 0 && rays <= 0 && nocks <= 0) return null;
  return { victim: PIECE_VALUE[s.target.type] ?? 0, near, dist, rays, nocks };
}

function barbBetter(
  gain: { victim: number; near: number; dist: number; rays: number; nocks: number },
  score: number,
  other: { victim: number; near: number; dist: number; rays: number; nocks: number },
  otherScore: number,
): boolean {
  if (gain.victim !== other.victim) return gain.victim > other.victim;
  if (gain.near !== other.near) return gain.near > other.near;
  if (gain.rays !== other.rays) return gain.rays > other.rays;
  if (gain.nocks !== other.nocks) return gain.nocks > other.nocks;
  if (gain.dist !== other.dist) return gain.dist < other.dist;
  return score > otherScore;
}

/**
 * The one capture barb ranks. Null when a safe non-queen non-rook arrow is
 * already legal, when a nock aim is still in the pool, or when no safe
 * shelter capture or uncovering capture exists. Nothing is removed. A king,
 * a queen, and a rook are not tagged.
 */
function barbChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (pool.some(isVolleyArrow)) return null;
  if (pool.some((s) => isNockAim(s, board, color))) return null;
  const beforePawn = friendlyPawnRays(board, color);
  const beforeNock = nockAimCount(board, color);
  let best: Scored | null = null;
  let bestGain: { victim: number; near: number; dist: number; rays: number; nocks: number } | null = null;
  for (const s of pool) {
    const gain = barbGain(s, board, color, beforePawn, beforeNock);
    if (!gain || !bestGain) {
      if (gain) {
        best = s;
        bestGain = gain;
      }
      continue;
    }
    if (barbBetter(gain, s.score, bestGain, best?.score ?? -Infinity)) {
      best = s;
      bestGain = gain;
    }
  }
  return best;
}

/**
 * Quiet knight or pawn that is not itself a flight setup and not a nock
 * aim. A capture, a check, and an escape stay. A bishop, a rook, a queen,
 * and a king stay. The knight that uncovers a pawn shot is flight and stays.
 */
function vaneHolds(
  s: Scored,
  board: Board,
  color: PlayerColor,
  beforePawn: number,
  beforeNock: number,
): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'knight' && s.piece.type !== 'pawn') return false;
  if (s.isCapture) return false;
  if (
    s.tags.includes('gives-check')
    || s.tags.includes('escape')
    || s.tags.includes('escape-best')
    || s.tags.includes('flight')
    || s.tags.includes('nock')
  ) return false;
  if (isNockAim(s, board, color)) return false;
  if (flightGain(s, board, color, beforePawn, beforeNock)) return false;
  return true;
}

/**
 * How many attacks this quiet queen or rook step steps off. Null when the
 * piece is not under attack, the destination is not safer, or the step
 * raises queen or rook pressure, a queen ray, king exposure, or loses
 * shelter. A capture, a check, an escape, a flight setup, and a nock aim
 * are not this. The caller does not remove the move.
 */
function quillDrop(s: Scored, board: Board, color: PlayerColor): number | null {
  if (!isQuietQrStep(s) || !s.piece) return null;
  if (s.tags.includes('flight') || s.tags.includes('nock') || s.tags.includes('fork')) return null;
  if (isNockAim(s, board, color)) return null;
  const beforePawn = friendlyPawnRays(board, color);
  const beforeNock = nockAimCount(board, color);
  if (flightGain(s, board, color, beforePawn, beforeNock)) return null;
  const enemy = enemyOf(color);
  const beforePiece = enemyAttackersOf(board, s.from, enemy, s.piece.type).length;
  if (beforePiece <= 0) return null;
  const beforeOurs = qrAttackCount(board, color);
  const beforeTheirs = qrAttackCount(board, enemy);
  const beforeQueen = friendlyQueenRays(board, color);
  const beforeExposure = ourKingExposure(board, color);
  const beforeShelter = kingShelter(board, color);
  const next = applyAction(board, 'move', s.from, s.to, s.piece);
  const afterPiece = enemyAttackersOf(next, s.to, enemy, s.piece.type).length;
  if (afterPiece >= beforePiece) return null;
  if (qrAttackCount(next, color) > beforeOurs) return null;
  if (qrAttackCount(next, enemy) > beforeTheirs) return null;
  if (friendlyQueenRays(next, color) > beforeQueen) return null;
  if (ourKingExposure(next, color) > beforeExposure) return null;
  if (kingShelter(next, color) < beforeShelter) return null;
  if (enemyCanArrowPos(next, s.to, enemy)) return null;
  if (enemyCanAxePos(next, s.to, enemy)) return null;
  return beforePiece - afterPiece;
}

/**
 * The one queen or rook step quill ranks ahead of a flight or nock shot.
 * Null when no such shot is tagged, when an arrow or an axe is already
 * legal, or when no safe step-off exists. Nothing is removed.
 */
function quillChoice(pool: Scored[], board: Board, color: PlayerColor): Scored | null {
  if (pool.some((s) => s.action.kind === 'arrow' || s.action.kind === 'axe')) return null;
  if (!pool.some((s) => s.tags.includes('flight') || s.tags.includes('nock'))) return null;
  let best: Scored | null = null;
  let bestDrop = 0;
  let bestScore = -Infinity;
  for (const s of pool) {
    const drop = quillDrop(s, board, color);
    if (drop === null) continue;
    if (drop > bestDrop || (drop === bestDrop && s.score > bestScore)) {
      best = s;
      bestDrop = drop;
      bestScore = s.score;
    }
  }
  return best;
}

/** Quiet knight that is itself a flight setup or a nock aim. Quill must not divert it. */
function knightIsShot(s: RankedAction, board: Board, color: PlayerColor): boolean {
  if (s.tags.includes('flight') || s.tags.includes('nock')) return true;
  const from = parseAlg(s.from);
  const piece = board[from.row]?.[from.col]?.piece ?? null;
  const stub = {
    action: s,
    from,
    to: parseAlg(s.to),
    piece,
    target: null,
    escapesCheck: false,
    diceCapture: false,
    boardEscapes: false,
    isCapture: s.tags.includes('capture'),
    isThrash: false,
    isOscillation: false,
    isWalkOffFork: false,
    isBlindHang: false,
    score: s.score,
    tags: s.tags,
  };
  if (isNockAim(stub, board, color)) return true;
  const beforePawn = friendlyPawnRays(board, color);
  const beforeNock = nockAimCount(board, color);
  return flightGain(stub, board, color, beforePawn, beforeNock) !== null;
}

/** A move barb must not pass. A quiet check is not held. A bigger victim is. */
function barbHeld(other: Scored, tagged: Scored): boolean {
  if (
    other.tags.includes('nock')
    || other.tags.includes('flight')
    || other.tags.includes('fork')
    || other.tags.includes('escape')
    || other.tags.includes('escape-best')
    || other.tags.includes('mate-net')
    || other.action.kind === 'arrow'
    || other.action.kind === 'axe'
  ) return true;
  if (!other.isCapture || !other.target) return false;
  if (other.target.type === 'king' || other.target.type === 'queen' || other.target.type === 'rook') return true;
  const victim = PIECE_VALUE[other.target.type] ?? 0;
  const ours = PIECE_VALUE[tagged.target?.type ?? 'pawn'] ?? 0;
  if (victim > ours) return true;
  // A free knight or bishop is material. Do not skip it for an equal trade.
  return other.tags.includes('hanging') && victim >= ours;
}

/** Quiet queen or rook step. Captures, escapes, and a last-flight check are not this. */
function isKeelDrift(s: Scored, board: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type !== 'queen' && s.piece.type !== 'rook') return false;
  if (s.isCapture) return false;
  if (s.tags.includes('escape') || s.tags.includes('escape-best')) return false;
  if (s.tags.includes('mate-net') || s.tags.includes('finish')) return false;
  if (takesEnemyKing(s) || isLastFlight(s, board, color)) return false;
  return true;
}

/**
 * A non-loose move that can justify dropping a qr-loose one.
 * Before ply 30 a non-escape king step does not count, so cover cannot
 * turn a loose arrow into an early king walk.
 */
function coverAlternative(s: Scored, history: Move[]): boolean {
  if (s.tags.includes('qr-loose')) return false;
  if (
    s.tags.includes('reply-unsafe')
    || s.tags.includes('self-check')
    || s.tags.includes('king-span')
  ) return false;
  if (hasUnsafeSelfTags(s.tags) || s.isBlindHang) return false;
  if (
    history.length + 1 < 30
    && s.action.kind === 'move'
    && s.piece?.type === 'king'
    && !s.tags.includes('escape')
  ) return false;
  return true;
}

/**
 * True when this check forces a queen or rook capture on the reply.
 * Every sure king-safe enemy reply leaves a queen or rook to our best
 * capture. A pawn capture is dice, so it is not a sure escape. Zero
 * escapes is mate, not this pattern, and stays untagged.
 * Replies come from getValidMoves, getArrowTargets, and getAxeTargets.
 */
function forcedQrReplies(board: Board, color: PlayerColor): boolean {
  const enemy = enemyOf(color);
  if (findPieces(board, enemy, 'king').length === 0) return false;
  if (!isInCheck(board, enemy)) return false;
  let escapes = 0;
  let hanging = 0;
  const scan = (from: Position, to: Position, kind: ActionKind, piece: Piece) => {
    if (kind === 'move' && piece.type === 'pawn') {
      const occ = board[to.row]?.[to.col]?.piece;
      if (occ && occ.color !== piece.color) return;
    }
    const after = applyAction(board, kind, from, to, piece);
    if (isInCheck(after, enemy)) return;
    const reply = worstCaptureReply(after, enemy);
    if (reply && reply.victim >= PIECE_VALUE.king) return;
    escapes++;
    if (reply && reply.victim >= PIECE_VALUE.rook && reply.victim < PIECE_VALUE.king) hanging++;
  };
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const piece = board[row][col].piece;
      if (!piece || piece.color !== enemy) continue;
      const from = { row, col };
      for (const to of getValidMoves(board, from, true)) scan(from, to, 'move', piece);
      if (piece.type === 'bishop') {
        for (const to of getArrowTargets(board, from)) scan(from, to, 'arrow', piece);
      }
      if (piece.type === 'knight') {
        for (const to of getAxeTargets(board, from)) scan(from, to, 'axe', piece);
      }
    }
  }
  return escapes > 0 && hanging === escapes;
}

/** Check, and the enemy king has no adjacent step that leaves check. */
function enemyKingHasNoFlight(board: Board, color: PlayerColor): boolean {
  const enemy = enemyOf(color);
  const kingPos = findPieces(board, enemy, 'king')[0];
  if (!kingPos || !isInCheck(board, enemy)) return false;
  const kingPiece = board[kingPos.row]?.[kingPos.col]?.piece;
  if (!kingPiece) return false;
  return safeKingSteps(board, kingPos, kingPiece).length === 0;
}

function pressUnsafe(s: Scored): boolean {
  return hasUnsafeSelfTags(s.tags)
    || s.tags.includes('hang-shield')
    || s.tags.includes('reply-unsafe')
    || s.tags.includes('qr-loose')
    || s.tags.includes('self-check')
    || s.tags.includes('king-span')
    || s.tags.includes('shot-waste')
    || s.tags.includes('check-waste')
    || s.isBlindHang;
}

/** A move press will not drop. Escapes, safe captures, and safe shots stay. */
function pressKeep(s: Scored): boolean {
  if (s.tags.includes('press')) return true;
  if (s.tags.includes('escape') || s.tags.includes('escape-best')) return true;
  if (s.tags.includes('qr-force')) return false;
  // A clout check is often not an approach, and a clout bomb is never one.
  // Press at ply 100 would delete both. The tag exists only while clout fires.
  if (s.tags.includes('clout')) return true;
  if (s.isCapture && !pressUnsafe(s)) return true;
  if (
    (s.action.kind === 'arrow' || s.action.kind === 'axe')
    && !s.tags.includes('qr-loose')
    && !s.tags.includes('shot-waste')
    && !hasUnsafeSelfTags(s.tags)
    && !s.isBlindHang
    && !s.tags.includes('reply-unsafe')
    && !s.tags.includes('hang-shield')
  ) return true;
  return false;
}

/** Sure capture of a pawn, knight, or bishop that does not lose a queen or rook on the reply. */
function isCoverGain(s: Scored): boolean {
  if (!s.isCapture || !s.piece || !s.target) return false;
  if (s.piece.type === 'pawn') return false;
  if (s.target.type === 'king' || s.target.type === 'queen' || s.target.type === 'rook') return false;
  if ((PIECE_VALUE[s.target.type] ?? 0) <= 0) return false;
  if (
    s.tags.includes('qr-loose')
    || s.tags.includes('hang-shield')
    || s.tags.includes('reply-unsafe')
    || s.tags.includes('shot-waste')
    || s.tags.includes('self-check')
    || s.tags.includes('king-span')
  ) return false;
  if (hasUnsafeSelfTags(s.tags) || s.isBlindHang) return false;
  return true;
}

/**
 * A move reap will keep. Safe non-QR arrows (including a king aim the king
 * cannot walk off), safe captures of a pawn, knight, or bishop, and a real
 * mate. Queen and rook captures are not kept. King steps are not tagged, so
 * this cannot add a king walk. Shot-waste stays out.
 */
function isReap(s: Scored, board: Board, color: PlayerColor): boolean {
  if (pressUnsafe(s) || s.tags.includes('qr-force')) return false;
  const kind = s.action.kind;
  const takesKing = s.target?.type === 'king' && (kind === 'move' || kind === 'arrow' || kind === 'axe');
  if (takesKing) return true;
  if (s.piece?.type === 'king') return false;
  if (s.tags.includes('gives-check') && s.piece) {
    const from = parseAlg(s.action.from);
    const to = parseAlg(s.action.to);
    const next = applyAction(board, kind, from, to, s.piece);
    if (enemyKingHasNoFlight(next, color)) return true;
  }
  if (isVolleyArrow(s)) return true;
  if (isCoverGain(s)) return true;
  return false;
}

function takesEnemyKing(s: Scored): boolean {
  return !!(
    s.target?.type === 'king'
    && (s.action.kind === 'move' || s.action.kind === 'arrow' || s.action.kind === 'axe')
  );
}

/** Check, and the enemy king has no flight. A king step is not this. */
function isLastFlight(s: Scored, board: Board, color: PlayerColor): boolean {
  if (!s.tags.includes('gives-check') || !s.piece || s.piece.type === 'king') return false;
  if (s.tags.includes('qr-force')) return false;
  const from = parseAlg(s.action.from);
  const to = parseAlg(s.action.to);
  const next = applyAction(board, s.action.kind, from, to, s.piece);
  return enemyKingHasNoFlight(next, color);
}

/** Approach, king-help, or any other non-capture step. Captures and escapes stay. */
function volleyStall(s: Scored): boolean {
  if (s.action.kind === 'arrow' || s.action.kind === 'axe') return false;
  if (s.isCapture) return false;
  if (s.tags.includes('escape') || s.tags.includes('escape-best') || s.tags.includes('mate-net')) return false;
  // The tag exists only while anchor is firing. Volley would delete the
  // bishop save whenever a safe arrow is already legal.
  if (s.tags.includes('anchor')) return false;
  // The tag exists only while cast is firing. Volley would delete the
  // bishop step whenever a safe arrow is already legal.
  if (s.tags.includes('cast')) return false;
  // The tag exists only while fetch is firing. Volley would delete the
  // minor capture whenever a checking arrow is already legal.
  if (s.tags.includes('fetch')) return false;
  // The tag exists only while grip is firing. A capture is already kept
  // above. This stays so a later edit cannot drop it beside the bad arrow.
  if (s.tags.includes('grip')) return false;
  // The tag exists only while blunt is firing. Volley would delete the
  // minor capture whenever a safe arrow is already legal.
  if (s.tags.includes('blunt')) return false;
  return true;
}

function dropTagged(pool: Scored[], tag: string): { kept: Scored[]; dropped: Scored[] } {
  const dropped = pool.filter((s) => s.tags.includes(tag));
  const kept = pool.filter((s) => !s.tags.includes(tag));
  if (dropped.length > 0 && kept.length > 0) return { kept, dropped };
  return { kept: pool, dropped: [] };
}

/** Equal-value capture (knight for knight or bishop). Already counted as a capture. */
function lateTrade(isCapture: boolean, piece: Piece | null, target: Piece | null): boolean {
  if (!isCapture || !piece || !target) return false;
  if (piece.type === 'king' || target.type === 'king') return false;
  return PIECE_VALUE[target.type] > 0 && PIECE_VALUE[target.type] === PIECE_VALUE[piece.type];
}

const HINT_TAGS = new Set([
  'hanging', 'hanging-pawn', 'axe-king', 'axe-valuable', 'take-checker',
  'take-forking-knight', 'pawn-takes-knight', 'pawn-takes-checker',
  'fork', 'arrow-king', 'arrow-hanging', 'bishop-aims-king', 'escape', 'gives-check',
  'develop-bishop', 'develop-center', 'open-lane', 'arrow-pawn', 'pawn-takes-checker',
  'axe-checker', 'arrow-enemy-bishop', 'bishop-duel', 'late-conv',
  'lookahead-gain', 'trade-down',
  'quiescence-gain', 'progress',
  'mate-net', 'king-hunt', 'escape-best',
  'finish', 'king-help',
  'convert',
  'volley',
  'cover-gain',
  'press',
  'reap',
  'glean',
  'sheaf',
  'keel',
  'sift',
  'prod',
  'nock',
  'fletch',
  'pile',
  'haft',
  'quarrel',
  'bodkin',
  'crest',
  'brace',
  'mark',
  'flight',
  'clout',
  'barb',
  'vane',
  'quill',
  'string',
  'bolt',
  'spine',
  'broadhead',
  'latch',
  'sighter',
  'pluck',
  'fetch',
  'grip',
  'blunt',
]);

function isHomeSnipeTags(tags: string[]): boolean {
  return tags.includes('axe-home-snipe');
}

/** Skip unmoved g1/g12 axe-home-snipe unless it is the only remaining ranked action. */
function pickSafeFallback(
  ranked: RankedAction[],
  mustDos: RankedAction[],
  skipHomeSnipe = true,
): RankedAction | null {
  const notSnipe = (r: RankedAction) => !skipHomeSnipe || !isHomeSnipeTags(r.tags);
  const notHang = (r: RankedAction) => !hasUnsafeSelfTags(r.tags);
  const notReplyBad = (r: RankedAction) =>
    !r.tags.includes('hang-shield') && !r.tags.includes('reply-unsafe') && !r.tags.includes('shot-waste')
    && !r.tags.includes('check-waste')
    && !r.tags.includes('king-span')
    && !r.tags.includes('qr-loose')
    && !r.tags.includes('qr-force');
  // Fetch exists only while that flag is firing, and only before ply 30,
  // on the one non-checking arrow or minor capture chosen instead of a
  // loose check. It has to beat the glean arrow that is that check, which
  // is otherwise the fallback when the model hangs a piece. Flag off, this
  // list is empty and the glean arrow below is unchanged.
  const fetchMove = ranked.filter((r) =>
    r.tags.includes('fetch') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (fetchMove.length > 0) return fetchMove[0];
  // Volley tags exist only when that flag is on and firing. Otherwise this
  // is the strategy-8 convert fallback, unchanged. Cover-gain exists only
  // when that flag is on, and it sits behind a clean volley arrow so a safe
  // pawn arrow is not replaced by a minor capture.
  // A glean arrow is the same shape as a volley arrow. It exists when that
  // flag is firing, including when reap is off, and it has to beat the
  // minor capture reap kept beside it.
  // A sheaf pawn arrow is the glean shape aimed at a pawn. It has to beat
  // a bishop duel, which scores higher and was the fallback when both lived.
  const sheafArrow = ranked.filter((r) =>
    r.tags.includes('sheaf') && r.kind === 'arrow' && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (sheafArrow.length > 0) return sheafArrow[0];
  const gleanArrow = ranked.filter((r) =>
    r.tags.includes('glean') && r.kind === 'arrow' && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (gleanArrow.length > 0) return gleanArrow[0];
  // A reap arrow is the same shape as a volley arrow, but reap does not
  // require a lead, so the tag exists when volley is off. It has to beat a
  // press step. Volley below still covers a volley arrow that was not retagged.
  const reapArrow = ranked.filter((r) =>
    r.tags.includes('reap') && r.kind === 'arrow' && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (reapArrow.length > 0) return reapArrow[0];
  const volley = ranked.filter((r) => r.tags.includes('volley') && notSnipe(r) && notHang(r) && notReplyBad(r));
  if (volley.length > 0) return volley[0];
  // A barb capture strips a piece next to the enemy king, or opens a bishop
  // pawn-shot. It sits behind a clean arrow and ahead of reap, so a far
  // minor capture does not steal the shelter capture. A capture, arrow, axe,
  // escape, nock, flight, fork, or mate-net ranked ahead of it still wins.
  // Tags exist only when barb is firing. Nothing was dropped to produce it.
  const barb = ranked.filter((r) =>
    r.tags.includes('barb') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (barb.length > 0) {
    const pick = barb[0];
    const ahead = ranked.slice(0, ranked.indexOf(pick));
    const held = ahead.some((r) =>
      r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('capture')
      || r.tags.includes('escape')
      || r.tags.includes('escape-best')
      || r.tags.includes('nock')
      || r.tags.includes('flight')
      || r.tags.includes('fork')
      || r.tags.includes('mate-net')
    );
    if (!held) return pick;
  }
  // Reap captures sit behind a clean arrow and ahead of a press step. A
  // closer check must not beat a safe pawn, knight, or bishop capture.
  // Tags exist only when reap is firing. King captures are in this set too;
  // an arrow, when one remains, was already returned above.
  const reapGain = ranked.filter((r) =>
    r.tags.includes('reap') && r.kind !== 'arrow' && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (reapGain.length > 0) return reapGain[0];
  // Press sits behind a clean volley arrow so a safe pawn arrow is not
  // replaced by a step. It is ahead of cover-gain so a closer step beats a
  // minor capture when no arrow remains. Tags exist only when press is firing.
  const press = ranked.filter((r) => r.tags.includes('press') && notSnipe(r) && notHang(r) && notReplyBad(r));
  if (press.length > 0) return press[0];
  const cover = ranked.filter((r) => r.tags.includes('cover-gain') && notSnipe(r) && notHang(r) && notReplyBad(r));
  if (cover.length > 0) return cover[0];
  const convert = ranked.filter((r) => r.tags.includes('convert') && notSnipe(r) && notHang(r) && notReplyBad(r));
  if (convert.length > 0) return convert[0];
  // A bishop step that opens a pawn arrow. Only tagged when no pawn arrow
  // is already legal. It sits behind a capture still in the pool so a
  // hanging pawn is not skipped for the step that would shoot it later.
  // The capture preference exists only while a sheaf aim is ranked, so a
  // flag-off genome keeps the old fallback order.
  const sheafAim = ranked.filter((r) =>
    r.tags.includes('sheaf') && r.kind === 'move' && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (sheafAim.length > 0) {
    const capture = ranked.filter((r) =>
      r.tags.includes('capture') && notSnipe(r) && notHang(r) && notReplyBad(r)
    );
    if (capture.length > 0) return capture[0];
    return sheafAim[0];
  }
  // A bishop step that opens a ray onto a pawn, knight, bishop, or king.
  // Only tagged when no safe non-QR arrow is already legal. It sits behind
  // a capture still in the pool. The preference exists only while a keel
  // ray is ranked, so a flag-off genome keeps the old fallback order.
  const keelRay = ranked.filter((r) =>
    r.tags.includes('keel') && r.kind === 'move' && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (keelRay.length > 0) {
    const capture = ranked.filter((r) =>
      r.tags.includes('capture') && notSnipe(r) && notHang(r) && notReplyBad(r)
    );
    if (capture.length > 0) return capture[0];
    return keelRay[0];
  }
  // A sift move is the fitted ray or the fitted material step. It exists
  // only when that flag is firing and no safe non-queen non-rook arrow is
  // ranked. A capture still in the pool stays the fallback. Nothing was
  // dropped to produce the tag, so a flag-off genome never reaches this.
  const sift = ranked.filter((r) =>
    r.tags.includes('sift') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (sift.length > 0) {
    const capture = ranked.filter((r) =>
      r.tags.includes('capture') && notSnipe(r) && notHang(r) && notReplyBad(r)
    );
    if (capture.length > 0) return capture[0];
    return sift[0];
  }
  // A prod move is a check, a non-queen non-rook capture, or a knight step
  // into the enemy king's ring. It exists only when that flag is firing and
  // no safe non-queen non-rook arrow is ranked. A non-queen non-rook capture
  // still in the pool stays the fallback. A queen or rook capture does not.
  // Nothing was dropped to produce the tag.
  const prod = ranked.filter((r) =>
    r.tags.includes('prod') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (prod.length > 0) {
    const capture = ranked.filter((r) =>
      r.tags.includes('capture')
      && !r.tags.includes('qr-take')
      && notSnipe(r)
      && notHang(r)
      && notReplyBad(r)
    );
    if (capture.length > 0) return capture[0];
    return prod[0];
  }
  // A nock move is the bishop step that opens a pawn ray. It exists only
  // when that flag is firing and the pool is a pure quiet stall, so a
  // capture, an arrow, or a check was not ranked beside it. Nothing was
  // dropped to produce the tag. A flag-off genome never reaches this.
  const nock = ranked.filter((r) =>
    r.tags.includes('nock') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (nock.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return nock[0];
  }
  // A fletch move is the pawn step that opens a pawn ray. It exists only
  // when that flag is firing, the pool is a pure quiet stall, and no nock
  // aim was legal. Nock is checked first, so a bishop step still wins when
  // both tags are present. Nothing was dropped to produce the tag.
  const fletch = ranked.filter((r) =>
    r.tags.includes('fletch') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (fletch.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return fletch[0];
  }
  // A pile move is the bishop step that puts the enemy king behind one
  // friendly screen. It exists only when that flag is firing, the pool is a
  // pure quiet stall, and no nock aim was legal. Nock, then fletch, are
  // checked first. Nothing was dropped. The move is not itself a check.
  const pile = ranked.filter((r) =>
    r.tags.includes('pile') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (pile.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return pile[0];
  }
  // A haft move is the bishop step that opens a firing lane. It exists only
  // when that flag is firing, the pool is a pure quiet stall, and no nock
  // aim was legal. Nock, then fletch, then pile, are checked first. Nothing
  // was dropped. The move is not itself a check.
  const haft = ranked.filter((r) =>
    r.tags.includes('haft') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (haft.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return haft[0];
  }
  // A quarrel move is the score-best quiet step that was not already a hint.
  // It exists only when that flag is firing, the pool is a pure quiet stall,
  // and no nock aim was legal. It is not a check. Nock, fletch, pile, and
  // haft are checked first. A capture, an arrow, an axe, or a check still
  // wins. Nothing was dropped.
  const quarrel = ranked.filter((r) =>
    r.tags.includes('quarrel') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (quarrel.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return quarrel[0];
  }
  // A bodkin move is the knight or bishop step that closes on the enemy
  // king. It exists only when that flag is firing, the pool is a pure quiet
  // stall, and no nock aim was legal. It is not a check. Nock, fletch, pile,
  // haft, and quarrel are checked first. A capture, an arrow, an axe, or a
  // check still wins. Nothing was dropped.
  const bodkin = ranked.filter((r) =>
    r.tags.includes('bodkin') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (bodkin.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return bodkin[0];
  }
  // A flight move is the pawn or knight step that sets up a bishop pawn-shot.
  // It exists only when that flag is firing, the pool is a pure quiet stall,
  // and no nock aim was legal. It is not a check. Nock is checked first. A
  // crest aim and a brace aim do not take this slot. A capture, an arrow,
  // an axe, or a check still wins. Nothing was dropped.
  const flight = ranked.filter((r) =>
    r.tags.includes('flight') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (flight.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return flight[0];
  }
  // A clout move is the queen or rook check that cuts the enemy king's
  // flights, or the rook bomb that opens more of those checks. Flight is
  // checked first. A capture, an arrow, an axe, an escape, a nock, a
  // flight, or a fork still wins. A bomb does not replace a check.
  const clout = ranked.filter((r) =>
    r.tags.includes('clout') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (clout.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('escape')
      || r.tags.includes('escape-best')
      || r.tags.includes('nock')
      || r.tags.includes('flight')
      || r.tags.includes('fork')
    );
    const check = clout.find((r) => r.tags.includes('gives-check') && r.kind !== 'bomb' && r.kind !== 'wall');
    const hasCheck = ranked.some((r) => r.tags.includes('gives-check') && r.kind !== 'bomb' && r.kind !== 'wall');
    if (!busy && check) return check;
    const bomb = clout.find((r) => r.kind === 'bomb');
    if (!busy && bomb && !hasCheck) return bomb;
  }
  // A crest move is the bishop step that closes on the nearest enemy pawn
  // without opening a pawn ray or a queen ray. It exists only when that flag
  // is firing, the pool is a pure quiet stall, and no nock aim was legal.
  // It is not a check and not a knight fork. Nock is checked first. A
  // capture, an arrow, an axe, or a check still wins. Nothing was dropped.
  const crest = ranked.filter((r) =>
    r.tags.includes('crest') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (crest.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return crest[0];
  }
  // A brace move is the pawn step that gives a bishop a new legal step.
  // It exists only when that flag is firing, the pool is a pure quiet stall,
  // and no nock aim or crest aim was legal. It is not a check. Crest is
  // checked first. A capture, an arrow, an axe, or a check still wins.
  // Nothing was dropped.
  const brace = ranked.filter((r) =>
    r.tags.includes('brace') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (brace.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return brace[0];
  }
  // A mark move is the knight step that closes on the nearest enemy pawn
  // without adding an attack on a queen or a rook. It exists only when that
  // flag is firing, the pool is a pure quiet stall, and no nock aim, crest
  // aim, or brace aim was legal. It is not a check. Brace is checked first.
  // A capture, an arrow, an axe, or a check still wins. Nothing was dropped.
  const mark = ranked.filter((r) =>
    r.tags.includes('mark') && notSnipe(r) && notHang(r) && notReplyBad(r)
  );
  if (mark.length > 0) {
    const busy = ranked.some((r) =>
      r.tags.includes('capture')
      || r.kind === 'arrow'
      || r.kind === 'axe'
      || r.tags.includes('gives-check')
    );
    if (!busy) return mark[0];
  }
  const hunt = ranked.filter((r) =>
    r.tags.includes('arrow-king')
    || r.tags.includes('arrow-checks-king')
    || r.tags.includes('bishop-aims-king'),
  );
  return (
    mustDos.filter(notSnipe).filter(notHang).filter(notReplyBad)[0]
    ?? hunt.filter(notSnipe).filter(notHang).filter(notReplyBad)[0]
    ?? ranked.filter(notSnipe).filter(notHang).filter(notReplyBad)[0]
    ?? mustDos.filter(notSnipe).filter(notHang)[0]
    ?? ranked.filter(notSnipe)[0]
    ?? ranked[0]
    ?? null
  );
}

/** Most-specific reject reason for a missed must-do set. */
function mostSpecificMustDoReason(mustDos: RankedAction[]): string {
  const tags = new Set<string>();
  for (const m of mustDos) for (const t of m.tags) tags.add(t);
  if (tags.has('axe-king')) return 'axe-royal';
  if (tags.has('arrow-king')) return 'bishop-shoots';
  if (tags.has('arrow-checks-king')) return 'bishop-shoots';
  if (tags.has('bishop-aims-king')) return 'bishop-shoots';
  if (tags.has('axe-checker')) return 'take-checker-first';
  if (tags.has('take-checker')) return 'take-checker-first';
  if (tags.has('axe-valuable')) return 'axe-royal';
  if (tags.has('arrow-hanging')) return 'bishop-shoots';
  if (tags.has('arrow-enemy-bishop') || tags.has('bishop-duel')) return 'bishop-shoots';
  if (tags.has('hanging')) return 'hanging-take';
  if (tags.has('fork')) return 'keep-fork';
  if (tags.has('develop-bishop')) return 'develop-center';
  return 'must-do';
}

function cloneBoard(board: Board): Board {
  return JSON.parse(JSON.stringify(board)) as Board;
}

function samePos(a: Position, b: Position): boolean {
  return a.row === b.row && a.col === b.col;
}

function parseAlg(alg: string): Position {
  const s = String(alg).trim().toLowerCase();
  const col = s.charCodeAt(0) - 97;
  const rank = Number(s.slice(1));
  return { row: 12 - rank, col };
}

function enemyOf(color: PlayerColor): PlayerColor {
  return color === 'white' ? 'black' : 'white';
}

function chebyshev(a: Position, b: Position): number {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
}

/** Geometric center of the 12x12 open field. */
const CENTER: Position = { row: 5, col: 5 }; // between f7/g6

function isCenterSquare(pos: Position): boolean {
  const file = pos.col; // 0=a .. 11=l
  const rank = 12 - pos.row; // 1..12
  return file >= 3 && file <= 8 && rank >= 4 && rank <= 9; // d-i, 4-9
}

function isBackRank(pos: Position, color: PlayerColor): boolean {
  const rank = 12 - pos.row;
  return color === 'white' ? rank <= 2 : rank >= 11;
}

function countAdjacentFriendly(board: Board, pos: Position, color: PlayerColor): number {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = pos.row + dr;
      const c = pos.col + dc;
      if (r < 0 || r > 11 || c < 0 || c > 11) continue;
      const p = board[r]?.[c]?.piece;
      if (p && p.color === color) n++;
    }
  }
  return n;
}

function aligned8(a: Position, b: Position): boolean {
  const dr = b.row - a.row;
  const dc = b.col - a.col;
  if (dr === 0 && dc === 0) return false;
  return dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc);
}

function squaresBetween(a: Position, b: Position): Position[] {
  if (!aligned8(a, b)) return [];
  const dr = Math.sign(b.row - a.row);
  const dc = Math.sign(b.col - a.col);
  const out: Position[] = [];
  let r = a.row + dr;
  let c = a.col + dc;
  while (r !== b.row || c !== b.col) {
    out.push({ row: r, col: c });
    r += dr;
    c += dc;
  }
  return out;
}

function homeKingSquare(color: PlayerColor): Position {
  return color === 'white' ? parseAlg('g1') : parseAlg('g12');
}

function kingHasLeftHome(history: Move[], color: PlayerColor): boolean {
  const home = homeKingSquare(color);
  for (const m of history) {
    if (!isTravelMove(m)) continue;
    if (m.piece.type !== 'king' || m.piece.color !== color) continue;
    return true;
  }
  return false;
}

function isUnmovedHomeKing(board: Board, history: Move[], enemy: PlayerColor, pos: Position): boolean {
  const king = board[pos.row]?.[pos.col]?.piece;
  if (!king || king.type !== 'king' || king.color !== enemy) return false;
  return samePos(pos, homeKingSquare(enemy)) && !kingHasLeftHome(history, enemy);
}

function isTravelMove(m: Move): boolean {
  return !m.isArrowAttack && !m.isAxeAttack && !m.isBombAttack && !m.isWallBuild;
}

function pieceMoves(history: Move[], piece: Piece, nowAt: Position): Move[] {
  const out: Move[] = [];
  if (piece.id) {
    for (const m of history) {
      if (m.piece.id === piece.id && isTravelMove(m)) out.push(m);
    }
    return out;
  }
  // Walk the chain backwards from the current square when ids are missing.
  let at = nowAt;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!isTravelMove(m)) continue;
    if (m.piece.color !== piece.color || m.piece.type !== piece.type) continue;
    if (samePos(m.to, at)) {
      out.unshift(m);
      at = m.from;
    }
  }
  return out;
}

/** A→B then B→A already appears in the last four travel moves. */
function twoSquareJob(trail: Move[], from: Position, to: Position): boolean {
  const last4 = trail.slice(-4);
  for (let i = 0; i < last4.length; i++) {
    const a = last4[i];
    if (!(samePos(a.from, from) && samePos(a.to, to))) continue;
    for (let j = i + 1; j < last4.length; j++) {
      const b = last4[j];
      if (samePos(b.from, to) && samePos(b.to, from)) return true;
    }
  }
  return false;
}

function applyAction(board: Board, kind: ActionKind, from: Position, to: Position, piece: Piece): Board {
  const next = cloneBoard(board);
  if (kind === 'move') {
    next[to.row][to.col].piece = piece;
    next[from.row][from.col].piece = null;
  } else if (kind === 'arrow' || kind === 'axe') {
    next[to.row][to.col].piece = null;
  } else if (kind === 'bomb') {
    next[to.row][to.col].isWall = false;
  } else if (kind === 'wall') {
    next[to.row][to.col].isWall = true;
  }
  return next;
}

function isAttackedBy(board: Board, pos: Position, byColor: PlayerColor): boolean {
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const p = board[row][col].piece;
      if (!p || p.color !== byColor) continue;
      const attacks = getValidMoves(board, { row, col }, true);
      if (attacks.some((a) => samePos(a, pos))) return true;
    }
  }
  return false;
}

/** True if `byColor` protects `pos` (occupant cleared so friendly attacks count). */
function isDefendedBy(board: Board, pos: Position, byColor: PlayerColor): boolean {
  const cleared = cloneBoard(board);
  cleared[pos.row][pos.col].piece = null;
  return isAttackedBy(cleared, pos, byColor);
}

/** Cheapest enemy take of occupant at `pos` (move, axe, or arrow). Null if none. */
function cheapestEnemyTake(
  board: Board,
  pos: Position,
  enemy: PlayerColor,
  occupantType: PieceType,
): number | null {
  let cheapest: number | null = null;
  const consider = (v: number) => {
    if (cheapest == null || v < cheapest) cheapest = v;
  };
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const p = board[row][col].piece;
      if (!p || p.color !== enemy) continue;
      const from = { row, col };
      if (getValidMoves(board, from, true).some((a) => samePos(a, pos))) {
        consider(PIECE_VALUE[p.type]);
      }
      if (p.type === 'knight' && occupantType !== 'rook') {
        if (getAxeTargets(board, from).some((a) => samePos(a, pos))) consider(PIECE_VALUE.knight);
      }
      if (p.type === 'bishop' && occupantType !== 'knight' && occupantType !== 'rook') {
        if (getArrowTargets(board, from).some((a) => samePos(a, pos))) consider(PIECE_VALUE.bishop);
      }
    }
  }
  return cheapest;
}

function pieceHangsCheaply(board: Board, pos: Position, color: PlayerColor, type: PieceType): boolean {
  const cheapest = cheapestEnemyTake(board, pos, enemyOf(color), type);
  if (cheapest == null) return false;
  const defended = isDefendedBy(board, pos, color);
  if (!defended) return true;
  return cheapest < PIECE_VALUE[type];
}

function enemyCanArrowPos(board: Board, pos: Position, enemy: PlayerColor): boolean {
  for (const bpos of findPieces(board, enemy, 'bishop')) {
    if (getArrowTargets(board, bpos).some((a) => samePos(a, pos))) return true;
  }
  return false;
}

function enemyCanAxePos(board: Board, pos: Position, enemy: PlayerColor): boolean {
  for (const npos of findPieces(board, enemy, 'knight')) {
    if (getAxeTargets(board, npos).some((a) => samePos(a, pos))) return true;
  }
  return false;
}

function hangingPowerPieces(board: Board, color: PlayerColor): { pos: Position; type: PieceType }[] {
  const out: { pos: Position; type: PieceType }[] = [];
  for (const type of ['queen', 'rook'] as PieceType[]) {
    for (const pos of findPieces(board, color, type)) {
      if (pieceHangsCheaply(board, pos, color, type)) out.push({ pos, type });
    }
  }
  return out;
}

function enemyAttackersOf(board: Board, pos: Position, enemy: PlayerColor, occupantType: PieceType): Position[] {
  const out: Position[] = [];
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const p = board[row][col].piece;
      if (!p || p.color !== enemy) continue;
      const from = { row, col };
      if (getValidMoves(board, from, true).some((a) => samePos(a, pos))) {
        out.push(from);
        continue;
      }
      if (p.type === 'knight' && occupantType !== 'rook') {
        if (getAxeTargets(board, from).some((a) => samePos(a, pos))) out.push(from);
      }
      if (p.type === 'bishop' && occupantType !== 'knight' && occupantType !== 'rook') {
        if (getArrowTargets(board, from).some((a) => samePos(a, pos))) out.push(from);
      }
    }
  }
  return out;
}

function actionSavesHangingPower(
  kind: ActionKind,
  from: Position,
  to: Position,
  isCapture: boolean,
  hanging: { pos: Position; type: PieceType }[],
  board: Board,
  enemy: PlayerColor,
): boolean {
  for (const h of hanging) {
    if (kind === 'move' && samePos(from, h.pos)) return true;
    const attackers = enemyAttackersOf(board, h.pos, enemy, h.type);
    if (isCapture && attackers.some((a) => samePos(a, to))) return true;
    if (kind === 'move') {
      for (const atk of attackers) {
        if (squaresBetween(atk, h.pos).some((sq) => samePos(sq, to))) return true;
      }
    }
  }
  return false;
}

function shouldDropUnsafe(s: { isBlindHang: boolean; tags: string[] }, g: PolicyGenome): boolean {
  if (s.isBlindHang || s.tags.includes('hangs-self')) return true;
  if (g.gates.reject_bishop_snipe_hangs && (s.tags.includes('bishop-snipe-hangs') || s.tags.includes('arrow-exposes-counter'))) {
    return true;
  }
  if (g.gates.reject_walks_into_snipe && (s.tags.includes('walks-into-snipe') || s.tags.includes('power-into-arrow-lane'))) {
    return true;
  }
  if (g.gates.reject_power_hangs_idle && (s.tags.includes('power-hangs-idle') || s.tags.includes('leaves-power-hanging'))) {
    return true;
  }
  return false;
}

function unsafeRejectReason(s: { tags: string[] }): string {
  if (s.tags.includes('walks-into-snipe') || s.tags.includes('power-into-arrow-lane')) return 'walks-into-snipe';
  if (s.tags.includes('power-hangs-idle') || s.tags.includes('leaves-power-hanging')) return 'power-hangs';
  return 'hangs-piece';
}

const SACRIFICE_OK_TAGS = new Set([
  'escape', 'take-checker', 'hanging', 'fork', 'axe-king', 'arrow-king', 'arrow-checks-king', 'arrow-hanging',
]);

/** Quiet (or under-valued) walk onto a square the enemy can take, with no one-ply gain. */
function isBlindHang(s: {
  action: PolicyAction;
  piece: Piece | null;
  target: Piece | null;
  isCapture: boolean;
  tags: string[];
}, next: Board, color: PlayerColor): boolean {
  if (s.action.kind !== 'move' || !s.piece) return false;
  if (s.piece.type === 'king') return false;
  if (s.tags.some((t) => SACRIFICE_OK_TAGS.has(t))) return false;
  const ourVal = PIECE_VALUE[s.piece.type];
  const capturedVal = s.isCapture && s.target ? PIECE_VALUE[s.target.type] : 0;
  if (capturedVal >= ourVal) return false;
  // A check or bishop-aims-king does not pay for hanging a piece for a pawn.
  const cheapest = cheapestEnemyTake(next, parseAlg(s.action.to), enemyOf(color), s.piece.type);
  if (cheapest == null) return false;
  const defended = isDefendedBy(next, parseAlg(s.action.to), color);
  if (!defended) return true;
  if (cheapest < ourVal) return true;
  return capturedVal < ourVal;
}

function findPieces(board: Board, color: PlayerColor, type?: PieceType): Position[] {
  const out: Position[] = [];
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const p = board[row][col].piece;
      if (p && p.color === color && (!type || p.type === type)) out.push({ row, col });
    }
  }
  return out;
}

function findCheckers(board: Board, color: PlayerColor): Position[] {
  const king = findPieces(board, color, 'king')[0];
  if (!king) return [];
  const enemy = enemyOf(color);
  const checkers: Position[] = [];
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const p = board[row][col].piece;
      if (!p || p.color !== enemy) continue;
      const from = { row, col };
      const hits = getValidMoves(board, from, true).some((a) => samePos(a, king));
      const arrowHit = p.type === 'bishop' && getArrowTargets(board, from).some((a) => samePos(a, king));
      const axeHit = p.type === 'knight' && getAxeTargets(board, from).some((a) => samePos(a, king));
      if (hits || arrowHit || axeHit) checkers.push(from);
    }
  }
  return checkers;
}

/** L-move or axe-adjacent hits on enemy king/queen/rook (unique squares). */
function valuableHitsFrom(board: Board, from: Position, color: PlayerColor): Position[] {
  const enemy = enemyOf(color);
  const hits: Position[] = [];
  const add = (pos: Position) => {
    const p = board[pos.row]?.[pos.col]?.piece;
    if (!p || p.color !== enemy || !VALUABLE.has(p.type)) return;
    if (!hits.some((h) => samePos(h, pos))) hits.push(pos);
  };
  for (const a of getValidMoves(board, from, true)) add(a);
  if (board[from.row][from.col].piece?.type === 'knight') {
    for (const a of getAxeTargets(board, from)) add(a);
  }
  return hits;
}

function enemyForkingKnight(board: Board, color: PlayerColor): Position | null {
  const enemy = enemyOf(color);
  for (const pos of findPieces(board, enemy, 'knight')) {
    const hits = valuableHitsFrom(board, pos, enemy);
    const types = new Set(hits.map((h) => board[h.row][h.col].piece!.type));
    if ((types.has('queen') && types.has('rook')) || hits.length >= 2) return pos;
  }
  return null;
}

export function collectLegalActions(state: GameState): PolicyAction[] {
  const board = state.board;
  const color = state.currentTurn;
  const actions: PolicyAction[] = [];
  const maxB = state.maxBishopAttacks ?? 10;
  const maxR = state.maxRookAttacks ?? 10;
  const used = state.specialAttackCounts ?? {};
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const piece = board[row][col].piece;
      if (!piece || piece.color !== color) continue;
      const from = { row, col };
      const fromAlg = squareName(from);
      for (const to of getValidMoves(board, from, true)) {
        actions.push({ from: fromAlg, to: squareName(to), kind: 'move', type: piece.type });
      }
      const charges = piece.id ? (used[piece.id] ?? 0) : 0;
      if (piece.type === 'bishop' && charges < maxB) {
        for (const to of getArrowTargets(board, from)) {
          actions.push({ from: fromAlg, to: squareName(to), kind: 'arrow', type: piece.type });
        }
      }
      if (piece.type === 'knight') {
        for (const to of getAxeTargets(board, from)) {
          actions.push({ from: fromAlg, to: squareName(to), kind: 'axe', type: piece.type });
        }
      }
      if (piece.type === 'rook' && charges < maxR) {
        for (const to of getBombTargets(board, from)) {
          actions.push({ from: fromAlg, to: squareName(to), kind: 'bomb', type: piece.type });
        }
        for (const to of getWallBuildTargets(board, from)) {
          actions.push({ from: fromAlg, to: squareName(to), kind: 'wall', type: piece.type });
        }
      }
    }
  }
  return actions;
}

function scoreOne(
  board: Board,
  color: PlayerColor,
  inCheck: boolean,
  history: Move[],
  action: PolicyAction,
  checkers: Position[],
  forkingKnight: Position | null,
  g: PolicyGenome,
  lookaheadBefore: number | null,
  quiescenceBefore: number | null,
  netBefore: KingReply | null,
  stickyBefore: number | null,
): Scored {
  const w = g.weights;
  const from = parseAlg(action.from);
  const to = parseAlg(action.to);
  const piece = board[from.row]?.[from.col]?.piece ?? null;
  const target = board[to.row]?.[to.col]?.piece ?? null;
  const kind = action.kind;
  const tags: string[] = [];
  let score = 0;
  const enemy = enemyOf(color);

  const next = piece ? applyAction(board, kind, from, to, piece) : board;
  const isCapture = !!(
    (kind === 'move' && target && target.color !== color) ||
    ((kind === 'arrow' || kind === 'axe') && target && target.color !== color)
  );
  const diceCapture = !!(kind === 'move' && piece?.type === 'pawn' && isCapture);
  const boardEscapes = !isInCheck(next, color);
  // Pawn attacks miss often (W0 17%). A miss ends the turn still in check.
  const escapesCheck = boardEscapes && !diceCapture;
  if (escapesCheck && inCheck) {
    score += w.w_escape;
    tags.push('escape');
  }

  if (isCapture && target) {
    score += PIECE_VALUE[target.type] * w.w_capture_unit;
    tags.push('capture');
    const undefended = !isDefendedBy(board, to, enemy);
    const sureTake = !diceCapture;
    if (undefended && HANGING_REQUIRED.has(target.type) && (kind === 'move' || kind === 'axe') && boardEscapes && sureTake) {
      score += w.w_hanging;
      tags.push('hanging');
    } else if (undefended && target.type === 'pawn') {
      score += w.w_hanging_pawn;
      tags.push('hanging-pawn');
    }
    if (checkers.some((c) => samePos(c, to))) {
      if (diceCapture) {
        score += w.w_pawn_takes_checker;
        tags.push('pawn-takes-checker');
        if (target.type === 'knight') tags.push('pawn-takes-knight');
      } else {
        score += w.w_take_checker;
        tags.push('take-checker');
        if (kind === 'axe') tags.push('axe-checker');
        if (kind === 'arrow') tags.push('arrow-checker');
      }
    }
    if (forkingKnight && samePos(forkingKnight, to)) {
      score += w.w_take_forking_knight;
      tags.push('take-forking-knight');
    }
    if (piece?.type === 'pawn') {
      score += w.w_pawn_capture;
      if (target.type === 'knight') {
        score += w.w_pawn_takes_knight;
        tags.push('pawn-takes-knight');
      }
    }
  }

  if (kind === 'axe' && target) {
    if (target.type === 'king') {
      // Cheap snipes on an unmoved g1/g12 king are rejected (not must-dos),
      // unless that axe is the only legal check escape.
      if (isUnmovedHomeKing(board, history, enemy, to)) {
        score += w.w_axe_home_snipe;
        tags.push('axe-home-snipe');
      } else {
        score += w.w_axe_king;
        tags.push('axe-king');
      }
    } else if ((target.type === 'queen' || target.type === 'rook') && escapesCheck) {
      score += w.w_axe_valuable;
      tags.push('axe-valuable');
    } else if (target.type === 'bishop' || target.type === 'knight') {
      score += w.w_axe_minor;
      tags.push('axe-minor');
    }
  }

  if (kind === 'arrow' && target && target.color !== color) {
    if (target.type === 'king') {
      score += w.w_arrow_king;
      tags.push('arrow-king');
    } else if (
      (target.type === 'queen' || target.type === 'rook' || target.type === 'bishop') &&
      boardEscapes &&
      !isDefendedBy(board, to, enemy)
    ) {
      score += w.w_arrow_hanging;
      tags.push('arrow-hanging');
    } else if (target.type === 'pawn') {
      score += w.w_arrow_pawn;
      tags.push('arrow-pawn');
    }
    if (target.type === 'bishop') {
      score += w.w_arrow_enemy_bishop;
      tags.push('arrow-enemy-bishop');
      tags.push('bishop-duel');
    }
  }

  // Knight move or axe that attacks two of {king, queen, rook}.
  if (piece?.type === 'knight' && (kind === 'move' || kind === 'axe')) {
    const probeFrom = kind === 'move' ? to : from;
    const probeBoard = kind === 'move' ? next : board;
    const hits = valuableHitsFrom(probeBoard, probeFrom, color);
    if (hits.length >= 2) {
      score += w.w_fork;
      tags.push('fork');
    }
  }

  // Walking our already-forking knight off the fork (no capture) is keep-fork.
  let isWalkOffFork = false;
  if (kind === 'move' && piece?.type === 'knight' && !isCapture) {
    const currentHits = valuableHitsFrom(board, from, color);
    if (currentHits.length >= 2) {
      isWalkOffFork = true;
      score += w.w_walk_off_fork;
      tags.push('walk-off-fork');
    }
  }

  // Walking a queen/rook off an enemy fork is allowed (bonus, not a must-do).
  if (forkingKnight && kind === 'move' && piece && VALUABLE.has(piece.type) && piece.type !== 'king') {
    const stillHit = valuableHitsFrom(board, forkingKnight, enemy).some((h) => samePos(h, from));
    if (stillHit) {
      score += w.w_step_off_fork;
      tags.push('step-off-fork');
    }
  }

  // Pressure: delivering check, stepping toward the enemy king, captures (above).
  if (isInCheck(next, enemy)) {
    score += w.w_gives_check;
    tags.push('gives-check');
    if (kind === 'arrow') {
      score += w.w_arrow_checks_king;
      tags.push('arrow-checks-king');
    }
  }
  const enemyKing = findPieces(board, enemy, 'king')[0];
  if (enemyKing && kind === 'move' && piece) {
    const before = chebyshev(from, enemyKing);
    const after = chebyshev(to, enemyKing);
    if (after < before) {
      score += (before - after) * w.w_approach;
      tags.push('approach');
    }
  }

  // Center development: Q/R/B into the open field. Bishops get extra weight
  // so they can use long-range 8-way arrows (LAB-W0-3 style).
  if (kind === 'move' && piece && (piece.type === 'bishop' || piece.type === 'queen' || piece.type === 'rook') && !isCapture) {
    const beforeC = chebyshev(from, CENTER);
    const afterC = chebyshev(to, CENTER);
    const weight = piece.type === 'bishop' ? w.w_develop_center_step : piece.type === 'queen' ? w.w_develop_center_step_queen : w.w_develop_center_step_rook;
    if (afterC < beforeC) {
      score += (beforeC - afterC) * weight;
      tags.push('develop-center');
    }
    if (isBackRank(from, color) && isCenterSquare(to)) {
      score += piece.type === 'bishop' ? w.w_develop_bishop_center : w.w_develop_heavy_center;
      tags.push('develop-center');
      if (piece.type === 'bishop') tags.push('develop-bishop');
    }
    if (isBackRank(from, color) && isBackRank(to, color)) {
      score += piece.type === 'bishop' ? w.w_back_rank_shuffle_b : w.w_back_rank_shuffle_heavy;
      tags.push('back-rank-shuffle');
      if (piece.type === 'bishop') {
        score += w.w_bishop_home_idle;
        tags.push('bishop-home-idle');
      }
    }
  }
  if (kind === 'move' && piece?.type === 'bishop') {
    const lanesAfter = countBishopFiringLanes(next, to, color);
    const lanesBefore = countBishopFiringLanes(board, from, color);
    if (lanesAfter > lanesBefore) {
      score += (lanesAfter - lanesBefore) * w.w_open_diagonal;
      tags.push('open-lane');
      if (lanesAfter >= 4) score += w.w_open_lane_bonus;
    }
    const arrowsAfter = getArrowTargets(next, to);
    if (enemyKing && arrowsAfter.some((a) => samePos(a, enemyKing))) {
      score += w.w_bishop_aims_king;
      tags.push('bishop-aims-king');
    }
  }

  // Open-board: wall/bomb are never the point unless they are the only escape.
  if (kind === 'wall' || kind === 'bomb') {
    score += w.w_open_board_penalty;
    tags.push('open-board-penalty');
  }

  if (inCheck && escapesCheck && piece?.type === 'king' && kind === 'move' && !tags.includes('take-checker')) {
    tags.push('king-run');
  }

  // Strategy-8 span filter. A king step farther than one square is the
  // castling teleport. gameUtils lists it; handleMove rejected every one
  // in round 8. The scorer does not move the rook with it. No-op unless
  // the flag is exactly true. Nothing here appends a square.
  if (
    g.span_filter_enabled === true
    && kind === 'move'
    && piece?.type === 'king'
    && chebyshev(from, to) > 1
  ) {
    tags.push('king-span');
  }

  const earlyKingPlies = earlyKingPliesOf(g);
  const quietKing = !!(
    kind === 'move'
    && piece?.type === 'king'
    && !isCapture
    && !inCheck
    && !tags.includes('escape')
    && !tags.includes('king-run')
    && !tags.includes('take-checker')
    && !tags.some((t) => MUST_DO_TAKE_TAGS.has(t))
  );
  if (quietKing && history.length < earlyKingPlies) {
    const leaveBack = isBackRank(from, color) && !isBackRank(to, color);
    const shelterLow = countAdjacentFriendly(next, to, color) < 2;
    const intoCenter = isCenterSquare(to);
    if (leaveBack) {
      score += w.w_king_wander;
      tags.push('king-wander');
    }
    if (shelterLow || intoCenter) {
      score += w.w_king_exposed;
      tags.push('king-exposed');
    }
  }

  // Late game: quiet king walks while a shot/take exists. Early king-home
  // never fired on the maxed 10+10 (draws shuffled from ply ~40 to 220).
  if (
    kind === 'move'
    && piece?.type === 'king'
    && !isCapture
    && !inCheck
    && history.length >= 40
    && !tags.includes('gives-check')
    && !tags.includes('take-checker')
  ) {
    score += w.w_king_idle;
    tags.push('king-idle');
  }

  let isThrash = false;
  let isOscillation = false;
  if (kind === 'move' && piece) {
    const trail = pieceMoves(history, piece, from);
    const last = trail[trail.length - 1];
    const reversal = !!(last && samePos(last.from, to) && samePos(last.to, from));
    const twoCycle = twoSquareJob(trail, from, to);
    // Capture always allowed; "only check escape" is kept later if the pool is empty.
    const allowed = isCapture;
    if (twoCycle && !allowed) {
      isOscillation = true;
      isThrash = true;
      score += w.w_oscillation;
      tags.push('oscillation');
    } else if (reversal && !allowed) {
      isThrash = true;
      score += w.w_reversal;
      tags.push('reversal');
    }
  }

  let isBlindHangFlag = false;
  if (kind === 'move' && piece) {
    const hangProbe = { action, piece, target, isCapture, tags };
    if (isBlindHang(hangProbe, next, color)) {
      isBlindHangFlag = true;
      score += w.w_hangs_self;
      tags.push('hangs-self');
    }
  }

  // Bishop snipe must not expose an immediate recapture / counter.
  // Arrow-king that captures the king is a finish (do not tag). Check escape is allowed.
  if (
    piece
    && !inCheck
    && target?.type !== 'king'
    && !tags.includes('escape')
  ) {
    const snipeShot = kind === 'arrow'
      || (kind === 'move' && piece.type === 'bishop' && (
        tags.includes('bishop-aims-king')
        || tags.includes('arrow-checks-king')
        || tags.includes('gives-check')
      ));
    if (snipeShot) {
      const sit = kind === 'move' ? to : from;
      const ourVal = PIECE_VALUE[piece.type];
      const capturedVal = isCapture && target ? PIECE_VALUE[target.type] : 0;
      if (pieceHangsCheaply(next, sit, color, piece.type) && capturedVal < ourVal) {
        score += w.w_bishop_snipe_hangs;
        tags.push('bishop-snipe-hangs');
        if (kind === 'arrow') tags.push('arrow-exposes-counter');
      }
    }
  }

  // Power Q/R must not sit idle while hanging if a save exists (tagged here; dropped later).
  if (
    piece
    && !inCheck
    && !tags.includes('arrow-king')
    && !tags.includes('axe-king')
    && !tags.includes('escape')
  ) {
    const hanging = hangingPowerPieces(board, color);
    if (hanging.length && !actionSavesHangingPower(kind, from, to, isCapture, hanging, board, enemy)) {
      score += w.w_power_hangs_idle;
      tags.push('power-hangs-idle');
      tags.push('leaves-power-hanging');
    }
  }

  // Quiet Q/R must not walk into enemy arrow LOS or knight-axe (suicide snipe).
  if (
    kind === 'move'
    && piece
    && (piece.type === 'queen' || piece.type === 'rook' || piece.type === 'bishop')
    && !isCapture
    && !inCheck
    && !tags.includes('escape')
  ) {
    const arrowHit = enemyCanArrowPos(next, to, enemy);
    const axeHit = enemyCanAxePos(next, to, enemy);
    if ((arrowHit || axeHit) && pieceHangsCheaply(next, to, color, piece.type)) {
      score += w.w_walks_into_snipe;
      tags.push('walks-into-snipe');
      if (arrowHit) tags.push('power-into-arrow-lane');
    }
  }

  // Do not force a suicidal bishop develop (hangs-self / snipe-hang / walk-into-snipe).
  if ((hasUnsafeSelfTags(tags) || isBlindHangFlag) && tags.includes('develop-bishop')) {
    for (let i = tags.length - 1; i >= 0; i--) {
      if (tags[i] === 'develop-bishop') tags.splice(i, 1);
    }
  }

  // Late conversion. Flag-off genomes skip this entirely (round-1 behavior).
  // Forcing progress is a capture (including a near-equal trade), a check, or a
  // safe step toward the enemy king. Quiet shuffles and square-repeats are
  // penalized. Nothing here adds a move that was not in `legal`.
  if (lateConvFiring(g, board, color, history)) {
    const forcing = lateForcing(kind, isCapture, isThrash, tags);
    const repeat = !forcing && lateRepeat(history, piece, from, to, tags);
    const weight = Number.isFinite(w.w_late_conv) ? w.w_late_conv : 0;
    if (forcing) {
      score += weight;
      tags.push('late-conv');
      if (lateTrade(isCapture, piece, target)) tags.push('late-conv-trade');
    } else {
      if (lateQuiet(kind, isCapture, tags)) {
        score -= weight;
        tags.push('late-conv-quiet');
      }
      if (repeat) {
        score -= weight;
        tags.push('late-conv-repeat');
      }
    }
  }

  // Strategy-4. Every block is a no-op unless its genome flag is exactly true.
  // Nothing here appends an action that was not in the legal list.
  if (lookaheadBefore !== null && g.lookahead_enabled === true) {
    const scale = clampInt(g.lookahead_scale, 0, 2000, 400);
    const delta = fittedValue(next, color) - lookaheadBefore;
    score += delta * scale;
    tags.push('lookahead');
    if (delta > 1e-9) tags.push('lookahead-gain');
  }

  if (g.trade_down_enabled === true && isCapture && piece && target) {
    const margin = clampInt(g.trade_down_margin, 1, 9, 1);
    const lead = sideMaterial(board, color) - sideMaterial(board, enemy);
    const equalOrBetter = PIECE_VALUE[target.type] >= PIECE_VALUE[piece.type];
    if (
      lead >= margin
      && piece.type !== 'king'
      && target.type !== 'king'
      && equalOrBetter
      && !hasUnsafeSelfTags(tags)
      && !isBlindHangFlag
    ) {
      tags.push('trade-down');
    }
  }

  if (g.king_guard_enabled === true) {
    const plies = clampInt(g.king_guard_plies, 1, 60, 30);
    if (
      history.length + 1 < plies
      && kind === 'move'
      && piece?.type === 'king'
      && !(inCheck && escapesCheck)
      && !tags.includes('escape')
      && !tags.includes('king-run')
    ) {
      tags.push('king-step');
    }
  }

  if (
    g.illegal_filter_enabled === true
    && !inCheck
    && !boardEscapes
    && target?.type !== 'king'
  ) {
    tags.push('self-check');
  }

  // Strategy-5. Each block is a no-op unless its flag is exactly true.
  // Replies are engine captures only. Nothing here appends a legal action.
  const wantReply = g.quiescence_enabled === true || g.reply_safety_enabled === true || g.cover_enabled === true;
  const reply = wantReply && target?.type !== 'king' ? worstCaptureReply(next, color) : null;
  if (quiescenceBefore !== null && g.quiescence_enabled === true && target?.type !== 'king') {
    const scale = clampInt(g.quiescence_scale, 0, 2000, 400);
    let after = fittedValue(next, color);
    if (findPieces(next, enemy, 'king').length === 0) after = FIT_KING_GONE;
    else if (reply) {
      const attackerPiece = next[reply.from.row]?.[reply.from.col]?.piece;
      if (attackerPiece) {
        after = fittedValue(applyAction(next, reply.kind, reply.from, reply.to, attackerPiece), color);
      }
    }
    const delta = after - quiescenceBefore;
    score += delta * scale;
    tags.push('quiescence');
    if (delta > 1e-9) tags.push('quiescence-gain');
  }

  if (g.reply_safety_enabled === true && target?.type !== 'king') {
    const kingTaken = !boardEscapes || (reply != null && reply.victim >= PIECE_VALUE.king);
    if (kingTaken) tags.push('reply-unsafe');
  }

  if (
    g.hang_shield_enabled === true
    && target?.type !== 'king'
    && piece
    && powerEnPrise(next, color)
  ) {
    tags.push('hang-shield');
  }

  // Strategy-11. Hang-shield misses a defended queen or rook taken by an
  // equal or heavier attacker. The tag is a no-op unless the flag is exactly
  // true, and it does not change the score. Nothing here appends a square.
  if (
    g.cover_enabled === true
    && target?.type !== 'king'
    && reply
    && reply.victim >= PIECE_VALUE.rook
    && reply.victim < PIECE_VALUE.king
  ) {
    tags.push('qr-loose');
  }
  if (g.cover_enabled === true && isCoverGain({
    action: { from: '', to: '', kind },
    piece,
    target,
    isCapture,
    tags,
    isBlindHang: isBlindHangFlag,
  } as Scored)) {
    tags.push('cover-gain');
  }

  // Strategy-12 seal. A check whose every sure reply hangs a queen or rook.
  // The score does not change. Nothing here appends a square.
  if (
    g.seal_enabled === true
    && tags.includes('gives-check')
    && target?.type !== 'king'
    && forcedQrReplies(next, color)
  ) {
    tags.push('qr-force');
  }

  // Strategy-12 press. Closer steps, mates, and safe shots. No lead required.
  // King steps are not tagged, so this cannot add an early king walk.
  if (pressFiring(g, history) && piece) {
    const probe = {
      action,
      tags,
      isBlindHang: isBlindHangFlag,
    } as Scored;
    const unsafe = pressUnsafe(probe);
    const takesKing = target?.type === 'king' && (kind === 'move' || kind === 'arrow' || kind === 'axe');
    const noFlight = tags.includes('gives-check') && enemyKingHasNoFlight(next, color);
    const closer = kind === 'move'
      && piece.type !== 'king'
      && tags.includes('approach')
      && !unsafe;
    const shot = (kind === 'arrow' || kind === 'axe')
      && !unsafe
      && (
        isCapture
        || tags.includes('gives-check')
        || tags.includes('bishop-aims-king')
        || tags.includes('arrow-king')
        || tags.includes('arrow-checks-king')
      );
    if ((takesKing && !unsafe) || (noFlight && !unsafe) || closer || shot) tags.push('press');
  }

  // Strategy-6. No-op unless the flag is exactly true. Replies are the enemy
  // king's engine-legal steps only. Nothing here appends a legal action.
  let escapeValue: number | undefined;
  if (g.escape_first_enabled === true && inCheck && escapesCheck && target?.type !== 'king') {
    escapeValue = fittedValue(next, color);
  }

  if (netBefore && stickyBefore !== null && piece) {
    const reply = target?.type === 'king'
      ? { value: FIT_KING_GONE, flights: 0, inCheck: false }
      : kingReply(next, color);
    const sticky = target?.type === 'king' ? FIT_KING_GONE : stickyKingValue(next, color);
    const margin = clampInt(g.mate_net_margin, 1, 9, 1);
    const lead = sideMaterial(board, color) - sideMaterial(board, enemy);
    const ahead = lead >= margin;
    const tight = target?.type === 'king'
      || (reply.inCheck && reply.flights === 0)
      || (sticky - stickyBefore) > NET_EPS
      || (!reply.inCheck && reply.flights < netBefore.flights);
    const isBishopShot = piece.type === 'bishop' && (
      kind === 'arrow'
      || tags.includes('bishop-aims-king')
      || tags.includes('gives-check')
      || tags.includes('arrow-checks-king')
      || tags.includes('arrow-pawn')
      || tags.includes('arrow-king')
    );
    const winsMaterial = !!(
      isCapture && target && target.color === enemy && target.type !== 'king' && (PIECE_VALUE[target.type] ?? 0) > 0
    );
    let shotWaste = false;
    if (g.shot_filter_enabled === true && isBishopShot && !winsMaterial && !tight && target?.type !== 'king') {
      tags.push('shot-waste');
      shotWaste = true;
    }
    if (g.mate_net_enabled === true && ahead && !shotWaste) {
      const scale = clampInt(g.mate_net_scale, 0, 2000, 400);
      let mate = target?.type === 'king' || (reply.inCheck && reply.flights === 0);
      if (target?.type !== 'king') {
        const delta = reply.value - netBefore.value;
        if (delta > NET_EPS) {
          score += delta * scale;
          mate = true;
        }
        if (!reply.inCheck && reply.flights < netBefore.flights) {
          score += Math.round(scale * 0.1) * (netBefore.flights - reply.flights);
          mate = true;
        }
      }
      if (mate) tags.push('mate-net');
    }
    if (
      g.king_hunt_enabled === true
      && ahead
      && history.length >= 40
      && nonKingMaterial(board) <= clampInt(g.king_hunt_max_material, 1, 40, 14)
      && kind === 'move'
      && piece.type === 'king'
      && enemyKing
      && chebyshev(to, enemyKing) < chebyshev(from, enemyKing)
      && boardEscapes
      && !tags.includes('reply-unsafe')
      && !tags.includes('hang-shield')
      && !tags.includes('walks-into-snipe')
      && !isBlindHangFlag
      && fittedValue(next, color) >= fittedValue(board, color) - NET_EPS
    ) {
      tags.push('king-hunt');
      if (tags.includes('king-idle')) score -= w.w_king_idle;
      if (tags.includes('king-exposed')) score -= w.w_king_exposed;
      if (tags.includes('king-wander')) score -= w.w_king_wander;
      score += 160;
    }
  }

  // Strategy-7. No-op unless the flag is exactly true. Replies are the enemy
  // king's engine-legal steps, same as strategy-6. Nothing here appends a move.
  if ((g.finish_enabled === true || g.king_help_enabled === true) && piece && netBefore && stickyBefore !== null) {
    const margin = clampInt(g.finish_margin, 1, 9, 1);
    const lead = sideMaterial(board, color) - sideMaterial(board, enemy);
    const ahead = lead >= margin;
    const reply = target?.type === 'king'
      ? { value: FIT_KING_GONE, flights: 0, inCheck: false }
      : kingReply(next, color);
    const sticky = target?.type === 'king' ? FIT_KING_GONE : stickyKingValue(next, color);
    // In-check flight loss is the king being in check, not a covered square.
    // Strategy-6 uses the same cut: only a quiet move removes a flight.
    // A check the king steps off does not raise sticky value and is waste.
    const flightCut = !reply.inCheck && reply.flights < netBefore.flights;
    const tight = target?.type === 'king'
      || (reply.inCheck && reply.flights === 0)
      || (sticky - stickyBefore) > NET_EPS
      || flightCut;
    const lateEnough = history.length >= clampInt(g.finish_ply, 40, 180, 40);
    if (
      g.finish_enabled === true
      && ahead
      && lateEnough
      && tags.includes('gives-check')
      && !isCapture
      && target?.type !== 'king'
      && !tight
    ) {
      tags.push('check-waste');
    }
    const helpPly = clampInt(g.king_help_ply, 40, 180, 80);
    const helpCap = clampInt(g.king_help_max_enemy, 1, 40, 12);
    if (
      g.king_help_enabled === true
      && ahead
      && history.length >= helpPly
      && sideMaterial(board, enemy) <= helpCap
      && kind === 'move'
      && piece.type === 'king'
      && enemyKing
      && chebyshev(to, enemyKing) < chebyshev(from, enemyKing)
      && boardEscapes
      && !tags.includes('reply-unsafe')
      && !tags.includes('hang-shield')
      && !tags.includes('walks-into-snipe')
      && !isBlindHangFlag
      && fittedValue(next, color) >= fittedValue(board, color) - NET_EPS
    ) {
      tags.push('king-help');
      if (tags.includes('king-idle')) score -= w.w_king_idle;
      if (tags.includes('king-exposed')) score -= w.w_king_exposed;
      if (tags.includes('king-wander')) score -= w.w_king_wander;
      score += 160;
    }
    if (g.finish_enabled === true && ahead && lateEnough && !tags.includes('check-waste')) {
      const unsafe = hasUnsafeSelfTags(tags)
        || tags.includes('hang-shield')
        || tags.includes('reply-unsafe')
        || isBlindHangFlag;
      const safeCapture = !!(isCapture && target && !unsafe);
      const safeApproach = kind === 'move'
        && piece.type !== 'king'
        && tags.includes('approach')
        && !isThrash
        && !unsafe
        && !tags.includes('reversal')
        && !tags.includes('oscillation');
      if (
        target?.type === 'king'
        || (tight && tags.includes('gives-check') && !unsafe)
        || safeCapture
        || safeApproach
        || flightCut
        || tags.includes('king-help')
        || tags.includes('king-hunt')
        || tags.includes('mate-net')
      ) {
        tags.push('finish');
      }
    }
  }

  // Strategy-8 convert. No-op unless the flag is exactly true. A safe arrow
  // or axe, or a capture worth more than the mover, is tagged. An equal
  // queen or rook trade is not. The drop happens later, and only when one
  // of these remains. Nothing here appends a square.
  if (g.convert_enabled === true && piece && !tags.includes('king-span')) {
    const margin = clampInt(g.convert_margin, 1, 9, 1);
    const lead = sideMaterial(board, color) - sideMaterial(board, enemy);
    const lateEnough = history.length >= clampInt(g.convert_ply, 40, 180, 40);
    if (lead >= margin && lateEnough) {
      const unsafe = hasUnsafeSelfTags(tags)
        || tags.includes('hang-shield')
        || tags.includes('reply-unsafe')
        || tags.includes('shot-waste')
        || tags.includes('check-waste')
        || tags.includes('self-check')
        || isBlindHangFlag;
      const arrowOrAxe = (kind === 'arrow' || kind === 'axe')
        && (isCapture || tags.includes('gives-check'));
      const winningCapture = !!(
        isCapture
        && target
        && target.type !== 'king'
        && (PIECE_VALUE[target.type] ?? 0) > (PIECE_VALUE[piece.type] ?? 0)
      );
      const takesKing = target?.type === 'king' && (kind === 'move' || kind === 'arrow' || kind === 'axe');
      if (!unsafe && (arrowOrAxe || winningCapture || takesKing)) tags.push('convert');
    }
  }

  if (g.progress_enabled === true) {
    const margin = clampInt(g.progress_margin, 1, 9, 1);
    const lead = sideMaterial(board, color) - sideMaterial(board, enemy);
    if (lead >= margin) {
      if (target?.type === 'king' && (kind === 'move' || kind === 'arrow' || kind === 'axe')) {
        tags.push('progress');
      } else {
        const unsafe = hasUnsafeSelfTags(tags)
          || tags.includes('hang-shield')
          || tags.includes('reply-unsafe')
          || tags.includes('shot-waste')
          || isBlindHangFlag;
        const winningCapture = !!(
          isCapture
          && target
          && piece
          && !unsafe
          && (
            PIECE_VALUE[target.type] > PIECE_VALUE[piece.type]
            || tags.includes('hanging')
            || tags.includes('hanging-pawn')
            || tags.includes('arrow-hanging')
            || tags.includes('axe-valuable')
          )
        );
        const safeCheck = tags.includes('gives-check') && !unsafe && !tags.includes('check-waste');
        const safeApproach = kind === 'move'
          && !!piece
          && piece.type !== 'king'
          && tags.includes('approach')
          && !isThrash
          && !unsafe
          && !tags.includes('reversal')
          && !tags.includes('oscillation')
          && !tags.includes('king-wander');
        if (winningCapture || safeCheck || safeApproach) tags.push('progress');
      }
    }
  }

  return {
    action,
    from,
    to,
    piece,
    target,
    escapesCheck,
    diceCapture,
    boardEscapes,
    isCapture,
    isThrash,
    isOscillation,
    isWalkOffFork,
    isBlindHang: isBlindHangFlag,
    score,
    tags,
    escapeValue,
  };
}

function toRanked(s: Scored, rejectReason?: string): RankedAction {
  return {
    ...s.action,
    score: s.score,
    tags: s.tags,
    rejectReason,
  };
}

function isPressureAction(s: Scored): boolean {
  return s.isCapture || s.tags.includes('gives-check') || s.action.kind === 'arrow';
}

function isWallOrBomb(s: Scored): boolean {
  return s.action.kind === 'wall' || s.action.kind === 'bomb';
}

/** Never rank wall/bomb above capture, check, or arrow. */
function compareRank(a: Scored, b: Scored): number {
  if (isWallOrBomb(a) && !isWallOrBomb(b) && isPressureAction(b)) return 1;
  if (isWallOrBomb(b) && !isWallOrBomb(a) && isPressureAction(a)) return -1;
  // The tag exists only while fetch is firing, and only on a loose early
  // check. Every other move sorts ahead of it, including the non-checking
  // arrow and a minor capture. A king capture is not marked. Nothing is
  // dropped. The score does not change.
  const aSkip = a.tags.includes('fetch-skip');
  const bSkip = b.tags.includes('fetch-skip');
  if (aSkip !== bSkip) return aSkip ? 1 : -1;
  // The tag exists only while grip is firing, and only on a checking pawn
  // arrow or an arrow that takes a queen or rook. Every other move sorts
  // ahead of it. A second arrow is not tagged, so this does not bury a
  // non-checking pawn shot. A king capture is not marked. Nothing is dropped.
  const aGripSkip = a.tags.includes('grip-skip');
  const bGripSkip = b.tags.includes('grip-skip');
  if (aGripSkip !== bGripSkip) return aGripSkip ? 1 : -1;
  // The tag exists only while blunt is firing, and only on a queen or rook
  // capture or a checking pawn arrow. Every other move sorts ahead of it.
  // A non-checking pawn arrow is not marked, so this does not bury the shot
  // blunt just ranked. A king capture is not marked. Nothing is dropped.
  const aBluntSkip = a.tags.includes('blunt-skip');
  const bBluntSkip = b.tags.includes('blunt-skip');
  if (aBluntSkip !== bBluntSkip) return aBluntSkip ? 1 : -1;
  // The tag exists only while sift is firing. A capture, a check, or an
  // arrow keeps its score order. A quiet shuffle does not.
  const aSift = a.tags.includes('sift');
  const bSift = b.tags.includes('sift');
  if (aSift !== bSift) {
    const other = aSift ? b : a;
    const quiet = !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aSift ? -1 : 1;
  }
  // The tag exists only while prod is firing. It jumps a quiet queen or rook
  // and a queen or rook capture. Every other move keeps its score order.
  const aProd = a.tags.includes('prod');
  const bProd = b.tags.includes('prod');
  if (aProd !== bProd) {
    const other = aProd ? b : a;
    if (isQuietQrStep(other) || capturesQr(other)) return aProd ? -1 : 1;
  }
  // A repeating bomb or wall sorts after every other move still in the
  // pool. The tag exists only while string is firing. The move stays legal.
  const aRepeat = a.tags.includes('string-repeat');
  const bRepeat = b.tags.includes('string-repeat');
  if (aRepeat !== bRepeat) return aRepeat ? 1 : -1;
  // The tag exists only while string is firing, and only on one safe bishop
  // arrow at a pawn or a king. It jumps a quiet shuffle and a queen or rook
  // capture. A non-QR capture, an escape, an axe, and a check that is not a
  // bomb or a wall keep their order. Nothing is dropped.
  const aString = a.tags.includes('string');
  const bString = b.tags.includes('string');
  if (aString !== bString) {
    const other = aString ? b : a;
    const nonBombCheck = other.tags.includes('gives-check')
      && other.action.kind !== 'bomb'
      && other.action.kind !== 'wall';
    const held = (other.isCapture && !capturesQr(other))
      || other.tags.includes('escape')
      || other.tags.includes('escape-best')
      || other.action.kind === 'axe'
      || nonBombCheck;
    if (!held) return aString ? -1 : 1;
  }
  // The tag exists only while bolt is firing, and only on one safe knight
  // or bishop capture. It jumps a pawn arrow and a quiet non-capture.
  // Other captures, escapes, checks, and axes keep their order. Nothing
  // is dropped. The score does not change.
  const aBolt = a.tags.includes('bolt');
  const bBolt = b.tags.includes('bolt');
  if (aBolt !== bBolt) {
    const other = aBolt ? b : a;
    if (isPawnArrow(other) || isQuietNonCapture(other)) return aBolt ? -1 : 1;
  }
  // The tag exists only while quill is firing, and only on one quiet queen
  // or rook step that steps off an attack while a flight or nock shot is
  // already tagged. It jumps that shot and any other quiet shuffle. A
  // capture, a check, an escape, a fork, an arrow, and an axe keep their
  // order. The score does not change. Nothing is dropped.
  const aQuill = a.tags.includes('quill');
  const bQuill = b.tags.includes('quill');
  if (aQuill !== bQuill) {
    const other = aQuill ? b : a;
    const held = other.isCapture
      || other.tags.includes('gives-check')
      || other.tags.includes('escape')
      || other.tags.includes('escape-best')
      || other.tags.includes('fork')
      || other.action.kind === 'arrow'
      || other.action.kind === 'axe';
    if (!held) return aQuill ? -1 : 1;
  }
  // The tag exists only while nock is firing, and only in a pool that has
  // no capture, arrow, axe, or check. It jumps a quiet shuffle. A capture,
  // a check, or an arrow keeps its score order.
  const aNock = a.tags.includes('nock');
  const bNock = b.tags.includes('nock');
  if (aNock !== bNock) {
    const other = aNock ? b : a;
    const quiet = !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aNock ? -1 : 1;
  }
  // The tag exists only while fletch is firing, and only in a pool that has
  // no capture, arrow, axe, check, or nock aim. It jumps a quiet shuffle.
  // It does not jump a nock-tagged move. A capture, a check, or an arrow
  // keeps its score order.
  const aFletch = a.tags.includes('fletch');
  const bFletch = b.tags.includes('fletch');
  if (aFletch !== bFletch) {
    const other = aFletch ? b : a;
    const quiet = !other.tags.includes('nock')
      && !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aFletch ? -1 : 1;
  }
  // The tag exists only while pile is firing, and only in a pool that has
  // no capture, arrow, axe, check, or nock aim. It jumps a quiet shuffle.
  // It does not jump a nock-tagged or fletch-tagged move. A capture, a
  // check, or an arrow keeps its score order.
  const aPile = a.tags.includes('pile');
  const bPile = b.tags.includes('pile');
  if (aPile !== bPile) {
    const other = aPile ? b : a;
    const quiet = !other.tags.includes('nock')
      && !other.tags.includes('fletch')
      && !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aPile ? -1 : 1;
  }
  // The tag exists only while haft is firing, and only in a pool that has
  // no capture, arrow, axe, check, or nock aim. It jumps a quiet shuffle,
  // including a knight fork. It does not jump a nock-tagged, fletch-tagged,
  // or pile-tagged move. A capture, a check, or an arrow keeps its score.
  const aHaft = a.tags.includes('haft');
  const bHaft = b.tags.includes('haft');
  if (aHaft !== bHaft) {
    const other = aHaft ? b : a;
    const quiet = !other.tags.includes('nock')
      && !other.tags.includes('fletch')
      && !other.tags.includes('pile')
      && !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aHaft ? -1 : 1;
  }
  // The tag exists only while quarrel is firing, and only on the score-best
  // quiet non-king step that was not already a hint. It is not a check. It
  // does not jump a nock, fletch, pile, or haft tag. A capture, a check, an
  // arrow, or an axe keeps its score order. A quiet shuffle does not.
  const aQuarrel = a.tags.includes('quarrel');
  const bQuarrel = b.tags.includes('quarrel');
  if (aQuarrel !== bQuarrel) {
    const other = aQuarrel ? b : a;
    const quiet = !other.tags.includes('nock')
      && !other.tags.includes('fletch')
      && !other.tags.includes('pile')
      && !other.tags.includes('haft')
      && !other.tags.includes('gives-check')
      && !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aQuarrel ? -1 : 1;
  }
  // The tag exists only while bodkin is firing, and only on one knight or
  // bishop step that got closer to the enemy king. It jumps a quiet queen
  // or rook. It does not jump a nock, fletch, pile, haft, or quarrel tag,
  // a knight fork, a capture, a check, an arrow, or an axe.
  const aBodkin = a.tags.includes('bodkin');
  const bBodkin = b.tags.includes('bodkin');
  if (aBodkin !== bBodkin) {
    const other = aBodkin ? b : a;
    const heavy = isQuietQrStep(other)
      && !other.tags.includes('nock')
      && !other.tags.includes('fletch')
      && !other.tags.includes('pile')
      && !other.tags.includes('haft')
      && !other.tags.includes('quarrel');
    if (heavy) return aBodkin ? -1 : 1;
  }
  // The tag exists only while spine is firing, and only on one quiet queen
  // or rook step that clears a cheap hang and leaves a safe pawn arrow.
  // It jumps a quiet shuffle, including flight. It does not jump a nock,
  // fletch, pile, haft, quarrel, or bodkin tag, a fork, a capture, a check,
  // an arrow, or an axe. Nothing is dropped. The score does not change.
  const aSpine = a.tags.includes('spine');
  const bSpine = b.tags.includes('spine');
  if (aSpine !== bSpine) {
    const other = aSpine ? b : a;
    const held = other.tags.includes('nock')
      || other.tags.includes('fletch')
      || other.tags.includes('pile')
      || other.tags.includes('haft')
      || other.tags.includes('quarrel')
      || other.tags.includes('bodkin')
      || other.tags.includes('fork')
      || other.tags.includes('gives-check')
      || other.tags.includes('escape')
      || other.tags.includes('escape-best')
      || other.isCapture
      || other.action.kind === 'arrow'
      || other.action.kind === 'axe';
    if (!held) return aSpine ? -1 : 1;
  }
  // The tag exists only while broadhead is firing, and only on one capture
  // that makes a safe pawn arrow exist. It jumps a quiet shuffle. It does
  // not jump a nock, crest, or flight tag, a fork, a capture, a check, an
  // arrow, or an axe. Nothing is dropped. The score does not change.
  const aBroad = a.tags.includes('broadhead');
  const bBroad = b.tags.includes('broadhead');
  if (aBroad !== bBroad) {
    const other = aBroad ? b : a;
    const held = other.tags.includes('nock')
      || other.tags.includes('crest')
      || other.tags.includes('flight')
      || other.tags.includes('fork')
      || other.tags.includes('gives-check')
      || other.tags.includes('escape')
      || other.tags.includes('escape-best')
      || other.isCapture
      || other.action.kind === 'arrow'
      || other.action.kind === 'axe';
    if (!held) return aBroad ? -1 : 1;
  }
  // The tag exists only while shaft is firing, and only on one quiet
  // bishop, knight, or pawn step that makes a safe pawn arrow exist. It
  // jumps a quiet queen or rook step. It does not jump a capture, a check,
  // an escape, a fork, an arrow, an axe, a nock, crest, or flight tag, or
  // any other quiet. Nothing is dropped. The score does not change.
  const aShaft = a.tags.includes('shaft');
  const bShaft = b.tags.includes('shaft');
  if (aShaft !== bShaft) {
    const other = aShaft ? b : a;
    if (isQuietQrStep(other)) return aShaft ? -1 : 1;
  }
  // The tag exists only while anchor is firing, and only on one save that
  // strictly reduces the hanging-bishop count. It jumps a quiet non-save.
  // It does not jump an arrow, an axe, a capture, a check, an escape, a
  // fork, a finish, a mate-net, a king step, or a flight, nock, or crest
  // tag. Nothing is dropped. The score does not change.
  const aAnchor = a.tags.includes('anchor');
  const bAnchor = b.tags.includes('anchor');
  if (aAnchor !== bAnchor) {
    const other = aAnchor ? b : a;
    if (anchorJumps(other)) return aAnchor ? -1 : 1;
  }
  // The tag exists only while cast is firing, and only on one quiet bishop
  // step that adds a pawn ray. It jumps a quiet approach, including a
  // finish approach. It does not jump an arrow, an axe, a capture, a
  // check, an escape, a fork, a mate-net, a king step, or a flight, nock,
  // crest, or anchor tag. Nothing is dropped. The score does not change.
  const aCast = a.tags.includes('cast');
  const bCast = b.tags.includes('cast');
  if (aCast !== bCast) {
    const other = aCast ? b : a;
    if (castJumps(other)) return aCast ? -1 : 1;
  }
  // The tag exists only while flight is firing, and only on one pawn or
  // knight step that sets up a bishop pawn-shot. An immediate knight uncover
  // raises the pawn-arrow count. A pawn step does not: it only clears a
  // square the bishop can step onto. It jumps a quiet shuffle, including a
  // crest step, a brace step, a mark step, a rook slide, and a quiet king
  // step. It does not jump a nock, fletch, pile, haft, quarrel, or bodkin
  // tag, a knight fork, a capture, a check, an arrow, or an axe.
  const aFlight = a.tags.includes('flight');
  const bFlight = b.tags.includes('flight');
  if (aFlight !== bFlight) {
    const other = aFlight ? b : a;
    const quiet = !other.tags.includes('nock')
      && !other.tags.includes('fletch')
      && !other.tags.includes('pile')
      && !other.tags.includes('haft')
      && !other.tags.includes('quarrel')
      && !other.tags.includes('bodkin')
      && !other.tags.includes('fork')
      && !other.tags.includes('gives-check')
      && other.action.kind !== 'axe'
      && !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aFlight ? -1 : 1;
  }
  // The tag exists only while barb is firing. One pawn, knight, or bishop
  // capture of a pawn, knight, or bishop that strips a piece within two
  // squares of the enemy king, or that opens a bishop pawn-shot. It jumps a
  // quiet move, a non-capturing check, and a capture of less material. It
  // also jumps an equal capture that is not a free hanging piece. It does
  // not jump an arrow, an axe, an escape, a nock, a flight, a fork, a
  // mate-net, or a capture of a king, a queen, a rook, a strictly greater
  // victim, or a free hanging piece of equal value. Finish is not a hold.
  // The score does not change.
  const aBarb = a.tags.includes('barb');
  const bBarb = b.tags.includes('barb');
  if (aBarb !== bBarb) {
    const tagged = aBarb ? a : b;
    const other = aBarb ? b : a;
    if (!barbHeld(other, tagged)) return aBarb ? -1 : 1;
  }
  // The tag exists only while clout is firing. One queen or rook check that
  // cuts the enemy king's flights, or one rook bomb that opens more of those
  // checks. It jumps a quiet shuffle and a check that did not cut a flight.
  // It does not jump a capture, an arrow, an axe, an escape, a nock, a
  // flight, or a fork. A bomb stays under a check because of the wall rule
  // above. The score does not change.
  const aClout = a.tags.includes('clout');
  const bClout = b.tags.includes('clout');
  if (aClout !== bClout) {
    const tagged = aClout ? a : b;
    const other = aClout ? b : a;
    const held = other.tags.includes('nock')
      || other.tags.includes('flight')
      || other.tags.includes('fork')
      || other.tags.includes('escape')
      || other.tags.includes('escape-best')
      || other.isCapture
      || other.action.kind === 'arrow'
      || other.action.kind === 'axe'
      || (isWallOrBomb(tagged) && other.tags.includes('gives-check'));
    if (!held) return aClout ? -1 : 1;
  }
  // The tag exists only while crest is firing, and only on one bishop step
  // that got closer to the nearest enemy pawn without opening a pawn ray or
  // a queen ray. It jumps a quiet shuffle. It does not jump a nock, fletch,
  // pile, haft, quarrel, or bodkin tag, a knight fork, a capture, a check,
  // an arrow, or an axe.
  const aCrest = a.tags.includes('crest');
  const bCrest = b.tags.includes('crest');
  if (aCrest !== bCrest) {
    const other = aCrest ? b : a;
    const quiet = !other.tags.includes('nock')
      && !other.tags.includes('fletch')
      && !other.tags.includes('pile')
      && !other.tags.includes('haft')
      && !other.tags.includes('quarrel')
      && !other.tags.includes('bodkin')
      && !other.tags.includes('fork')
      && !other.tags.includes('gives-check')
      && !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aCrest ? -1 : 1;
  }
  // The tag exists only while brace is firing, and only on one pawn step
  // that gave a bishop a new legal step without opening a pawn ray or a
  // queen ray. It jumps a quiet shuffle, including a knight develop, a rook
  // slide, and a quiet king step. It does not jump a nock, fletch, pile,
  // haft, quarrel, bodkin, or crest tag, a knight fork, a capture, a check,
  // an arrow, or an axe.
  const aBrace = a.tags.includes('brace');
  const bBrace = b.tags.includes('brace');
  if (aBrace !== bBrace) {
    const other = aBrace ? b : a;
    const quiet = !other.tags.includes('nock')
      && !other.tags.includes('fletch')
      && !other.tags.includes('pile')
      && !other.tags.includes('haft')
      && !other.tags.includes('quarrel')
      && !other.tags.includes('bodkin')
      && !other.tags.includes('crest')
      && !other.tags.includes('fork')
      && !other.tags.includes('gives-check')
      && other.action.kind !== 'axe'
      && !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aBrace ? -1 : 1;
  }
  // The tag exists only while mark is firing, and only on one knight step
  // that got closer to the nearest enemy pawn without adding an attack on
  // a queen or a rook. It jumps a quiet shuffle, including a rook slide and
  // a quiet king step. It does not jump a nock, fletch, pile, haft, quarrel,
  // bodkin, crest, or brace tag, a knight fork, a capture, a check, an
  // arrow, or an axe.
  const aMark = a.tags.includes('mark');
  const bMark = b.tags.includes('mark');
  if (aMark !== bMark) {
    const other = aMark ? b : a;
    const quiet = !other.tags.includes('nock')
      && !other.tags.includes('fletch')
      && !other.tags.includes('pile')
      && !other.tags.includes('haft')
      && !other.tags.includes('quarrel')
      && !other.tags.includes('bodkin')
      && !other.tags.includes('crest')
      && !other.tags.includes('brace')
      && !other.tags.includes('fork')
      && !other.tags.includes('gives-check')
      && other.action.kind !== 'axe'
      && !isPressureAction(other)
      && !other.tags.includes('escape')
      && !other.tags.includes('escape-best');
    if (quiet) return aMark ? -1 : 1;
  }
  // The tag exists only while latch is firing, and only on one quiet pawn,
  // knight, or bishop step that closed a bishop ray on our king. A clear
  // ray is check, so flight, nock, and crest have already run on the
  // escapes that remain. This does not jump those tags, a capture, a
  // check, a fork, or a bishop, knight, or pawn. It does jump a quiet
  // queen, rook, or king step, including the king or rook that only steps
  // off the ray. Nothing is dropped. The score does not change.
  const aLatch = a.tags.includes('latch');
  const bLatch = b.tags.includes('latch');
  if (aLatch !== bLatch) {
    const other = aLatch ? b : a;
    if (latchJumps(other)) return aLatch ? -1 : 1;
  }
  // The tag exists only while sighter is firing, and only on one quiet
  // rook or queen slide that newly attacks an undefended pawn. Nock,
  // flight, and crest have already been given the stall. This jumps a
  // quiet queen, rook, or king step. It does not jump a bishop, a knight,
  // a pawn, a capture, an arrow, an axe, a check, an escape, a fork, or a
  // flight, nock, or crest tag. Nothing is dropped. The score does not
  // change.
  const aSighter = a.tags.includes('sighter');
  const bSighter = b.tags.includes('sighter');
  if (aSighter !== bSighter) {
    const other = aSighter ? b : a;
    if (sighterJumps(other)) return aSighter ? -1 : 1;
  }
  // The tag exists only while pluck is firing, and only on one quiet pawn,
  // knight, or bishop step that newly attacks an enemy piece. Nock, flight,
  // and crest have already been given the stall. This jumps a quiet queen,
  // rook, or king step. It does not jump a bishop, a knight, a pawn, a
  // capture, an arrow, an axe, a check, an escape, a fork, or a flight,
  // nock, or crest tag. Nothing is dropped. The score does not change.
  const aPluck = a.tags.includes('pluck');
  const bPluck = b.tags.includes('pluck');
  if (aPluck !== bPluck) {
    const other = aPluck ? b : a;
    if (pluckJumps(other)) return aPluck ? -1 : 1;
  }
  // The tag exists only while fetch is firing, and only on one safe
  // non-checking arrow or one safe minor capture. The loose check is
  // already last. This still jumps that check and a quiet queen, rook, or
  // king step. It does not jump a non-checking arrow, a capture, a king
  // capture, or a flight, nock, or crest tag. Nothing is dropped.
  const aFetch = a.tags.includes('fetch');
  const bFetch = b.tags.includes('fetch');
  if (aFetch !== bFetch) {
    const other = aFetch ? b : a;
    if (fetchJumps(other)) return aFetch ? -1 : 1;
  }
  // The tag exists only while grip is firing, and only on one safe minor
  // capture. The bad arrow is already last. This still jumps that arrow
  // and a quiet king step. It does not jump a non-checking arrow, another
  // capture, or a flight, nock, or crest tag. Nothing is dropped.
  const aGrip = a.tags.includes('grip');
  const bGrip = b.tags.includes('grip');
  if (aGrip !== bGrip) {
    const other = aGrip ? b : a;
    if (gripJumps(other)) return aGrip ? -1 : 1;
  }
  // The tag exists only while blunt is firing, and only on one safe minor
  // shot. The bad tactic is already last. This still jumps that tactic and
  // a quiet non-capture. It does not jump another capture, a non-checking
  // arrow, a king capture, or a flight, nock, or crest tag. Nothing is dropped.
  const aBlunt = a.tags.includes('blunt');
  const bBlunt = b.tags.includes('blunt');
  if (aBlunt !== bBlunt) {
    const other = aBlunt ? b : a;
    if (bluntJumps(other)) return aBlunt ? -1 : 1;
  }
  // The tag exists only while quarry is firing, and only on one quiet
  // queen or rook step that got closer to the enemy king. Nock, crest, and
  // flight already ran, and each of them jumps a quiet queen, so this does
  // not retune those layers. It jumps a quiet approach that is not one of
  // those tags, including a finish approach, a quiet king step, and a
  // quieter queen or rook step. It does not jump an arrow, an axe, a
  // capture, a check, an escape, a fork, a king-hunt, or a king-help.
  // Nothing is dropped. The score does not change.
  const aQuarry = a.tags.includes('quarry');
  const bQuarry = b.tags.includes('quarry');
  if (aQuarry !== bQuarry) {
    const other = aQuarry ? b : a;
    if (quarryJumps(other)) return aQuarry ? -1 : 1;
  }
  return b.score - a.score;
}

/**
 * Strategy-46 reply2. Win-points, not the lookahead logit.
 * material +30 per SD, king exposure -18 per SD. Mobility, king cover,
 * tempo, and hanging_power are not scored. Same raw features as fittedValue.
 */
const REPLY2_MAT_PER_SD = 30;
const REPLY2_EXP_PER_SD = -18;
const REPLY2_WIN = 100;
const REPLY2_MAX_CANDIDATES = 12;
const REPLY2_MAX_REPLIES = 32;
const REPLY2_HANG_CAP = 48;

function reply2Firing(g: PolicyGenome, history: Move[]): boolean {
  if (g.reply2_enabled !== true) return false;
  return history.length >= clampInt(g.reply2_ply, 0, 180, 0);
}

function reply2Features(board: Board, color: PlayerColor): { mat: number; exp: number; us: boolean; them: boolean } {
  const enemy = enemyOf(color);
  const ourKing = findPieces(board, color, 'king')[0];
  const theirKing = findPieces(board, enemy, 'king')[0];
  let ourMat = 0;
  let theirMat = 0;
  let ourExp = 0;
  let theirExp = 0;
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const piece = board[row]?.[col]?.piece;
      if (!piece) continue;
      const pos = { row, col };
      const points = MODEL_VALUE[piece.type] ?? 0;
      const arrows = piece.type === 'bishop' ? getArrowTargets(board, pos).length : 0;
      if (piece.color === color) ourMat += points + arrows;
      else theirMat += points + arrows;
      if (piece.type === 'bishop' && piece.color !== color && ourKing) {
        if (getArrowTargets(board, pos).some((t) => samePos(t, ourKing))) ourExp++;
      }
      if (piece.type === 'bishop' && piece.color === color && theirKing) {
        if (getArrowTargets(board, pos).some((t) => samePos(t, theirKing))) theirExp++;
      }
      if (piece.type === 'knight' && piece.color !== color && ourKing) {
        if (chebyshev(pos, ourKing) > 0 && chebyshev(pos, ourKing) <= 2) ourExp++;
      }
      if (piece.type === 'knight' && piece.color === color && theirKing) {
        if (chebyshev(pos, theirKing) > 0 && chebyshev(pos, theirKing) <= 2) theirExp++;
      }
    }
  }
  return {
    mat: ourMat - theirMat,
    exp: ourExp - theirExp,
    us: !!ourKing,
    them: !!theirKing,
  };
}

/** Win-points for `color`. Their missing king is a win. Ours missing is a loss. */
function reply2Value(board: Board, color: PlayerColor): number {
  const f = reply2Features(board, color);
  if (!f.them) return REPLY2_WIN;
  if (!f.us) return -REPLY2_WIN;
  return REPLY2_MAT_PER_SD * (f.mat / FIT_MAT_SD) + REPLY2_EXP_PER_SD * (f.exp / FIT_EXP_SD);
}

interface Reply2Move {
  from: Position;
  to: Position;
  kind: ActionKind;
  piece: Piece;
  victimType: PieceType | null;
}

function reply2Priority(r: Reply2Move): number {
  if (r.victimType === 'king') return 0;
  if (r.victimType === 'queen') return 1;
  if (r.victimType === 'rook') return 2;
  if (r.victimType) return 3;
  if (r.kind === 'arrow' || r.kind === 'axe') return 4;
  if (r.piece.type === 'knight' || r.piece.type === 'bishop') return 5;
  return 6;
}

/** Opponent legal replies. Captures, arrows, axes, knight and bishop moves, then the rest. */
function listReplies(board: Board, enemy: PlayerColor, us: PlayerColor): Reply2Move[] {
  const out: Reply2Move[] = [];
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const piece = board[row][col].piece;
      if (!piece || piece.color !== enemy) continue;
      const from = { row, col };
      const add = (to: Position, kind: ActionKind) => {
        const occ = board[to.row]?.[to.col]?.piece ?? null;
        const victimType = occ && occ.color === us ? occ.type : null;
        out.push({ from, to, kind, piece, victimType });
      };
      for (const to of getValidMoves(board, from, true)) add(to, 'move');
      if (piece.type === 'bishop') {
        for (const to of getArrowTargets(board, from)) add(to, 'arrow');
      }
      if (piece.type === 'knight') {
        for (const to of getAxeTargets(board, from)) add(to, 'axe');
      }
      if (piece.type === 'rook') {
        for (const to of getBombTargets(board, from)) add(to, 'bomb');
        for (const to of getWallBuildTargets(board, from)) add(to, 'wall');
      }
    }
  }
  out.sort((a, b) => {
    const pa = reply2Priority(a);
    const pb = reply2Priority(b);
    if (pa !== pb) return pa - pb;
    if (a.from.row !== b.from.row) return a.from.row - b.from.row;
    if (a.from.col !== b.from.col) return a.from.col - b.from.col;
    if (a.to.row !== b.to.row) return a.to.row - b.to.row;
    if (a.to.col !== b.to.col) return a.to.col - b.to.col;
    if (a.kind < b.kind) return -1;
    if (a.kind > b.kind) return 1;
    return 0;
  });
  return out;
}

/**
 * True when some legal reply captures our queen or rook and the material
 * balance is worse than before our move. Scans captures only. The cap keeps
 * queen, rook, and king captures first, so a hanging major is not skipped.
 */
function reply2HangsQr(beforeMat: number, afterUs: Board, color: PlayerColor): boolean {
  const enemy = enemyOf(color);
  const replies = listReplies(afterUs, enemy, color);
  const capped = replies.length > REPLY2_HANG_CAP ? replies.slice(0, REPLY2_HANG_CAP) : replies;
  for (const r of capped) {
    if (r.victimType !== 'queen' && r.victimType !== 'rook') continue;
    const next = applyAction(afterUs, r.kind, r.from, r.to, r.piece);
    const after = sideMaterial(next, color) - sideMaterial(next, enemy);
    if (after < beforeMat - 1e-9) return true;
  }
  return false;
}

function reply2MoveValue(afterUs: Board, color: PlayerColor): number {
  const enemy = enemyOf(color);
  if (findPieces(afterUs, enemy, 'king').length === 0) return REPLY2_WIN;
  if (findPieces(afterUs, color, 'king').length === 0) return -REPLY2_WIN;
  const replies = listReplies(afterUs, enemy, color);
  const capped = replies.length > REPLY2_MAX_REPLIES ? replies.slice(0, REPLY2_MAX_REPLIES) : replies;
  if (capped.length === 0) return reply2Value(afterUs, color);
  let best = Infinity;
  for (const r of capped) {
    const next = applyAction(afterUs, r.kind, r.from, r.to, r.piece);
    const v = reply2Value(next, color);
    if (v < best) best = v;
  }
  return best;
}

function reply2MustKeep(s: Scored, board: Board, color: PlayerColor, value: number): boolean {
  if (takesEnemyKing(s)) return true;
  if (value >= REPLY2_WIN - 1e-6) return true;
  if (s.tags.includes('gives-check') && isLastFlight(s, board, color)) return true;
  return false;
}

/**
 * Drop queen/rook hangs when a searched alternative avoids them. Re-rank
 * searched moves by Value via the score. Does not append a move. A pool of
 * one is left untouched. Flag-off callers never reach this.
 */
function applyReply2(
  pool: Scored[],
  board: Board,
  color: PlayerColor,
  g: PolicyGenome,
): { kept: Scored[]; dropped: Scored[] } {
  if (pool.length < 2) return { kept: pool, dropped: [] };
  const ordered = pool.map((s, i) => ({ s, i }));
  ordered.sort((a, b) => {
    const c = compareRank(a.s, b.s);
    return c !== 0 ? c : a.i - b.i;
  });
  const chosen: Scored[] = [];
  const seen = new Set<Scored>();
  const take = (s: Scored) => {
    if (seen.has(s)) return;
    seen.add(s);
    chosen.push(s);
  };
  for (let i = 0; i < ordered.length && chosen.length < REPLY2_HANG_CAP; i++) take(ordered[i].s);
  for (const s of pool) {
    if (takesEnemyKing(s)) take(s);
  }
  const beforeMat = sideMaterial(board, color) - sideMaterial(board, enemyOf(color));
  const stand = reply2Value(board, color);
  const scale = clampInt(g.reply2_scale, 0, 2000, 20);
  const info = new Map<Scored, { hang: boolean; value: number; valued: boolean }>();
  let valued = 0;
  for (const s of chosen) {
    if (!s.piece) {
      info.set(s, { hang: false, value: stand, valued: false });
      continue;
    }
    const afterUs = applyAction(board, s.action.kind, s.from, s.to, s.piece);
    const hang = reply2HangsQr(beforeMat, afterUs, color);
    let value = stand;
    let did = false;
    if (valued < REPLY2_MAX_CANDIDATES || takesEnemyKing(s)) {
      value = reply2MoveValue(afterUs, color);
      did = true;
      valued++;
    }
    info.set(s, { hang, value, valued: did });
  }
  let safeExists = false;
  for (const s of chosen) {
    const row = info.get(s);
    if (!row) continue;
    if (!row.hang || reply2MustKeep(s, board, color, row.value)) safeExists = true;
  }
  const dropped: Scored[] = [];
  const kept: Scored[] = [];
  let bestKept: Scored | null = null;
  let bestVal = -Infinity;
  for (const s of pool) {
    const row = info.get(s);
    if (row?.valued) s.score += (row.value - stand) * scale;
    if (row && row.hang && !reply2MustKeep(s, board, color, row.value) && safeExists) {
      if (!s.tags.includes('reply2-hang')) s.tags.push('reply2-hang');
      dropped.push(s);
      continue;
    }
    if (row && row.value > bestVal) {
      bestVal = row.value;
      bestKept = s;
    }
    kept.push(s);
  }
  if (kept.length === 0) return { kept: pool, dropped: [] };
  if (dropped.length > 0 && bestKept && !bestKept.tags.includes('reply2')) bestKept.tags.push('reply2');
  return { kept, dropped };
}

export function evaluateComputerPolicy(args: {
  board: Board;
  color: PlayerColor;
  legal: PolicyAction[];
  history: Move[];
  inCheck?: boolean;
  genome?: PolicyGenome;
}): PolicyResult {
  const { board, color, legal, history } = args;
  const g = args.genome ?? getPolicyGenome();
  const inCheck = args.inCheck ?? isInCheck(board, color);
  const checkers = inCheck ? findCheckers(board, color) : [];
  const forkingKnight = enemyForkingKnight(board, color);

  const lookaheadBefore = g.lookahead_enabled === true ? fittedValue(board, color) : null;
  const quiescenceBefore = g.quiescence_enabled === true ? fittedValue(board, color) : null;
  const wantNet = g.shot_filter_enabled === true
    || g.mate_net_enabled === true
    || g.king_hunt_enabled === true
    || g.finish_enabled === true
    || g.king_help_enabled === true;
  const netBefore = wantNet ? kingReply(board, color) : null;
  const stickyBefore = wantNet ? stickyKingValue(board, color) : null;
  const scoredAll = legal.map((action) =>
    scoreOne(
      board, color, inCheck, history, action, checkers, forkingKnight, g,
      lookaheadBefore, quiescenceBefore, netBefore, stickyBefore,
    ),
  );

  // Drop the castling teleport before escape-first can crown it. A real
  // adjacent step, if one was supplied, stays. If the teleport is the only
  // listed move, it stays — the filter does not invent a replacement.
  let spanDropped: Scored[] = [];
  let scored = scoredAll;
  if (g.span_filter_enabled === true) {
    const span = scoredAll.filter((s) => s.tags.includes('king-span'));
    const rest = scoredAll.filter((s) => !s.tags.includes('king-span'));
    if (span.length > 0 && rest.length > 0) {
      spanDropped = span;
      scored = rest;
    }
  }

  if (g.escape_first_enabled === true && inCheck) {
    const escapes = scored.filter((s) =>
      s.escapesCheck
      && s.escapeValue != null
      && !s.tags.includes('reply-unsafe')
      && !s.tags.includes('hang-shield')
    );
    if (escapes.length >= 2) {
      let best = -Infinity;
      for (const s of escapes) {
        if ((s.escapeValue as number) > best) best = s.escapeValue as number;
      }
      for (const s of escapes) {
        if (best - (s.escapeValue as number) > NET_EPS) s.tags.push('loose-escape');
        else s.tags.push('escape-best');
      }
    }
  }

  const sureEscapes = scored.filter((s) => s.escapesCheck);
  const diceEscapes = scored.filter((s) => s.diceCapture && s.boardEscapes);
  const checkPool = sureEscapes.length > 0
    ? sureEscapes
    : (diceEscapes.length > 0 ? diceEscapes : scored);
  const droppedForCheck = sureEscapes.length > 0
    ? scored.filter((s) => !s.escapesCheck)
    : (diceEscapes.length > 0 ? scored.filter((s) => !(s.diceCapture && s.boardEscapes)) : []);

  const nonThrash = checkPool.filter((s) => !s.isThrash);
  const afterThrash = nonThrash.length > 0 ? nonThrash : checkPool;
  const droppedThrash = nonThrash.length > 0
    ? checkPool.filter((s) => s.isThrash)
    : [];

  const nonWalkOff = afterThrash.filter((s) => !s.isWalkOffFork);
  const pool = nonWalkOff.length > 0 ? nonWalkOff : afterThrash;
  const droppedWalkOff = nonWalkOff.length > 0
    ? afterThrash.filter((s) => s.isWalkOffFork)
    : [];

  // v4: reject axe on unmoved g1/g12 king unless it is the only legal check escape.
  const otherEscapes = inCheck && pool.some((s) => s.escapesCheck && !isHomeSnipeTags(s.tags));
  const droppedHomeSnipe = g.gates.reject_axe_home_snipe ? pool.filter((s) => {
    if (!isHomeSnipeTags(s.tags)) return false;
    const onlyEscape = inCheck && s.escapesCheck && !otherEscapes;
    return !onlyEscape;
  }) : [];
  const afterSnipe = pool.filter((s) => !droppedHomeSnipe.includes(s));
  const snipePool = afterSnipe.length > 0 ? afterSnipe : (inCheck ? pool : afterSnipe);

  // v5+: reject self-hangs, hanging snipes, walking into a snipe, and idle
  // while a hanging Q/R can be saved — unless that is the entire remaining pool.
  const droppedHang = snipePool.filter((s) => shouldDropUnsafe(s, g));
  const afterHang = snipePool.filter((s) => !shouldDropUnsafe(s, g));
  const finalPool = afterHang.length > 0 ? afterHang : snipePool;

  // Drop quiet shuffles and repetitions only when a forcing legal move remains.
  // If every legal move is quiet, keep them — do not invent a forcing move.
  const lateForcingPool = finalPool.filter((s) => s.tags.includes('late-conv'));
  let droppedLate: Scored[] = [];
  let rankedPool = finalPool;
  if (lateForcingPool.length > 0) {
    const lateBad = finalPool.filter((s) =>
      !s.tags.includes('late-conv')
      && (s.tags.includes('late-conv-quiet') || s.tags.includes('late-conv-repeat'))
    );
    const kept = finalPool.filter((s) => !lateBad.includes(s));
    if (lateBad.length > 0 && kept.length > 0) {
      droppedLate = lateBad;
      rankedPool = kept;
    }
  }

  // King steps before the scorer's ply-30 window, then moves that put our
  // own king in check, then quiet moves once a simplifying capture exists.
  // Each drop keeps the pool non-empty and never adds a move.
  const kingDrop = dropTagged(rankedPool, 'king-step');
  rankedPool = kingDrop.kept;
  const selfDrop = dropTagged(rankedPool, 'self-check');
  rankedPool = selfDrop.kept;
  let droppedTrade: Scored[] = [];
  if (rankedPool.some((s) => s.tags.includes('trade-down'))) {
    const tradeBad = rankedPool.filter((s) => !s.tags.includes('trade-down') && tradeQuiet(s));
    const kept = rankedPool.filter((s) => !tradeBad.includes(s));
    if (tradeBad.length > 0 && kept.length > 0) {
      droppedTrade = tradeBad;
      rankedPool = kept;
    }
  }

  // Strategy-5 drops. Each one keeps a non-empty pool and adds no moves.
  const replyDrop = g.reply_safety_enabled === true
    ? dropTagged(rankedPool, 'reply-unsafe')
    : { kept: rankedPool, dropped: [] as Scored[] };
  rankedPool = replyDrop.kept;
  const hangShieldDrop = g.hang_shield_enabled === true
    ? dropTagged(rankedPool, 'hang-shield')
    : { kept: rankedPool, dropped: [] as Scored[] };
  rankedPool = hangShieldDrop.kept;

  // Strategy-12 seal. Runs before progress and finish, which would otherwise
  // keep this check and delete the quiet alternative. The check that forces
  // the queen or rook onto its only safe square is removed when something
  // else remains. The sole escape on the next ply is not this move. No-op
  // unless the flag is exactly true.
  let droppedForce: Scored[] = [];
  if (g.seal_enabled === true && rankedPool.some((s) => s.tags.includes('qr-force'))) {
    const alt = rankedPool.filter((s) => !s.tags.includes('qr-force') && coverAlternative(s, history));
    if (alt.length > 0) {
      droppedForce = rankedPool.filter((s) => s.tags.includes('qr-force'));
      rankedPool = rankedPool.filter((s) => !s.tags.includes('qr-force'));
    }
  }

  // Strategy-9 shelter. King-guard already removed non-escape king steps.
  // Span already removed the teleport. Escape-first has not yet deleted a
  // worse non-king escape, so this can still see it. No-op unless the flag
  // is exactly true. Nothing here appends a square.
  let droppedShelter: Scored[] = [];
  if (
    g.shelter_enabled === true
    && inCheck
    && history.length + 1 < clampInt(g.shelter_plies, 1, 30, 30)
  ) {
    const other = rankedPool.filter((s) =>
      s.piece?.type !== 'king'
      && s.escapesCheck
      && !s.tags.includes('reply-unsafe')
      && !s.tags.includes('hang-shield')
      && !s.tags.includes('king-span')
    );
    if (other.length > 0) {
      const kings = rankedPool.filter((s) => s.action.kind === 'move' && s.piece?.type === 'king');
      const kept = rankedPool.filter((s) => !kings.includes(s));
      if (kings.length > 0 && kept.length > 0) {
        for (const s of kings) {
          if (!s.tags.includes('king-shelter')) s.tags.push('king-shelter');
        }
        droppedShelter = kings;
        rankedPool = kept;
      }
    }
  }

  // Strategy-29 clout, before progress. Progress, finish, convert, and
  // rubble would otherwise delete a rook bomb, and finish would delete a
  // check that is not already a mate. The tag has to exist first. Press
  // later keeps it. Volley, glean, and reap still drop it when an arrow
  // or a reap capture remains. Flag-off genomes never tag. Nothing here
  // appends a square.
  if (cloutFiring(g, history)) {
    const choice = cloutChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('clout')) choice.tags.push('clout');
  }

  // Strategy-33. Before progress, so a bomb that the opponent just walled
  // off is not the only move progress keeps. Escapes are not retagged.
  // No-op unless the flag is firing. Nothing here appends a square.
  if (stringFiring(g, history)) markStringRepeats(rankedPool, history);

  // Strategy-38 anchor. Before progress. Progress deletes a quiet bishop
  // step whenever the side is ahead and a closer step is legal, including
  // the step that takes a hanging bishop off that square. Round 42 lost
  // those bishops after the drop. Tag the one legal save first. Progress,
  // finish, convert, volley, press, reap, and glean keep that tag and no
  // other move. Flag off, nothing is tagged, and those drops are unchanged.
  // Nothing here appends a square. The score does not change.
  if (anchorFiring(g, history)) {
    const choice = anchorChoice(rankedPool, board, color, history);
    if (choice && !choice.tags.includes('anchor')) choice.tags.push('anchor');
  }

  // Strategy-39 cast. Before progress. Progress and finish delete a quiet
  // bishop step whenever the side is ahead and a closer step is legal,
  // including the step that would open the first pawn ray. Round 43's late
  // plies were that walk. Tag the one legal step first. Progress, finish,
  // convert, volley, press, reap, and glean keep that tag and no other
  // move. Flag off, nothing is tagged, and those drops are unchanged.
  // Nothing here appends a square. The score does not change.
  if (castFiring(g, history)) {
    const choice = castChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('cast')) choice.tags.push('cast');
  }

  // Strategy-41 latch. Before progress. A finish rook walk is a closer
  // step, so progress and finish would delete the quiet block. Tag it
  // first. Volley and glean are not exempted: a safe arrow still removes
  // the block, and there is no second look after those drops. Flag off,
  // nothing is tagged. Nothing here appends a square. The score does not
  // change.
  if (latchFiring(g, history)) {
    const choice = latchChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('latch')) choice.tags.push('latch');
  }

  // Strategy-42 sighter. Before progress. Finish would delete the quiet
  // slide whenever a closer step is legal. Tag it first. A capture, an
  // arrow, or a nock, flight, or crest aim already returned null, so this
  // does not keep a slide beside a tactic. Flag off, nothing is tagged.
  // Nothing here appends a square. The score does not change.
  if (sighterFiring(g, history)) {
    const choice = sighterChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('sighter')) choice.tags.push('sighter');
  }

  // Strategy-43 pluck. Before progress. Finish would delete the minor step
  // whenever a closer rook is legal. Tag it first. A capture, an arrow, or
  // a nock, flight, or crest aim already returned null, so this does not
  // keep a step beside a tactic and does not retune those layers. Flag off,
  // nothing is tagged. Nothing here appends a square. The score does not
  // change.
  if (pluckFiring(g, history)) {
    const choice = pluckChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('pluck')) choice.tags.push('pluck');
  }

  // Strategy-44 fetch. Before progress. A loose early check is already
  // tagged mate-net and glean, so those drops would keep the check and
  // delete a minor capture. Tag the alternative first. The check stays
  // legal and is marked fetch-skip. Flag off, nothing is tagged. Nothing
  // here appends a square. The score does not change.
  if (fetchFiring(g, history)) {
    const choice = fetchChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('fetch')) choice.tags.push('fetch');
  }

  // Strategy-45 grip. Before progress. A checking pawn arrow and an arrow
  // that takes a queen or rook are already scored as shots, so glean would
  // keep the pawn shot and delete the minor capture. Tag the capture first.
  // The bad arrow stays legal and is marked grip-skip. If no safe capture
  // exists, nothing is tagged: a substitute arrow is fetch, and it
  // lengthened the games. Flag off, nothing is tagged. Nothing here
  // appends a square. The score does not change.
  if (gripFiring(g, history)) {
    const choice = gripChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('grip')) choice.tags.push('grip');
  }

  // Strategy-46 blunt. Before progress. A queen or rook capture of any
  // kind, and a checking pawn arrow, are already scored as tactics, so
  // glean and the must-do set keep them and delete or reject the minor
  // shot. Tag the shot first. The bad tactic stays legal and is marked
  // blunt-skip. If no safe minor shot exists, nothing is tagged: a quiet
  // substitute is not this layer. Flag off, nothing is tagged. Nothing
  // here appends a square. The score does not change.
  if (bluntFiring(g, history)) {
    const choice = bluntChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('blunt')) choice.tags.push('blunt');
  }

  let droppedProgress: Scored[] = [];
  if (g.progress_enabled === true && rankedPool.some((s) => s.tags.includes('progress'))) {
    const progressBad = rankedPool.filter((s) => progressDrop(s));
    const kept = rankedPool.filter((s) => !progressBad.includes(s));
    if (progressBad.length > 0 && kept.length > 0) {
      droppedProgress = progressBad;
      rankedPool = kept;
    }
  }

  // Strategy-6 drops. A bishop shot is removed only when a capture, a
  // mating-net move, a king-hunt step, or a real escape is still legal.
  let droppedShot: Scored[] = [];
  if (g.shot_filter_enabled === true) {
    const waste = rankedPool.filter((s) => s.tags.includes('shot-waste') && !s.tags.includes('anchor') && !s.tags.includes('cast'));
    const better = rankedPool.filter((s) =>
      !s.tags.includes('shot-waste')
      && (
        s.tags.includes('mate-net')
        || s.tags.includes('king-hunt')
        || s.tags.includes('escape')
        || s.tags.includes('escape-best')
        || (s.isCapture && !s.tags.includes('hang-shield') && !s.tags.includes('reply-unsafe'))
      )
    );
    if (waste.length > 0 && better.length > 0) {
      droppedShot = waste;
      rankedPool = rankedPool.filter((s) => !waste.includes(s));
    }
  }
  let droppedLoose: Scored[] = [];
  if (g.mate_net_enabled === true && rankedPool.some((s) => s.tags.includes('mate-net'))) {
    const loose = rankedPool.filter((s) =>
      s.tags.includes('gives-check')
      && !s.tags.includes('mate-net')
      && !s.isCapture
      && !s.tags.includes('escape')
      && !s.tags.includes('king-hunt')
      && !s.tags.includes('king-help')
      && !s.tags.includes('finish')
      && !s.tags.includes('clout')
    );
    const kept = rankedPool.filter((s) => !loose.includes(s));
    if (loose.length > 0 && kept.length > 0) {
      droppedLoose = loose;
      rankedPool = kept;
    }
  }
  const escapeDrop = g.escape_first_enabled === true
    ? dropTagged(rankedPool, 'loose-escape')
    : { kept: rankedPool, dropped: [] as Scored[] };
  rankedPool = escapeDrop.kept;

  // Strategy-18 prod, before finish. A prod move has to be tagged first or
  // finish would delete the check and the knight step whenever a queen or
  // rook capture is the only capture. Finish still drops every other quiet.
  // Prod drops nothing. Flag-off genomes never tag, so finish is unchanged.
  if (prodFiring(g, history)) {
    const choice = prodChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('prod')) choice.tags.push('prod');
    if (choice) {
      for (const s of rankedPool) {
        if (capturesQr(s) && !s.tags.includes('qr-take')) s.tags.push('qr-take');
      }
    }
  }

  // Strategy-7. A loose queen or rook check is removed only when a capture,
  // a flight cut, a safe approach, or a king-help step is still legal.
  // A prod-tagged move is not one of those quiets. The tag exists only while
  // strategy-18 is firing, and it is not added to `good`, so it cannot start
  // a drop that a flag-off genome would not start.
  let droppedCheck: Scored[] = [];
  let droppedFinish: Scored[] = [];
  if (g.finish_enabled === true) {
    const good = rankedPool.filter((s) =>
      s.tags.includes('finish')
      || s.tags.includes('king-help')
      || s.tags.includes('mate-net')
      || s.tags.includes('king-hunt')
      || s.tags.includes('escape')
      || s.tags.includes('escape-best')
      || (
        s.isCapture
        && !s.tags.includes('hang-shield')
        && !s.tags.includes('reply-unsafe')
        && !s.tags.includes('check-waste')
      )
    );
    if (good.length > 0) {
      const waste = rankedPool.filter((s) =>
        s.tags.includes('check-waste') && !good.includes(s) && !s.tags.includes('clout')
      );
      const quiet = rankedPool.filter((s) =>
        !good.includes(s)
        && !waste.includes(s)
        && !s.tags.includes('escape')
        && !s.tags.includes('prod')
        && !s.tags.includes('clout')
        && !s.tags.includes('anchor')
        && !s.tags.includes('cast')
        && !s.tags.includes('latch')
        && !s.tags.includes('sighter')
        && !s.tags.includes('pluck')
        && !s.tags.includes('fetch')
        && !s.tags.includes('grip')
        && !s.tags.includes('blunt')
        && !s.isCapture
        && s.action.kind !== 'arrow'
        && s.action.kind !== 'axe'
        && !s.tags.includes('finish')
        && !s.tags.includes('king-help')
      );
      const drop = waste.concat(quiet);
      const kept = rankedPool.filter((s) => !drop.includes(s));
      if (drop.length > 0 && kept.length > 0) {
        droppedCheck = waste;
        droppedFinish = quiet;
        rankedPool = kept;
      }
    }
  }

  // Strategy-8. A quiet step or an approach is removed only when a safe
  // arrow, axe, or winning capture is still legal. Equal trades stay.
  // Mate-net, king-help, king-hunt, and real escapes stay.
  let droppedStall: Scored[] = [];
  if (g.convert_enabled === true && rankedPool.some((s) => s.tags.includes('convert'))) {
    const stall = rankedPool.filter((s) =>
      !s.tags.includes('convert')
      && !s.tags.includes('clout')
      && !s.tags.includes('anchor')
      && !s.tags.includes('cast')
      && !s.tags.includes('latch')
      && !s.tags.includes('sighter')
      && !s.tags.includes('pluck')
      && !s.tags.includes('fetch')
      && !s.tags.includes('grip')
      && !s.tags.includes('blunt')
      && !s.isCapture
      && s.action.kind !== 'arrow'
      && s.action.kind !== 'axe'
      && !s.tags.includes('escape')
      && !s.tags.includes('king-help')
      && !s.tags.includes('king-hunt')
      && !s.tags.includes('mate-net')
    );
    const kept = rankedPool.filter((s) => !stall.includes(s));
    if (stall.length > 0 && kept.length > 0) {
      droppedStall = stall;
      rankedPool = kept;
    }
  }

  // Strategy-9. A queen or rook capture is removed only when an arrow that
  // does not take a queen or rook is still legal, and never when the capture
  // is the escape from check. A wall or bomb is removed when any other
  // listed move remains. Neither drop invents a move, and neither is trade-down.
  let droppedSpare: Scored[] = [];
  if (g.qr_spare_enabled === true && rankedPool.some((s) => s.action.kind === 'arrow' && !capturesQr(s))) {
    const spare = rankedPool.filter((s) => capturesQr(s) && !s.tags.includes('escape'));
    const kept = rankedPool.filter((s) => !spare.includes(s));
    if (spare.length > 0 && kept.length > 0) {
      for (const s of spare) {
        if (!s.tags.includes('qr-spare')) s.tags.push('qr-spare');
      }
      droppedSpare = spare;
      rankedPool = kept;
    }
  }
  let droppedRubble: Scored[] = [];
  if (g.rubble_enabled === true) {
    const rubble = rankedPool.filter((s) =>
      (s.action.kind === 'wall' || s.action.kind === 'bomb') && !s.tags.includes('clout')
    );
    const kept = rankedPool.filter((s) => !rubble.includes(s));
    if (rubble.length > 0 && kept.length > 0) {
      for (const s of rubble) {
        if (!s.tags.includes('rubble')) s.tags.push('rubble');
      }
      droppedRubble = rubble;
      rankedPool = kept;
    }
  }

  // Strategy-10. A safe non-QR arrow is preferred over an approach or a
  // king-help step once the side is ahead. Queen and rook captures are not
  // tagged, so qr-spare still decides those. No-op unless the flag is exactly
  // true. Nothing here appends a square.
  let droppedVolley: Scored[] = [];
  if (volleyFiring(g, board, color, history)) {
    for (const s of rankedPool) {
      if (isVolleyArrow(s) && !s.tags.includes('volley')) s.tags.push('volley');
    }
    if (rankedPool.some((s) => s.tags.includes('volley'))) {
      const stall = rankedPool.filter((s) => volleyStall(s));
      const kept = rankedPool.filter((s) => !stall.includes(s));
      if (stall.length > 0 && kept.length > 0) {
        droppedVolley = stall;
        rankedPool = kept;
      }
    }
  }

  // Strategy-11. A move that leaves a queen or rook to the reply is removed
  // when a move that does not remains. A clean volley arrow is not qr-loose,
  // so this does not turn volley off. A sole escape stays. No-op unless the
  // flag is exactly true. Nothing here appends a square.
  let droppedCover: Scored[] = [];
  if (g.cover_enabled === true && rankedPool.some((s) => s.tags.includes('qr-loose'))) {
    const safe = rankedPool.filter((s) => coverAlternative(s, history));
    if (safe.length > 0) {
      const loose = rankedPool.filter((s) => s.tags.includes('qr-loose'));
      if (loose.length > 0) {
        droppedCover = loose;
        rankedPool = rankedPool.filter((s) => !loose.includes(s));
      }
    }
  }

  // Strategy-12 press. A non-closing check or a quiet step is removed when
  // a closer step, a safe capture, or a safe shot remains. Does not require
  // a material lead. Escapes stay. No-op unless the flag is firing.
  let droppedPress: Scored[] = [];
  if (pressFiring(g, history) && rankedPool.some((s) => pressKeep(s))) {
    const stall = rankedPool.filter((s) => !pressKeep(s) && !s.tags.includes('anchor') && !s.tags.includes('cast') && !s.tags.includes('latch') && !s.tags.includes('sighter') && !s.tags.includes('pluck') && !s.tags.includes('fetch') && !s.tags.includes('grip') && !s.tags.includes('blunt'));
    const kept = rankedPool.filter((s) => pressKeep(s) || s.tags.includes('anchor') || s.tags.includes('cast') || s.tags.includes('latch') || s.tags.includes('sighter') || s.tags.includes('pluck') || s.tags.includes('fetch') || s.tags.includes('grip') || s.tags.includes('blunt'));
    if (stall.length > 0 && kept.length > 0) {
      droppedPress = stall;
      rankedPool = kept;
    }
  }

  // Strategy-13 reap. After press, so a closer non-capturing check that press
  // kept is removed when a safe arrow or a safe minor capture remains.
  // No lead required. Escapes stay. A queen or rook capture is not the reason
  // and is not kept. No-op unless the flag is firing. Nothing here appends a square.
  let droppedReap: Scored[] = [];
  if (reapFiring(g, history)) {
    for (const s of rankedPool) {
      if (isReap(s, board, color) && !s.tags.includes('reap')) s.tags.push('reap');
    }
    if (rankedPool.some((s) => s.tags.includes('reap'))) {
      const stall = rankedPool.filter((s) =>
        !s.tags.includes('reap')
        && !s.tags.includes('escape')
        && !s.tags.includes('escape-best')
        && !s.tags.includes('anchor')
        && !s.tags.includes('cast')
        && !s.tags.includes('latch')
        && !s.tags.includes('sighter')
        && !s.tags.includes('pluck')
        && !s.tags.includes('fetch')
        && !s.tags.includes('grip')
        && !s.tags.includes('blunt')
      );
      const kept = rankedPool.filter((s) => !stall.includes(s));
      if (stall.length > 0 && kept.length > 0) {
        droppedReap = stall;
        rankedPool = kept;
      }
    }
  }

  // Strategy-34 bolt. Before glean. Glean deletes every non-arrow once a
  // pawn arrow is legal, including the knight or bishop capture this layer
  // exists to rank. Tag that one capture first. The glean stall below keeps
  // it. Flag off, nothing is tagged, and glean drops the same moves it
  // dropped before. Nothing here appends a square. The score does not change.
  if (boltFiring(g, history)) {
    const choice = boltChoice(rankedPool, board, color, history);
    if (choice && !choice.tags.includes('bolt')) choice.tags.push('bolt');
  }

  // Strategy-14 glean. After reap, so a safe pawn or bishop arrow that reap
  // left beside a minor capture becomes the only non-escape. Reap does not
  // delete that capture, and the model was playing it. No lead. A queen or
  // rook capture is not the arrow. A king step is not tagged. A king capture
  // and a check that takes the last flight stay. A bolt capture stays too:
  // the tag exists only while bolt is firing, so a flag-off genome still
  // drops that capture. No-op unless the flag is firing. Nothing here
  // appends a square. The score does not change.
  let droppedGlean: Scored[] = [];
  if (gleanFiring(g, history)) {
    for (const s of rankedPool) {
      if (isVolleyArrow(s) && !s.tags.includes('glean')) s.tags.push('glean');
    }
    if (rankedPool.some((s) => s.tags.includes('glean'))) {
      const stall = rankedPool.filter((s) =>
        !s.tags.includes('glean')
        && !s.tags.includes('bolt')
        && !s.tags.includes('anchor')
        && !s.tags.includes('cast')
        && !s.tags.includes('fetch')
        && !s.tags.includes('grip')
        && !s.tags.includes('blunt')
        && !s.tags.includes('escape')
        && !s.tags.includes('escape-best')
        && !takesEnemyKing(s)
        && !isLastFlight(s, board, color)
      );
      const kept = rankedPool.filter((s) => !stall.includes(s));
      if (stall.length > 0 && kept.length > 0) {
        droppedGlean = stall;
        rankedPool = kept;
      }
    }
  }

  // Strategy-15 sheaf. After glean. A safe pawn arrow beats a bishop duel:
  // round 17's fitness moved with pawn arrows (+0.4 each), and a duel spends
  // the same arrow on removing the other shooter. A king-target arrow stays,
  // as do a king capture and a last-flight check. When no safe pawn arrow is
  // legal, a bishop step that opens one replaces a quiet non-capture.
  // Captures stay. A king step is not tagged. No-op unless the flag is
  // firing. Nothing here appends a square. The score does not change.
  let droppedSheaf: Scored[] = [];
  if (sheafFiring(g, history)) {
    for (const s of rankedPool) {
      if (isSheafArrow(s) && !s.tags.includes('sheaf')) s.tags.push('sheaf');
    }
    const hasPawnArrow = rankedPool.some((s) => s.tags.includes('sheaf') && s.action.kind === 'arrow');
    if (hasPawnArrow) {
      const stall = rankedPool.filter((s) =>
        !s.tags.includes('sheaf')
        && !s.tags.includes('escape')
        && !s.tags.includes('escape-best')
        && !takesEnemyKing(s)
        && !isLastFlight(s, board, color)
        && !(s.action.kind === 'arrow' && s.tags.includes('arrow-king'))
      );
      const kept = rankedPool.filter((s) => !stall.includes(s));
      if (stall.length > 0 && kept.length > 0) {
        droppedSheaf = stall;
        rankedPool = kept;
      }
    } else {
      for (const s of rankedPool) {
        if (isSheafAim(s, board) && !s.tags.includes('sheaf')) s.tags.push('sheaf');
      }
      if (rankedPool.some((s) => s.tags.includes('sheaf'))) {
        const stall = rankedPool.filter((s) =>
          !s.tags.includes('sheaf')
          && !s.tags.includes('escape')
          && !s.tags.includes('escape-best')
          && !s.tags.includes('king-hunt')
          && !s.tags.includes('king-help')
          && !s.tags.includes('mate-net')
          && !takesEnemyKing(s)
          && !isLastFlight(s, board, color)
          && s.action.kind !== 'arrow'
          && s.action.kind !== 'axe'
          && !s.isCapture
        );
        const kept = rankedPool.filter((s) => !stall.includes(s));
        if (stall.length > 0 && kept.length > 0) {
          droppedSheaf = stall;
          rankedPool = kept;
        }
      }
    }
  }

  // Strategy-16 keel. After sheaf. A quiet king step is dropped when a safe
  // non-king move remains. Then, only when no safe non-queen non-rook arrow
  // is already legal, a quiet queen or rook step is dropped if a bishop step
  // opens a ray onto a pawn, knight, bishop, or king. An arrow that is
  // already legal is left to glean. Captures, escapes, king-hunt, king-help,
  // mate-net, finish, a king capture, and a last-flight check stay. No-op
  // unless the flag is firing. Nothing here appends a square. The score
  // does not change.
  let droppedKeel: Scored[] = [];
  if (keelFiring(g, history)) {
    if (rankedPool.some(keelAlternative)) {
      const kings = rankedPool.filter(isQuietKingStep);
      if (kings.length > 0) {
        for (const s of kings) {
          if (!s.tags.includes('keel')) s.tags.push('keel');
        }
        droppedKeel = kings;
        rankedPool = rankedPool.filter((s) => !isQuietKingStep(s));
      }
    }
    if (!rankedPool.some(isVolleyArrow) && rankedPool.some((s) => isKeelRay(s, board))) {
      for (const s of rankedPool) {
        if (isKeelRay(s, board) && !s.tags.includes('keel')) s.tags.push('keel');
      }
      const drift = rankedPool.filter((s) => isKeelDrift(s, board, color));
      if (drift.length > 0 && drift.length < rankedPool.length) {
        for (const s of drift) {
          if (!s.tags.includes('keel')) s.tags.push('keel');
        }
        droppedKeel = droppedKeel.concat(drift);
        rankedPool = rankedPool.filter((s) => !isKeelDrift(s, board, color));
      }
    }
  }

  // Strategy-17 sift. After keel. Ranks one safe move that raises the fitted
  // material and king-exposure value. A bishop step that opens a non-queen
  // non-rook ray wins that slot. Does not drop the king, the queen, the
  // rook, or anything else. No-op when a safe non-queen non-rook arrow is
  // already legal, and no-op unless the flag is firing. Nothing here appends
  // a square. The score does not change.
  if (siftFiring(g, history)) {
    const choice = siftChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('sift')) choice.tags.push('sift');
  }

  // Strategy-19 nock. After sift. Ranks one safe bishop step that opens a
  // pawn ray and does not open a queen ray. Only a pure quiet pool: a
  // capture, an arrow, an axe, or a check means glean, finish, or prod
  // already had a say, and nock stays out. Does not drop the queen, the
  // rook, the knight, the king, or anything else. No-op unless the flag is
  // firing. Nothing here appends a square. The score does not change.
  if (nockFiring(g, history)) {
    const choice = nockChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('nock')) choice.tags.push('nock');
  }

  // Strategy-20 fletch. After nock. Ranks one quiet pawn step that steps off
  // a friendly bishop's ray so the side's pawn-arrow count rises, without
  // opening a queen ray and without hanging a queen or rook. Defers when any
  // legal move is already a nock aim. Same pure quiet stall as nock. Does
  // not drop the queen, the rook, the knight, the king, the bishop, or
  // anything else. No-op unless the flag is firing. Nothing here appends a
  // square. The score does not change.
  if (fletchFiring(g, history)) {
    const choice = fletchChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('fletch')) choice.tags.push('fletch');
  }

  // Strategy-21 pile. After fletch. Ranks one safe bishop step that puts
  // the enemy king behind exactly one friendly pawn, knight, or bishop,
  // without opening a queen ray and without raising our king exposure.
  // A clear king ray is already a check and is left to bishop-aims-king.
  // Defers when any legal move is already a nock aim. Same pure quiet stall
  // as nock. Does not drop the queen, the rook, the knight, the king, the
  // pawn, or anything else. No-op unless the flag is firing. Nothing here
  // appends a square. The score does not change.
  if (pileFiring(g, history)) {
    const choice = pileChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('pile')) choice.tags.push('pile');
  }

  // Strategy-22 haft. After pile. Ranks one safe bishop step that opens a
  // longer firing lane, or that leaves the back rank toward the center
  // without losing a lane. Defers when any legal move is already a nock
  // aim. Same pure quiet stall as nock. Does not drop the queen, the rook,
  // the knight, the king, the pawn, or anything else. No-op unless the flag
  // is firing. Nothing here appends a square. The score does not change.
  if (haftFiring(g, history)) {
    const choice = haftChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('haft')) choice.tags.push('haft');
  }

  // Strategy-23 quarrel. After haft. Tags the highest-scoring quiet move
  // when it is not already a hint and is not a king step, so the model list
  // shows that move first. A capture, an arrow, an axe, a check, or an
  // escape keeps it out. Defers when any legal move is already a nock aim.
  // Does not drop the queen, the rook, the knight, the king, the pawn, or
  // anything else. No-op unless the flag is firing. Nothing here appends a
  // square. The score does not change.
  if (quarrelFiring(g, history)) {
    const choice = quarrelChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('quarrel')) choice.tags.push('quarrel');
  }

  // Strategy-24 bodkin. After quarrel. Ranks one knight or bishop step that
  // reduces Chebyshev distance to the enemy king, ahead of a quiet queen or
  // rook. Defers when any legal move is already a nock aim. Same pure quiet
  // stall as nock. Does not drop the queen, the rook, the king, the pawn, or
  // anything else. No-op unless the flag is firing. Nothing here appends a
  // square. The score does not change.
  if (bodkinFiring(g, history)) {
    const choice = bodkinChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('bodkin')) choice.tags.push('bodkin');
  }

  // Strategy-25 crest. After bodkin. Ranks one bishop step that closes on
  // the nearest enemy pawn without opening a pawn ray or a queen ray.
  // Defers when any legal move is already a nock aim. Same pure quiet stall
  // as nock. Does not drop the queen, the rook, the knight, the king, the
  // pawn, or anything else. No-op unless the flag is firing. Nothing here
  // appends a square. The score does not change.
  if (crestFiring(g, history)) {
    const choice = crestChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('crest')) choice.tags.push('crest');
  }

  // Strategy-26 brace. After crest. Ranks one quiet pawn step that gives a
  // bishop a new legal step, without opening a pawn ray or a queen ray.
  // Defers when any legal move is already a nock aim or a crest aim. Before
  // ply 30, prefers a step that keeps the king's adjacent pawn shield.
  // Same pure quiet stall as nock. Does not drop the queen, the rook, the
  // knight, the king, the bishop, or anything else. No-op unless the flag
  // is firing. Nothing here appends a square. The score does not change.
  if (braceFiring(g, history)) {
    const choice = braceChoice(rankedPool, board, color, history);
    if (choice && !choice.tags.includes('brace')) choice.tags.push('brace');
  }

  // Strategy-27 mark. After brace. Ranks one knight step that closes on the
  // nearest enemy pawn without adding an attack on a queen or a rook and
  // without opening a pawn ray or a queen ray. Defers when any legal move is
  // already a nock aim, a crest aim, or a brace aim. Same pure quiet stall
  // as nock. Does not drop the queen, the rook, the bishop, the king, the
  // pawn, or anything else. No-op unless the flag is firing. Nothing here
  // appends a square. The score does not change.
  if (markFiring(g, history)) {
    const choice = markChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('mark')) choice.tags.push('mark');
  }

  // Strategy-28 flight. After mark. Ranks one pawn or knight step that sets
  // up a bishop pawn-shot. A pawn counts only when it creates a nock aim and
  // does not itself raise the pawn-arrow count. A knight counts when it
  // uncovers that arrow or creates the same aim. Defers when any legal move
  // is already a nock aim. Does not defer to a crest aim or a brace aim.
  // Same pure quiet stall as nock. Does not drop the queen, the rook, the
  // bishop, the king, or anything else. No-op unless the flag is firing.
  // Nothing here appends a square. The score does not change.
  if (flightFiring(g, history)) {
    const choice = flightChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('flight')) choice.tags.push('flight');
  }

  // Strategy-32 quill. After flight, before vane. One quiet queen or rook
  // step that steps off an attack, ranked ahead of the flight or nock shot.
  // An arrow or an axe that is already legal is left alone. Nothing is
  // dropped. No-op unless the flag is firing. The score does not change.
  if (quillFiring(g, history)) {
    const choice = quillChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('quill')) choice.tags.push('quill');
  }

  // Strategy-33 string. After quill. One safe bishop arrow at a pawn or a
  // king. Nothing is dropped. No-op unless the flag is firing. The score
  // does not change. Quiet knights are left for flight.
  if (stringFiring(g, history)) {
    const choice = stringChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('string')) choice.tags.push('string');
  }

  // Strategy-31 vane. After flight. When a flight setup or a nock aim is
  // already in the pool, drop quiet knights and quiet pawns that are not
  // that shot. The model plays those knights while the shot is already
  // first; reordering does not change the committed move. Bishops, rooks,
  // queens, kings, captures, checks, escapes, and the shot itself stay.
  // No-op unless the flag is firing. Nothing here appends a square.
  let droppedVane: Scored[] = [];
  if (vaneFiring(g, history)) {
    const shot = rankedPool.some((s) =>
      s.tags.includes('flight') || s.tags.includes('nock') || s.action.kind === 'arrow'
    );
    if (shot) {
      const beforePawn = friendlyPawnRays(board, color);
      const beforeNock = nockAimCount(board, color);
      const held = rankedPool.filter((s) => vaneHolds(s, board, color, beforePawn, beforeNock));
      const kept = rankedPool.filter((s) => !held.includes(s));
      if (held.length > 0 && kept.length > 0) {
        droppedVane = held;
        rankedPool = kept;
      }
    }
  }

  // Strategy-30 barb. After flight, and after glean, so an arrow that is
  // already legal is still in the pool and a nock aim that survived is still
  // visible. One safe minor capture that strips the enemy king's shelter or
  // opens a bishop pawn-shot. Reap already kept that capture. Nothing here
  // is dropped. No-op unless the flag is firing. The score does not change.
  if (barbFiring(g, history)) {
    const choice = barbChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('barb')) choice.tags.push('barb');
  }

  // Strategy-35 spine. After the drops, so a safe pawn arrow that glean
  // kept is still visible and this layer stays quiet. One queen or rook
  // step that clears a cheap hang and leaves that arrow for the next ply.
  // Nothing is dropped. No-op unless the flag is firing. The score does
  // not change.
  if (spineFiring(g, history)) {
    const choice = spineChoice(rankedPool, board, color, history);
    if (choice && !choice.tags.includes('spine')) choice.tags.push('spine');
  }

  // Strategy-36 broadhead. After the drops, so a safe pawn arrow glean kept
  // is still visible and this layer stays quiet. One capture that makes a
  // safe pawn arrow exist. Nothing is dropped. No-op unless the flag is
  // firing. The score does not change.
  if (broadheadFiring(g, history)) {
    const choice = broadheadChoice(rankedPool, board, color, history);
    if (choice && !choice.tags.includes('broadhead')) choice.tags.push('broadhead');
  }

  // Strategy-37 shaft. After broadhead, so a flight, nock, or crest tag is
  // already visible and this layer stays quiet. One bishop, knight, or pawn
  // step that makes a safe pawn arrow exist. Nothing is dropped. No-op
  // unless the flag is firing. The score does not change.
  if (shaftFiring(g, history)) {
    const choice = shaftChoice(rankedPool, board, color, history);
    if (choice && !choice.tags.includes('shaft')) choice.tags.push('shaft');
  }

  // Strategy-38 anchor, second look. The save is tagged before progress.
  // This only fills a save that the earlier pool did not have, which is
  // rare. A flag-off genome never tags.
  if (anchorFiring(g, history) && !rankedPool.some((s) => s.tags.includes('anchor'))) {
    const choice = anchorChoice(rankedPool, board, color, history);
    if (choice && !choice.tags.includes('anchor')) choice.tags.push('anchor');
  }

  // Strategy-39 cast, second look. The step is tagged before progress.
  // This only fills a step that the earlier pool did not have, which is
  // rare. A flag-off genome never tags.
  if (castFiring(g, history) && !rankedPool.some((s) => s.tags.includes('cast'))) {
    const choice = castChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('cast')) choice.tags.push('cast');
  }

  // Strategy-40 quarry. After every drop. A safe pawn arrow that glean
  // kept has already removed this queen, and a reap capture has too.
  // Tagging earlier would exempt the step and spend the arrow tempo.
  // Flag off, nothing is tagged. Nothing here appends a square. The score
  // does not change. Nothing is dropped.
  if (quarryFiring(g, history)) {
    const choice = quarryChoice(rankedPool, board, color);
    if (choice && !choice.tags.includes('quarry')) choice.tags.push('quarry');
  }

  // Strategy-46 reply2. After every earlier filter. Worst legal reply
  // re-ranks the searched pool. A queen or rook hang is dropped when a
  // searched alternative avoids it. A king capture and a winning check stay.
  // Flag off does not run. Nothing here appends a square.
  let droppedReply2: Scored[] = [];
  if (reply2Firing(g, history)) {
    const reply2 = applyReply2(rankedPool, board, color, g);
    rankedPool = reply2.kept;
    droppedReply2 = reply2.dropped;
  }

  const ranked = [...rankedPool].sort(compareRank).map((s) => toRanked(s));
  const hints = ranked.filter((r) => r.tags.some((t) => HINT_TAGS.has(t)));
  const rejected = [
    ...droppedForCheck.map((s) => toRanked(s, nonEscapeReason(s, g, inCheck))),
    ...droppedThrash.map((s) => toRanked(s, s.isOscillation ? 'oscillation' : 'reversal')),
    ...droppedWalkOff.map((s) => toRanked(s, 'keep-fork')),
    ...droppedHomeSnipe.map((s) => toRanked(s, 'axe-home-snipe')),
    ...(afterHang.length > 0 ? droppedHang.map((s) => toRanked(s, unsafeRejectReason(s))) : []),
    ...droppedLate.map((s) => toRanked(s, 'late-conv')),
    ...kingDrop.dropped.map((s) => toRanked(s, 'king-step')),
    ...selfDrop.dropped.map((s) => toRanked(s, 'self-check')),
    ...droppedTrade.map((s) => toRanked(s, 'trade-down')),
    ...replyDrop.dropped.map((s) => toRanked(s, 'reply-unsafe')),
    ...hangShieldDrop.dropped.map((s) => toRanked(s, 'hang-shield')),
    ...droppedProgress.map((s) => toRanked(s, 'progress')),
    ...droppedShot.map((s) => toRanked(s, 'shot-waste')),
    ...droppedLoose.map((s) => toRanked(s, 'loose-check')),
    ...escapeDrop.dropped.map((s) => toRanked(s, 'escape-first')),
    ...droppedCheck.map((s) => toRanked(s, 'check-waste')),
    ...droppedFinish.map((s) => toRanked(s, 'finish')),
    ...spanDropped.map((s) => toRanked(s, 'king-span')),
    ...droppedStall.map((s) => toRanked(s, 'convert-stall')),
    ...droppedShelter.map((s) => toRanked(s, 'king-shelter')),
    ...droppedSpare.map((s) => toRanked(s, 'qr-spare')),
    ...droppedRubble.map((s) => toRanked(s, 'rubble')),
    ...droppedVolley.map((s) => toRanked(s, 'volley')),
    ...droppedCover.map((s) => toRanked(s, 'qr-cover')),
    ...droppedForce.map((s) => toRanked(s, 'qr-force')),
    ...droppedPress.map((s) => toRanked(s, 'press')),
    ...droppedReap.map((s) => toRanked(s, 'reap')),
    ...droppedGlean.map((s) => toRanked(s, 'glean')),
    ...droppedSheaf.map((s) => toRanked(s, 'sheaf')),
    ...droppedKeel.map((s) => toRanked(s, 'keel')),
    ...droppedVane.map((s) => toRanked(s, 'vane')),
    ...droppedReply2.map((s) => toRanked(s, 'reply2')),
  ];

  const tacticOk = (tags: string[]) =>
    !hasUnsafeSelfTags(tags)
    && !tags.includes('hang-shield')
    && !tags.includes('reply-unsafe')
    && !tags.includes('shot-waste')
    && !tags.includes('check-waste')
    && !tags.includes('king-span')
    && !tags.includes('qr-loose')
    && !tags.includes('qr-force');
  const mustDos = ranked.filter((r) =>
    r.tags.some((t) => mustDoTagSet(g.gates).has(t)) && tacticOk(r.tags)
  );
  const fallback = pickSafeFallback(ranked, mustDos, g.gates.stuck_breaker_skips_home_snipe);
  return { inCheck, ranked, hints, rejected, fallback };
}

export function filterModelPick(args: {
  board: Board;
  color: PlayerColor;
  legal: PolicyAction[];
  history: Move[];
  pick: PolicyAction;
  inCheck?: boolean;
  genome?: PolicyGenome;
}): FilterPickResult {
  const g = args.genome ?? getPolicyGenome();
  const policy = evaluateComputerPolicy({ ...args, genome: g });
  const key = (a: PolicyAction) => `${a.kind}:${a.from}:${a.to}`;
  const pickKey = key(args.pick);
  if (g.illegal_filter_enabled === true && !args.legal.some((a) => key(a) === pickKey)) {
    const hints = policy.hints.length ? policy.hints : policy.ranked.slice(0, 8);
    return {
      accept: false,
      reason: 'not-legal',
      retryHints: hints,
      fallback: policy.fallback ?? hints[0],
    };
  }
  const mustDos = policy.ranked.filter((r) =>
    r.tags.some((t) => mustDoTagSet(g.gates).has(t))
    && !hasUnsafeSelfTags(r.tags)
    && !r.tags.includes('hang-shield')
    && !r.tags.includes('reply-unsafe')
    && !r.tags.includes('shot-waste')
    && !r.tags.includes('check-waste')
    && !r.tags.includes('king-span')
    && !r.tags.includes('qr-loose')
    && !r.tags.includes('qr-force')
  );
  const fallback = pickSafeFallback(policy.ranked, mustDos, g.gates.stuck_breaker_skips_home_snipe) ?? policy.fallback ?? undefined;

  const stringArrow = stringFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('string'))
    : undefined;
  const rejected = policy.rejected.find((r) => key(r) === pickKey);
  if (rejected) {
    // Finish already removed the quiet bishop, and qr-spare already removed
    // the queen or rook capture. Commit the pawn or king arrow on attempt 1
    // instead of leaving a retry. Hangs, snipes, and qr-force stay as they are.
    const quietBishop = rejected.kind === 'move'
      && rejected.type === 'bishop'
      && !rejected.tags.includes('capture')
      && !rejected.tags.includes('gives-check')
      && !rejected.tags.includes('escape')
      && !rejected.tags.includes('escape-best')
      && !rejected.tags.includes('nock')
      && !rejected.tags.includes('crest')
      && !rejected.tags.includes('flight');
    if (
      stringArrow
      && key(stringArrow) !== pickKey
      && (rejected.rejectReason === 'qr-spare' || (rejected.rejectReason === 'finish' && quietBishop))
    ) {
      return {
        accept: false,
        reason: 'string',
        retryHints: [stringArrow],
        fallback: stringArrow,
      };
    }
    // A shuffle that power-hangs already dropped is the move this layer
    // exists to replace. Must-dos still win: the generic return below
    // points the retry at them. Nothing is dropped here.
    const broadheadCap = broadheadFiring(g, args.history)
      ? policy.ranked.find((r) => r.tags.includes('broadhead'))
      : undefined;
    const quietDropped = rejected.kind === 'move'
      && !rejected.tags.includes('capture')
      && !rejected.tags.includes('gives-check')
      && !rejected.tags.includes('escape')
      && !rejected.tags.includes('escape-best')
      && !rejected.tags.includes('nock')
      && !rejected.tags.includes('crest')
      && !rejected.tags.includes('flight');
    if (broadheadCap && quietDropped && mustDos.length === 0 && key(broadheadCap) !== pickKey) {
      return {
        accept: false,
        reason: 'broadhead',
        retryHints: [broadheadCap],
        fallback: broadheadCap,
      };
    }
    return {
      accept: false,
      reason: rejected.rejectReason,
      retryHints: mustDos.length ? mustDos : (policy.hints.length ? policy.hints : policy.ranked.slice(0, 8)),
      fallback,
    };
  }

  // Bolt. A pawn arrow, including an early checking pawn arrow that is
  // already a must-do, commits to the knight or bishop capture on attempt
  // 1. After ply 30 a must-do checking pawn arrow is left alone. This sits
  // in front of the must-do return so a hanging capture does not turn the
  // arrow into a retry. Nothing is dropped.
  const boltCap = boltFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('bolt'))
    : undefined;
  const pickedEarly = policy.ranked.find((r) => key(r) === pickKey);
  if (boltCap && pickedEarly && key(boltCap) !== pickKey) {
    const pawnArrow = pickedEarly.kind === 'arrow'
      && pickedEarly.tags.includes('arrow-pawn')
      && !pickedEarly.tags.includes('arrow-king');
    const checkingPawn = pawnArrow && (
      pickedEarly.tags.includes('gives-check') || pickedEarly.tags.includes('arrow-checks-king')
    );
    const lateMustCheck = args.history.length >= 30
      && checkingPawn
      && mustDos.some((m) => key(m) === pickKey);
    if (pawnArrow && !lateMustCheck) {
      return {
        accept: false,
        reason: 'bolt',
        retryHints: [boltCap],
        fallback: boltCap,
      };
    }
  }

  // Fetch. Before must-do. arrow-checks-king is a must-do, and that is
  // the loose g-file arrow rounds 47 and 48 actually played. When this
  // alternative is already rank 0, a quiet non-capture is rejected. A
  // loose check is rejected whenever the alternative exists, and it is
  // not left in the must-do set, or the must-do return would force the
  // check back. A hanging capture that is not the check still wins.
  // Nothing is dropped. play-loop forces this on attempt 1.
  const fetchStep = fetchFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('fetch'))
    : undefined;
  const fetchTop = !!(fetchStep && policy.ranked[0] && key(policy.ranked[0]) === key(fetchStep));
  const pickedFetch = policy.ranked.find((r) => key(r) === pickKey);
  if (fetchStep && pickedFetch && key(fetchStep) !== pickKey) {
    const looseCheck = pickedFetch.tags.includes('fetch-skip');
    const quietJump = fetchTop
      && pickedFetch.kind === 'move'
      && !pickedFetch.tags.includes('capture')
      && !pickedFetch.tags.includes('gives-check')
      && !pickedFetch.tags.includes('escape')
      && !pickedFetch.tags.includes('escape-best')
      && !pickedFetch.tags.includes('flight')
      && !pickedFetch.tags.includes('nock')
      && !pickedFetch.tags.includes('crest')
      && !pickedFetch.tags.includes('fork')
      && !pickedFetch.tags.includes('king-hunt')
      && !pickedFetch.tags.includes('king-help');
    if (looseCheck || quietJump) {
      const fb = fetchTop ? fetchStep : policy.ranked[0];
      if (fb && key(fb) !== pickKey) {
        return {
          accept: false,
          reason: 'fetch',
          retryHints: [fb],
          fallback: fb,
        };
      }
    }
  }
  // Grip. Before must-do. A checking pawn arrow is arrow-checks-king,
  // and an arrow that takes a queen is a capture the model will play.
  // Reject only that arrow. A quiet move is not rejected: fetch's quiet
  // reject never fired, and a forced substitute on a quiet ply is how
  // NOT_LISTED climbs. The fallback is the listed capture. Nothing is
  // dropped. This is not the generic fallback, so hangs-piece still
  // falls through to glean.
  const gripStep = gripFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('grip'))
    : undefined;
  const pickedGrip = policy.ranked.find((r) => key(r) === pickKey);
  if (gripStep && pickedGrip && key(gripStep) !== pickKey && pickedGrip.tags.includes('grip-skip')) {
    return {
      accept: false,
      reason: 'grip',
      retryHints: [gripStep],
      fallback: gripStep,
    };
  }
  let mustDosForGate = fetchStep
    ? mustDos.filter((m) => !m.tags.includes('fetch-skip'))
    : mustDos;
  if (gripStep) mustDosForGate = mustDosForGate.filter((m) => !m.tags.includes('grip-skip'));
  // Blunt. Before must-do. A checking pawn arrow is arrow-checks-king,
  // and a queen or rook capture is a capture the model will play. Reject
  // only that tactic. A quiet move is not rejected. The fallback is the
  // listed minor shot, which may be an arrow. Nothing is dropped. This is
  // not the generic fallback, so hangs-piece still falls through to glean.
  const bluntStep = bluntFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('blunt'))
    : undefined;
  const pickedBlunt = policy.ranked.find((r) => key(r) === pickKey);
  if (bluntStep && pickedBlunt && key(bluntStep) !== pickKey && pickedBlunt.tags.includes('blunt-skip')) {
    return {
      accept: false,
      reason: 'blunt',
      retryHints: [bluntStep],
      fallback: bluntStep,
    };
  }
  if (bluntStep) mustDosForGate = mustDosForGate.filter((m) => !m.tags.includes('blunt-skip'));
  if (mustDosForGate.length && !mustDosForGate.some((m) => key(m) === pickKey)) {
    return {
      accept: false,
      reason: mostSpecificMustDoReason(mustDosForGate),
      retryHints: mustDosForGate,
      fallback: mustDosForGate[0],
    };
  }

  // Center: if a bishop can step off the back rank into the field, reject
  // quiet Q/R/B back-rank shuffles. Not a silent replace on attempt 1.
  const develop = policy.ranked.filter((r) => r.tags.includes('develop-bishop'));
  const picked = policy.ranked.find((r) => key(r) === pickKey);
  if (g.gates.reject_back_rank_when_develop_bishop && develop.length && picked?.tags.includes('back-rank-shuffle')) {
    return {
      accept: false,
      reason: 'develop-center',
      retryHints: develop,
      fallback: develop[0],
    };
  }

  // Early king walk off the back ranks, into low shelter, or into the open center.
  const earlyKingBad = (r: RankedAction) => r.tags.includes('king-wander') || r.tags.includes('king-exposed');
  if (
    g.gates.reject_early_king_wander
    && picked
    && earlyKingBad(picked)
    && !picked.tags.includes('king-hunt')
    && !picked.tags.includes('king-help')
  ) {
    const stay = policy.ranked.filter((r) => !earlyKingBad(r));
    if (stay.length && !mustDos.some((m) => key(m) === pickKey)) {
      return {
        accept: false,
        reason: 'king-home',
        retryHints: stay.slice(0, 8),
        fallback: stay[0],
      };
    }
  }

  // Bishop snipe / power hang / walk-into-snipe: backup if they remained ranked.
  if (picked && hasUnsafeSelfTags(picked.tags) && !mustDos.some((m) => key(m) === pickKey)) {
    const safer = policy.ranked.filter((r) => !hasUnsafeSelfTags(r.tags));
    if (safer.length) {
      return {
        accept: false,
        reason: unsafeRejectReason(picked),
        retryHints: safer.slice(0, 8),
        fallback: safer[0],
      };
    }
  }

  // Late quiet king walk while a shot or take exists.
  if (picked?.tags.includes('king-idle') && !picked.tags.includes('king-hunt') && !picked.tags.includes('king-help')) {
    const shoot = policy.ranked.filter((r) =>
      !r.tags.includes('shot-waste')
      && (
        r.kind === 'arrow'
        || r.kind === 'axe'
        || r.tags.includes('capture')
        || r.tags.includes('gives-check')
        || r.tags.includes('arrow-king')
        || r.tags.includes('arrow-checks-king')
        || r.tags.includes('bishop-aims-king')
      ),
    );
    if (shoot.length && !mustDos.some((m) => key(m) === pickKey)) {
      return {
        accept: false,
        reason: 'king-idle',
        retryHints: shoot.slice(0, 8),
        fallback: shoot[0],
      };
    }
  }

  // String. A quiet bishop that is not already the nock or crest aim, and
  // the repeating bomb or wall, commit to the pawn or king arrow on attempt
  // 1. Quiet knights are not diverted. Nothing is dropped.
  const quietBishop = !!(
    picked
    && picked.kind === 'move'
    && picked.type === 'bishop'
    && !picked.tags.includes('capture')
    && !picked.tags.includes('gives-check')
    && !picked.tags.includes('escape')
    && !picked.tags.includes('escape-best')
    && !picked.tags.includes('nock')
    && !picked.tags.includes('crest')
    && !picked.tags.includes('flight')
  );
  if (stringArrow && quietBishop && key(stringArrow) !== pickKey) {
    return {
      accept: false,
      reason: 'string',
      retryHints: [stringArrow],
      fallback: stringArrow,
    };
  }
  if (picked?.tags.includes('string-repeat') && key(picked) === pickKey) {
    const alt = stringArrow
      ?? policy.ranked.find((r) => !r.tags.includes('string-repeat') && key(r) !== pickKey);
    if (alt && key(alt) !== pickKey) {
      return {
        accept: false,
        reason: 'string',
        retryHints: [alt],
        fallback: alt,
      };
    }
  }

  // Bolt. A quiet bishop that is still ranked, and is not a must-do, commits
  // to the knight or bishop capture. Quiet knights, flight, nock, and crest
  // are not diverted. bishop-shoots would otherwise retry into the pawn arrow.
  if (boltCap && picked && key(boltCap) !== pickKey) {
    const quietBishopBolt = picked.kind === 'move'
      && picked.type === 'bishop'
      && !picked.tags.includes('capture')
      && !picked.tags.includes('gives-check')
      && !picked.tags.includes('escape')
      && !picked.tags.includes('escape-best')
      && !picked.tags.includes('nock')
      && !picked.tags.includes('crest')
      && !picked.tags.includes('flight')
      && !mustDos.some((m) => key(m) === pickKey);
    if (quietBishopBolt) {
      return {
        accept: false,
        reason: 'bolt',
        retryHints: [boltCap],
        fallback: boltCap,
      };
    }
  }

  // Spine. A quiet non-capture that leaves the hanging queen or rook is
  // rejected with reason spine. The step that clears the hang and leaves
  // a safe pawn arrow is the substitute. Captures, checks, escapes, nock,
  // forks, arrows, and axes stay. Nothing is dropped. play-loop forces
  // this on attempt 1.
  const spineStep = spineFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('spine'))
    : undefined;
  if (spineStep && picked && key(spineStep) !== pickKey) {
    const held = picked.tags.includes('capture')
      || picked.tags.includes('gives-check')
      || picked.tags.includes('escape')
      || picked.tags.includes('escape-best')
      || picked.tags.includes('nock')
      || picked.tags.includes('fork')
      || picked.kind === 'arrow'
      || picked.kind === 'axe';
    if (!held) {
      return {
        accept: false,
        reason: 'spine',
        retryHints: [spineStep],
        fallback: spineStep,
      };
    }
  }

  // Broadhead. A quiet non-capture that is not nock, crest, or flight
  // commits to the capture that makes a pawn arrow safe. Captures, checks,
  // escapes, arrows, and axes stay. Must-dos already returned above.
  // Nothing is dropped. play-loop forces this on attempt 1.
  const broadheadCap = broadheadFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('broadhead'))
    : undefined;
  if (broadheadCap && picked && key(broadheadCap) !== pickKey) {
    const held = picked.tags.includes('capture')
      || picked.tags.includes('gives-check')
      || picked.tags.includes('escape')
      || picked.tags.includes('escape-best')
      || picked.tags.includes('nock')
      || picked.tags.includes('crest')
      || picked.tags.includes('flight')
      || picked.kind === 'arrow'
      || picked.kind === 'axe';
    if (!held) {
      return {
        accept: false,
        reason: 'broadhead',
        retryHints: [broadheadCap],
        fallback: broadheadCap,
      };
    }
  }

  // Shaft. A quiet queen or rook step that is still ranked commits to the
  // step that makes a pawn arrow safe. Captures, checks, escapes, arrows,
  // axes, and other quiets stay. A move another filter already rejected
  // keeps that reason. Nothing is dropped. play-loop forces this on attempt 1.
  const shaftStep = shaftFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('shaft'))
    : undefined;
  if (shaftStep && picked && key(shaftStep) !== pickKey) {
    const quietQr = picked.kind === 'move'
      && (picked.type === 'queen' || picked.type === 'rook')
      && !picked.tags.includes('capture')
      && !picked.tags.includes('gives-check')
      && !picked.tags.includes('escape')
      && !picked.tags.includes('escape-best')
      && !picked.tags.includes('mate-net')
      && !picked.tags.includes('finish');
    if (quietQr) {
      return {
        accept: false,
        reason: 'shaft',
        retryHints: [shaftStep],
        fallback: shaftStep,
      };
    }
  }

  // Anchor. A quiet non-save that is still ranked commits to the move that
  // reduces the hanging-bishop count. Arrows, axes, captures, checks,
  // escapes, forks, finish, mate-net, king steps, and flight, nock, or
  // crest tags stay. A move another filter already rejected keeps that
  // reason. Nothing is dropped. play-loop forces this on attempt 1.
  const anchorStep = anchorFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('anchor'))
    : undefined;
  if (anchorStep && picked && key(anchorStep) !== pickKey) {
    const quietNonSave = picked.kind === 'move'
      && picked.type !== 'king'
      && !picked.tags.includes('capture')
      && !picked.tags.includes('gives-check')
      && !picked.tags.includes('escape')
      && !picked.tags.includes('escape-best')
      && !picked.tags.includes('flight')
      && !picked.tags.includes('nock')
      && !picked.tags.includes('crest')
      && !picked.tags.includes('mate-net')
      && !picked.tags.includes('finish')
      && !picked.tags.includes('fork');
    if (quietNonSave) {
      return {
        accept: false,
        reason: 'anchor',
        retryHints: [anchorStep],
        fallback: anchorStep,
      };
    }
  }

  // Cast. A quiet approach that is still ranked, including a finish
  // approach, commits to the bishop step that opens the first pawn ray.
  // Arrows, axes, captures, checks, escapes, forks, mate-net, king steps,
  // and flight, nock, crest, or anchor tags stay. Finish is not a hold:
  // the approach finish keeps is the walk this layer exists to replace.
  // A move another filter already rejected keeps that reason. Nothing is
  // dropped. play-loop forces this on attempt 1.
  const castStep = castFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('cast'))
    : undefined;
  if (castStep && picked && key(castStep) !== pickKey) {
    const quietWalk = picked.kind === 'move'
      && picked.type !== 'king'
      && !picked.tags.includes('capture')
      && !picked.tags.includes('gives-check')
      && !picked.tags.includes('escape')
      && !picked.tags.includes('escape-best')
      && !picked.tags.includes('flight')
      && !picked.tags.includes('nock')
      && !picked.tags.includes('crest')
      && !picked.tags.includes('mate-net')
      && !picked.tags.includes('fork')
      && !picked.tags.includes('anchor');
    if (quietWalk) {
      return {
        accept: false,
        reason: 'cast',
        retryHints: [castStep],
        fallback: castStep,
      };
    }
  }

  // Latch. Only when the block is already rank 0. A quiet queen, rook, or
  // king step is rejected. A quiet bishop, knight, or pawn is not, and
  // neither is a capture, a check, an arrow, an axe, or a flight, nock, or
  // crest tag. A lower block is never forced over those. Round 45's illegal
  // rise was the model naming a one-square diagonal from a rook. This
  // substitutes a listed block for that quiet rook instead of walking the
  // rook. Nothing is dropped. play-loop forces this on attempt 1.
  const latchStep = latchFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('latch'))
    : undefined;
  const latchTop = !!(latchStep && policy.ranked[0] && key(policy.ranked[0]) === key(latchStep));
  if (latchTop && latchStep && picked && key(latchStep) !== pickKey) {
    const quietHeavy = picked.kind === 'move'
      && (picked.type === 'queen' || picked.type === 'rook' || picked.type === 'king')
      && !picked.tags.includes('capture')
      && !picked.tags.includes('gives-check')
      && !picked.tags.includes('flight')
      && !picked.tags.includes('nock')
      && !picked.tags.includes('crest')
      && !picked.tags.includes('fork')
      && !picked.tags.includes('king-hunt')
      && !picked.tags.includes('king-help');
    if (quietHeavy) {
      return {
        accept: false,
        reason: 'latch',
        retryHints: [latchStep],
        fallback: latchStep,
      };
    }
  }

  // Sighter. Only when the loose-pawn slide is already rank 0. A quiet
  // queen, rook, or king step is rejected. A bishop, a knight, a pawn, a
  // capture, a check, an arrow, an axe, and a flight, nock, or crest tag
  // are not. A lower slide is never forced over those. Round 45's illegal
  // rise came from one-square rook diagonals; this slide is orthogonal and
  // at least two squares, and it is already on the legal list. Nothing is
  // dropped. play-loop forces this on attempt 1.
  const sighterStep = sighterFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('sighter'))
    : undefined;
  const sighterHeld = policy.ranked.some((r) =>
    r.tags.includes('flight') || r.tags.includes('nock') || r.tags.includes('crest')
  );
  const sighterTop = !!(sighterStep && policy.ranked[0] && key(policy.ranked[0]) === key(sighterStep));
  if (sighterTop && sighterStep && picked && !sighterHeld && key(sighterStep) !== pickKey) {
    const quietHeavy = picked.kind === 'move'
      && (picked.type === 'queen' || picked.type === 'rook' || picked.type === 'king')
      && !picked.tags.includes('capture')
      && !picked.tags.includes('gives-check')
      && !picked.tags.includes('escape')
      && !picked.tags.includes('escape-best')
      && !picked.tags.includes('flight')
      && !picked.tags.includes('nock')
      && !picked.tags.includes('crest')
      && !picked.tags.includes('fork')
      && !picked.tags.includes('king-hunt')
      && !picked.tags.includes('king-help');
    if (quietHeavy) {
      return {
        accept: false,
        reason: 'sighter',
        retryHints: [sighterStep],
        fallback: sighterStep,
      };
    }
  }

  // Pluck. Only when the new-attack step is already rank 0. A quiet queen,
  // rook, or king step is rejected. A bishop, a knight, a pawn, a capture,
  // a check, an arrow, an axe, and a flight, nock, or crest tag are not.
  // A lower step is never forced over those. The step is already on the
  // legal list. Nothing is dropped. play-loop forces this on attempt 1.
  const pluckStep = pluckFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('pluck'))
    : undefined;
  const pluckHeld = policy.ranked.some((r) =>
    r.tags.includes('flight') || r.tags.includes('nock') || r.tags.includes('crest')
  );
  const pluckTop = !!(pluckStep && policy.ranked[0] && key(policy.ranked[0]) === key(pluckStep));
  if (pluckTop && pluckStep && picked && !pluckHeld && key(pluckStep) !== pickKey) {
    const quietHeavy = picked.kind === 'move'
      && (picked.type === 'queen' || picked.type === 'rook' || picked.type === 'king')
      && !picked.tags.includes('capture')
      && !picked.tags.includes('gives-check')
      && !picked.tags.includes('escape')
      && !picked.tags.includes('escape-best')
      && !picked.tags.includes('flight')
      && !picked.tags.includes('nock')
      && !picked.tags.includes('crest')
      && !picked.tags.includes('fork')
      && !picked.tags.includes('king-hunt')
      && !picked.tags.includes('king-help');
    if (quietHeavy) {
      return {
        accept: false,
        reason: 'pluck',
        retryHints: [pluckStep],
        fallback: pluckStep,
      };
    }
  }

  // Quarry. Only when the closer queen or rook step is already rank 0.
  // A different quiet move is rejected. Nock, crest, flight, a capture, a
  // check, an arrow, and an axe are not this, and a lower quarry step is
  // never forced over them. Forcing a bishop ray over a higher nock is
  // how cast lost. Nothing is dropped. play-loop forces this on attempt 1.
  const quarryStep = quarryFiring(g, args.history)
    ? policy.ranked.find((r) => r.tags.includes('quarry'))
    : undefined;
  const quarryTop = !!(quarryStep && policy.ranked[0] && key(policy.ranked[0]) === key(quarryStep));
  if (quarryTop && quarryStep && picked && key(quarryStep) !== pickKey) {
    const quietJump = picked.kind === 'move'
      && !picked.tags.includes('capture')
      && !picked.tags.includes('gives-check')
      && !picked.tags.includes('escape')
      && !picked.tags.includes('escape-best')
      && !picked.tags.includes('nock')
      && !picked.tags.includes('crest')
      && !picked.tags.includes('flight')
      && !picked.tags.includes('fork')
      && !picked.tags.includes('king-hunt')
      && !picked.tags.includes('king-help');
    if (quietJump) {
      return {
        accept: false,
        reason: 'quarry',
        retryHints: [quarryStep],
        fallback: quarryStep,
      };
    }
  }

  // Bishop can arrow a pawn: don't quiet-shuffle instead. Promo/captures/must-dos still ok.
  const pawnArrows = policy.ranked.filter((r) => r.tags.includes('arrow-pawn') && !r.tags.includes('shot-waste'));
  if (
    pawnArrows.length
    && picked
    && picked.kind !== 'arrow'
    && !picked.tags.includes('capture')
    && !args.pick.promo
    && !mustDos.some((m) => key(m) === pickKey)
  ) {
    return {
      accept: false,
      reason: 'bishop-shoots',
      retryHints: pawnArrows,
      fallback: pawnArrows[0],
    };
  }

  const nonThrashEscapes = policy.ranked.filter((r) =>
    !r.tags.includes('reversal') && !r.tags.includes('oscillation'),
  );
  if (policy.inCheck && nonThrashEscapes.length === 0 && fallback) {
    if (key(fallback) !== pickKey) {
      return {
        accept: false,
        reason: 'only-escape-fallback',
        retryHints: policy.hints,
        fallback,
      };
    }
  }

  // Quill. A quiet knight that is not the shot is the move vane had to
  // retry. Substitute a legal tuck, or the shot when no tuck exists.
  // The knight stays in the ranked list. play-loop forces this on attempt 1.
  if (
    quillFiring(g, args.history)
    && picked
    && picked.kind === 'move'
    && picked.type === 'knight'
    && !picked.tags.includes('capture')
    && !picked.tags.includes('gives-check')
    && !picked.tags.includes('escape')
    && !picked.tags.includes('escape-best')
    && !knightIsShot(picked, args.board, args.color)
  ) {
    const tuck = policy.ranked.find((r) => r.tags.includes('quill'));
    const shot = policy.ranked.find((r) =>
      r.tags.includes('flight') || r.tags.includes('nock') || r.kind === 'arrow'
    );
    const sub = tuck ?? shot;
    if (sub && key(sub) !== pickKey) {
      return {
        accept: false,
        reason: 'quill',
        retryHints: [sub],
        fallback: sub,
      };
    }
  }

  return {
    accept: true,
    retryHints: policy.hints,
    fallback,
  };
}

/** Convenience: evaluate from a full GameState (side to move). */
export function evaluateState(state: GameState, legal?: PolicyAction[], genome?: PolicyGenome): PolicyResult {
  return evaluateComputerPolicy({
    board: state.board,
    color: state.currentTurn,
    legal: legal ?? collectLegalActions(state),
    history: state.moveHistory,
    genome,
  });
}

export function filterStatePick(
  state: GameState,
  pick: PolicyAction,
  legal?: PolicyAction[],
  genome?: PolicyGenome,
): FilterPickResult {
  return filterModelPick({
    board: state.board,
    color: state.currentTurn,
    legal: legal ?? collectLegalActions(state),
    history: state.moveHistory,
    pick,
    genome,
  });
}
