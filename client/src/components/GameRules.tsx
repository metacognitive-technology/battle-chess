import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { BookOpen, Castle, Target, Swords, Crown, Percent, Shield } from "lucide-react";

export function GameRules() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-2">
        <BookOpen className="w-4 h-4 text-muted-foreground" />
        <CardTitle className="text-sm font-medium">Game Rules</CardTitle>
      </CardHeader>
      <CardContent className="p-0 px-4 pb-4">
        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="setup">
            <AccordionTrigger className="text-sm py-2">
              <span className="flex items-center gap-2">
                <Castle className="w-4 h-4" />
                Setup Phase
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-xs text-muted-foreground space-y-1">
              <p>The game creator chooses how many walls each player gets (0-32).</p>
              <p>If walls are enabled, each player places walls on their half of the board before play begins.</p>
              <p>Walls block all piece movement and cannot be passed through.</p>
              <p>Click squares to toggle walls on/off, or use "Place Randomly" / "Generate Maze" for quick setup.</p>
              <p>Wall layouts can be saved and loaded from a shared library accessible to all players.</p>
              <p>Click "Ready" when done. Play begins once both sides are ready.</p>
              <p>If walls are set to 0, the setup phase is skipped entirely.</p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="budget">
            <AccordionTrigger className="text-sm py-2">
              <span className="flex items-center gap-2">
                <Percent className="w-4 h-4" />
                Attack Budget
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-xs text-muted-foreground space-y-1">
              <p>Each special attack has a success chance set by a percentage budget.</p>
              <p>The total budget (default 250%) is split across all five attack types using sliders. Higher percentage means a better chance of success.</p>
              <p><strong>Shared mode:</strong> The game creator sets attack percentages for both players.</p>
              <p><strong>Individual mode:</strong> Each player assigns their own percentages before play begins. Your opponent's settings are hidden during the game.</p>
              <p>This lets you choose a strategy: go all-in on one powerful attack, or spread the budget for balanced options.</p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="limits">
            <AccordionTrigger className="text-sm py-2">
              <span className="flex items-center gap-2">
                <Shield className="w-4 h-4" />
                Attack Limits
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-xs text-muted-foreground space-y-1">
              <p>The game creator can set limits on how many special attacks each individual bishop or rook may use per game (0-10 each).</p>
              <p><strong>Bishop Arrow Limit:</strong> Caps the number of arrow attacks each individual bishop can fire. Each bishop tracks its own count independently.</p>
              <p><strong>Rook Special Limit:</strong> Caps the number of bomb and wall-build attacks each individual rook can use. Each rook tracks its own count independently.</p>
              <p>When a piece is selected, a colored badge on bishops and rooks shows that piece's remaining attacks: blue (plenty), orange (low), or red (exhausted).</p>
              <p>Once an individual piece's limit reaches 0, the attack buttons appear grayed out and cannot be activated. The piece can still move normally.</p>
              <p>These limits apply equally to human players, AI opponents in Player vs Computer, and both sides in Computer vs Computer games.</p>
            </AccordionContent>
          </AccordionItem>
          
          <AccordionItem value="movement">
            <AccordionTrigger className="text-sm py-2">
              <span className="flex items-center gap-2">
                <Crown className="w-4 h-4" />
                Piece Movement
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-xs text-muted-foreground space-y-1">
              <p><strong>King:</strong> Moves 1 square in any direction.</p>
              <p><strong>Queen:</strong> Moves up to 8 squares in any direction.</p>
              <p><strong>Rook:</strong> Moves up to 8 squares horizontally/vertically.</p>
              <p><strong>Bishop:</strong> Moves up to 8 squares diagonally.</p>
              <p><strong>Knight:</strong> Moves in L-shape (2+1 squares). Can jump over walls as long as the landing square is not a wall.</p>
              <p><strong>Pawn:</strong> Moves 1 square in any direction (like a King). Promotes to Queen upon reaching the far row.</p>
            </AccordionContent>
          </AccordionItem>
          
          <AccordionItem value="attacks">
            <AccordionTrigger className="text-sm py-2">
              <span className="flex items-center gap-2">
                <Swords className="w-4 h-4" />
                Special Attacks
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-xs text-muted-foreground space-y-1">
              <p>Success chance for each attack depends on the percentage you assigned in the attack budget.</p>
              <p><strong>Pawn Attack:</strong> A pawn can attempt to capture an adjacent enemy. Pawn attacks always succeed (100%).</p>
              <p><strong>Bishop Arrow:</strong> Select a bishop and click the orange target icon. Fires an arrow at a distant enemy along its diagonal. Success chance is based on your bishop attack budget. Knights and Rooks are immune to arrows.</p>
              <p><strong>Knight Axe:</strong> Select a knight and click the purple axe icon. Strikes an adjacent enemy. Success chance is based on your knight axe budget.</p>
              <p><strong>Rook Bomb:</strong> Select a rook and click the red bomb icon. Destroys an adjacent wall. Success chance is based on your bomb budget.</p>
              <p><strong>Rook Wall Build:</strong> Select a rook and click the blue wall icon. Creates a new wall on an adjacent empty square. Success chance is based on your wall build budget.</p>
              <p>Each bishop and rook tracks its own attack count individually. A failed attack still counts toward that piece's limit.</p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="modes">
            <AccordionTrigger className="text-sm py-2">
              <span className="flex items-center gap-2">
                <Target className="w-4 h-4" />
                Game Modes
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-xs text-muted-foreground space-y-1">
              <p><strong>Player vs Player:</strong> Create a game and share the link. The second player joins as the opponent.</p>
              <p><strong>Player vs Computer:</strong> The default computer is the cand-r32 FILTER champion. It does not look ahead. The legacy heuristic is still available, and AI Depth 0-8 applies only to that policy.</p>
              <p><strong>Computer vs Computer:</strong> Watch two computers play each other. The default for both sides is cand-r32. You can load a saved CvC game and take over as either side.</p>
              <p>The legacy policy can use minimax with alpha-beta pruning for regular moves. Special attacks (arrows, axes, bombs) stay heuristic because they are probabilistic. cand-r32 does not search ahead.</p>
            </AccordionContent>
          </AccordionItem>
          
          <AccordionItem value="winning">
            <AccordionTrigger className="text-sm py-2">
              <span className="flex items-center gap-2">
                <Crown className="w-4 h-4" />
                Winning
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-xs text-muted-foreground space-y-1">
              <p>Capture the opponent's King to win.</p>
              <p>Or put them in checkmate (no legal moves).</p>
              <p>Players can also offer or accept a draw.</p>
              <p>Resign to forfeit the game.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
