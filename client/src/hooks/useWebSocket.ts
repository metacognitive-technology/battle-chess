import { useState, useEffect, useCallback, useRef } from "react";
import type { GameMessage, GameState, GameMode, Position, AttackSettings, ComputerPolicyId } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface PendingPromotion {
  from: Position;
  to: Position;
}

interface UseWebSocketOptions {
  onDrawOffered?: () => void;
  onDrawResponse?: (accepted: boolean) => void;
}

interface UseWebSocketReturn {
  gameState: GameState | null;
  playerId: string | null;
  playerColor: 'white' | 'black' | null;
  connectionStatus: ConnectionStatus;
  sendMessage: (message: GameMessage) => void;
  createGame: (maxWalls: number, gameMode?: GameMode, attackSettings?: AttackSettings, budgetMode?: 'shared' | 'individual', aiDepth?: number, computerPolicy?: ComputerPolicyId) => void;
  joinGame: (gameId: string) => void;
  reconnectGame: (gameId: string, storedPlayerId: string | null) => void;
  takeoverGame: (gameId: string, color: 'white' | 'black') => void;
  watchCvCGame: (gameId: string) => void;
  pauseCvCGame: (paused: boolean) => void;
  offerDraw: () => void;
  respondToDraw: (accept: boolean) => void;
  submitBudget: (attackSettings: { pawnAttackPercent: number; bishopAttackPercent: number; knightAttackPercent: number; bombAttackPercent: number; wallBuildPercent: number }) => void;
  isObserver: boolean;
  lastError: string | null;
  pendingPromotion: PendingPromotion | null;
  clearPendingPromotion: () => void;
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { onDrawOffered, onDrawResponse } = options;
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [playerColor, setPlayerColor] = useState<'white' | 'black' | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [lastError, setLastError] = useState<string | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);
  const [isObserver, setIsObserver] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const gameIdRef = useRef<string | null>(null);
  const playerIdRef = useRef<string | null>(null);
  const pendingReconnectRef = useRef<{ gameId: string; playerId: string } | null>(null);
  
  const clearPendingPromotion = useCallback(() => {
    setPendingPromotion(null);
  }, []);
  
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    
    setConnectionStatus('connecting');
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onopen = () => {
      setConnectionStatus('connected');
      setLastError(null);
      
      // Handle pending explicit reconnect first (from reconnectGame)
      if (pendingReconnectRef.current) {
        const { gameId, playerId: storedPlayerId } = pendingReconnectRef.current;
        pendingReconnectRef.current = null;
        ws.send(JSON.stringify({
          type: 'reconnect',
          payload: { gameId },
          playerId: storedPlayerId,
        }));
        return;
      }
      
      // Auto-reconnect to game if we have a game ID and player ID (for connection drops)
      if (gameIdRef.current && playerIdRef.current) {
        ws.send(JSON.stringify({
          type: 'reconnect',
          payload: { gameId: gameIdRef.current },
          playerId: playerIdRef.current,
        }));
      }
    };
    
    ws.onmessage = (event) => {
      try {
        const message: GameMessage = JSON.parse(event.data);
        
        switch (message.type) {
          case 'state':
            setGameState(message.payload.state);
            if (message.payload.isObserver) {
              setIsObserver(true);
            }
            if (message.payload.playerId && !playerId) {
              setPlayerId(message.payload.playerId);
              playerIdRef.current = message.payload.playerId;
              // Store playerId in localStorage for reconnection
              if (message.payload.state?.id) {
                localStorage.setItem(`playerId_${message.payload.state.id}`, message.payload.playerId);
              }
            }
            if (message.payload.color) {
              setPlayerColor(message.payload.color);
            }
            if (message.payload.state?.id) {
              gameIdRef.current = message.payload.state.id;
            }
            break;
            
          case 'error':
            setLastError(message.payload.message);
            break;
            
          case 'player_joined':
          case 'player_left':
            setGameState(message.payload.state);
            break;
            
          case 'needsPromotion':
            setPendingPromotion({
              from: message.payload.from,
              to: message.payload.to,
            });
            break;
            
          case 'games_updated':
            // Refresh the saved games list when another player deletes a game
            queryClient.invalidateQueries({ queryKey: ['/api/games'] });
            break;
            
          case 'draw_offered':
            // Opponent offered a draw
            if (onDrawOffered) {
              onDrawOffered();
            }
            break;
            
          case 'draw_response':
            // Opponent responded to our draw offer
            if (onDrawResponse) {
              onDrawResponse(message.payload.accepted);
            }
            break;
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };
    
    ws.onclose = () => {
      setConnectionStatus('disconnected');
      wsRef.current = null;
      
      // Attempt to reconnect after 2 seconds
      if (gameIdRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, 2000);
      }
    };
    
    ws.onerror = () => {
      setConnectionStatus('error');
      setLastError('Connection error');
    };
    
    wsRef.current = ws;
  }, [playerId]);
  
  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);
  
  const sendMessage = useCallback((message: GameMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ ...message, playerId }));
    }
  }, [playerId]);
  
  const createGame = useCallback((maxWalls: number, gameMode: GameMode = 'pvp', attackSettings?: AttackSettings, budgetMode?: 'shared' | 'individual', aiDepth?: number, computerPolicy?: ComputerPolicyId) => {
    connect();
    
    const checkAndSend = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'join',
          payload: { action: 'create', maxWalls, gameMode, attackSettings, budgetMode, aiDepth, computerPolicy },
        }));
      } else {
        setTimeout(checkAndSend, 100);
      }
    };
    checkAndSend();
  }, [connect]);
  
  const joinGame = useCallback((gameId: string) => {
    gameIdRef.current = gameId;
    connect();
    
    const checkAndSend = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'join',
          payload: { action: 'join', gameId },
        }));
      } else {
        setTimeout(checkAndSend, 100);
      }
    };
    checkAndSend();
  }, [connect]);
  
  const reconnectGame = useCallback((gameId: string, storedPlayerId: string | null) => {
    gameIdRef.current = gameId;
    
    if (storedPlayerId) {
      setPlayerId(storedPlayerId);
      playerIdRef.current = storedPlayerId;
      
      // If already connected, send reconnect message directly
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'reconnect',
          payload: { gameId },
          playerId: storedPlayerId,
        }));
      } else {
        // Store pending reconnect to handle in onopen before auto-reconnect logic
        pendingReconnectRef.current = { gameId, playerId: storedPlayerId };
        connect();
      }
    } else {
      // No stored player ID, join as new player
      joinGame(gameId);
    }
  }, [connect, joinGame]);
  
  const takeoverGame = useCallback((gameId: string, color: 'white' | 'black') => {
    gameIdRef.current = gameId;
    setIsObserver(false);
    connect();
    
    const checkAndSend = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'takeover',
          payload: { gameId, color },
        }));
      } else {
        setTimeout(checkAndSend, 100);
      }
    };
    checkAndSend();
  }, [connect]);
  
  const watchCvCGame = useCallback((gameId: string) => {
    gameIdRef.current = gameId;
    setIsObserver(true);
    connect();
    
    const checkAndSend = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'watch_cvc',
          payload: { gameId },
        }));
      } else {
        setTimeout(checkAndSend, 100);
      }
    };
    checkAndSend();
  }, [connect]);
  
  const pauseCvCGame = useCallback((paused: boolean) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'pause_cvc',
        payload: { paused },
      }));
    }
  }, []);
  
  const offerDraw = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && playerIdRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'offer_draw',
        payload: {},
        playerId: playerIdRef.current,
      }));
    }
  }, []);
  
  const respondToDraw = useCallback((accept: boolean) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && playerIdRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'respond_draw',
        payload: { accept },
        playerId: playerIdRef.current,
      }));
    }
  }, []);
  
  const submitBudget = useCallback((attackSettings: { pawnAttackPercent: number; bishopAttackPercent: number; knightAttackPercent: number; bombAttackPercent: number; wallBuildPercent: number }) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && playerIdRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'budget_submit',
        payload: attackSettings,
        playerId: playerIdRef.current,
      }));
    }
  }, []);
  
  return {
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
  };
}
