import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { GameBoard, AttackAnimation, AttackAnimationType } from "@/components/GameBoard";
import { PlayerPanel } from "@/components/PlayerPanel";
import { MoveHistory } from "@/components/MoveHistory";
import { GameControls } from "@/components/GameControls";
import { GameStatus } from "@/components/GameStatus";
import { GameRules } from "@/components/GameRules";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useToast } from "@/hooks/use-toast";
import { getValidMoves, getCheckSafeMoves, getArrowTargets, getAxeTargets, getBombTargets, getWallBuildTargets, findHangingPieces, isInCheck, isCheckmate, createInitialBoard, PIECE_SYMBOLS } from "@/lib/gameUtils";
import type { Position, GameState, SavedGameInfo, PromotionPieceType } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Wifi, WifiOff, Plus, Link2, Bot, Users, History, Trash2, MonitorPlay, Play, ArrowLeft, ArrowRight, User, Brain } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { playAttackSound, playSuccessSound, playFailSound, playVictoryFanfare, playDefeatSound } from "@/lib/sounds";

const GAME_VERSION = "1.20.2";

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default function Game() {
  const searchParams = new URLSearchParams(useSearch());
  const gameIdFromUrl = searchParams.get('game');
  const playerIdFromUrl = searchParams.get('playerId');
  
  const { toast } = useToast();
  const [drawOffered, setDrawOffered] = useState(false);
  const [drawOfferPending, setDrawOfferPending] = useState(false);
  
  const {
    gameState,
    playerId,
    playerColor,
    connectionStatus,
    sendMessage,
    createGame,
    joinGame,
    reconnectGame,
    takeoverGame,
    watchCvCGame,
    pauseCvCGame,
    offerDraw,
    respondToDraw,
    submitBudget,
    isObserver,
    lastError,
    pendingPromotion,
    clearPendingPromotion,
  } = useWebSocket({
    onDrawOffered: () => {
      setDrawOffered(true);
      toast({
        title: "Draw Offered",
        description: "Your opponent has offered a draw.",
      });
    },
    onDrawResponse: (accepted: boolean) => {
      setDrawOfferPending(false);
      if (!accepted) {
        toast({
          title: "Draw Declined",
          description: "Your opponent declined the draw offer.",
        });
      }
    },
  });
  
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [isArrowMode, setIsArrowMode] = useState(false);
  const [isAxeMode, setIsAxeMode] = useState(false);
  const [isBombMode, setIsBombMode] = useState(false);
  const [isWallBuildMode, setIsWallBuildMode] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [maxWalls, setMaxWalls] = useState(8);
  const [joinGameId, setJoinGameId] = useState(gameIdFromUrl || '');
  const [flashingSquare, setFlashingSquare] = useState<Position | null>(null);
  const [attackAnimation, setAttackAnimation] = useState<AttackAnimation | null>(null);
  const [flashColor, setFlashColor] = useState<'red' | 'yellow'>('red');
  const [isCreatingCvC, setIsCreatingCvC] = useState(false);
  const [moveFlashSquares, setMoveFlashSquares] = useState<Position[]>([]);
  const [targetPopup, setTargetPopup] = useState<{ position: Position; message: string } | null>(null);
  const [isCvCPaused, setIsCvCPaused] = useState(false);
  const lastDiceRollRef = useRef<string | null>(null);
  const lastPhaseRef = useRef<string | null>(null);
  const lastMoveCountRef = useRef<number>(0);
  
  // Attack probability settings (percentage-based)
  const [totalAttackBudget, setTotalAttackBudget] = useState(250);
  const [pawnAttackPercent, setPawnAttackPercent] = useState(17);
  const [bishopAttackPercent, setBishopAttackPercent] = useState(50);
  const [knightAttackPercent, setKnightAttackPercent] = useState(50);
  const [bombAttackPercent, setBombAttackPercent] = useState(10);
  const [wallBuildPercent, setWallBuildPercent] = useState(50);
  const [budgetMode, setBudgetMode] = useState<'shared' | 'individual'>('shared');
  const [aiDepth, setAiDepth] = useState(0);
  const [maxBishopAttacksLobby, setMaxBishopAttacksLobby] = useState(10);
  const [maxRookAttacksLobby, setMaxRookAttacksLobby] = useState(10);
  const [attackStats, setAttackStats] = useState<{ gamesPlayed: number; bishopArrows: { min: number; avg: number; max: number }; rookBombs: { min: number; avg: number; max: number }; rookWallBuilds: { min: number; avg: number; max: number } } | null>(null);
  const [budgetSubmitted, setBudgetSubmitted] = useState(false);

  const totalUsed = pawnAttackPercent + bishopAttackPercent + knightAttackPercent + bombAttackPercent + wallBuildPercent;
  const budgetRemaining = totalAttackBudget - totalUsed;

  const clampToAttackBudget = (newValue: number, currentValue: number) => {
    const otherTotal = totalUsed - currentValue;
    const maxAllowed = Math.min(100, totalAttackBudget - otherTotal);
    return Math.max(0, Math.min(newValue, maxAllowed));
  };

  const percentToThreshold = (percent: number, dieSize: number, rollUnder: boolean) => {
    if (rollUnder) return Math.round(percent / 100 * dieSize);
    return dieSize + 1 - Math.round(percent / 100 * dieSize);
  };
  
  // Fetch saved games
  const { data: savedGames = [], isLoading: loadingSavedGames } = useQuery<SavedGameInfo[]>({
    queryKey: ['/api/games'],
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    fetch('/api/attack-stats')
      .then(r => r.json())
      .then(data => setAttackStats(data))
      .catch(() => {});
  }, []);
  
  const handleDeleteGame = useCallback(async (gameId: string) => {
    try {
      const storedPlayerId = localStorage.getItem(`playerId_${gameId}`);
      const url = storedPlayerId 
        ? `/api/games/${gameId}?playerId=${storedPlayerId}`
        : `/api/games/${gameId}`;
      await apiRequest('DELETE', url);
      queryClient.invalidateQueries({ queryKey: ['/api/games'] });
      localStorage.removeItem(`playerId_${gameId}`);
      toast({
        title: "Game deleted",
        description: "The saved game has been removed.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete game. You may not have permission.",
        variant: "destructive",
      });
    }
  }, [toast]);
  
  const handleReconnectToGame = useCallback((game: SavedGameInfo, storedPlayerId: string | null) => {
    reconnectGame(game.id, storedPlayerId);
  }, [reconnectGame]);

  const handleCreateCvCGame = useCallback(async () => {
    setIsCreatingCvC(true);
    try {
      const attackSettings = {
        pawnSuccessRoll: percentToThreshold(pawnAttackPercent, 6, true),
        bishopMinRoll: 0,
        knightMinRoll: percentToThreshold(knightAttackPercent, 6, false),
        bombSuccessRoll: percentToThreshold(bombAttackPercent, 10, true),
        wallBuildRoll: percentToThreshold(wallBuildPercent, 10, true),
        totalAttackBudget,
        maxBishopAttacks: maxBishopAttacksLobby,
        maxRookAttacks: maxRookAttacksLobby,
        pawnAttackPercent,
        bishopAttackPercent,
        knightAttackPercent,
        bombAttackPercent,
        wallBuildPercent,
      };
      const response = await apiRequest('POST', '/api/games/cvc', { maxWalls, attackSettings, aiDepth });
      const data = await response.json();
      queryClient.invalidateQueries({ queryKey: ['/api/games'] });
      watchCvCGame(data.gameId);
      toast({
        title: "Watching CvC Game",
        description: "Watch the computers play! You can take over as White or Black at any time.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create computer vs computer game.",
        variant: "destructive",
      });
    } finally {
      setIsCreatingCvC(false);
    }
  }, [maxWalls, toast, watchCvCGame, pawnAttackPercent, bishopAttackPercent, knightAttackPercent, bombAttackPercent, wallBuildPercent, totalAttackBudget, percentToThreshold, aiDepth, maxBishopAttacksLobby, maxRookAttacksLobby]);

  const handleTakeoverGame = useCallback((gameId: string, color: 'white' | 'black') => {
    takeoverGame(gameId, color);
  }, [takeoverGame]);

  const handleClearAllGames = useCallback(async () => {
    try {
      await apiRequest('DELETE', '/api/games');
      // Clear all stored player IDs from localStorage
      savedGames.forEach(game => {
        localStorage.removeItem(`playerId_${game.id}`);
      });
      queryClient.invalidateQueries({ queryKey: ['/api/games'] });
      toast({
        title: "All games cleared",
        description: "All saved games have been removed.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to clear games.",
        variant: "destructive",
      });
    }
  }, [savedGames, toast]);
  
  // Auto-join / reconnect from URL (?game=…&playerId=… for theater PvC-from-ply)
  useEffect(() => {
    if (gameIdFromUrl && !gameState) {
      if (playerIdFromUrl) {
        try { localStorage.setItem(`playerId_${gameIdFromUrl}`, playerIdFromUrl); } catch {}
        reconnectGame(gameIdFromUrl, playerIdFromUrl);
      } else {
        const stored = (() => { try { return localStorage.getItem(`playerId_${gameIdFromUrl}`); } catch { return null; } })();
        if (stored) reconnectGame(gameIdFromUrl, stored);
        else joinGame(gameIdFromUrl);
      }
    }
  }, [gameIdFromUrl, playerIdFromUrl, gameState, joinGame, reconnectGame]);
  
  useEffect(() => {
    if (gameState?.attackSettings?.totalAttackBudget != null) {
      setTotalAttackBudget(gameState.attackSettings.totalAttackBudget);
    }
    if (gameState?.phase && gameState.phase !== 'budget_setup') {
      setBudgetSubmitted(false);
    }
  }, [gameState?.attackSettings?.totalAttackBudget, gameState?.phase]);
  
  // Show errors as toasts
  useEffect(() => {
    if (lastError) {
      toast({
        title: "Error",
        description: lastError,
        variant: "destructive",
      });
    }
  }, [lastError, toast]);
  
  // Handle dice roll results with flash effect - only for actual attacks
  useEffect(() => {
    if (gameState?.lastDiceRoll && gameState.moveHistory.length > 0) {
      const lastMove = gameState.moveHistory[gameState.moveHistory.length - 1];
      
      // Only show flash/toast if the last move was actually an attack (has explicit attack flag or dice roll data)
      const isAttackMove = lastMove.isArrowAttack || lastMove.isAxeAttack || lastMove.isBombAttack || lastMove.isWallBuild || (lastMove.diceRoll !== undefined && lastMove.diceRequired !== undefined);
      if (!isAttackMove) return;
      
      const rollKey = `${lastMove.from.row}-${lastMove.from.col}-${lastMove.to.row}-${lastMove.to.col}-${gameState.lastDiceRoll.value}`;
      
      if (lastDiceRollRef.current !== rollKey) {
        lastDiceRollRef.current = rollKey;
        
        const diceType = gameState.lastDiceRoll.type;
        const rolled = gameState.lastDiceRoll.value;
        const success = gameState.lastDiceRoll.success;
        const distance = Math.max(
          Math.abs(lastMove.to.row - lastMove.from.row),
          Math.abs(lastMove.to.col - lastMove.from.col)
        );
        const pieceType = lastMove.piece?.type || 'pawn';
        
        // Determine animation type based on move flags, not piece type
        let animType: AttackAnimationType = 'pawn';
        if (lastMove.isArrowAttack) animType = 'arrow';
        else if (lastMove.isAxeAttack) animType = 'axe';
        else if (lastMove.isWallBuild) animType = 'wallbuild';
        else if (lastMove.isBombAttack) animType = 'bomb';
        
        // Trigger attack animation and sound
        setAttackAnimation({
          type: animType,
          from: lastMove.from,
          to: lastMove.to,
          success,
        });
        
        // Play attack sound
        playAttackSound(animType);
        
        // Play success/fail sound after attack lands
        setTimeout(() => {
          if (success) {
            playSuccessSound();
          } else {
            playFailSound();
          }
        }, 600);
        
        // Clear animation after it plays
        setTimeout(() => setAttackAnimation(null), 1100);
        
        // Flash the target square on success (red), or the attacker on failure (yellow)
        if (success) {
          setFlashColor('red');
          setFlashingSquare(lastMove.to);
        } else {
          setFlashColor('yellow');
          setFlashingSquare(lastMove.from);
        }
        
        if (!success) {
          let failMessage = '';
          if (lastMove.isArrowAttack) {
            failMessage = `Missed! (${rolled})`;
          } else if (lastMove.isAxeAttack) {
            failMessage = `Missed! (${rolled})`;
          } else if (lastMove.isBombAttack) {
            failMessage = `Failed! (${rolled})`;
          } else if (lastMove.isWallBuild) {
            failMessage = `Failed! (${rolled})`;
          } else {
            failMessage = `Failed! (${rolled})`;
          }
          
          setTimeout(() => {
            setTargetPopup({ position: lastMove.to, message: failMessage });
            setTimeout(() => setTargetPopup(null), 2000);
          }, 600);
        }
        
        setTimeout(() => {
          setFlashingSquare(null);
        }, 600);
      }
    }
  }, [gameState?.lastDiceRoll, gameState?.moveHistory]);
  
  // Play victory/defeat sounds when game ends
  useEffect(() => {
    if (!gameState) return;
    
    const currentPhase = gameState.phase;
    const prevPhase = lastPhaseRef.current;
    
    // Detect transition to 'finished' phase
    if (currentPhase === 'finished' && prevPhase !== 'finished') {
      const winner = gameState.winner;
      
      if (playerColor && winner) {
        // Delay slightly to let the final move register
        setTimeout(() => {
          if (winner === playerColor) {
            playVictoryFanfare();
          } else {
            playDefeatSound();
          }
        }, 500);
      }
    }
    
    lastPhaseRef.current = currentPhase;
  }, [gameState?.phase, gameState?.winner, playerColor]);
  
  // Flash origin and destination squares when a move is made
  useEffect(() => {
    if (!gameState || !gameState.moveHistory.length) return;
    
    const currentMoveCount = gameState.moveHistory.length;
    if (currentMoveCount > lastMoveCountRef.current) {
      const lastMove = gameState.moveHistory[currentMoveCount - 1];
      
      // Set the squares to flash
      setMoveFlashSquares([lastMove.from, lastMove.to]);
      
      // Clear flash after animation (1.5s for 3 flashes at 0.5s each)
      setTimeout(() => {
        setMoveFlashSquares([]);
      }, 1500);
    }
    
    lastMoveCountRef.current = currentMoveCount;
  }, [gameState?.moveHistory]);
  
  const board = gameState?.board || createInitialBoard();
  const phase = gameState?.phase || 'waiting';
  const currentTurn = gameState?.currentTurn || 'white';
  
  const validMoves = useMemo(() => {
    if (!selectedPosition || !gameState || phase !== 'playing' || isArrowMode || isAxeMode || isBombMode || isWallBuildMode) return [];
    const piece = board[selectedPosition.row][selectedPosition.col].piece;
    if (!piece || piece.color !== playerColor || playerColor !== currentTurn) return [];
    // Use getCheckSafeMoves to filter out moves that would leave king in check
    return getCheckSafeMoves(board, selectedPosition);
  }, [selectedPosition, gameState, phase, isArrowMode, isAxeMode, isBombMode, isWallBuildMode, board, playerColor, currentTurn]);
  
  const arrowTargets = useMemo(() => {
    if (!selectedPosition || !isArrowMode || !gameState || phase !== 'playing') return [];
    return getArrowTargets(board, selectedPosition);
  }, [selectedPosition, isArrowMode, gameState, phase, board]);
  
  const axeTargets = useMemo(() => {
    if (!selectedPosition || !isAxeMode || !gameState || phase !== 'playing') return [];
    return getAxeTargets(board, selectedPosition);
  }, [selectedPosition, isAxeMode, gameState, phase, board]);
  
  const bombTargets = useMemo(() => {
    if (!selectedPosition || !isBombMode || !gameState || phase !== 'playing') return [];
    return getBombTargets(board, selectedPosition);
  }, [selectedPosition, isBombMode, gameState, phase, board]);
  
  const wallBuildTargets = useMemo(() => {
    if (!selectedPosition || !isWallBuildMode || !gameState || phase !== 'playing') return [];
    return getWallBuildTargets(board, selectedPosition);
  }, [selectedPosition, isWallBuildMode, gameState, phase, board]);
  
  const hangingPieces = useMemo(() => {
    if (!gameState || phase !== 'playing' || !playerColor) return [];
    return findHangingPieces(board, playerColor);
  }, [gameState, phase, playerColor, board]);
  
  const wallPositions = useMemo(() => {
    if (!board) return [];
    const positions: Position[] = [];
    for (let row = 0; row < board.length; row++) {
      for (let col = 0; col < board[row].length; col++) {
        if (board[row][col].isWall) {
          positions.push({ row, col });
        }
      }
    }
    return positions;
  }, [board]);
  
  const checkStatus = useMemo(() => {
    if (!gameState || phase !== 'playing') return { isCheck: false, isCheckmate: false };
    const inCheck = isInCheck(board, currentTurn);
    const inCheckmate = inCheck && isCheckmate(board, currentTurn);
    return {
      isCheck: inCheck,
      isCheckmate: inCheckmate,
    };
  }, [gameState, phase, board, currentTurn]);
  
  const handleSquareClick = useCallback((position: Position) => {
    if (!gameState) return;
    
    // Setup phase - toggle walls
    if (phase === 'setup') {
      const isOwnHalf = playerColor === 'white' 
        ? position.row >= 6 
        : position.row < 6;
      
      if (!isOwnHalf) return;
      
      const square = board[position.row][position.col];
      if (square.piece) return; // Can't place wall on piece
      
      sendMessage({
        type: 'setup_wall',
        payload: { position },
      });
      return;
    }
    
    // Playing phase
    if (phase !== 'playing' || playerColor !== currentTurn) return;
    
    // Arrow mode - select target
    if (isArrowMode && selectedPosition) {
      const isTarget = arrowTargets.some(t => t.row === position.row && t.col === position.col);
      if (isTarget) {
        sendMessage({
          type: 'arrow_attack',
          payload: { from: selectedPosition, to: position },
        });
        setIsArrowMode(false);
        setSelectedPosition(null);
      } else {
        setIsArrowMode(false);
      }
      return;
    }
    
    // Axe mode - select target
    if (isAxeMode && selectedPosition) {
      const isTarget = axeTargets.some(t => t.row === position.row && t.col === position.col);
      if (isTarget) {
        sendMessage({
          type: 'axe_attack',
          payload: { from: selectedPosition, to: position },
        });
        setIsAxeMode(false);
        setSelectedPosition(null);
      } else {
        setIsAxeMode(false);
      }
      return;
    }
    
    // Bomb mode - select wall target
    if (isBombMode && selectedPosition) {
      const isTarget = bombTargets.some(t => t.row === position.row && t.col === position.col);
      if (isTarget) {
        sendMessage({
          type: 'bomb_attack',
          payload: { from: selectedPosition, to: position },
        });
        setIsBombMode(false);
        setSelectedPosition(null);
      } else {
        setIsBombMode(false);
      }
      return;
    }
    
    if (isWallBuildMode && selectedPosition) {
      const isTarget = wallBuildTargets.some(t => t.row === position.row && t.col === position.col);
      if (isTarget) {
        sendMessage({
          type: 'wall_attack',
          payload: { from: selectedPosition, to: position },
        });
        setIsWallBuildMode(false);
        setSelectedPosition(null);
      } else {
        setIsWallBuildMode(false);
      }
      return;
    }
    
    const clickedPiece = board[position.row][position.col].piece;
    
    // If clicking on own piece, select it
    if (clickedPiece && clickedPiece.color === playerColor) {
      setSelectedPosition(position);
      setIsArrowMode(false);
      setIsAxeMode(false);
      setIsBombMode(false);
      return;
    }
    
    // If we have a selection and clicking on valid move, make move
    if (selectedPosition) {
      const isValidMove = validMoves.some(m => m.row === position.row && m.col === position.col);
      if (isValidMove) {
        sendMessage({
          type: 'move',
          payload: { from: selectedPosition, to: position },
        });
        setSelectedPosition(null);
      } else {
        setSelectedPosition(null);
      }
    }
  }, [gameState, phase, playerColor, currentTurn, isArrowMode, isAxeMode, isBombMode, isWallBuildMode, selectedPosition, arrowTargets, axeTargets, bombTargets, wallBuildTargets, validMoves, board, sendMessage]);
  
  const handleArrowModeToggle = useCallback((position: Position) => {
    if (!playerColor || !gameState) return;
    const piece = gameState.board[position.row]?.[position.col]?.piece;
    const used = piece?.id ? (gameState.specialAttackCounts?.[piece.id] ?? 0) : 0;
    const max = gameState.maxBishopAttacks ?? 10;
    if (used >= max) return;
    setIsArrowMode(true);
    setIsAxeMode(false);
    setIsBombMode(false);
    setSelectedPosition(position);
  }, [playerColor, gameState]);
  
  const handleAxeModeToggle = useCallback((position: Position) => {
    setIsAxeMode(true);
    setIsArrowMode(false);
    setIsBombMode(false);
    setSelectedPosition(position);
  }, []);
  
  const handleBombModeToggle = useCallback((position: Position) => {
    if (!playerColor || !gameState) return;
    const piece = gameState.board[position.row]?.[position.col]?.piece;
    const used = piece?.id ? (gameState.specialAttackCounts?.[piece.id] ?? 0) : 0;
    const max = gameState.maxRookAttacks ?? 10;
    if (used >= max) return;
    setIsBombMode(true);
    setIsArrowMode(false);
    setIsAxeMode(false);
    setIsWallBuildMode(false);
    setSelectedPosition(position);
  }, [playerColor, gameState]);
  
  const handleWallBuildModeToggle = useCallback((position: Position) => {
    if (!playerColor || !gameState) return;
    const piece = gameState.board[position.row]?.[position.col]?.piece;
    const used = piece?.id ? (gameState.specialAttackCounts?.[piece.id] ?? 0) : 0;
    const max = gameState.maxRookAttacks ?? 10;
    if (used >= max) return;
    setIsWallBuildMode(true);
    setIsArrowMode(false);
    setIsAxeMode(false);
    setIsBombMode(false);
    setSelectedPosition(position);
  }, [playerColor, gameState]);
  
  const handleReady = useCallback(() => {
    setIsReady(true);
    sendMessage({ type: 'ready', payload: {} });
  }, [sendMessage]);
  
  const handleRandomWalls = useCallback(() => {
    sendMessage({ type: 'setup_random_walls', payload: {} });
  }, [sendMessage]);
  
  const handleMazeWalls = useCallback(() => {
    sendMessage({ type: 'setup_maze_walls', payload: {} });
  }, [sendMessage]);
  
  const handleLoadLayout = useCallback((walls: Position[]) => {
    sendMessage({ type: 'setup_load_layout', payload: { walls } });
  }, [sendMessage]);
  
  const handleNewGame = useCallback(() => {
    window.location.href = '/';
  }, []);
  
  const handleResign = useCallback(() => {
    // For CvC games, send stop_cvc message instead
    if (gameState?.gameMode === 'cvc') {
      sendMessage({ type: 'stop_cvc', payload: {} });
    } else {
      sendMessage({ type: 'move', payload: { resign: true } });
    }
  }, [sendMessage, gameState?.gameMode]);
  
  const handleOfferDraw = useCallback(() => {
    setDrawOfferPending(true);
    offerDraw();
    toast({
      title: "Draw Offered",
      description: "Waiting for opponent's response...",
    });
  }, [offerDraw, toast]);
  
  const handleAcceptDraw = useCallback(() => {
    respondToDraw(true);
    setDrawOffered(false);
  }, [respondToDraw]);
  
  const handleDeclineDraw = useCallback(() => {
    respondToDraw(false);
    setDrawOffered(false);
    toast({
      title: "Draw Declined",
      description: "The game continues.",
    });
  }, [respondToDraw, toast]);
  
  const handleTogglePause = useCallback(() => {
    const newPaused = !isCvCPaused;
    setIsCvCPaused(newPaused);
    pauseCvCGame(newPaused);
  }, [isCvCPaused, pauseCvCGame]);
  
  const handleHandoff = useCallback(() => {
    sendMessage({ type: 'handoff', payload: {} });
    toast({
      title: "Handed Off to AI",
      description: "The AI will play for you. Click 'Take Control' to resume.",
    });
  }, [sendMessage, toast]);
  
  const handleTakeControl = useCallback(() => {
    sendMessage({ type: 'take_control', payload: {} });
    toast({
      title: "Control Resumed",
      description: "You are now playing again.",
    });
  }, [sendMessage, toast]);
  
  const handlePromotion = useCallback((pieceType: PromotionPieceType) => {
    if (pendingPromotion) {
      sendMessage({
        type: 'move',
        payload: { 
          from: pendingPromotion.from, 
          to: pendingPromotion.to,
          promotionPiece: pieceType,
        },
      });
      clearPendingPromotion();
    }
  }, [pendingPromotion, sendMessage, clearPendingPromotion]);
  
  
  // Lobby view - no game yet
  if (!gameState) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold">Battle Chess</CardTitle>
            <p className="text-muted-foreground">A novel chess variant with walls and special attacks</p>
            <p className="text-xs text-muted-foreground mt-1">Version {GAME_VERSION}</p>
            {attackStats && attackStats.gamesPlayed > 0 && (
              <div className="mt-3 p-3 bg-muted/50 rounded-lg text-xs space-y-1" data-testid="attack-stats-panel">
                <p className="font-medium text-sm text-foreground">Per-Game Attack Stats ({attackStats.gamesPlayed} games)</p>
                <div className="grid grid-cols-4 gap-x-3 gap-y-1 text-muted-foreground">
                  <span></span>
                  <span className="text-center font-semibold text-foreground">Low</span>
                  <span className="text-center font-semibold text-foreground">Avg</span>
                  <span className="text-center font-semibold text-foreground">High</span>
                  <span>Bishop arrows:</span>
                  <span className="text-center font-mono" data-testid="stat-bishop-min">{attackStats.bishopArrows.min}</span>
                  <span className="text-center font-mono" data-testid="stat-bishop-avg">{attackStats.bishopArrows.avg}</span>
                  <span className="text-center font-mono" data-testid="stat-bishop-max">{attackStats.bishopArrows.max}</span>
                  <span>Rook bombs:</span>
                  <span className="text-center font-mono" data-testid="stat-bomb-min">{attackStats.rookBombs.min}</span>
                  <span className="text-center font-mono" data-testid="stat-bomb-avg">{attackStats.rookBombs.avg}</span>
                  <span className="text-center font-mono" data-testid="stat-bomb-max">{attackStats.rookBombs.max}</span>
                  <span>Rook walls:</span>
                  <span className="text-center font-mono" data-testid="stat-wall-min">{attackStats.rookWallBuilds.min}</span>
                  <span className="text-center font-mono" data-testid="stat-wall-avg">{attackStats.rookWallBuilds.avg}</span>
                  <span className="text-center font-mono" data-testid="stat-wall-max">{attackStats.rookWallBuilds.max}</span>
                </div>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center gap-2 justify-center text-sm">
              {connectionStatus === 'connected' ? (
                <>
                  <Wifi className="w-4 h-4 text-green-500" />
                  <span className="text-green-500">Connected</span>
                </>
              ) : connectionStatus === 'connecting' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Not connected</span>
                </>
              )}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="walls-per-player">Walls per player</Label>
              <Select 
                value={maxWalls.toString()} 
                onValueChange={(v) => setMaxWalls(parseInt(v))}
              >
                <SelectTrigger id="walls-per-player" data-testid="select-walls">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 4, 8, 12, 16, 24, 32].map(n => (
                    <SelectItem key={n} value={n.toString()}>{n} walls</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label>Budget Assignment</Label>
              <Select
                value={budgetMode}
                onValueChange={(v) => setBudgetMode(v as 'shared' | 'individual')}
              >
                <SelectTrigger data-testid="select-budget-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared">Shared (same for both players)</SelectItem>
                  <SelectItem value="individual">Individual (each player assigns their own)</SelectItem>
                </SelectContent>
              </Select>
              {budgetMode === 'individual' && (
                <p className="text-xs text-muted-foreground">Each player will assign their own attack percentages within the budget before play begins.</p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <Label>AI Look-Ahead (Ply Depth)</Label>
                <span className="text-muted-foreground">{aiDepth === 0 ? 'Off (fast)' : `${aiDepth} ply${aiDepth > 1 ? 's' : ''}`}</span>
              </div>
              <input
                type="range"
                min="0"
                max="8"
                step="1"
                value={aiDepth}
                onChange={(e) => setAiDepth(parseInt(e.target.value))}
                className="w-full accent-primary"
                data-testid="slider-ai-depth"
              />
              <p className="text-xs text-muted-foreground">
                {aiDepth === 0 && 'Instant moves, heuristic only.'}
                {aiDepth >= 1 && aiDepth <= 2 && `Thinks ${aiDepth} move${aiDepth > 1 ? 's' : ''} ahead. Quick.`}
                {aiDepth >= 3 && aiDepth <= 4 && `Thinks ${aiDepth} moves ahead. Moderate.`}
                {aiDepth >= 5 && aiDepth <= 6 && `Thinks ${aiDepth} moves ahead. Slow but strong.`}
                {aiDepth >= 7 && `Thinks ${aiDepth} moves ahead. Very slow, strongest.`}
              </p>
            </div>

            <div className="space-y-3 pt-2 border-t">
              <h4 className="text-sm font-medium text-muted-foreground">Attack Limits (per piece)</h4>
              
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <Label>Bishop Arrow Attacks</Label>
                  <span className="text-muted-foreground">{maxBishopAttacksLobby}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="75"
                  step="1"
                  value={maxBishopAttacksLobby}
                  onChange={(e) => setMaxBishopAttacksLobby(parseInt(e.target.value))}
                  className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                  data-testid="slider-max-bishop-attacks"
                />
                <p className="text-xs text-muted-foreground">Each bishop can fire up to {maxBishopAttacksLobby} arrow{maxBishopAttacksLobby !== 1 ? 's' : ''}</p>
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <Label>Rook Special Attacks</Label>
                  <span className="text-muted-foreground">{maxRookAttacksLobby}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="75"
                  step="1"
                  value={maxRookAttacksLobby}
                  onChange={(e) => setMaxRookAttacksLobby(parseInt(e.target.value))}
                  className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                  data-testid="slider-max-rook-attacks"
                />
                <p className="text-xs text-muted-foreground">Each rook can use up to {maxRookAttacksLobby} bomb/wall build attack{maxRookAttacksLobby !== 1 ? 's' : ''}</p>
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t">
              <h4 className="text-sm font-medium text-muted-foreground">
                {budgetMode === 'individual' ? 'Attack Budget (max per player)' : 'Special Attack Chances'}
              </h4>
              
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <Label>Total Budget</Label>
                  <span className="text-muted-foreground">{totalAttackBudget}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="500"
                  step="5"
                  value={totalAttackBudget}
                  onChange={(e) => {
                    const newBudget = parseInt(e.target.value);
                    setTotalAttackBudget(newBudget);
                    const currentTotal = pawnAttackPercent + bishopAttackPercent + knightAttackPercent + bombAttackPercent + wallBuildPercent;
                    if (currentTotal > newBudget) {
                      const scale = newBudget / currentTotal;
                      setPawnAttackPercent(Math.round(pawnAttackPercent * scale));
                      setBishopAttackPercent(Math.round(bishopAttackPercent * scale));
                      setKnightAttackPercent(Math.round(knightAttackPercent * scale));
                      setBombAttackPercent(Math.round(bombAttackPercent * scale));
                      setWallBuildPercent(Math.round(wallBuildPercent * scale));
                    }
                  }}
                  className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                  data-testid="slider-total-budget"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Used: {totalUsed}%</span>
                  <span className={budgetRemaining < 0 ? "text-destructive font-medium" : ""}>
                    Remaining: {budgetRemaining}%
                  </span>
                </div>
              </div>

              {budgetMode === 'shared' && (
                <>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Pawn Attack</Label>
                      <span className="text-muted-foreground">{pawnAttackPercent}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={pawnAttackPercent}
                      onChange={(e) => setPawnAttackPercent(clampToAttackBudget(parseInt(e.target.value), pawnAttackPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="slider-pawn-attack"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Bishop Arrow</Label>
                      <span className="text-muted-foreground">{bishopAttackPercent}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={bishopAttackPercent}
                      onChange={(e) => setBishopAttackPercent(clampToAttackBudget(parseInt(e.target.value), bishopAttackPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="slider-bishop-attack"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Knight Axe</Label>
                      <span className="text-muted-foreground">{knightAttackPercent}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={knightAttackPercent}
                      onChange={(e) => setKnightAttackPercent(clampToAttackBudget(parseInt(e.target.value), knightAttackPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="slider-knight-attack"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Rook Bomb</Label>
                      <span className="text-muted-foreground">{bombAttackPercent}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={bombAttackPercent}
                      onChange={(e) => setBombAttackPercent(clampToAttackBudget(parseInt(e.target.value), bombAttackPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="slider-bomb-attack"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Rook Wall Build</Label>
                      <span className="text-muted-foreground">{wallBuildPercent}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={wallBuildPercent}
                      onChange={(e) => setWallBuildPercent(clampToAttackBudget(parseInt(e.target.value), wallBuildPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="slider-wall-build"
                    />
                  </div>
                </>
              )}
            </div>
            
            <div className="space-y-4">
              <Button 
                className="w-full gap-2" 
                size="lg"
                onClick={() => {
                  const as = {
                    pawnSuccessRoll: percentToThreshold(pawnAttackPercent, 6, true),
                    bishopMinRoll: 0,
                    knightMinRoll: percentToThreshold(knightAttackPercent, 6, false),
                    bombSuccessRoll: percentToThreshold(bombAttackPercent, 10, true),
                    wallBuildRoll: percentToThreshold(wallBuildPercent, 10, true),
                    totalAttackBudget,
                    maxBishopAttacks: maxBishopAttacksLobby,
                    maxRookAttacks: maxRookAttacksLobby,
                    ...(budgetMode === 'shared' ? { pawnAttackPercent, bishopAttackPercent, knightAttackPercent, bombAttackPercent, wallBuildPercent } : {}),
                  };
                  createGame(maxWalls, 'pvc', as, budgetMode, aiDepth);
                }}
                data-testid="button-play-computer"
              >
                <Bot className="w-5 h-5" />
                Play vs Computer
              </Button>
              
              <Button 
                className="w-full gap-2" 
                size="lg"
                variant="outline"
                onClick={() => {
                  const as = {
                    pawnSuccessRoll: percentToThreshold(pawnAttackPercent, 6, true),
                    bishopMinRoll: 0,
                    knightMinRoll: percentToThreshold(knightAttackPercent, 6, false),
                    bombSuccessRoll: percentToThreshold(bombAttackPercent, 10, true),
                    wallBuildRoll: percentToThreshold(wallBuildPercent, 10, true),
                    totalAttackBudget,
                    maxBishopAttacks: maxBishopAttacksLobby,
                    maxRookAttacks: maxRookAttacksLobby,
                    ...(budgetMode === 'shared' ? { pawnAttackPercent, bishopAttackPercent, knightAttackPercent, bombAttackPercent, wallBuildPercent } : {}),
                  };
                  createGame(maxWalls, 'pvp', as, budgetMode);
                }}
                data-testid="button-create-game"
              >
                <Users className="w-5 h-5" />
                Create Multiplayer Game
              </Button>
              
              <Button 
                className="w-full gap-2" 
                size="lg"
                variant="secondary"
                onClick={handleCreateCvCGame}
                disabled={isCreatingCvC}
                data-testid="button-cvc-game"
              >
                {isCreatingCvC ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <MonitorPlay className="w-5 h-5" />
                )}
                {isCreatingCvC ? 'Running...' : 'Computer vs Computer'}
              </Button>
              
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">Or join existing</span>
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="game-id">Game ID</Label>
                <Input
                  id="game-id"
                  placeholder="Enter game ID..."
                  value={joinGameId}
                  onChange={(e) => setJoinGameId(e.target.value)}
                  data-testid="input-game-id"
                />
                <Button
                  className="w-full gap-2"
                  variant="secondary"
                  onClick={() => {
                    if (joinGameId) {
                      joinGame(joinGameId.trim());
                    }
                  }}
                  disabled={!joinGameId.trim()}
                  data-testid="button-join-game"
                >
                  <Link2 className="w-4 h-4" />
                  Join Game
                </Button>
              </div>
            </div>
            
            {/* Saved Games Section */}
            {savedGames.length > 0 && (
              <div className="space-y-2">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">Saved Games</span>
                  </div>
                </div>
                
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={handleClearAllGames}
                    data-testid="button-clear-all-games"
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Clear All
                  </Button>
                </div>
                
                <ScrollArea className="h-48">
                  <div className="space-y-2">
                    {loadingSavedGames ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="w-5 h-5 animate-spin" />
                      </div>
                    ) : (
                      savedGames.map((game) => {
                        const storedPlayerId = localStorage.getItem(`playerId_${game.id}`);
                        const isYourGame = storedPlayerId && (game.whitePlayer === storedPlayerId || game.blackPlayer === storedPlayerId);
                        const isCvCGame = game.gameMode === 'cvc';
                        const timeAgo = formatTimeAgo(game.updatedAt);
                        const statusText = game.phase === 'finished' 
                          ? (game.winner ? `${game.winner} won` : 'Draw') 
                          : `${game.currentTurn}'s turn`;
                        
                        return (
                          <div 
                            key={game.id}
                            className="flex items-center gap-2 p-2 rounded-md border bg-muted/50"
                            data-testid={`saved-game-${game.id}`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <History className="w-4 h-4 text-muted-foreground shrink-0" />
                                <span className="font-mono text-sm truncate">{game.id}</span>
                                {game.gameMode === 'pvc' && (
                                  <span className="text-xs bg-primary/10 text-primary px-1 rounded">vs AI</span>
                                )}
                                {isCvCGame && (
                                  <span className="text-xs bg-secondary text-secondary-foreground px-1 rounded">CvC</span>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {statusText} - {game.moveCount} moves - {timeAgo}
                              </div>
                            </div>
                            {isCvCGame ? (
                              <div className="flex gap-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleTakeoverGame(game.id, 'white')}
                                  data-testid={`button-takeover-white-${game.id}`}
                                >
                                  <Play className="w-3 h-3 mr-1" />
                                  White
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleTakeoverGame(game.id, 'black')}
                                  data-testid={`button-takeover-black-${game.id}`}
                                >
                                  <Play className="w-3 h-3 mr-1" />
                                  Black
                                </Button>
                              </div>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleReconnectToGame(game, storedPlayerId)}
                                data-testid={`button-resume-${game.id}`}
                              >
                                {isYourGame ? 'Resume' : 'Join'}
                              </Button>
                            )}
                            {(isYourGame || isCvCGame) && (
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => handleDeleteGame(game.id)}
                                data-testid={`button-delete-${game.id}`}
                              >
                                <Trash2 className="w-4 h-4 text-muted-foreground" />
                              </Button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </ScrollArea>
              </div>
            )}
            
            <GameRules />
          </CardContent>
        </Card>
      </div>
    );
  }
  
  const isVsComputer = gameState.gameMode === 'pvc';
  const whitePlayer = gameState.players.white;
  const blackPlayer = isVsComputer && gameState.aiColor === 'black' ? 'Computer' : gameState.players.black;
  
  return (
    <div className="min-h-screen bg-background p-2 sm:p-4">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row gap-3 sm:gap-6">
          {/* Left panel - Black player */}
          <div className="lg:w-64 space-y-3 sm:space-y-4 order-2 lg:order-1">
            <PlayerPanel
              color="black"
              playerName={blackPlayer}
              isCurrentTurn={currentTurn === 'black'}
              capturedPieces={gameState.capturedPieces.white}
              isYou={playerColor === 'black'}
              isConnected={!!blackPlayer}
            />
            <div className="hidden lg:block">
              <GameRules />
            </div>
          </div>
          
          {/* Center - Game board */}
          <div className="flex-1 flex flex-col items-center gap-2 sm:gap-4 order-1 lg:order-2">
            <GameStatus
              phase={phase}
              currentTurn={currentTurn}
              playerColor={playerColor}
              isCheck={checkStatus.isCheck}
              isCheckmate={checkStatus.isCheckmate}
              winner={gameState.winner}
              isArrowMode={isArrowMode}
            />
            
            <div className="w-full" data-testid="turn-indicator-container">
              <div className="relative h-8">
                <div
                  className={`absolute top-0 transition-all duration-300 flex items-center gap-1 ${
                    (phase === 'playing' || phase === 'setup') ? 'visible' : 'invisible'
                  } ${
                    currentTurn === 'black' ? 'left-0' : 'right-0'
                  }`}
                  data-testid="turn-indicator-arrow"
                >
                  {currentTurn === 'black' ? (
                    <div className="flex items-center gap-1 text-foreground">
                      <ArrowLeft className="w-7 h-7" strokeWidth={3} />
                      <span className="text-sm font-bold">Black</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-foreground">
                      <span className="text-sm font-bold">White</span>
                      <ArrowRight className="w-7 h-7" strokeWidth={3} />
                    </div>
                  )}
                </div>
              </div>
              {gameState.aiThinkingPly != null && gameState.aiThinkingMaxPly != null && (
                <div className="flex items-center justify-center gap-1.5 text-muted-foreground" data-testid="ai-ply-indicator">
                  <Brain className="w-4 h-4 animate-pulse" />
                  <span className="text-xs font-medium">
                    Thinking... Ply {gameState.aiThinkingPly}/{gameState.aiThinkingMaxPly}
                  </span>
                </div>
              )}
              {gameState.gameMode === 'cvc' && phase === 'playing' && (
                <div className="flex justify-center gap-2 mt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleTakeoverGame(gameState.id, 'white')}
                    data-testid="button-cvc-takeover-white"
                  >
                    <User className="w-3 h-3 mr-1" />
                    Play White
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleTakeoverGame(gameState.id, 'black')}
                    data-testid="button-cvc-takeover-black"
                  >
                    <User className="w-3 h-3 mr-1" />
                    Play Black
                  </Button>
                </div>
              )}
            </div>
            
            {phase === 'budget_setup' && !budgetSubmitted ? (
              <Card className="w-full max-w-md p-4 space-y-4" data-testid="budget-setup-panel">
                <h3 className="text-lg font-semibold text-center">Assign Your Attack Budget</h3>
                <p className="text-sm text-muted-foreground text-center">
                  Budget: {gameState.attackSettings?.totalAttackBudget ?? totalAttackBudget}% total. Distribute percentages across your attacks.
                </p>
                <div className="space-y-3">
                  <div className="flex justify-between text-xs">
                    <span>Used: {totalUsed}%</span>
                    <span className={budgetRemaining < 0 ? "text-destructive font-medium" : ""}>
                      Remaining: {budgetRemaining}%
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Pawn Attack</Label>
                      <span className="text-muted-foreground">{pawnAttackPercent}%</span>
                    </div>
                    <input type="range" min="0" max="100" value={pawnAttackPercent}
                      onChange={(e) => setPawnAttackPercent(clampToAttackBudget(parseInt(e.target.value), pawnAttackPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="budget-slider-pawn" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Bishop Arrow</Label>
                      <span className="text-muted-foreground">{bishopAttackPercent}%</span>
                    </div>
                    <input type="range" min="0" max="100" value={bishopAttackPercent}
                      onChange={(e) => setBishopAttackPercent(clampToAttackBudget(parseInt(e.target.value), bishopAttackPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="budget-slider-bishop" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Knight Axe</Label>
                      <span className="text-muted-foreground">{knightAttackPercent}%</span>
                    </div>
                    <input type="range" min="0" max="100" value={knightAttackPercent}
                      onChange={(e) => setKnightAttackPercent(clampToAttackBudget(parseInt(e.target.value), knightAttackPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="budget-slider-knight" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Rook Bomb</Label>
                      <span className="text-muted-foreground">{bombAttackPercent}%</span>
                    </div>
                    <input type="range" min="0" max="100" value={bombAttackPercent}
                      onChange={(e) => setBombAttackPercent(clampToAttackBudget(parseInt(e.target.value), bombAttackPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="budget-slider-bomb" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <Label>Rook Wall Build</Label>
                      <span className="text-muted-foreground">{wallBuildPercent}%</span>
                    </div>
                    <input type="range" min="0" max="100" value={wallBuildPercent}
                      onChange={(e) => setWallBuildPercent(clampToAttackBudget(parseInt(e.target.value), wallBuildPercent))}
                      className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                      data-testid="budget-slider-wall" />
                  </div>
                </div>
                <Button
                  className="w-full"
                  disabled={budgetRemaining < 0}
                  onClick={() => {
                    submitBudget({ pawnAttackPercent, bishopAttackPercent, knightAttackPercent, bombAttackPercent, wallBuildPercent });
                    setBudgetSubmitted(true);
                  }}
                  data-testid="button-submit-budget"
                >
                  Submit Budget
                </Button>
              </Card>
            ) : phase === 'budget_setup' && budgetSubmitted ? (
              <Card className="w-full max-w-md p-4 text-center" data-testid="budget-waiting-panel">
                <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">Waiting for opponent to submit their budget...</p>
              </Card>
            ) : (
              <GameBoard
                board={board}
                currentTurn={currentTurn}
                playerColor={playerColor}
                phase={phase}
                selectedPosition={selectedPosition}
                validMoves={validMoves}
                arrowTargets={arrowTargets}
                axeTargets={axeTargets}
                bombTargets={bombTargets}
                wallBuildTargets={wallBuildTargets}
                hangingPieces={hangingPieces}
                isArrowMode={isArrowMode}
                isAxeMode={isAxeMode}
                isBombMode={isBombMode}
                isWallBuildMode={isWallBuildMode}
                onSquareClick={handleSquareClick}
                onArrowModeToggle={handleArrowModeToggle}
                onAxeModeToggle={handleAxeModeToggle}
                onBombModeToggle={handleBombModeToggle}
                onWallBuildModeToggle={handleWallBuildModeToggle}
                setupWallsRemaining={playerColor ? gameState.setupWallsRemaining[playerColor] : 0}
                flashingSquare={flashingSquare}
                flashColor={flashColor}
                attackAnimation={attackAnimation}
                moveFlashSquares={moveFlashSquares}
                gameMode={gameState.gameMode}
                specialAttackCounts={gameState.specialAttackCounts}
                maxBishopAttacks={gameState.maxBishopAttacks}
                maxRookAttacks={gameState.maxRookAttacks}
                targetPopup={targetPopup}
              />
            )}
            
            {pendingPromotion && (
              <Card className="p-4" data-testid="promotion-dialog">
                <p className="text-center font-semibold mb-3">Choose piece to promote to:</p>
                <div className="flex justify-center gap-2">
                  {(['queen', 'rook', 'bishop', 'knight'] as PromotionPieceType[]).map((pieceType) => (
                    <Button
                      key={pieceType}
                      variant="outline"
                      size="lg"
                      onClick={() => handlePromotion(pieceType)}
                      className="text-3xl w-14 h-14"
                      data-testid={`promotion-${pieceType}`}
                    >
                      {PIECE_SYMBOLS[pieceType][playerColor || 'white']}
                    </Button>
                  ))}
                </div>
              </Card>
            )}
            
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {connectionStatus === 'connected' ? (
                <>
                  <Wifi className="w-4 h-4 text-green-500" />
                  <span>Connected</span>
                </>
              ) : (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Reconnecting...</span>
                </>
              )}
            </div>
          </div>
          
          {/* Right panel - White player & controls */}
          <div className="lg:w-64 space-y-3 sm:space-y-4 order-3">
            <PlayerPanel
              color="white"
              playerName={whitePlayer}
              isCurrentTurn={currentTurn === 'white'}
              capturedPieces={gameState.capturedPieces.black}
              isYou={playerColor === 'white'}
              isConnected={!!whitePlayer}
            />
            
            <GameControls
              gameId={gameState.id}
              phase={phase}
              isHost={playerColor === 'white'}
              maxWalls={gameState.maxWallsPerPlayer}
              onMaxWallsChange={setMaxWalls}
              onReady={handleReady}
              onNewGame={handleNewGame}
              onResign={handleResign}
              isReady={isReady}
              isCvCGame={gameState.gameMode === 'cvc'}
              isCvCPaused={isCvCPaused}
              onPauseCvC={handleTogglePause}
              onOfferDraw={handleOfferDraw}
              drawOffered={drawOffered}
              drawOfferPending={drawOfferPending}
              onAcceptDraw={handleAcceptDraw}
              onDeclineDraw={handleDeclineDraw}
              onRandomWalls={handleRandomWalls}
              onMazeWalls={handleMazeWalls}
              wallsRemaining={playerColor ? gameState.setupWallsRemaining[playerColor] : 0}
              isAIControlled={playerColor ? gameState.aiControlled?.[playerColor] ?? false : false}
              onHandoff={handleHandoff}
              onTakeControl={handleTakeControl}
              winner={gameState.winner}
              wallPositions={wallPositions}
              onLoadLayout={handleLoadLayout}
            />
            
            {(phase === 'playing' || phase === 'setup') && gameState.attackSettings && (
              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="text-sm font-medium">Your Attack Chances</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <span className="text-muted-foreground">Pawn</span>
                    <span data-testid="text-own-pawn-percent">{gameState.attackSettings.pawnAttackPercent ?? '?'}%</span>
                    <span className="text-muted-foreground">Bishop</span>
                    <span data-testid="text-own-bishop-percent">{gameState.attackSettings.bishopAttackPercent ?? '?'}%</span>
                    <span className="text-muted-foreground">Knight</span>
                    <span data-testid="text-own-knight-percent">{gameState.attackSettings.knightAttackPercent ?? '?'}%</span>
                    <span className="text-muted-foreground">Bomb</span>
                    <span data-testid="text-own-bomb-percent">{gameState.attackSettings.bombAttackPercent ?? '?'}%</span>
                    <span className="text-muted-foreground">Wall Build</span>
                    <span data-testid="text-own-wall-percent">{gameState.attackSettings.wallBuildPercent ?? '?'}%</span>
                  </div>
                  {gameState.attackSettings.budgetMode === 'individual' && (
                    <p className="text-xs text-muted-foreground mt-1 italic">Opponent's settings are hidden</p>
                  )}
                </CardContent>
              </Card>
            )}
            
            <MoveHistory moves={gameState.moveHistory} />
          </div>
        </div>
      </div>
      
    </div>
  );
}
