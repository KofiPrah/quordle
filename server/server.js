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
    console.log('[Redis] Attempting connection to:', process.env.REDIS_URL.replace(/:[^:@]+@/, ':***@'));
    redis = new Redis(process.env.REDIS_URL);
    redis.on('error', (err) => console.error('[Redis] Error:', err.message));
    redis.on('connect', () => console.log('[Redis] Connected successfully'));
    redis.on('ready', () => console.log('[Redis] Ready to accept commands'));
    redis.on('close', () => console.log('[Redis] Connection closed'));
    redis.on('reconnecting', () => console.log('[Redis] Reconnecting...'));
  } catch (err) {
    console.error('[Redis] Failed to initialize:', err);
    redis = null;
  }
} else {
  console.log('[Redis] No REDIS_URL configured - using in-memory storage only');
}

// ========== REDIS KEY HELPERS ==========
// Keys: player:{roomId}:{dateKey}:{language}:{visibleUserId} for PlayerState
// Keys: roomPlayers:{roomId}:{dateKey}:{language} (Set) for leaderboard index

function makePlayerRedisKey(roomId, dateKey, visibleUserId, language = 'en') {
  return `player:${roomId}:${dateKey}:${language}:${visibleUserId}`;
}

function makeRoomPlayersSetKey(roomId, dateKey, language = 'en') {
  return `roomPlayers:${roomId}:${dateKey}:${language}`;
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

/** @type {Map<string, {roomId: string, dateKey: string, guildId: string|null, players: Map<string, object>, leaderboard: Array, lastBroadcastAt: number}>} */
const roomStateStore = new Map();

/** @type {Map<string, string>} roomId -> guildId mapping for announcement channel resolution */
const roomGuildMap = new Map();

/** @type {Map<string, Set<{ws: WebSocket, visibleUserId: string, roomId: string, dateKey: string}>>} */
const wsConnectionsByRoom = new Map();

function makeRoomKey(roomId, dateKey, language = 'en') {
  return `${roomId}:${dateKey}:${language}`;
}

function makePlayerKey(roomId, dateKey, visibleUserId, language = 'en') {
  return `${roomId}:${dateKey}:${language}:${visibleUserId}`;
}

// ========== REDIS PERSISTENCE HELPERS ==========
// Redis is source of truth for player state; in-memory Maps are cache

/** Save a single player state to Redis with TTL */
async function persistPlayerToRedis(playerState) {
  if (!redis) {
    console.log('[Redis] Skipping persist - no Redis connection');
    return;
  }
  const language = playerState.language || 'en';
  const key = makePlayerRedisKey(playerState.roomId, playerState.dateKey, playerState.visibleUserId, language);
  const setKey = makeRoomPlayersSetKey(playerState.roomId, playerState.dateKey, language);

  // Log what we're about to save
  const guessCount = playerState.gameState?.guessCount || 0;
  const boardGuesses = playerState.gameState?.boards?.map(b => b.guesses?.length || 0) || [];
  console.log('[Redis SAVE]', key, '- guesses:', guessCount, 'boards:', boardGuesses);

  try {
    // Use pipeline for atomicity
    const pipeline = redis.pipeline();
    const serialized = JSON.stringify(playerState);
    pipeline.setex(key, REDIS_TTL_SECONDS, serialized);
    pipeline.sadd(setKey, playerState.visibleUserId);
    pipeline.expire(setKey, REDIS_TTL_SECONDS);
    const results = await pipeline.exec();
    // Check for errors in pipeline results
    const errors = results?.filter(r => r[0] !== null) || [];
    if (errors.length > 0) {
      console.error('[Redis] Pipeline errors:', errors);
    } else {
      console.log('[Redis SAVE OK]', key, '- bytes:', serialized.length);
    }
  } catch (err) {
    console.error('[Redis] Failed to persist player:', err.message);
  }
}

/** Load a single player state from Redis */
async function loadPlayerFromRedis(roomId, dateKey, visibleUserId, language = 'en') {
  if (!redis) {
    console.log('[Redis] Skipping load - no Redis connection');
    return null;
  }
  try {
    const key = makePlayerRedisKey(roomId, dateKey, visibleUserId, language);
    console.log('[Redis LOAD] Attempting to load:', key);
    const data = await redis.get(key);
    if (data) {
      const parsed = JSON.parse(data);
      const guessCount = parsed.gameState?.guessCount || 0;
      const boardGuesses = parsed.gameState?.boards?.map(b => b.guesses?.length || 0) || [];
      console.log('[Redis LOAD OK]', key, '- guesses:', guessCount, 'boards:', boardGuesses, 'bytes:', data.length);
      return parsed;
    } else {
      console.log('[Redis LOAD] No data found for:', key);
    }
  } catch (err) {
    console.error('[Redis] Failed to load player:', err.message);
  }
  return null;
}

/** Rebuild leaderboard from Redis by loading all players in the roomPlayers set */
async function rebuildLeaderboardFromRedis(roomId, dateKey, language = 'en') {
  if (!redis) {
    console.log('[Redis] Cannot rebuild leaderboard - no Redis connection');
    return null;
  }
  try {
    const setKey = makeRoomPlayersSetKey(roomId, dateKey, language);
    const visibleUserIds = await redis.smembers(setKey);
    console.log('[Redis] Rebuilding leaderboard for', setKey, '- found', visibleUserIds?.length || 0, 'players');
    if (!visibleUserIds || visibleUserIds.length === 0) return null;

    const room = getOrCreateRoom(roomId, dateKey, language);

    // Load all players in parallel
    const playerPromises = visibleUserIds.map(async (visibleUserId) => {
      const key = makePlayerRedisKey(roomId, dateKey, visibleUserId, language);
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    });

    const players = await Promise.all(playerPromises);

    // Populate in-memory cache
    let loadedCount = 0;
    for (const player of players) {
      if (player) {
        room.players.set(player.visibleUserId, player);
        loadedCount++;
      }
    }

    // Update leaderboard
    updateLeaderboard(room);
    console.log('[Redis] Rebuilt leaderboard with', loadedCount, 'players from', visibleUserIds.length, 'in set');
    return room;
  } catch (err) {
    console.error('Failed to rebuild leaderboard from Redis:', err);
  }
  return null;
}

/** Get or create room state (rebuilds from Redis if cache empty) */
async function getOrCreateRoomAsync(roomId, dateKey, language = 'en') {
  const key = makeRoomKey(roomId, dateKey, language);
  let room = roomStateStore.get(key);

  // If room exists in memory but is empty, try to rebuild from Redis
  if ((!room || room.players.size === 0) && redis) {
    const rebuilt = await rebuildLeaderboardFromRedis(roomId, dateKey, language);
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
function getOrCreateRoom(roomId, dateKey, language = 'en') {
  const key = makeRoomKey(roomId, dateKey, language);
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
async function getPlayerAsync(roomId, dateKey, visibleUserId, language = 'en') {
  // First check in-memory cache
  const room = roomStateStore.get(makeRoomKey(roomId, dateKey, language));
  const cachedPlayer = room?.players.get(visibleUserId);
  if (cachedPlayer) {
    console.log('[getPlayerAsync] Found in cache:', visibleUserId, 'guesses:', cachedPlayer.gameState?.guessCount || 0);
    return cachedPlayer;
  }

  // Try to load from Redis
  console.log('[getPlayerAsync] Not in cache, trying Redis for:', visibleUserId);
  const redisPlayer = await loadPlayerFromRedis(roomId, dateKey, visibleUserId, language);
  if (redisPlayer) {
    // Cache in memory
    const r = getOrCreateRoom(roomId, dateKey, language);
    r.players.set(visibleUserId, redisPlayer);
    updateLeaderboard(r);
    console.log('[getPlayerAsync] Cached from Redis:', visibleUserId);
  } else {
    console.log('[getPlayerAsync] Not found in Redis either:', visibleUserId);
  }
  return redisPlayer;
}

/** Get player state from room (sync) */
function getPlayer(roomId, dateKey, visibleUserId, language = 'en') {
  const room = roomStateStore.get(makeRoomKey(roomId, dateKey, language));
  return room?.players.get(visibleUserId) ?? null;
}

/** Set player state in room (also persists to Redis) */
function setPlayer(playerState) {
  const language = playerState.language || 'en';
  const room = getOrCreateRoom(playerState.roomId, playerState.dateKey, language);
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
function createPlayerState(roomId, dateKey, visibleUserId, gameState, profile = { displayName: visibleUserId, avatarUrl: null }, language = 'en') {
  const now = Date.now();
  return {
    visibleUserId,
    roomId,
    dateKey,
    mode: 'daily',
    language,
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
          const { roomId, dateKey, visibleUserId, profile, guildId, language: msgLanguage } = message;
          const language = (msgLanguage === 'ko') ? 'ko' : 'en';
          if (!roomId || !dateKey || !visibleUserId) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_MESSAGE', message: 'Missing required fields' }));
            return;
          }

          // Validate and sanitize profile
          const cleanProfile = {
            displayName: (profile?.displayName || visibleUserId).slice(0, 100),
            avatarUrl: (profile?.avatarUrl || null),
          };

          currentRoomKey = makeRoomKey(roomId, dateKey, language);
          currentVisibleUserId = visibleUserId;
          currentRoomId = roomId;
          currentDateKey = dateKey;

          // Track guildId for this room (needed for announcements)
          if (guildId) {
            roomGuildMap.set(roomId, guildId);
          }

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
          let playerState = await getPlayerAsync(roomId, dateKey, visibleUserId, language);
          if (!playerState) {
            // Create new daily game
            console.log('[JOIN] Creating new player state for:', visibleUserId, 'language:', language);
            const targetWords = getDailyTargets(dateKey, language);
            const gameState = createGameState(targetWords, 9, language);
            playerState = createPlayerState(roomId, dateKey, visibleUserId, gameState, cleanProfile, language);
          } else {
            // Update existing player's profile (in case they changed their display name)
            console.log('[JOIN] Loaded existing player state for:', visibleUserId, 'guesses:', playerState.gameState?.guessCount || 0);
            playerState.profile = cleanProfile;
            playerState.updatedAt = Date.now();
          }
          // Always (re-)add player to room to ensure leaderboard is updated
          setPlayer(playerState);

          // Send STATE to joining client
          ws.send(JSON.stringify({ type: 'STATE', playerState }));

          // Broadcast LEADERBOARD to ALL players in room (rebuilds from Redis if cache empty)
          const room = await getOrCreateRoomAsync(roomId, dateKey, language);
          if (DEBUG_WS) {
            console.log('[WS JOIN] Broadcasting leaderboard, players in room:', room.players.size);
          }
          if (DEBUG_LEADERBOARD) {
            console.log('[LEADERBOARD DEBUG] room.players.size:', room.players.size);
            console.log('[LEADERBOARD DEBUG] leaderboard payload length:', room.leaderboard.length);
            console.log('[LEADERBOARD DEBUG] leaderboard:', JSON.stringify(room.leaderboard));
          }
          broadcastToRoomByKey(currentRoomKey, { type: 'LEADERBOARD', leaderboard: room.leaderboard, language });

          // Broadcast ROOM_EVENT join to everyone in room (including joiner)
          broadcastToRoomByKey(currentRoomKey, { type: 'ROOM_EVENT', event: 'join', visibleUserId });
          break;
        }

        case "GUESS": {
          const { roomId, dateKey, visibleUserId, guess, language: guessLanguage } = message;
          const language = (guessLanguage === 'ko') ? 'ko' : 'en';
          if (!roomId || !dateKey || !visibleUserId || !guess) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_MESSAGE', message: 'Missing required fields' }));
            return;
          }

          const playerState = getPlayer(roomId, dateKey, visibleUserId, language);
          if (!playerState) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'PLAYER_NOT_FOUND', message: 'Player not found. Send JOIN first.' }));
            return;
          }

          if (playerState.gameState.gameOver) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'GAME_OVER', message: 'Game already over' }));
            return;
          }

          // Validate guess
          const normalizedGuess = language === 'ko' ? guess : guess.toLowerCase();
          if (!isValidGuessFormat(normalizedGuess, language)) {
            const expectedLen = getWordLengthForLanguage(language);
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_GUESS', message: `Guess must be ${expectedLen} ${language === 'ko' ? 'syllables' : 'letters'}` }));
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
          console.log('[GUESS] Updating player:', visibleUserId, 'guessCount:', newGuessCount, 'boards:', newBoards.map(b => b.guesses.length));
          setPlayer(updatedPlayerState);

          // Publish DAILY_FINISHED event if game just ended
          if (newGameOver && redis) {
            const solvedCount = newBoards.filter(b => b.solved).length;
            const resolvedGuildId = roomGuildMap.get(roomId) || null;
            // roomId === channelId (set by client from discordSdk.channelId)
            const finishEvent = JSON.stringify({
              type: 'DAILY_FINISHED',
              roomId,
              channelId: roomId,
              guildId: resolvedGuildId,
              dateKey,
              visibleUserId,
              displayName: playerState.profile?.displayName || visibleUserId,
              avatarUrl: playerState.profile?.avatarUrl || null,
              won: allSolved,
              guessCount: newGuessCount,
              solvedBoards: solvedCount,
              totalBoards: 4,
              timestamp: Date.now(),
            });
            redis.publish('activity:events', finishEvent).catch(err => {
              console.error('[Activity] Failed to publish DAILY_FINISHED:', err.message);
            });
            console.log(`[Activity] Published DAILY_FINISHED for ${visibleUserId} in ${roomId} (${allSolved ? 'won' : 'lost'})`);
          }

          // Send updated STATE to player
          ws.send(JSON.stringify({ type: 'STATE', playerState: updatedPlayerState }));

          // Broadcast updated LEADERBOARD to room
          const room = getOrCreateRoom(roomId, dateKey, language);
          const roomKey = makeRoomKey(roomId, dateKey, language);
          if (DEBUG_WS) {
            console.log('[WS GUESS] Broadcasting leaderboard, players in room:', room.players.size);
          }
          if (DEBUG_LEADERBOARD) {
            console.log('[LEADERBOARD DEBUG] GUESS - roomKey:', roomKey);
            console.log('[LEADERBOARD DEBUG] GUESS - room.players.size:', room.players.size);
            console.log('[LEADERBOARD DEBUG] GUESS - leaderboard payload length:', room.leaderboard.length);
          }
          broadcastToRoomByKey(roomKey, { type: 'LEADERBOARD', leaderboard: room.leaderboard, language });
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

// Korean 3-syllable answer word list
const KO_WORD_LIST = [
  '사과나', '바나나', '고구마', '감자탕', '김치찌', '라면집', '불고기', '비빔밥', '삼겹살', '된장찌',
  '떡볶이', '치킨집', '냉면집', '순두부', '잡채밥', '김밥집', '갈비탕', '설렁탕', '해물탕', '닭갈비',
  '오징어', '소고기', '돼지고', '미역국', '콩나물', '시금치', '양배추', '오이김', '깍두기', '젓가락',
  '숟가락', '냄비뚜', '프라이', '주전자', '도마위', '칼국수', '수제비', '만두국', '부침개', '호떡집',
  '짜장면', '짬뽕집', '볶음밥', '유부초', '어묵탕', '순대국', '곱창전', '족발집', '보쌈집', '찜닭집',
  '아이스', '초콜릿', '사탕류', '과자류', '빵집류', '커피숍', '녹차잎', '홍차잎', '우유팩', '주스병',
  '마을길', '학교길', '병원길', '시장길', '공원길', '도서관', '미술관', '박물관', '음악당', '체육관',
  '운동장', '수영장', '놀이터', '공항역', '기차역', '버스정', '택시비', '자전거', '지하철', '고속도',
  '신호등', '횡단보', '주차장', '도로변', '아파트', '빌라집', '주택가', '오피스', '사무실', '회의실',
  '교실안', '강당안', '식당안', '카페안', '미용실', '세탁소', '편의점', '약국앞', '은행앞', '우체국',
  '법원앞', '경찰서', '소방서', '보건소', '휴가철', '여름철', '겨울철', '가을철', '봄나들', '눈사람',
  '비오는', '바람길', '태양빛', '별빛밤', '얼음판', '물결파', '안개꽃', '노을빛', '무지개', '구름위',
  '천둥번', '가족사', '부모님', '형제자', '자매간', '할머니', '할아버', '삼촌댁', '이모집', '고모집',
  '조카딸', '손자손', '친구네', '이웃집', '동네길', '마을회', '반장선', '회장님', '사장님', '부장님',
  '과장님', '대리님', '신입사', '인턴생', '학생회', '교수님', '선생님', '강사님', '의사선', '간호사',
  '약사님', '변호사', '판사님', '검사님', '경찰관', '군인복', '소방관', '기자님', '작가님', '화가님',
  '음악가', '배우님', '감독님', '가수님', '요리사', '미용사', '운전사', '건축가', '정치인', '과학자',
  '연구원', '기술자', '디자인', '프로그', '엔지니', '마케팅', '영업직', '회계사', '세무사', '통역사',
  '번역가', '교육자', '상담사', '자원봉', '봉사활', '나무꽃', '풀잎줄', '열매씨', '뿌리줄', '나뭇잎',
  '소나무', '참나무', '대나무', '벚나무', '은행나', '장미꽃', '해바라', '튤립꽃', '국화꽃', '백합꽃',
  '진달래', '무궁화', '개나리', '라일락', '수선화', '강아지', '고양이', '토끼풀', '거북이', '원숭이',
  '코끼리', '사자왕', '호랑이', '여우굴', '늑대산', '독수리', '참새새', '비둘기', '까치새', '앵무새',
  '금붕어', '열대어', '고래밥', '돌고래', '상어턱', '나비꽃', '잠자리', '무당벌', '개미집', '꿀벌집',
  '거미줄', '메뚜기', '귀뚜라', '달팽이', '지렁이', '행복한', '슬픔의', '기쁨의', '두려움', '분노의',
  '사랑의', '희망찬', '용기와', '지혜의', '평화의', '자유의', '정의의', '진실의', '아름다', '거짓말',
  '약속의', '신뢰의', '존경의', '감사의', '배려의', '친절한', '정직한', '성실한', '겸손한', '열정의',
  '노력의', '성공의', '실패의', '도전의', '모험의', '창조의', '상상력', '호기심', '집중력', '인내력',
  '끈기의', '자신감', '여유의', '균형의', '조화의', '질서의', '혼돈의', '변화의', '성장의', '발전의',
  '혁신의', '전통의', '문화의', '역사의', '자연의', '환경의', '생명의', '건강의', '행운의', '기적의',
  '추억의', '소중한', '특별한', '평범한', '일상의', '순간의', '영원의', '시작의', '마무리', '완성의',
  '준비의', '계획의', '목표의', '결과의', '과정의', '방법의', '해결의', '문제의', '질문의', '대답의',
  '선택의', '결정의', '판단의', '이해의', '공감의', '소통의', '연결의', '관계의', '만남의', '이별의',
  '그리움', '기다림', '설레임', '떨림의', '웃음의', '눈물의', '한숨의', '고민의', '걱정의', '안심의',
  '편안함', '따뜻함', '시원함', '차가움', '뜨거움', '부드러', '단단함', '가벼움', '무거움', '빠름의',
  '느림의', '높이의', '깊이의', '넓이의', '길이의', '멀리서', '가까이', '위쪽의', '아래쪽', '오른쪽',
  '왼쪽의', '앞쪽의', '뒤쪽의', '안쪽의', '바깥쪽', '새벽녘', '아침햇', '점심때', '저녁때', '한밤중',
  '월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일', '오늘날', '어제날', '내일날',
  '모레날', '올해의', '작년의', '내년의', '일월달', '이월달', '삼월달', '사월달', '오월달', '유월달',
  '칠월달', '팔월달', '구월달', '시월달',
];

/** Get word list for a given language */
function getWordListForLanguage(language) {
  return language === 'ko' ? KO_WORD_LIST : WORD_LIST;
}

/** Get expected word length for a given language */
function getWordLengthForLanguage(language) {
  return language === 'ko' ? 3 : 5;
}

/** Validate guess format for a given language */
function isValidGuessFormat(guess, language) {
  if (language === 'ko') {
    return guess.length === 3 && /^[\uAC00-\uD7A3]+$/.test(guess);
  }
  return guess.length === 5 && /^[a-z]+$/.test(guess);
}

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

function getDailyTargets(dateKey, language = 'en') {
  // Korean uses a different seed to guarantee independent daily puzzles
  const seedInput = language === 'ko' ? `${dateKey}:ko` : dateKey;
  const seed = dateKeyToSeed(seedInput);
  const random = mulberry32(seed);
  const wordList = getWordListForLanguage(language);
  const indices = [];
  const used = new Set();
  for (let i = 0; i < 4; i++) {
    let idx;
    do {
      idx = Math.floor(random() * wordList.length);
    } while (used.has(idx));
    used.add(idx);
    indices.push(idx);
  }
  return [wordList[indices[0]], wordList[indices[1]], wordList[indices[2]], wordList[indices[3]]];
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

function createGameState(targetWords, maxGuesses = 9, language = 'en') {
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
    language,
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

// Activity leave notification - triggers "was playing" message in Discord
app.post("/api/activity/leave", async (req, res) => {
  try {
    const { userId, guildId, channelId, dateKey, profile, gameState } = req.body;

    if (!userId || !guildId || !channelId) {
      return res.status(400).json({ error: "userId, guildId, channelId required" });
    }

    // Publish leave event to Redis for bot to pick up
    if (redis) {
      const leaveEvent = JSON.stringify({
        type: 'ACTIVITY_LEAVE',
        userId,
        guildId,
        channelId,
        dateKey: dateKey || getTodayDateKey(),
        profile: profile || { displayName: 'Player', avatarUrl: null },
        gameState: gameState || null,
        timestamp: Date.now(),
      });

      await redis.publish('activity:events', leaveEvent);
      console.log('[Activity] Published leave event:', userId, 'in', guildId, '/', channelId);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Activity] Leave notification error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET leaderboard for a room (rebuilds from Redis if cache empty)
app.get("/api/room/:roomId/:dateKey/leaderboard", async (req, res) => {
  const { roomId, dateKey } = req.params;
  const language = (req.query.language === 'ko') ? 'ko' : 'en';
  if (!roomId || !dateKey) {
    return res.status(400).json({ error: "roomId and dateKey required" });
  }

  // Try to rebuild from Redis if room not in memory
  const room = await getOrCreateRoomAsync(roomId, dateKey, language);
  res.json({ leaderboard: room.leaderboard });
});

// GET players in a room (from Redis roomPlayers set)
app.get("/api/room/:roomId/:dateKey/players", async (req, res) => {
  const { roomId, dateKey } = req.params;
  if (!roomId || !dateKey) {
    return res.status(400).json({ error: "roomId and dateKey required" });
  }

  let visibleUserIds = [];
  let playerDetails = [];

  // Try Redis first for authoritative list
  if (redis) {
    try {
      const setKey = makeRoomPlayersSetKey(roomId, dateKey);
      visibleUserIds = await redis.smembers(setKey);

      // Also load player details from Redis
      for (const visibleUserId of visibleUserIds) {
        const playerKey = makePlayerRedisKey(roomId, dateKey, visibleUserId);
        const data = await redis.get(playerKey);
        if (data) {
          const parsed = JSON.parse(data);
          playerDetails.push({
            visibleUserId,
            guessCount: parsed.gameState?.guessCount || 0,
            boardGuesses: parsed.gameState?.boards?.map(b => b.guesses?.length || 0) || [],
            gameOver: parsed.gameState?.gameOver || false,
            inRedis: true,
          });
        } else {
          playerDetails.push({
            visibleUserId,
            inRedis: false,
            note: 'In roomPlayers set but no player:* key found',
          });
        }
      }
    } catch (err) {
      console.error('Failed to get room players from Redis:', err);
    }
  }

  // Fallback to in-memory if Redis empty/unavailable
  if (visibleUserIds.length === 0) {
    const room = roomStateStore.get(makeRoomKey(roomId, dateKey));
    if (room) {
      visibleUserIds = Array.from(room.players.keys());
      for (const [visibleUserId, player] of room.players) {
        playerDetails.push({
          visibleUserId,
          guessCount: player.gameState?.guessCount || 0,
          boardGuesses: player.gameState?.boards?.map(b => b.guesses?.length || 0) || [],
          gameOver: player.gameState?.gameOver || false,
          source: 'memory',
        });
      }
    }
  }

  res.json({
    roomId,
    dateKey,
    count: visibleUserIds.length,
    visibleUserIds,
    playerDetails,
  });
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
    redisStatus: redis?.status || 'not initialized',
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
      const parsed = data ? JSON.parse(data) : null;
      status.tests.playerGet = {
        key: playerKey,
        success: true,
        found: !!data,
        guessCount: parsed?.gameState?.guessCount || 0,
        boardGuesses: parsed?.gameState?.boards?.map(b => b.guesses?.length || 0) || [],
        gameOver: parsed?.gameState?.gameOver || false,
        updatedAt: parsed?.updatedAt ? new Date(parsed.updatedAt).toISOString() : null,
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
    const { roomId, userId, dateKey: clientDateKey, language: reqLanguage } = req.body;
    const language = (reqLanguage === 'ko') ? 'ko' : 'en';
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
      const targetWords = getDailyTargets(dateKey, language);
      state = {
        gameState: createGameState(targetWords, 9, language),
        gameMode: "daily",
        dateKey,
        language,
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
    const { roomId, userId, guess, dateKey: clientDateKey, language: reqLanguage } = req.body;
    const language = (reqLanguage === 'ko') ? 'ko' : 'en';
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

    // Validate guess format (language-aware)
    const normalizedGuess = language === 'ko' ? guess : guess.toLowerCase();
    if (!isValidGuessFormat(normalizedGuess, language)) {
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
// Works for both English (5 chars) and Korean (3 syllable blocks)
function evaluateGuess(guess, target) {
  const len = target.length;
  const result = new Array(len).fill('absent');
  const targetLetterCounts = new Map();

  for (const letter of target) {
    targetLetterCounts.set(letter, (targetLetterCounts.get(letter) || 0) + 1);
  }

  // First pass: correct letters
  for (let i = 0; i < len; i++) {
    if (guess[i] === target[i]) {
      result[i] = 'correct';
      targetLetterCounts.set(guess[i], targetLetterCounts.get(guess[i]) - 1);
    }
  }

  // Second pass: present letters
  for (let i = 0; i < len; i++) {
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
