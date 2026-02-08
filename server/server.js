import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import Redis from "ioredis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from parent directory in dev, or current directory in production
dotenv.config({ path: "../.env" });
dotenv.config(); // Also try current directory

// Debug flag for WebSocket logging
const DEBUG_WS = process.env.DEBUG_WS === 'true';
const DEBUG_LEADERBOARD = process.env.DEBUG_LEADERBOARD === '1' || process.env.DEBUG_LEADERBOARD === 'true';

// Redis client (optional - falls back to in-memory if not configured)
let redis = null;
const REDIS_TTL_SECONDS = 60 * 60 * 48; // 48 hours TTL

if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL);
    redis.on('error', (err) => console.error('Redis error:', err));
    redis.on('connect', () => console.log('Redis connected'));
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    redis = null;
  }
}

// ========== REDIS KEY HELPERS ==========
// Keys: player:{roomId}:{dateKey}:{visibleUserId} for PlayerState
// Keys: roomPlayers:{roomId}:{dateKey} (Set) for leaderboard index

function makePlayerRedisKey(roomId, dateKey, visibleUserId) {
  return `player:${roomId}:${dateKey}:${visibleUserId}`;
}

function makeRoomPlayersSetKey(roomId, dateKey) {
  return `roomPlayers:${roomId}:${dateKey}`;
}

const app = express();
const port = process.env.PORT || 3001;
const server = createServer(app);

// CORS configuration - permissive since client/server are on same origin in production
app.use(cors({
  origin: true, // Allow all origins (same-origin requests will work, external too)
  credentials: true,
}));

// Allow express to parse JSON bodies
app.use(express.json());

// ========== GAME STATE STORAGE ==========
// In-memory storage keyed by roomId:dateKey for room-level state
// and roomId:dateKey:visibleUserId for player-level state

/** @type {Map<string, {roomId: string, dateKey: string, players: Map<string, object>, leaderboard: Array, lastBroadcastAt: number}>} */
const roomStateStore = new Map();

/** @type {Map<string, Set<{ws: WebSocket, visibleUserId: string, roomId: string, dateKey: string}>>} */
const wsConnectionsByRoom = new Map();

function makeRoomKey(roomId, dateKey) {
  return `${roomId}:${dateKey}`;
}

function makePlayerKey(roomId, dateKey, visibleUserId) {
  return `${roomId}:${dateKey}:${visibleUserId}`;
}

// ========== REDIS PERSISTENCE HELPERS ==========
// Redis is source of truth for player state; in-memory Maps are cache

/** Save a single player state to Redis with TTL */
async function persistPlayerToRedis(playerState) {
  if (!redis) return;
  const key = makePlayerRedisKey(playerState.roomId, playerState.dateKey, playerState.visibleUserId);
  const setKey = makeRoomPlayersSetKey(playerState.roomId, playerState.dateKey);
  try {
    // Use pipeline for atomicity
    const pipeline = redis.pipeline();
    pipeline.setex(key, REDIS_TTL_SECONDS, JSON.stringify(playerState));
    pipeline.sadd(setKey, playerState.visibleUserId);
    pipeline.expire(setKey, REDIS_TTL_SECONDS);
    await pipeline.exec();
  } catch (err) {
    console.error('Failed to persist player to Redis:', err);
  }
}

/** Load a single player state from Redis */
async function loadPlayerFromRedis(roomId, dateKey, visibleUserId) {
  if (!redis) return null;
  try {
    const key = makePlayerRedisKey(roomId, dateKey, visibleUserId);
    const data = await redis.get(key);
    if (data) {
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load player from Redis:', err);
  }
  return null;
}

/** Rebuild leaderboard from Redis by loading all players in the roomPlayers set */
async function rebuildLeaderboardFromRedis(roomId, dateKey) {
  if (!redis) return null;
  try {
    const setKey = makeRoomPlayersSetKey(roomId, dateKey);
    const visibleUserIds = await redis.smembers(setKey);
    if (!visibleUserIds || visibleUserIds.length === 0) return null;

    const room = getOrCreateRoom(roomId, dateKey);

    // Load all players in parallel
    const playerPromises = visibleUserIds.map(async (visibleUserId) => {
      const key = makePlayerRedisKey(roomId, dateKey, visibleUserId);
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    });

    const players = await Promise.all(playerPromises);

    // Populate in-memory cache
    for (const player of players) {
      if (player) {
        room.players.set(player.visibleUserId, player);
      }
    }

    // Update leaderboard
    updateLeaderboard(room);
    return room;
  } catch (err) {
    console.error('Failed to rebuild leaderboard from Redis:', err);
  }
  return null;
}

/** Get or create room state (rebuilds from Redis if cache empty) */
async function getOrCreateRoomAsync(roomId, dateKey) {
  const key = makeRoomKey(roomId, dateKey);
  let room = roomStateStore.get(key);

  // If room exists in memory but is empty, try to rebuild from Redis
  if ((!room || room.players.size === 0) && redis) {
    const rebuilt = await rebuildLeaderboardFromRedis(roomId, dateKey);
    if (rebuilt && rebuilt.players.size > 0) {
      return rebuilt;
    }
  }

  if (!room) {
    room = {
      roomId,
      dateKey,
      players: new Map(),
      leaderboard: [],
      lastBroadcastAt: Date.now(),
    };
    roomStateStore.set(key, room);
  }
  return room;
}

/** Get or create room state (sync version for non-async contexts) */
function getOrCreateRoom(roomId, dateKey) {
  const key = makeRoomKey(roomId, dateKey);
  let room = roomStateStore.get(key);
  if (!room) {
    room = {
      roomId,
      dateKey,
      players: new Map(),
      leaderboard: [],
      lastBroadcastAt: Date.now(),
    };
    roomStateStore.set(key, room);
  }
  return room;
}

/** Get player state from room (checks Redis first) */
async function getPlayerAsync(roomId, dateKey, visibleUserId) {
  // First check in-memory cache
  const room = roomStateStore.get(makeRoomKey(roomId, dateKey));
  const cachedPlayer = room?.players.get(visibleUserId);
  if (cachedPlayer) return cachedPlayer;

  // Try to load from Redis
  const redisPlayer = await loadPlayerFromRedis(roomId, dateKey, visibleUserId);
  if (redisPlayer) {
    // Cache in memory
    const r = getOrCreateRoom(roomId, dateKey);
    r.players.set(visibleUserId, redisPlayer);
    updateLeaderboard(r);
  }
  return redisPlayer;
}

/** Get player state from room (sync) */
function getPlayer(roomId, dateKey, visibleUserId) {
  const room = roomStateStore.get(makeRoomKey(roomId, dateKey));
  return room?.players.get(visibleUserId) ?? null;
}

/** Set player state in room (also persists to Redis) */
function setPlayer(playerState) {
  const room = getOrCreateRoom(playerState.roomId, playerState.dateKey);
  room.players.set(playerState.visibleUserId, playerState);
  updateLeaderboard(room);
  // Fire-and-forget Redis persistence of individual player
  persistPlayerToRedis(playerState);
}

/** Convert player state to leaderboard entry */
function toLeaderboardEntry(player) {
  const gs = player.gameState;
  const solvedCount = gs.boards.filter(b => b.solved).length;
  return {
    visibleUserId: player.visibleUserId,
    profile: player.profile || { displayName: player.visibleUserId, avatarUrl: null },
    solvedCount,
    guessCount: gs.guessCount,
    gameOver: gs.gameOver,
    won: gs.won,
    finishedAt: player.finishedAt,
    updatedAt: player.updatedAt,
    status: gs.gameOver ? (gs.won ? 'won' : 'lost') : 'playing',
  };
}

/** Sort leaderboard: finished first, most solved, fewest guesses, earliest finish */
function sortLeaderboard(entries) {
  return [...entries].sort((a, b) => {
    if (a.gameOver !== b.gameOver) return a.gameOver ? -1 : 1;
    if (a.solvedCount !== b.solvedCount) return b.solvedCount - a.solvedCount;
    if (a.guessCount !== b.guessCount) return a.guessCount - b.guessCount;
    if (a.finishedAt !== null && b.finishedAt !== null) {
      return a.finishedAt - b.finishedAt;
    }
    return 0;
  });
}

/** Update leaderboard for a room */
function updateLeaderboard(room) {
  const entries = [];
  for (const player of room.players.values()) {
    entries.push(toLeaderboardEntry(player));
  }
  room.leaderboard = sortLeaderboard(entries);
  room.lastBroadcastAt = Date.now();
}

/** Create new player state */
function createPlayerState(roomId, dateKey, visibleUserId, gameState, profile = { displayName: visibleUserId, avatarUrl: null }) {
  const now = Date.now();
  return {
    visibleUserId,
    roomId,
    dateKey,
    mode: 'daily',
    profile,
    gameState,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
}

// Legacy store for REST API compatibility
const gameStateStore = {
  /** @type {Map<string, object>} */
  _store: new Map(),

  _makeKey(roomId, dateKey, userId) {
    return `${roomId}:${dateKey}:${userId}`;
  },

  async get(roomId, dateKey, userId) {
    // First check new room store
    const player = getPlayer(roomId, dateKey, userId);
    if (player) {
      return { gameState: player.gameState, gameMode: player.mode, dateKey: player.dateKey };
    }
    // Fallback to legacy store
    const key = this._makeKey(roomId, dateKey, userId);
    return this._store.get(key) || null;
  },

  async set(roomId, dateKey, userId, state) {
    const key = this._makeKey(roomId, dateKey, userId);
    this._store.set(key, state);
  },

  async delete(roomId, dateKey, userId) {
    const key = this._makeKey(roomId, dateKey, userId);
    this._store.delete(key);
  },
};

// ========== WEBSOCKET SETUP ==========
const wss = new WebSocketServer({ server, path: "/ws" });

// Track connections by room (new protocol uses roomKey = roomId:dateKey)
const rooms = new Map(); // roomId -> Set<{ws, visibleUserId}> (legacy compat)

wss.on("connection", (ws, req) => {
  let currentRoomKey = null;
  let currentVisibleUserId = null;
  let currentRoomId = null;
  let currentDateKey = null;

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        // ===== NEW PROTOCOL =====
        case "JOIN": {
          const { roomId, dateKey, visibleUserId, profile } = message;
          if (!roomId || !dateKey || !visibleUserId) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_MESSAGE', message: 'Missing required fields' }));
            return;
          }

          // Validate and sanitize profile
          const cleanProfile = {
            displayName: (profile?.displayName || visibleUserId).slice(0, 100),
            avatarUrl: (profile?.avatarUrl || null),
          };

          currentRoomKey = makeRoomKey(roomId, dateKey);
          currentVisibleUserId = visibleUserId;
          currentRoomId = roomId;
          currentDateKey = dateKey;

          // Add to WebSocket connections for this room
          if (!wsConnectionsByRoom.has(currentRoomKey)) {
            wsConnectionsByRoom.set(currentRoomKey, new Set());
          }
          wsConnectionsByRoom.get(currentRoomKey).add({ ws, visibleUserId, roomId, dateKey });

          if (DEBUG_WS) {
            console.log('[WS JOIN] roomId:', roomId, 'dateKey:', dateKey, 'visibleUserId:', visibleUserId);
          }
          if (DEBUG_LEADERBOARD) {
            console.log('[LEADERBOARD DEBUG] JOIN payload:', JSON.stringify({ roomId, dateKey, visibleUserId, profile: cleanProfile }));
            console.log('[LEADERBOARD DEBUG] roomKey:', currentRoomKey);
          }

          // Get or create player state (checks Redis first)
          let playerState = await getPlayerAsync(roomId, dateKey, visibleUserId);
          if (!playerState) {
            // Create new daily game
            const targetWords = getDailyTargets(dateKey);
            const gameState = createGameState(targetWords);
            playerState = createPlayerState(roomId, dateKey, visibleUserId, gameState, cleanProfile);
          } else {
            // Update existing player's profile (in case they changed their display name)
            playerState.profile = cleanProfile;
            playerState.updatedAt = Date.now();
          }
          // Always (re-)add player to room to ensure leaderboard is updated
          setPlayer(playerState);

          // Send STATE to joining client
          ws.send(JSON.stringify({ type: 'STATE', playerState }));

          // Broadcast LEADERBOARD to ALL players in room (rebuilds from Redis if cache empty)
          const room = await getOrCreateRoomAsync(roomId, dateKey);
          if (DEBUG_WS) {
            console.log('[WS JOIN] Broadcasting leaderboard, players in room:', room.players.size);
          }
          if (DEBUG_LEADERBOARD) {
            console.log('[LEADERBOARD DEBUG] room.players.size:', room.players.size);
            console.log('[LEADERBOARD DEBUG] leaderboard payload length:', room.leaderboard.length);
            console.log('[LEADERBOARD DEBUG] leaderboard:', JSON.stringify(room.leaderboard));
          }
          broadcastToRoomByKey(currentRoomKey, { type: 'LEADERBOARD', leaderboard: room.leaderboard });

          // Broadcast ROOM_EVENT join to everyone in room (including joiner)
          broadcastToRoomByKey(currentRoomKey, { type: 'ROOM_EVENT', event: 'join', visibleUserId });
          break;
        }

        case "GUESS": {
          const { roomId, dateKey, visibleUserId, guess } = message;
          if (!roomId || !dateKey || !visibleUserId || !guess) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_MESSAGE', message: 'Missing required fields' }));
            return;
          }

          const playerState = getPlayer(roomId, dateKey, visibleUserId);
          if (!playerState) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'PLAYER_NOT_FOUND', message: 'Player not found. Send JOIN first.' }));
            return;
          }

          if (playerState.gameState.gameOver) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'GAME_OVER', message: 'Game already over' }));
            return;
          }

          // Validate guess
          const normalizedGuess = guess.toLowerCase();
          if (normalizedGuess.length !== 5 || !/^[a-z]+$/.test(normalizedGuess)) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_GUESS', message: 'Guess must be 5 letters' }));
            return;
          }

          // Apply guess to game state
          const oldGameState = playerState.gameState;
          const newBoards = oldGameState.boards.map((board) => {
            if (board.solved) {
              return {
                ...board,
                guesses: [...board.guesses, normalizedGuess],
                results: [...board.results, board.results[board.results.length - 1] || []],
              };
            }
            const result = evaluateGuess(normalizedGuess, board.targetWord);
            const solved = result.every(r => r === 'correct');
            return {
              ...board,
              guesses: [...board.guesses, normalizedGuess],
              results: [...board.results, result],
              solved,
              solvedOnGuess: solved ? oldGameState.guessCount + 1 : board.solvedOnGuess,
            };
          });

          const newGuessCount = oldGameState.guessCount + 1;
          const allSolved = newBoards.every(b => b.solved);
          const outOfGuesses = newGuessCount >= oldGameState.maxGuesses;
          const newGameOver = allSolved || outOfGuesses;

          const newGameState = {
            ...oldGameState,
            boards: newBoards,
            currentGuess: '',
            guessCount: newGuessCount,
            gameOver: newGameOver,
            won: allSolved,
          };

          // Update player state
          const now = Date.now();
          const updatedPlayerState = {
            ...playerState,
            gameState: newGameState,
            updatedAt: now,
            finishedAt: newGameOver && !playerState.finishedAt ? now : playerState.finishedAt,
          };
          setPlayer(updatedPlayerState);

          // Send updated STATE to player
          ws.send(JSON.stringify({ type: 'STATE', playerState: updatedPlayerState }));

          // Broadcast updated LEADERBOARD to room
          const room = getOrCreateRoom(roomId, dateKey);
          const roomKey = makeRoomKey(roomId, dateKey);
          if (DEBUG_WS) {
            console.log('[WS GUESS] Broadcasting leaderboard, players in room:', room.players.size);
          }
          if (DEBUG_LEADERBOARD) {
            console.log('[LEADERBOARD DEBUG] GUESS - roomKey:', roomKey);
            console.log('[LEADERBOARD DEBUG] GUESS - room.players.size:', room.players.size);
            console.log('[LEADERBOARD DEBUG] GUESS - leaderboard payload length:', room.leaderboard.length);
          }
          broadcastToRoomByKey(roomKey, { type: 'LEADERBOARD', leaderboard: room.leaderboard });
          break;
        }

        case "LEAVE": {
          const { roomId, dateKey, visibleUserId } = message;
          if (!roomId || !dateKey || !visibleUserId) {
            return;
          }
          handleLeave(roomId, dateKey, visibleUserId, ws);
          break;
        }

        // ===== LEGACY PROTOCOL (backwards compat) =====
        case "join_room": {
          const { roomId, userId } = message;
          currentRoomId = roomId;
          currentVisibleUserId = userId;

          if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
          }
          rooms.get(roomId).add({ ws, userId });

          // Notify others in the room
          broadcastToRoom(roomId, {
            type: "player_joined",
            userId,
            playerCount: rooms.get(roomId).size,
          }, ws);

          // Send current player list to the joining player
          const players = Array.from(rooms.get(roomId)).map(p => p.userId);
          ws.send(JSON.stringify({ type: "room_state", players, playerCount: players.length }));
          break;
        }

        case "guess_made": {
          // Broadcast guess to other players in the room (for spectating/multiplayer)
          const { roomId, userId, guess, boardStates } = message;
          broadcastToRoom(roomId, {
            type: "player_guessed",
            userId,
            guess,
            boardStates,
          }, ws);
          break;
        }

        case "game_over": {
          const { roomId, userId, won, guessCount } = message;
          broadcastToRoom(roomId, {
            type: "player_finished",
            userId,
            won,
            guessCount,
          }, ws);
          break;
        }
      }
    } catch (err) {
      console.error("WebSocket message error:", err);
      ws.send(JSON.stringify({ type: 'ERROR', code: 'INTERNAL_ERROR', message: 'Failed to process message' }));
    }
  });

  ws.on("close", () => {
    // Handle new protocol disconnect
    if (currentRoomKey && currentVisibleUserId) {
      handleLeave(currentRoomId, currentDateKey, currentVisibleUserId, ws);
    }

    // Handle legacy protocol disconnect
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      for (const client of room) {
        if (client.ws === ws) {
          room.delete(client);
          break;
        }
      }

      // Notify others
      broadcastToRoom(currentRoomId, {
        type: "player_left",
        userId: currentVisibleUserId,
        playerCount: room.size,
      });

      // Clean up empty rooms
      if (room.size === 0) {
        rooms.delete(currentRoomId);
      }
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

/** Handle player leaving (LEAVE message or disconnect) */
function handleLeave(roomId, dateKey, visibleUserId, ws) {
  const roomKey = makeRoomKey(roomId, dateKey);
  const connections = wsConnectionsByRoom.get(roomKey);
  if (connections) {
    for (const client of connections) {
      if (client.ws === ws) {
        connections.delete(client);
        break;
      }
    }
    if (connections.size === 0) {
      wsConnectionsByRoom.delete(roomKey);
    }
  }

  // Broadcast ROOM_EVENT leave to remaining players
  broadcastToRoomByKey(roomKey, { type: 'ROOM_EVENT', event: 'leave', visibleUserId });

  // Broadcast updated LEADERBOARD to remaining players
  const room = roomStateStore.get(roomKey);
  if (room) {
    if (DEBUG_LEADERBOARD) {
      console.log('[LEADERBOARD DEBUG] LEAVE - roomKey:', roomKey);
      console.log('[LEADERBOARD DEBUG] LEAVE - room.players.size:', room.players.size);
      console.log('[LEADERBOARD DEBUG] LEAVE - leaderboard payload length:', room.leaderboard.length);
    }
    broadcastToRoomByKey(roomKey, { type: 'LEADERBOARD', leaderboard: room.leaderboard });
  }
}

/** Broadcast to room using new protocol (roomKey = roomId:dateKey) */
function broadcastToRoomByKey(roomKey, message, excludeWs = null) {
  const connections = wsConnectionsByRoom.get(roomKey);
  if (!connections) return;

  const data = JSON.stringify(message);
  for (const client of connections) {
    if (client.ws !== excludeWs && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

/** Broadcast to room using legacy protocol (roomId only) */
function broadcastToRoom(roomId, message, excludeWs = null) {
  if (!rooms.has(roomId)) return;

  const data = JSON.stringify(message);
  for (const client of rooms.get(roomId)) {
    if (client.ws !== excludeWs && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

// ========== DAILY TARGETS GENERATION ==========
// Duplicated from engine for server-side use (avoids complex bundling)
const WORD_LIST = [
  'apple', 'beach', 'chair', 'dance', 'eagle',
  'flame', 'grape', 'house', 'image', 'juice',
  'knife', 'lemon', 'mouse', 'night', 'ocean',
  'piano', 'queen', 'river', 'stone', 'table',
  'ultra', 'vivid', 'water', 'xenon', 'youth',
  'zebra', 'brave', 'crane', 'dream', 'frost',
  'ghost', 'heart', 'index', 'joker', 'karma',
  'laser', 'metal', 'noble', 'orbit', 'pearl',
  'quest', 'radar', 'solar', 'train', 'unity',
  'voice', 'whale', 'xerox', 'yield', 'zones',
  'about', 'above', 'abuse', 'actor', 'acute',
  'admit', 'adopt', 'adult', 'after', 'again',
  'agent', 'agree', 'ahead', 'alarm', 'album',
  'alert', 'alike', 'alive', 'allow', 'alone',
  'along', 'alter', 'amino', 'among', 'angel',
  'anger', 'angle', 'angry', 'apart', 'arena',
  'argue', 'arise', 'armor', 'aroma', 'array',
  'arrow', 'asset', 'avoid', 'award', 'aware',
  'bacon', 'badge', 'basic', 'basin', 'batch',
  'began', 'begin', 'being', 'below', 'bench',
  'berry', 'black', 'blade', 'blame', 'blank',
  'blast', 'blaze', 'blend', 'bless', 'blind',
  'block', 'bloom', 'board', 'bonus', 'boost',
  'brain', 'brand', 'bread', 'break', 'breed',
  'brick', 'brief', 'bring', 'broad', 'brook',
  'brown', 'brush', 'build', 'bunch', 'burst',
  'cabin', 'cable', 'candy', 'cargo', 'carry',
  'catch', 'cause', 'chain', 'chalk', 'champ',
  'charm', 'chase', 'cheap', 'check', 'chess',
  'chest', 'child', 'china', 'chunk', 'civic',
  'civil', 'claim', 'clash', 'class', 'clean',
  'clear', 'clerk', 'click', 'cliff', 'climb',
  'clock', 'close', 'cloth', 'cloud', 'coach',
  'coast', 'could', 'count', 'court', 'cover',
  'craft', 'crash', 'crawl', 'crazy', 'cream',
  'creek', 'creep', 'crime', 'crisp', 'cross',
  'crowd', 'crown', 'crude', 'cruel', 'crush',
  'curve', 'cycle', 'dairy', 'dealt', 'death',
  'debut', 'decay', 'delta', 'dense', 'depot',
  'depth', 'dirty', 'disco', 'doubt', 'dough',
];

function dateKeyToSeed(dateKey) {
  let hash = 5381;
  for (let i = 0; i < dateKey.length; i++) {
    hash = ((hash << 5) + hash) ^ dateKey.charCodeAt(i);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getDailyTargets(dateKey) {
  const seed = dateKeyToSeed(dateKey);
  const random = mulberry32(seed);
  const indices = [];
  const used = new Set();
  for (let i = 0; i < 4; i++) {
    let idx;
    do {
      idx = Math.floor(random() * WORD_LIST.length);
    } while (used.has(idx));
    used.add(idx);
    indices.push(idx);
  }
  return [WORD_LIST[indices[0]], WORD_LIST[indices[1]], WORD_LIST[indices[2]], WORD_LIST[indices[3]]];
}

function createBoardState(targetWord) {
  return {
    targetWord: targetWord.toLowerCase(),
    guesses: [],
    results: [],
    solved: false,
    solvedOnGuess: null,
  };
}

function createGameState(targetWords, maxGuesses = 9) {
  return {
    boards: [
      createBoardState(targetWords[0]),
      createBoardState(targetWords[1]),
      createBoardState(targetWords[2]),
      createBoardState(targetWords[3]),
    ],
    currentGuess: '',
    guessCount: 0,
    maxGuesses,
    gameOver: false,
    won: false,
  };
}

function getTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

// ========== API ENDPOINTS ==========

// Health check for deployment platforms
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// GET leaderboard for a room
app.get("/api/room/:roomId/:dateKey/leaderboard", (req, res) => {
  const { roomId, dateKey } = req.params;
  if (!roomId || !dateKey) {
    return res.status(400).json({ error: "roomId and dateKey required" });
  }

  const room = roomStateStore.get(makeRoomKey(roomId, dateKey));
  if (!room) {
    // Return empty leaderboard if room doesn't exist yet
    return res.json({ leaderboard: [] });
  }

  res.json({ leaderboard: room.leaderboard });
});

// GET player state
app.get("/api/room/:roomId/:dateKey/player/:visibleUserId", (req, res) => {
  const { roomId, dateKey, visibleUserId } = req.params;
  if (!roomId || !dateKey || !visibleUserId) {
    return res.status(400).json({ error: "roomId, dateKey, and visibleUserId required" });
  }

  const playerState = getPlayer(roomId, dateKey, visibleUserId);
  if (!playerState) {
    return res.status(404).json({ error: "Player not found" });
  }

  res.json({ playerState });
});

// Debug endpoint to verify Redis persistence
app.get("/api/debug/persist", async (req, res) => {
  const { roomId, dateKey, visibleUserId } = req.query;

  const status = {
    redisConnected: !!redis,
    redisUrl: process.env.REDIS_URL ? '***configured***' : 'not configured',
    tests: {},
  };

  if (!redis) {
    return res.json({ ...status, message: 'Redis not configured' });
  }

  // Test basic Redis connectivity
  try {
    const pong = await redis.ping();
    status.tests.ping = { success: true, result: pong };
  } catch (err) {
    status.tests.ping = { success: false, error: err.message };
  }

  // If specific player requested, test load/save
  if (roomId && dateKey && visibleUserId) {
    const playerKey = makePlayerRedisKey(roomId, dateKey, visibleUserId);
    const setKey = makeRoomPlayersSetKey(roomId, dateKey);

    // Test GET player
    try {
      const data = await redis.get(playerKey);
      status.tests.playerGet = {
        key: playerKey,
        success: true,
        found: !!data,
        data: data ? JSON.parse(data) : null,
      };
    } catch (err) {
      status.tests.playerGet = { key: playerKey, success: false, error: err.message };
    }

    // Test SET members
    try {
      const members = await redis.smembers(setKey);
      status.tests.roomPlayersSet = {
        key: setKey,
        success: true,
        members,
        count: members.length,
      };
    } catch (err) {
      status.tests.roomPlayersSet = { key: setKey, success: false, error: err.message };
    }

    // Test TTL
    try {
      const ttl = await redis.ttl(playerKey);
      status.tests.playerTtl = {
        key: playerKey,
        success: true,
        ttlSeconds: ttl,
        ttlHours: ttl > 0 ? (ttl / 3600).toFixed(2) : null,
      };
    } catch (err) {
      status.tests.playerTtl = { key: playerKey, success: false, error: err.message };
    }
  }

  // Memory cache stats
  status.memoryStats = {
    roomsInMemory: roomStateStore.size,
    rooms: Array.from(roomStateStore.keys()).slice(0, 10), // First 10 room keys
  };

  res.json(status);
});

app.post("/api/token", async (req, res) => {

  // Exchange the code for an access_token
  const response = await fetch(`https://discord.com/api/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: process.env.VITE_DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: req.body.code,
    }),
  });

  // Retrieve the access_token from the response
  const { access_token } = await response.json();

  // Return the access_token to our client as { access_token: "..."}
  res.send({ access_token });
});

// JOIN: Get or create game state for a player in a room
app.post("/api/game/join", async (req, res) => {
  try {
    const { roomId, userId, dateKey: clientDateKey } = req.body;
    if (!roomId || !userId) {
      return res.status(400).json({ error: "roomId and userId required" });
    }

    // Use client-provided dateKey if valid, otherwise compute on server
    const dateKey = (clientDateKey && /^\d{4}-\d{2}-\d{2}$/.test(clientDateKey))
      ? clientDateKey
      : getTodayDateKey();
    let state = await gameStateStore.get(roomId, dateKey, userId);

    if (!state) {
      // Create new daily game
      const targetWords = getDailyTargets(dateKey);
      state = {
        gameState: createGameState(targetWords),
        gameMode: "daily",
        dateKey,
      };
      await gameStateStore.set(roomId, dateKey, userId, state);
    }

    res.json(state);
  } catch (err) {
    console.error("JOIN error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GUESS: Submit a guess and get updated state
app.post("/api/game/guess", async (req, res) => {
  try {
    const { roomId, userId, guess, dateKey: clientDateKey } = req.body;
    if (!roomId || !userId || !guess) {
      return res.status(400).json({ error: "roomId, userId, and guess required" });
    }

    // Use client-provided dateKey if valid, otherwise compute on server
    const dateKey = (clientDateKey && /^\d{4}-\d{2}-\d{2}$/.test(clientDateKey))
      ? clientDateKey
      : getTodayDateKey();
    let state = await gameStateStore.get(roomId, dateKey, userId);

    if (!state) {
      return res.status(404).json({ error: "No game found. Call /api/game/join first." });
    }

    const { gameState } = state;
    if (gameState.gameOver) {
      return res.json(state); // Game already over, return current state
    }

    // Validate guess length
    const normalizedGuess = guess.toLowerCase();
    if (normalizedGuess.length !== 5 || !/^[a-z]+$/.test(normalizedGuess)) {
      return res.status(400).json({ error: "Invalid guess format" });
    }

    // Apply guess to all boards
    const newBoards = gameState.boards.map((board) => {
      if (board.solved) {
        return {
          ...board,
          guesses: [...board.guesses, normalizedGuess],
          results: [...board.results, board.results[board.results.length - 1]],
        };
      }

      const result = evaluateGuess(normalizedGuess, board.targetWord);
      const solved = result.every(r => r === 'correct');

      return {
        ...board,
        guesses: [...board.guesses, normalizedGuess],
        results: [...board.results, result],
        solved,
        solvedOnGuess: solved ? gameState.guessCount + 1 : null,
      };
    });

    const newGuessCount = gameState.guessCount + 1;
    const allSolved = newBoards.every(b => b.solved);
    const outOfGuesses = newGuessCount >= gameState.maxGuesses;
    const newGameOver = allSolved || outOfGuesses;

    const newGameState = {
      ...gameState,
      boards: newBoards,
      currentGuess: '',
      guessCount: newGuessCount,
      gameOver: newGameOver,
      won: allSolved,
    };

    state = { ...state, gameState: newGameState };
    await gameStateStore.set(roomId, dateKey, userId, state);

    res.json(state);
  } catch (err) {
    console.error("GUESS error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Evaluate a guess against a target word (server-side version)
function evaluateGuess(guess, target) {
  const result = new Array(5).fill('absent');
  const targetLetterCounts = new Map();

  for (const letter of target) {
    targetLetterCounts.set(letter, (targetLetterCounts.get(letter) || 0) + 1);
  }

  // First pass: correct letters
  for (let i = 0; i < 5; i++) {
    if (guess[i] === target[i]) {
      result[i] = 'correct';
      targetLetterCounts.set(guess[i], targetLetterCounts.get(guess[i]) - 1);
    }
  }

  // Second pass: present letters
  for (let i = 0; i < 5; i++) {
    if (result[i] === 'correct') continue;
    const remaining = targetLetterCounts.get(guess[i]) || 0;
    if (remaining > 0) {
      result[i] = 'present';
      targetLetterCounts.set(guess[i], remaining - 1);
    }
  }

  return result;
}

// ========== STATIC FILE SERVING ==========
// Serve built client files from public folder
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath, {
  // Set proper MIME types
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    } else if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    }
  }
}));

// SPA fallback - serve index.html for all non-API, non-asset routes
app.get('*', (req, res, next) => {
  // Don't intercept API routes or asset requests
  if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
    return next();
  }

  const indexPath = path.join(publicPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('Error serving index.html:', err);
      res.status(500).send('Server error - index.html not found. Did the build complete?');
    }
  });
});

server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
  console.log(`WebSocket available at ws://localhost:${port}/ws`);
  console.log(`Serving static files from: ${publicPath}`);
});

// ========== CLEANUP JOB ==========
// Remove room states older than 2 days to prevent memory growth
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run every hour
const MAX_AGE_DAYS = 2;

function cleanupOldRoomStates() {
  const now = new Date();
  const chicagoNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));

  // Calculate cutoff date (2 days ago)
  const cutoffDate = new Date(chicagoNow);
  cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS);
  const cutoffDateKey = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;

  let cleanedCount = 0;

  for (const [roomKey, room] of roomStateStore.entries()) {
    // roomKey format: "roomId:dateKey"
    const dateKey = room.dateKey;
    if (dateKey && dateKey < cutoffDateKey) {
      roomStateStore.delete(roomKey);
      wsConnectionsByRoom.delete(roomKey);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`[Cleanup] Removed ${cleanedCount} room states older than ${cutoffDateKey}`);
  }
}

// Run cleanup on startup and then periodically
cleanupOldRoomStates();
setInterval(cleanupOldRoomStates, CLEANUP_INTERVAL_MS);
