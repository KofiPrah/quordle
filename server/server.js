import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "url";
import Redis from "ioredis";
import { KO_ANSWER_WORDS, isValidKoreanGuess } from "@quordle/engine/koreanLexicon";
import { isValidChineseGuess, isValidChinesePinyinGuessKey } from "@quordle/engine/chineseLexicon";
import { calculatePerformanceMetrics, normalizeAssistanceState } from "@quordle/engine/assistance";
import { requestHint } from "@quordle/engine/hints";
import {
  createDailyGame,
  transitionPlayerGuess,
  validateDailyGuess,
} from "./gameplay.js";
import {
  PINYIN_PUZZLE_VARIANT,
  dailyRoundId,
  isCompatiblePersistedPlayer,
  makePlayerRedisKey,
  makePlayerStoreKey as makePlayerKey,
  makeRoomPlayersRedisKey as makeRoomPlayersSetKey,
  makeRoomStoreKey as makeRoomKey,
  parseReadPuzzleVariant,
  parseRequiredPuzzleVariant,
} from "./gameNamespace.js";
import { createLearningDataService } from "./learningData.js";
import {
  createAppSessionToken,
  getBearerToken,
  secureTokenEquals,
  verifyAppSessionToken,
} from "./sessionAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from parent directory in dev, or current directory in production
dotenv.config({ path: "../.env" });
dotenv.config(); // Also try current directory

// Debug flag for WebSocket logging
const DEBUG_WS = process.env.DEBUG_WS === 'true';
const DEBUG_LEADERBOARD = process.env.DEBUG_LEADERBOARD === '1' || process.env.DEBUG_LEADERBOARD === 'true';
const LEARNING_ANALYTICS_ENABLED = ['1', 'true'].includes(String(process.env.LEARNING_ANALYTICS_ENABLED).toLowerCase());
const APP_SESSION_SECRET = process.env.APP_SESSION_SECRET || '';
const ANALYTICS_HMAC_SECRET = process.env.ANALYTICS_HMAC_SECRET || '';
const ANALYTICS_ADMIN_TOKEN = process.env.ANALYTICS_ADMIN_TOKEN || '';
const ALLOW_DEV_SESSION = process.env.NODE_ENV !== 'production'
  && ['1', 'true'].includes(String(process.env.ALLOW_DEV_SESSION).toLowerCase());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORTED_LANGUAGES = new Set(['en', 'ko', 'zh']);
const LEARNING_CONFIGURATION_COMPLETE = LEARNING_ANALYTICS_ENABLED
  && Boolean(APP_SESSION_SECRET)
  && Boolean(ANALYTICS_HMAC_SECRET)
  && Boolean(ANALYTICS_ADMIN_TOKEN);

function parseLanguage(value) {
  if (value === undefined || value === null || value === '') return { ok: true, language: 'en' };
  if (SUPPORTED_LANGUAGES.has(value)) return { ok: true, language: value };
  return { ok: false, language: null };
}

function gameplayError(code, message, details = {}) {
  return { code, error: message, message, ...details };
}

function sendWebSocketError(ws, error) {
  ws.send(JSON.stringify({
    type: 'ERROR',
    code: error.code,
    message: error.message || error.error,
    ...(error.submissionId ? { submissionId: error.submissionId } : {}),
  }));
}

function parseGameplayRequest(language, puzzleVariant) {
  return parseRequiredPuzzleVariant(language, puzzleVariant);
}

function submissionError(language, validation) {
  if (language === 'zh') return validation;
  return {
    code: 'INVALID_GUESS',
    error: validation.error || 'Invalid guess.',
    message: validation.error || 'Invalid guess.',
  };
}

function normalizeGuessForLanguage(guess, language) {
  return language === 'en' ? String(guess ?? '').toLowerCase() : String(guess ?? '').normalize('NFC');
}

function parseSavedWordsLanguage(value) {
  if (value === undefined || value === null || value === '') return { ok: true, language: 'ko' };
  if (value === 'ko' || value === 'zh') return { ok: true, language: value };
  return { ok: false, language: null };
}

let koreanRecognitionWords = Object.freeze({});
let englishGuessWords = new Set();
try {
  const recognitionPath = new URL('../engine/src/koWordRecognition.generated.json', import.meta.url);
  koreanRecognitionWords = JSON.parse(fs.readFileSync(recognitionPath, 'utf8')).words ?? koreanRecognitionWords;
} catch (error) {
  console.warn('[Learning] Korean recognition snapshot unavailable:', error.message);
}
try {
  const guessWordsPath = new URL('../engine/src/guessWords.txt', import.meta.url);
  englishGuessWords = new Set(
    fs.readFileSync(guessWordsPath, 'utf8').split(/\r?\n/u).map((word) => word.trim()).filter(Boolean),
  );
} catch (error) {
  console.warn('[Game] English guess snapshot unavailable:', error.message);
}

// Redis client (optional - falls back to in-memory if not configured)
let redis = null;
let redisErrorLogged = false;
const REDIS_TTL_SECONDS = 60 * 60 * 48; // 48 hours TTL

function hasRedisConnection() {
  return !!redis && redis.status === 'ready';
}

if (process.env.REDIS_URL) {
  try {
    console.log('[Redis] Attempting connection to:', process.env.REDIS_URL.replace(/:[^:@]+@/, ':***@'));
    const redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 1) {
          if (!redisErrorLogged) {
            console.warn('[Redis] Connection failed, using in-memory storage only');
            redisErrorLogged = true;
          }
          return null;
        }
        return Math.min(times * 200, 2000);
      },
    });
    redis = redisClient;

    const disableRedis = () => {
      if (redis === redisClient) {
        redis = null;
      }
      redisClient.disconnect();
    };

    redisClient.on('error', (err) => {
      if (!redisErrorLogged) {
        console.error('[Redis] Error:', err.message);
        redisErrorLogged = true;
      }
      if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(err.message)) {
        console.warn('[Redis] Host unreachable, using in-memory storage only');
        disableRedis();
      }
    });
    redisClient.on('connect', () => console.log('[Redis] Connected successfully'));
    redisClient.on('ready', () => {
      redisErrorLogged = false;
      console.log('[Redis] Ready to accept commands');
    });
    redisClient.on('close', () => console.log('[Redis] Connection closed'));
    redisClient.on('reconnecting', () => {
      if (!redisErrorLogged) {
        console.log('[Redis] Reconnecting...');
      }
    });
  } catch (err) {
    console.error('[Redis] Failed to initialize:', err);
    redis = null;
  }
} else {
  console.log('[Redis] No REDIS_URL configured - using in-memory storage only');
}

const learningData = createLearningDataService({
  enabled: LEARNING_CONFIGURATION_COMPLETE,
  hmacSecret: ANALYTICS_HMAC_SECRET,
  redisProvider: () => hasRedisConnection() ? redis : null,
  allowMemoryFallback: process.env.NODE_ENV === 'test',
  isAcceptedKoreanWord: isValidKoreanGuess,
  isAcceptedChineseWord: isValidChineseGuess,
  isAcceptedPinyinGuessKey: isValidChinesePinyinGuessKey,
  isRecognizedKoreanWord: (word) => Boolean(koreanRecognitionWords[word]),
});

function getAuthenticatedLearningUser(req) {
  const payload = verifyAppSessionToken(getBearerToken(req), APP_SESSION_SECRET);
  return payload?.sub ?? null;
}

function learningRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
    console.warn('[Learning] Request failed:', error.message);
    if (!res.headersSent) {
      res.status(503).json({ error: 'Learning data service unavailable', code: 'LEARNING_DATA_ERROR' });
    }
  });
}

function learningEventBase(player, overrides = {}) {
  const language = SUPPORTED_LANGUAGES.has(player.language) ? player.language : 'en';
  const dateKey = player.dateKey;
  return {
    version: 1,
    occurredAt: Date.now(),
    dateKey,
    language,
    ...(player.puzzleVariant ? { puzzleVariant: player.puzzleVariant } : {}),
    mode: 'daily',
    roundId: dailyRoundId(dateKey, language, player.puzzleVariant),
    ...overrides,
  };
}

async function safelyRecordLearningEvent(event, userId, options = {}) {
  try {
    return await learningData.recordEvent(event, userId, options);
  } catch (error) {
    console.warn('[Learning] Event recording failed:', error.message);
    return { accepted: false, code: 'LEARNING_DATA_ERROR' };
  }
}

async function recordDailyRoundStarted(player) {
  if (!player) return;
  await safelyRecordLearningEvent(learningEventBase(player, {
    eventId: `round-start:${dailyRoundId(player.dateKey, player.language || 'en', player.puzzleVariant)}`,
    type: 'round_started',
    occurredAt: player.createdAt || Date.now(),
  }), player.visibleUserId);
}

async function recordDailyGuessTransition(player, previousGameState, nextGameState, guess) {
  if (!player || !previousGameState || !nextGameState) return;
  const guessNumber = nextGameState.guessCount;
  const roundId = dailyRoundId(player.dateKey, player.language || 'en', player.puzzleVariant);
  const baseId = `${roundId}:${guessNumber}`;
  await safelyRecordLearningEvent(learningEventBase(player, {
    eventId: `guess:${baseId}`,
    type: 'valid_guess_submitted',
    ...(player.puzzleVariant === PINYIN_PUZZLE_VARIANT ? { guessKey: guess } : { word: guess }),
  }), player.visibleUserId);

  for (let boardIndex = 0; boardIndex < nextGameState.boards.length; boardIndex += 1) {
    const before = previousGameState.boards[boardIndex];
    const after = nextGameState.boards[boardIndex];
    if (!before.solved && after.solved) {
      const targetId = after.targetId || after.targetWord;
      await safelyRecordLearningEvent(learningEventBase(player, {
        eventId: `board-solved:${baseId}:${boardIndex}`,
        type: 'board_solved',
        boardIndex,
        word: targetId,
      }), player.visibleUserId);
      if (['ko', 'zh'].includes(player.language)) {
        await learningData.markSavedWordLaterGuessed(player.visibleUserId, targetId, {
          language: player.language,
          puzzleVariant: player.puzzleVariant,
          dateKey: player.dateKey,
          mode: 'daily',
          roundId,
          roundStartedAt: player.createdAt,
        }).catch((error) => console.warn('[Learning] Saved-word recall failed:', error.message));
      }
    }
  }

  if (!previousGameState.gameOver && nextGameState.gameOver) {
    for (let boardIndex = 0; boardIndex < nextGameState.boards.length; boardIndex += 1) {
      const board = nextGameState.boards[boardIndex];
      if (!board.solved) {
        await safelyRecordLearningEvent(learningEventBase(player, {
          eventId: `board-failed:${roundId}:${boardIndex}`,
          type: 'board_failed',
          boardIndex,
          word: board.targetId || board.targetWord,
        }), player.visibleUserId);
      }
    }
    const performance = calculatePerformanceMetrics(nextGameState);
    await safelyRecordLearningEvent(learningEventBase(player, {
      eventId: `round-completed:${roundId}`,
      type: 'round_completed',
      metrics: {
        won: nextGameState.won,
        assisted: performance.assisted,
        guessCount: performance.guessCount,
        score: performance.score,
        solvedCount: performance.solvedCount,
        failedCount: 4 - performance.solvedCount,
      },
    }), player.visibleUserId);
  }
}

async function recordDailyHint(player, hint) {
  if (!player || !hint) return;
  await safelyRecordLearningEvent(learningEventBase(player, {
    eventId: `hint:${dailyRoundId(player.dateKey, player.language || 'en', player.puzzleVariant)}:${hint.boardIndex}:${hint.type}`,
    type: 'hint_used',
    boardIndex: hint.boardIndex,
    hintType: hint.type,
  }), player.visibleUserId);
}

async function recordDailyInvalidGuess(player, guess, attemptId) {
  if (!player || typeof attemptId !== 'string' || !UUID_RE.test(attemptId)) return;
  if (learningData.available()
    && !(await learningData.checkRateLimit(player.visibleUserId, 'daily-invalid', 60))) return;
  const language = SUPPORTED_LANGUAGES.has(player.language) ? player.language : 'en';
  const normalizedGuess = normalizeGuessForLanguage(guess, language);
  const recognizedKorean = language === 'ko'
    && /^[\uAC00-\uD7A3]{2}$/u.test(normalizedGuess)
    && !isValidKoreanGuess(normalizedGuess)
    && Boolean(koreanRecognitionWords[normalizedGuess]);
  await safelyRecordLearningEvent(learningEventBase(player, {
    eventId: `invalid:${attemptId}`,
    type: 'invalid_guess_submitted',
    classification: recognizedKorean
      ? 'recognized-unaccepted'
      : (language === 'ko' ? 'unrecognized' : 'not-in-list'),
    ...(recognizedKorean ? { word: normalizedGuess } : {}),
  }), player.visibleUserId);
}

function normalizePersistedPlayer(player) {
  if (!player?.gameState) return player;
  return {
    ...player,
    gameState: {
      ...player.gameState,
      assistance: normalizeAssistanceState(player.gameState.assistance),
    },
  };
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

// ========== REDIS PERSISTENCE HELPERS ==========
// Redis is source of truth for player state; in-memory Maps are cache

/** Save a single player state to Redis with TTL */
async function persistPlayerToRedis(playerState) {
  if (!hasRedisConnection()) {
    console.log('[Redis] Skipping persist - no Redis connection');
    return;
  }
  const language = playerState.language || 'en';
  const puzzleVariant = playerState.puzzleVariant;
  const key = makePlayerRedisKey(playerState.roomId, playerState.dateKey, playerState.visibleUserId, language, puzzleVariant);
  const setKey = makeRoomPlayersSetKey(playerState.roomId, playerState.dateKey, language, puzzleVariant);

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
async function loadPlayerFromRedis(roomId, dateKey, visibleUserId, language = 'en', puzzleVariant) {
  if (!hasRedisConnection()) {
    console.log('[Redis] Skipping load - no Redis connection');
    return null;
  }
  try {
    const key = makePlayerRedisKey(roomId, dateKey, visibleUserId, language, puzzleVariant);
    console.log('[Redis LOAD] Attempting to load:', key);
    const data = await redis.get(key);
    if (data) {
      const parsed = normalizePersistedPlayer(JSON.parse(data));
      if (!isCompatiblePersistedPlayer(parsed, language, puzzleVariant)) {
        console.warn('[Redis LOAD] Rejected incompatible player state:', key);
        return null;
      }
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
async function rebuildLeaderboardFromRedis(roomId, dateKey, language = 'en', puzzleVariant) {
  if (!hasRedisConnection()) {
    console.log('[Redis] Cannot rebuild leaderboard - no Redis connection');
    return null;
  }
  try {
    const setKey = makeRoomPlayersSetKey(roomId, dateKey, language, puzzleVariant);
    const visibleUserIds = await redis.smembers(setKey);
    console.log('[Redis] Rebuilding leaderboard for', setKey, '- found', visibleUserIds?.length || 0, 'players');
    if (!visibleUserIds || visibleUserIds.length === 0) return null;

    const room = getOrCreateRoom(roomId, dateKey, language, puzzleVariant);

    // Load all players in parallel
    const playerPromises = visibleUserIds.map(async (visibleUserId) => {
      const key = makePlayerRedisKey(roomId, dateKey, visibleUserId, language, puzzleVariant);
      const data = await redis.get(key);
      const player = data ? normalizePersistedPlayer(JSON.parse(data)) : null;
      return isCompatiblePersistedPlayer(player, language, puzzleVariant) ? player : null;
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
async function getOrCreateRoomAsync(roomId, dateKey, language = 'en', puzzleVariant) {
  const key = makeRoomKey(roomId, dateKey, language, puzzleVariant);
  let room = roomStateStore.get(key);

  // If room exists in memory but is empty, try to rebuild from Redis
  if ((!room || room.players.size === 0) && hasRedisConnection()) {
    const rebuilt = await rebuildLeaderboardFromRedis(roomId, dateKey, language, puzzleVariant);
    if (rebuilt && rebuilt.players.size > 0) {
      return rebuilt;
    }
  }

  if (!room) {
    room = {
      roomId,
      dateKey,
      language,
      puzzleVariant,
      players: new Map(),
      leaderboard: [],
      lastBroadcastAt: Date.now(),
    };
    roomStateStore.set(key, room);
  }
  return room;
}

/** Get or create room state (sync version for non-async contexts) */
function getOrCreateRoom(roomId, dateKey, language = 'en', puzzleVariant) {
  const key = makeRoomKey(roomId, dateKey, language, puzzleVariant);
  let room = roomStateStore.get(key);
  if (!room) {
    room = {
      roomId,
      dateKey,
      language,
      puzzleVariant,
      players: new Map(),
      leaderboard: [],
      lastBroadcastAt: Date.now(),
    };
    roomStateStore.set(key, room);
  }
  return room;
}

/** Get player state from room (checks Redis first) */
async function getPlayerAsync(roomId, dateKey, visibleUserId, language = 'en', puzzleVariant) {
  // First check in-memory cache
  const room = roomStateStore.get(makeRoomKey(roomId, dateKey, language, puzzleVariant));
  const cachedPlayer = room?.players.get(visibleUserId);
  if (cachedPlayer && isCompatiblePersistedPlayer(cachedPlayer, language, puzzleVariant)) {
    console.log('[getPlayerAsync] Found in cache:', visibleUserId, 'guesses:', cachedPlayer.gameState?.guessCount || 0);
    return cachedPlayer;
  }

  // Try to load from Redis
  console.log('[getPlayerAsync] Not in cache, trying Redis for:', visibleUserId);
  const redisPlayer = await loadPlayerFromRedis(roomId, dateKey, visibleUserId, language, puzzleVariant);
  if (redisPlayer) {
    // Cache in memory
    const r = getOrCreateRoom(roomId, dateKey, language, puzzleVariant);
    r.players.set(visibleUserId, redisPlayer);
    updateLeaderboard(r);
    console.log('[getPlayerAsync] Cached from Redis:', visibleUserId);
  } else {
    console.log('[getPlayerAsync] Not found in Redis either:', visibleUserId);
  }
  return redisPlayer;
}

/** Get player state from room (sync) */
function getPlayer(roomId, dateKey, visibleUserId, language = 'en', puzzleVariant) {
  const room = roomStateStore.get(makeRoomKey(roomId, dateKey, language, puzzleVariant));
  const player = room?.players.get(visibleUserId) ?? null;
  return isCompatiblePersistedPlayer(player, language, puzzleVariant) ? player : null;
}

/** Set player state in room (also persists to Redis) */
function setPlayer(playerState) {
  const language = playerState.language || 'en';
  const room = getOrCreateRoom(playerState.roomId, playerState.dateKey, language, playerState.puzzleVariant);
  room.players.set(playerState.visibleUserId, playerState);
  updateLeaderboard(room);
  // Fire-and-forget Redis persistence of individual player
  persistPlayerToRedis(playerState);
}

/** Convert player state to leaderboard entry */
function toLeaderboardEntry(player) {
  const gs = player.gameState;
  const performance = calculatePerformanceMetrics(gs);
  return {
    visibleUserId: player.visibleUserId,
    ...(player.puzzleVariant ? { puzzleVariant: player.puzzleVariant } : {}),
    profile: player.profile || { displayName: player.visibleUserId, avatarUrl: null },
    solvedCount: performance.solvedCount,
    guessCount: performance.guessCount,
    hintCount: performance.hintCount,
    hintPenalty: performance.hintPenalty,
    assisted: performance.assisted,
    score: performance.score,
    gameOver: gs.gameOver,
    won: gs.won,
    finishedAt: player.finishedAt,
    updatedAt: player.updatedAt,
    status: gs.gameOver ? (gs.won ? 'won' : 'lost') : 'playing',
  };
}

/** Sort leaderboard: most solved, highest score, fewest guesses, earliest finish */
function sortLeaderboard(entries) {
  return [...entries].sort((a, b) => {
    if (a.solvedCount !== b.solvedCount) return b.solvedCount - a.solvedCount;
    if (a.score !== b.score) return b.score - a.score;
    if (a.guessCount !== b.guessCount) return a.guessCount - b.guessCount;
    return (a.finishedAt ?? Number.POSITIVE_INFINITY) - (b.finishedAt ?? Number.POSITIVE_INFINITY);
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
function createPlayerState(roomId, dateKey, visibleUserId, gameState, profile = { displayName: visibleUserId, avatarUrl: null }, language = 'en', puzzleVariant) {
  const now = Date.now();
  return {
    visibleUserId,
    roomId,
    dateKey,
    mode: 'daily',
    language,
    ...(puzzleVariant ? { puzzleVariant } : {}),
    profile,
    gameState: {
      ...gameState,
      assistance: normalizeAssistanceState(gameState.assistance),
    },
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
}

// Legacy store for REST API compatibility
const gameStateStore = {
  /** @type {Map<string, object>} */
  _store: new Map(),

  _makeKey(roomId, dateKey, userId, language = 'en', puzzleVariant) {
    return makePlayerKey(roomId, dateKey, userId, language, puzzleVariant);
  },

  _makeLegacyKey(roomId, dateKey, userId) {
    return `${roomId}:${dateKey}:${userId}`;
  },

  _matchesLanguage(state, language) {
    if (!state || typeof state !== 'object') return false;
    const stateLanguage = state.language || state.gameState?.language || 'en';
    return stateLanguage === language;
  },

  async get(roomId, dateKey, userId, language = 'en', puzzleVariant) {
    // First check new room store
    const player = getPlayer(roomId, dateKey, userId, language, puzzleVariant);
    if (player) {
      return {
        gameState: player.gameState,
        gameMode: player.mode,
        dateKey: player.dateKey,
        language: player.language || language,
        ...(player.pinyinSubmissionReceipt
          ? { pinyinSubmissionReceipt: player.pinyinSubmissionReceipt }
          : {}),
        ...(player.puzzleVariant ? { puzzleVariant: player.puzzleVariant } : {}),
      };
    }

    // Fallback to language-aware legacy store
    const key = this._makeKey(roomId, dateKey, userId, language, puzzleVariant);
    const stored = this._store.get(key);
    if (stored && isCompatiblePersistedPlayer(stored, language, puzzleVariant)) {
      return stored;
    }

    // Backward compatibility for older in-memory keys created before language isolation.
    const legacyKey = this._makeLegacyKey(roomId, dateKey, userId);
    const legacyState = this._store.get(legacyKey);
    if (language !== 'zh' && legacyState && this._matchesLanguage(legacyState, language)) {
      this._store.set(key, legacyState);
      this._store.delete(legacyKey);
      return legacyState;
    }

    return null;
  },

  async set(roomId, dateKey, userId, state, language = 'en', puzzleVariant) {
    const player = getPlayer(roomId, dateKey, userId, language, puzzleVariant);
    if (player) {
      const now = Date.now();
      const gameState = {
        ...state.gameState,
        assistance: normalizeAssistanceState(state.gameState?.assistance),
      };
      const updatedPlayer = {
        ...player,
        gameState,
        language,
        ...(state.pinyinSubmissionReceipt
          ? { pinyinSubmissionReceipt: state.pinyinSubmissionReceipt }
          : {}),
        ...(puzzleVariant ? { puzzleVariant } : {}),
        updatedAt: now,
        finishedAt: gameState.gameOver && !player.finishedAt ? now : player.finishedAt,
      };
      setPlayer(updatedPlayer);
      broadcastToRoomByKey(
        makeRoomKey(roomId, dateKey, language, puzzleVariant),
        { type: 'LEADERBOARD', leaderboard: getOrCreateRoom(roomId, dateKey, language, puzzleVariant).leaderboard, language, puzzleVariant },
      );
      return;
    }
    const key = this._makeKey(roomId, dateKey, userId, language, puzzleVariant);
    this._store.set(key, { ...state, language, ...(puzzleVariant ? { puzzleVariant } : {}) });
    if (language !== 'zh') this._store.delete(this._makeLegacyKey(roomId, dateKey, userId));
  },

  async delete(roomId, dateKey, userId, language = 'en', puzzleVariant) {
    const key = this._makeKey(roomId, dateKey, userId, language, puzzleVariant);
    this._store.delete(key);
    if (language !== 'zh') this._store.delete(this._makeLegacyKey(roomId, dateKey, userId));
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
  let currentLanguage = 'en';
  let currentPuzzleVariant;

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        // ===== NEW PROTOCOL =====
        case "JOIN": {
          const { roomId, dateKey, visibleUserId, profile, guildId, language: msgLanguage, puzzleVariant: msgPuzzleVariant } = message;
          const parsedLanguage = parseLanguage(msgLanguage);
          if (!parsedLanguage.ok) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_LANGUAGE', message: 'Unsupported language' }));
            return;
          }
          const language = parsedLanguage.language;
          const parsedVariant = parseGameplayRequest(language, msgPuzzleVariant);
          if (!parsedVariant.ok) {
            sendWebSocketError(ws, parsedVariant);
            return;
          }
          const puzzleVariant = parsedVariant.puzzleVariant;
          if (!roomId || !dateKey || !visibleUserId) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_MESSAGE', message: 'Missing required fields' }));
            return;
          }

          // Validate and sanitize profile
          const cleanProfile = {
            displayName: (profile?.displayName || visibleUserId).slice(0, 100),
            avatarUrl: (profile?.avatarUrl || null),
          };

          const newRoomKey = makeRoomKey(roomId, dateKey, language, puzzleVariant);

          // If switching languages (or rooms), remove ws from old room's connection set
          if (currentRoomKey && currentRoomKey !== newRoomKey) {
            const oldConns = wsConnectionsByRoom.get(currentRoomKey);
            if (oldConns) {
              for (const client of oldConns) {
                if (client.ws === ws) {
                  oldConns.delete(client);
                  break;
                }
              }
              if (oldConns.size === 0) {
                wsConnectionsByRoom.delete(currentRoomKey);
              }
            }
          }

          currentRoomKey = newRoomKey;
          currentVisibleUserId = visibleUserId;
          currentRoomId = roomId;
          currentDateKey = dateKey;
          currentLanguage = language;
          currentPuzzleVariant = puzzleVariant;

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
          let playerState = await getPlayerAsync(roomId, dateKey, visibleUserId, language, puzzleVariant);
          if (!playerState) {
            // Create new daily game
            console.log('[JOIN] Creating new player state for:', visibleUserId, 'language:', language);
            const targetWords = language === 'zh' ? undefined : getDailyTargets(dateKey, language);
            const gameState = createDailyGame(dateKey, language, puzzleVariant, targetWords);
            playerState = createPlayerState(roomId, dateKey, visibleUserId, gameState, cleanProfile, language, puzzleVariant);
          } else {
            // Update existing player's profile (in case they changed their display name)
            console.log('[JOIN] Loaded existing player state for:', visibleUserId, 'guesses:', playerState.gameState?.guessCount || 0);
            playerState.profile = cleanProfile;
            playerState.updatedAt = Date.now();
          }
          // Always (re-)add player to room to ensure leaderboard is updated
          setPlayer(playerState);
          await recordDailyRoundStarted(playerState);

          // Send STATE to joining client
          ws.send(JSON.stringify({ type: 'STATE', playerState }));

          // Broadcast LEADERBOARD to ALL players in room (rebuilds from Redis if cache empty)
          const room = await getOrCreateRoomAsync(roomId, dateKey, language, puzzleVariant);
          if (DEBUG_WS) {
            console.log('[WS JOIN] Broadcasting leaderboard, players in room:', room.players.size);
          }
          if (DEBUG_LEADERBOARD) {
            console.log('[LEADERBOARD DEBUG] room.players.size:', room.players.size);
            console.log('[LEADERBOARD DEBUG] leaderboard payload length:', room.leaderboard.length);
            console.log('[LEADERBOARD DEBUG] leaderboard:', JSON.stringify(room.leaderboard));
          }
          broadcastToRoomByKey(currentRoomKey, { type: 'LEADERBOARD', leaderboard: room.leaderboard, language, puzzleVariant });

          // Broadcast ROOM_EVENT join to everyone in room (including joiner)
          broadcastToRoomByKey(currentRoomKey, { type: 'ROOM_EVENT', event: 'join', visibleUserId });
          break;
        }

        case "INVALID_GUESS_ATTEMPT": {
          const {
            roomId, dateKey, visibleUserId, guess, attemptId, language: guessLanguage, puzzleVariant: guessPuzzleVariant,
          } = message;
          const parsedLanguage = parseLanguage(guessLanguage);
          if (!parsedLanguage.ok) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_LANGUAGE', message: 'Unsupported language' }));
            return;
          }
          const language = parsedLanguage.language;
          const parsedVariant = parseGameplayRequest(language, guessPuzzleVariant);
          if (!parsedVariant.ok) {
            sendWebSocketError(ws, parsedVariant);
            return;
          }
          const puzzleVariant = parsedVariant.puzzleVariant;
          if (!roomId || !dateKey || !visibleUserId || !guess || !UUID_RE.test(String(attemptId ?? ''))) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_MESSAGE', message: 'Missing or invalid fields' }));
            return;
          }
          const playerState = getPlayer(roomId, dateKey, visibleUserId, language, puzzleVariant);
          if (!playerState || playerState.gameState.gameOver) return;
          const validation = validateDailyGuess(playerState.gameState, guess, {
            isAcceptedEnglishGuess: (word) => englishGuessWords.has(word),
            isAcceptedKoreanGuess: isValidKoreanGuess,
          });
          if (validation.valid) return;
          await recordDailyInvalidGuess(playerState, guess, attemptId);
          ws.send(JSON.stringify({ type: 'ANALYTICS_ACK', event: 'invalid_guess', attemptId }));
          break;
        }

        case "GUESS": {
          const {
            roomId,
            dateKey,
            visibleUserId,
            guess,
            submissionId,
            language: guessLanguage,
            puzzleVariant: guessPuzzleVariant,
          } = message;
          const parsedLanguage = parseLanguage(guessLanguage);
          if (!parsedLanguage.ok) {
            sendWebSocketError(ws, {
              code: 'INVALID_LANGUAGE',
              message: 'Unsupported language',
              ...(submissionId ? { submissionId } : {}),
            });
            return;
          }
          const language = parsedLanguage.language;
          const parsedVariant = parseGameplayRequest(language, guessPuzzleVariant);
          if (!parsedVariant.ok) {
            sendWebSocketError(ws, { ...parsedVariant, ...(submissionId ? { submissionId } : {}) });
            return;
          }
          const puzzleVariant = parsedVariant.puzzleVariant;
          if (!roomId || !dateKey || !visibleUserId || !guess) {
            sendWebSocketError(ws, {
              code: 'INVALID_MESSAGE',
              message: 'Missing required fields',
              ...(submissionId ? { submissionId } : {}),
            });
            return;
          }
          if (language === 'zh' && (typeof submissionId !== 'string' || !submissionId || submissionId.length > 128)) {
            sendWebSocketError(ws, {
              code: 'INVALID_SUBMISSION_ID',
              message: 'A valid submissionId is required for Pinyin guesses.',
              ...(typeof submissionId === 'string' && submissionId ? { submissionId } : {}),
            });
            return;
          }

          const playerState = getPlayer(roomId, dateKey, visibleUserId, language, puzzleVariant);
          if (!playerState) {
            sendWebSocketError(ws, {
              code: 'PLAYER_NOT_FOUND',
              message: 'Player not found. Send JOIN first.',
              ...(submissionId ? { submissionId } : {}),
            });
            return;
          }

          if (language !== 'zh' && playerState.gameState.gameOver) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'GAME_OVER', message: 'Game already over' }));
            return;
          }

          const transition = transitionPlayerGuess(playerState, guess, {
            isAcceptedEnglishGuess: (word) => englishGuessWords.has(word),
            isAcceptedKoreanGuess: isValidKoreanGuess,
          }, Date.now(), submissionId);
          if (!transition.ok) {
            if (!['INVALID_SUBMISSION_ID', 'SUBMISSION_ID_REUSED', 'GAME_OVER'].includes(transition.code)) {
              await recordDailyInvalidGuess(
                playerState,
                guess,
                UUID_RE.test(String(message.attemptId ?? '')) ? message.attemptId : crypto.randomUUID(),
              );
            }
            sendWebSocketError(ws, submissionError(language, transition));
            return;
          }
          const {
            previousGameState: oldGameState,
            gameState: newGameState,
            playerState: updatedPlayerState,
            normalizedGuess,
          } = transition;
          if (transition.idempotent) {
            ws.send(JSON.stringify({ type: 'STATE', playerState: updatedPlayerState }));
            break;
          }
          const newBoards = newGameState.boards;
          const newGuessCount = newGameState.guessCount;
          const newGameOver = newGameState.gameOver;
          const allSolved = newGameState.won;
          console.log('[GUESS] Updating player:', visibleUserId, 'guessCount:', newGuessCount, 'boards:', newBoards.map(b => b.guesses.length));
          setPlayer(updatedPlayerState);
          await recordDailyGuessTransition(updatedPlayerState, oldGameState, newGameState, normalizedGuess);

          // Publish DAILY_FINISHED event if game just ended
          if (newGameOver && hasRedisConnection()) {
            const solvedCount = newBoards.filter(b => b.solved).length;
            const performance = calculatePerformanceMetrics(newGameState);
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
              hintCount: performance.hintCount,
              hintPenalty: performance.hintPenalty,
              assisted: performance.assisted,
              score: performance.score,
              language,
              puzzleVariant,
              timestamp: Date.now(),
            });
            redis.publish('activity:events', finishEvent).catch(err => {
              console.error('[Activity] Failed to publish DAILY_FINISHED:', err.message);
            });
            console.log(`[Activity] Published DAILY_FINISHED for ${visibleUserId} in ${roomId} lang=${language} (${allSolved ? 'won' : 'lost'})`);
          }

          // Send updated STATE to player
          ws.send(JSON.stringify({ type: 'STATE', playerState: updatedPlayerState }));

          // Broadcast updated LEADERBOARD to room
          const room = getOrCreateRoom(roomId, dateKey, language, puzzleVariant);
          const roomKey = makeRoomKey(roomId, dateKey, language, puzzleVariant);
          if (DEBUG_WS) {
            console.log('[WS GUESS] Broadcasting leaderboard, players in room:', room.players.size);
          }
          if (DEBUG_LEADERBOARD) {
            console.log('[LEADERBOARD DEBUG] GUESS - roomKey:', roomKey);
            console.log('[LEADERBOARD DEBUG] GUESS - room.players.size:', room.players.size);
            console.log('[LEADERBOARD DEBUG] GUESS - leaderboard payload length:', room.leaderboard.length);
          }
          broadcastToRoomByKey(roomKey, { type: 'LEADERBOARD', leaderboard: room.leaderboard, language, puzzleVariant });
          break;
        }

        case "HINT": {
          const { roomId, dateKey, visibleUserId, boardIndex, hintType, language: hintLanguage, puzzleVariant: hintPuzzleVariant } = message;
          if (!roomId || !dateKey || !visibleUserId || !Number.isInteger(boardIndex) || typeof hintType !== 'string') {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_MESSAGE', message: 'Missing or invalid hint request fields' }));
            return;
          }
          if (!['ko', 'zh'].includes(hintLanguage)) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_LANGUAGE', message: 'Hints are available only for Korean and Chinese games.' }));
            return;
          }
          const language = hintLanguage;
          const parsedVariant = parseGameplayRequest(language, hintPuzzleVariant);
          if (!parsedVariant.ok) {
            sendWebSocketError(ws, parsedVariant);
            return;
          }
          const puzzleVariant = parsedVariant.puzzleVariant;

          const playerState = getPlayer(roomId, dateKey, visibleUserId, language, puzzleVariant);
          if (!playerState) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'PLAYER_NOT_FOUND', message: 'Player not found. Send JOIN first.' }));
            return;
          }

          const result = requestHint(playerState.gameState, boardIndex, hintType, Date.now());
          if (!result.ok) {
            ws.send(JSON.stringify({ type: 'ERROR', code: result.code, message: result.message }));
            return;
          }

          const updatedPlayerState = result.duplicate
            ? { ...playerState, gameState: result.state }
            : { ...playerState, gameState: result.state, updatedAt: Date.now() };
          if (!result.duplicate) {
            setPlayer(updatedPlayerState);
            const hint = result.state.assistance?.hints?.find(
              (entry) => entry.boardIndex === boardIndex && entry.type === hintType,
            );
            await recordDailyHint(updatedPlayerState, hint);
          }

          ws.send(JSON.stringify({ type: 'STATE', playerState: updatedPlayerState }));
          if (!result.duplicate) {
            const room = getOrCreateRoom(roomId, dateKey, language, puzzleVariant);
            broadcastToRoomByKey(
              makeRoomKey(roomId, dateKey, language, puzzleVariant),
              { type: 'LEADERBOARD', leaderboard: room.leaderboard, language, puzzleVariant },
            );
          }
          break;
        }

        case "LEAVE": {
          const { roomId, dateKey, visibleUserId, language: leaveLang, puzzleVariant: leaveVariant } = message;
          if (!roomId || !dateKey || !visibleUserId) {
            return;
          }
          const parsedLanguage = leaveLang === undefined ? { ok: true, language: currentLanguage } : parseLanguage(leaveLang);
          if (!parsedLanguage.ok) {
            ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_LANGUAGE', message: 'Unsupported language' }));
            return;
          }
          const leaveLanguage = parsedLanguage.language;
          handleLeave(roomId, dateKey, visibleUserId, ws, leaveLanguage, leaveVariant ?? currentPuzzleVariant);
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
      handleLeave(currentRoomId, currentDateKey, currentVisibleUserId, ws, currentLanguage, currentPuzzleVariant);
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
function handleLeave(roomId, dateKey, visibleUserId, ws, language = 'en', puzzleVariant) {
  const roomKey = makeRoomKey(roomId, dateKey, language, puzzleVariant);
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
    broadcastToRoomByKey(roomKey, { type: 'LEADERBOARD', leaderboard: room.leaderboard, language, puzzleVariant });
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

/** Get word list for a given language */
function getWordListForLanguage(language) {
  if (language === 'ko') return KO_ANSWER_WORDS;
  return WORD_LIST;
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
  // Preserve the historical English seed while namespacing additional languages.
  const seedInput = language === 'en' ? dateKey : `${dateKey}:${language}`;
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

function getTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

// ========== API ENDPOINTS ==========

// Health check for deployment platforms
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    capabilities: {
      learningDataEnabled: LEARNING_ANALYTICS_ENABLED,
      learningDataAvailable: learningData.available(),
      learningDataRedisBacked: learningData.available() && hasRedisConnection(),
    },
  });
});

app.post('/api/session/dev', (req, res) => {
  if (!ALLOW_DEV_SESSION || !APP_SESSION_SECRET) {
    return res.status(404).json({ error: 'Not found' });
  }
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim().slice(0, 100) : '';
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const session = createAppSessionToken(userId, APP_SESSION_SECRET);
  return res.json({ app_session_token: session.token, app_session_expires_at: session.expiresAt });
});

app.post('/api/analytics/events', learningRoute(async (req, res) => {
  if (!learningData.available()) {
    return res.status(503).json({ error: 'Learning analytics unavailable', code: 'LEARNING_DATA_UNAVAILABLE' });
  }
  const userId = getAuthenticatedLearningUser(req);
  if (!userId) return res.status(401).json({ error: 'Valid app session required' });
  const events = req.body?.events;
  if (!Array.isArray(events) || events.length < 1 || events.length > 20) {
    return res.status(400).json({ error: 'events must contain between 1 and 20 items' });
  }
  if (!(await learningData.checkRateLimit(userId, 'events', 60))) {
    return res.status(429).json({ error: 'Analytics rate limit exceeded' });
  }

  const acceptedIds = [];
  const duplicateIds = [];
  const rejected = [];
  for (const event of events) {
    const result = await learningData.recordEvent(event, userId, { client: true });
    if (!result.accepted) {
      rejected.push({ eventId: typeof event?.eventId === 'string' ? event.eventId : null, code: result.code });
      continue;
    }
    if (result.duplicate) duplicateIds.push(result.event.eventId);
    else acceptedIds.push(result.event.eventId);
    if (
      !result.duplicate
      && result.event.type === 'board_solved'
      && result.event.mode === 'practice'
      && ['ko', 'zh'].includes(result.event.language)
    ) {
      await learningData.markSavedWordLaterGuessed(userId, result.event.word, {
        language: result.event.language,
        puzzleVariant: result.event.puzzleVariant,
        dateKey: result.event.dateKey,
        mode: 'practice',
        roundId: result.event.roundId,
        roundStartedAt: result.event.roundStartedAt,
      });
    }
  }
  return res.json({ version: 1, acceptedIds, duplicateIds, rejected });
}));

app.get('/api/learning/saved-words', learningRoute(async (req, res) => {
  if (!learningData.available()) {
    return res.status(503).json({ error: 'Saved Words unavailable', code: 'LEARNING_DATA_UNAVAILABLE' });
  }
  const userId = getAuthenticatedLearningUser(req);
  if (!userId) return res.status(401).json({ error: 'Valid app session required' });
  if (!(await learningData.checkRateLimit(userId, 'saved-words-read', 60))) {
    return res.status(429).json({ error: 'Saved Words rate limit exceeded' });
  }
  const parsedLanguage = parseSavedWordsLanguage(req.query.language);
  if (!parsedLanguage.ok) {
    return res.status(400).json({ error: 'Saved Words supports ko or zh', code: 'INVALID_LANGUAGE' });
  }
  const words = await learningData.getSavedWords(userId, parsedLanguage.language);
  return res.json({ version: 2, language: parsedLanguage.language, storage: 'server', words });
}));

app.put('/api/learning/saved-words/:word', learningRoute(async (req, res) => {
  if (!learningData.available()) {
    return res.status(503).json({ error: 'Saved Words unavailable', code: 'LEARNING_DATA_UNAVAILABLE' });
  }
  const userId = getAuthenticatedLearningUser(req);
  if (!userId) return res.status(401).json({ error: 'Valid app session required' });
  if (!(await learningData.checkRateLimit(userId, 'saved-words', 30))) {
    return res.status(429).json({ error: 'Saved Words rate limit exceeded' });
  }
  const parsedLanguage = parseSavedWordsLanguage(req.body?.language);
  if (!parsedLanguage.ok) {
    return res.status(400).json({ error: 'Saved Words supports ko or zh', code: 'INVALID_LANGUAGE' });
  }
  try {
    const result = await learningData.saveWord(userId, req.params.word, {
      language: parsedLanguage.language,
      puzzleVariant: req.body?.puzzleVariant,
      source: req.body?.source,
      dateKey: req.body?.dateKey,
      mode: req.body?.mode,
      roundId: req.body?.roundId,
    });
    return res.status(result.created ? 201 : 200).json({ version: 2, language: parsedLanguage.language, ...result });
  } catch (error) {
    const status = error.message === 'INVALID_WORD' ? 400 : 503;
    return res.status(status).json({ error: error.message, code: error.message });
  }
}));

app.delete('/api/learning/saved-words/:word', learningRoute(async (req, res) => {
  if (!learningData.available()) {
    return res.status(503).json({ error: 'Saved Words unavailable', code: 'LEARNING_DATA_UNAVAILABLE' });
  }
  const userId = getAuthenticatedLearningUser(req);
  if (!userId) return res.status(401).json({ error: 'Valid app session required' });
  if (!(await learningData.checkRateLimit(userId, 'saved-words', 30))) {
    return res.status(429).json({ error: 'Saved Words rate limit exceeded' });
  }
  const parsedLanguage = parseSavedWordsLanguage(req.body?.language);
  if (!parsedLanguage.ok) {
    return res.status(400).json({ error: 'Saved Words supports ko or zh', code: 'INVALID_LANGUAGE' });
  }
  try {
    const result = await learningData.unsaveWord(userId, req.params.word, {
      language: parsedLanguage.language,
      puzzleVariant: req.body?.puzzleVariant,
      dateKey: req.body?.dateKey,
      mode: req.body?.mode,
      roundId: req.body?.roundId,
    });
    return res.json({ version: 2, language: parsedLanguage.language, ...result });
  } catch (error) {
    const status = error.message === 'INVALID_WORD' ? 400 : 503;
    return res.status(status).json({ error: error.message, code: error.message });
  }
}));

app.get('/api/admin/analytics/summary', learningRoute(async (req, res) => {
  const adminToken = getBearerToken(req);
  if (!secureTokenEquals(adminToken, ANALYTICS_ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'Valid analytics admin token required' });
  }
  if (!learningData.available()) {
    return res.status(503).json({ error: 'Learning analytics unavailable', code: 'LEARNING_DATA_UNAVAILABLE' });
  }
  try {
    const summary = await learningData.getSummary({
      from: req.query.from,
      to: req.query.to,
      language: req.query.language,
      puzzleVariant: req.query.puzzleVariant,
      mode: req.query.mode,
    });
    return res.json(summary);
  } catch (error) {
    const status = ['INVALID_DATE_RANGE', 'INVALID_FILTER'].includes(error.message) ? 400 : 500;
    return res.status(status).json({ error: error.message });
  }
}));

// Activity leave notification - triggers "was playing" message in Discord
app.post("/api/activity/leave", async (req, res) => {
  try {
    const { userId, guildId, channelId, dateKey, profile, gameState, language: reqLanguage, puzzleVariant } = req.body;
    const parsedLanguage = parseLanguage(reqLanguage);
    if (!parsedLanguage.ok) {
      return res.status(400).json({ error: 'Unsupported language', code: 'INVALID_LANGUAGE' });
    }

    if (!userId || !guildId || !channelId) {
      return res.status(400).json({ error: "userId, guildId, channelId required" });
    }

    // Publish leave event to Redis for bot to pick up
    if (hasRedisConnection()) {
      const leaveEvent = JSON.stringify({
        type: 'ACTIVITY_LEAVE',
        userId,
        guildId,
        channelId,
        dateKey: dateKey || getTodayDateKey(),
        language: parsedLanguage.language,
        puzzleVariant,
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
  const parsedLanguage = parseLanguage(req.query.language);
  if (!parsedLanguage.ok) {
    return res.status(400).json({ error: 'Unsupported language', code: 'INVALID_LANGUAGE' });
  }
  const language = parsedLanguage.language;
  const parsedVariant = parseReadPuzzleVariant(language, req.query.puzzleVariant);
  if (!parsedVariant.ok) {
    return res.status(400).json(gameplayError(parsedVariant.code, parsedVariant.message));
  }
  const puzzleVariant = parsedVariant.puzzleVariant;
  if (!roomId || !dateKey) {
    return res.status(400).json({ error: "roomId and dateKey required" });
  }

  // Try to rebuild from Redis if room not in memory
  const room = await getOrCreateRoomAsync(roomId, dateKey, language, puzzleVariant);
  res.json({ language, puzzleVariant, leaderboard: room.leaderboard });
});

// GET players in a room (from Redis roomPlayers set)
app.get("/api/room/:roomId/:dateKey/players", async (req, res) => {
  const { roomId, dateKey } = req.params;
  const parsedLanguage = parseLanguage(req.query.language);
  if (!parsedLanguage.ok) {
    return res.status(400).json({ error: 'Unsupported language', code: 'INVALID_LANGUAGE' });
  }
  const language = parsedLanguage.language;
  const parsedVariant = parseReadPuzzleVariant(language, req.query.puzzleVariant);
  if (!parsedVariant.ok) {
    return res.status(400).json(gameplayError(parsedVariant.code, parsedVariant.message));
  }
  const puzzleVariant = parsedVariant.puzzleVariant;
  if (!roomId || !dateKey) {
    return res.status(400).json({ error: "roomId and dateKey required" });
  }

  let visibleUserIds = [];
  let playerDetails = [];

  // Try Redis first for authoritative list
  if (hasRedisConnection()) {
    try {
      const setKey = makeRoomPlayersSetKey(roomId, dateKey, language, puzzleVariant);
      visibleUserIds = await redis.smembers(setKey);

      // Also load player details from Redis
      for (const visibleUserId of visibleUserIds) {
        const playerKey = makePlayerRedisKey(roomId, dateKey, visibleUserId, language, puzzleVariant);
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
    const room = roomStateStore.get(makeRoomKey(roomId, dateKey, language, puzzleVariant));
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
    language,
    puzzleVariant,
    count: visibleUserIds.length,
    visibleUserIds,
    playerDetails,
  });
});

// GET player state
app.get("/api/room/:roomId/:dateKey/player/:visibleUserId", (req, res) => {
  const { roomId, dateKey, visibleUserId } = req.params;
  const parsedLanguage = parseLanguage(req.query.language);
  if (!parsedLanguage.ok) {
    return res.status(400).json({ error: 'Unsupported language', code: 'INVALID_LANGUAGE' });
  }
  const language = parsedLanguage.language;
  const parsedVariant = parseReadPuzzleVariant(language, req.query.puzzleVariant);
  if (!parsedVariant.ok) {
    return res.status(400).json(gameplayError(parsedVariant.code, parsedVariant.message));
  }
  const puzzleVariant = parsedVariant.puzzleVariant;
  if (!roomId || !dateKey || !visibleUserId) {
    return res.status(400).json({ error: "roomId, dateKey, and visibleUserId required" });
  }

  const playerState = getPlayer(roomId, dateKey, visibleUserId, language, puzzleVariant);
  if (!playerState) {
    return res.status(404).json({ error: "Player not found" });
  }

  res.json({ playerState });
});

// Debug endpoint to verify Redis persistence
app.get("/api/debug/persist", async (req, res) => {
  const { roomId, dateKey, visibleUserId } = req.query;
  const parsedLanguage = parseLanguage(req.query.language);
  const language = parsedLanguage.ok ? parsedLanguage.language : 'en';
  const parsedVariant = parseReadPuzzleVariant(language, req.query.puzzleVariant);
  const puzzleVariant = parsedVariant.ok ? parsedVariant.puzzleVariant : undefined;

  const status = {
    redisConnected: hasRedisConnection(),
    redisStatus: redis?.status || 'not initialized',
    redisUrl: process.env.REDIS_URL ? '***configured***' : 'not configured',
    tests: {},
  };

  if (!hasRedisConnection()) {
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
    const playerKey = makePlayerRedisKey(roomId, dateKey, visibleUserId, language, puzzleVariant);
    const setKey = makeRoomPlayersSetKey(roomId, dateKey, language, puzzleVariant);

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
  try {
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
    const tokenPayload = await response.json();
    if (!response.ok || !tokenPayload.access_token) {
      return res.status(502).json({ error: 'Discord token exchange failed' });
    }

    let appSession = null;
    if (APP_SESSION_SECRET) {
      try {
        const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
        });
        const user = await userResponse.json();
        if (userResponse.ok && user?.id) {
          appSession = createAppSessionToken(user.id, APP_SESSION_SECRET);
        } else {
          console.warn('[Learning] Discord identity verification did not return a user; learning data is unavailable for this session.');
        }
      } catch (error) {
        console.warn('[Learning] Discord identity verification failed:', error.message);
      }
    }

    return res.send({
      access_token: tokenPayload.access_token,
      ...(appSession ? {
        app_session_token: appSession.token,
        app_session_expires_at: appSession.expiresAt,
      } : {}),
    });
  } catch (error) {
    console.error('[Auth] Discord token exchange failed:', error.message);
    return res.status(502).json({ error: 'Discord authentication unavailable' });
  }
});

// JOIN: Get or create game state for a player in a room
app.post("/api/game/join", async (req, res) => {
  try {
    const { roomId, userId, dateKey: clientDateKey, language: reqLanguage, puzzleVariant: reqPuzzleVariant, guildId, profile } = req.body;
    const parsedLanguage = parseLanguage(reqLanguage);
    if (!parsedLanguage.ok) {
      return res.status(400).json({ error: 'Unsupported language', code: 'INVALID_LANGUAGE' });
    }
    const language = parsedLanguage.language;
    const parsedVariant = parseGameplayRequest(language, reqPuzzleVariant);
    if (!parsedVariant.ok) {
      return res.status(400).json(gameplayError(parsedVariant.code, parsedVariant.message));
    }
    const puzzleVariant = parsedVariant.puzzleVariant;
    if (!roomId || !userId) {
      return res.status(400).json({ error: "roomId and userId required" });
    }

    // Use client-provided dateKey if valid, otherwise compute on server
    const dateKey = (clientDateKey && /^\d{4}-\d{2}-\d{2}$/.test(clientDateKey))
      ? clientDateKey
      : getTodayDateKey();
    if (guildId) roomGuildMap.set(roomId, guildId);
    let playerState = await getPlayerAsync(roomId, dateKey, userId, language, puzzleVariant);
    let state = playerState ? {
      gameState: playerState.gameState,
      gameMode: playerState.mode,
      dateKey: playerState.dateKey,
      language: playerState.language,
      ...(playerState.pinyinSubmissionReceipt
        ? { pinyinSubmissionReceipt: playerState.pinyinSubmissionReceipt }
        : {}),
      ...(playerState.puzzleVariant ? { puzzleVariant: playerState.puzzleVariant } : {}),
    } : await gameStateStore.get(roomId, dateKey, userId, language, puzzleVariant);

    if (!playerState) {
      const targetWords = language === 'zh' ? undefined : getDailyTargets(dateKey, language);
      const gameState = state?.gameState ?? createDailyGame(dateKey, language, puzzleVariant, targetWords);
      const cleanProfile = {
        displayName: (profile?.displayName || userId).slice(0, 100),
        avatarUrl: profile?.avatarUrl || null,
      };
      playerState = createPlayerState(roomId, dateKey, userId, gameState, cleanProfile, language, puzzleVariant);
      setPlayer(playerState);
      await gameStateStore.delete(roomId, dateKey, userId, language, puzzleVariant);
      state = {
        gameState: playerState.gameState,
        gameMode: playerState.mode,
        dateKey: playerState.dateKey,
        language: playerState.language,
        ...(playerState.pinyinSubmissionReceipt
          ? { pinyinSubmissionReceipt: playerState.pinyinSubmissionReceipt }
          : {}),
        ...(playerState.puzzleVariant ? { puzzleVariant: playerState.puzzleVariant } : {}),
      };
    }

    await recordDailyRoundStarted(playerState);

    broadcastToRoomByKey(
      makeRoomKey(roomId, dateKey, language, puzzleVariant),
      { type: 'LEADERBOARD', leaderboard: getOrCreateRoom(roomId, dateKey, language, puzzleVariant).leaderboard, language, puzzleVariant },
    );
    res.json(state);
  } catch (err) {
    console.error("JOIN error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// INVALID GUESS: Server-classify a rejected daily attempt without blocking client feedback.
app.post('/api/game/invalid-guess', async (req, res) => {
  try {
    const {
      roomId, userId, guess, attemptId, dateKey: clientDateKey, language: reqLanguage, puzzleVariant: reqPuzzleVariant,
    } = req.body;
    const parsedLanguage = parseLanguage(reqLanguage);
    if (!parsedLanguage.ok) {
      return res.status(400).json({ error: 'Unsupported language', code: 'INVALID_LANGUAGE' });
    }
    const language = parsedLanguage.language;
    const parsedVariant = parseGameplayRequest(language, reqPuzzleVariant);
    if (!parsedVariant.ok) {
      return res.status(400).json(gameplayError(parsedVariant.code, parsedVariant.message));
    }
    const puzzleVariant = parsedVariant.puzzleVariant;
    if (!roomId || !userId || !guess || !UUID_RE.test(String(attemptId ?? ''))) {
      return res.status(400).json({ error: 'roomId, userId, guess, and UUID attemptId required' });
    }
    const dateKey = clientDateKey && /^\d{4}-\d{2}-\d{2}$/.test(clientDateKey)
      ? clientDateKey
      : getTodayDateKey();
    const player = await getPlayerAsync(roomId, dateKey, userId, language, puzzleVariant);
    if (!player) return res.status(404).json({ error: 'No game found. Call /api/game/join first.' });
    if (player.gameState.gameOver) return res.status(204).end();
    const validation = validateDailyGuess(player.gameState, guess, {
      isAcceptedEnglishGuess: (word) => englishGuessWords.has(word),
      isAcceptedKoreanGuess: isValidKoreanGuess,
    });
    if (validation.valid) {
      return res.status(400).json({ error: 'Guess is accepted by the current lexicon' });
    }
    await recordDailyInvalidGuess(player, guess, attemptId);
    return res.status(202).json({ accepted: true });
  } catch (error) {
    console.warn('[Learning] Invalid-guess instrumentation failed:', error.message);
    return res.status(202).json({ accepted: false });
  }
});

// GUESS: Submit a guess and get updated state
app.post("/api/game/guess", async (req, res) => {
  try {
    const {
      roomId,
      userId,
      guess,
      submissionId,
      dateKey: clientDateKey,
      language: reqLanguage,
      puzzleVariant: reqPuzzleVariant,
    } = req.body;
    const parsedLanguage = parseLanguage(reqLanguage);
    if (!parsedLanguage.ok) {
      return res.status(400).json(gameplayError(
        'INVALID_LANGUAGE',
        'Unsupported language',
        submissionId ? { submissionId } : {},
      ));
    }
    const language = parsedLanguage.language;
    const parsedVariant = parseGameplayRequest(language, reqPuzzleVariant);
    if (!parsedVariant.ok) {
      return res.status(400).json(gameplayError(
        parsedVariant.code,
        parsedVariant.message,
        submissionId ? { submissionId } : {},
      ));
    }
    const puzzleVariant = parsedVariant.puzzleVariant;
    if (!roomId || !userId || !guess) {
      return res.status(400).json(gameplayError(
        'INVALID_MESSAGE',
        'roomId, userId, and guess required',
        submissionId ? { submissionId } : {},
      ));
    }
    if (language === 'zh' && (typeof submissionId !== 'string' || !submissionId || submissionId.length > 128)) {
      return res.status(400).json(gameplayError(
        'INVALID_SUBMISSION_ID',
        'A valid submissionId is required for Pinyin guesses.',
        typeof submissionId === 'string' && submissionId ? { submissionId } : {},
      ));
    }

    // Use client-provided dateKey if valid, otherwise compute on server
    const dateKey = (clientDateKey && /^\d{4}-\d{2}-\d{2}$/.test(clientDateKey))
      ? clientDateKey
      : getTodayDateKey();
    let state = await gameStateStore.get(roomId, dateKey, userId, language, puzzleVariant);

    if (!state) {
      return res.status(404).json(gameplayError(
        'PLAYER_NOT_FOUND',
        'No game found. Call /api/game/join first.',
        submissionId ? { submissionId } : {},
      ));
    }

    const { gameState } = state;
    const existingPlayer = await getPlayerAsync(roomId, dateKey, userId, language, puzzleVariant);
    if (language !== 'zh' && gameState.gameOver) {
      return res.json(state); // Game already over, return current state
    }

    const playerForTransition = existingPlayer ?? {
      roomId,
      dateKey,
      visibleUserId: userId,
      language,
      puzzleVariant,
      gameState,
      createdAt: Date.now(),
      finishedAt: null,
    };
    const transition = transitionPlayerGuess(playerForTransition, guess, {
      isAcceptedEnglishGuess: (word) => englishGuessWords.has(word),
      isAcceptedKoreanGuess: isValidKoreanGuess,
    }, Date.now(), submissionId);
    if (!transition.ok) {
      if (existingPlayer && !['INVALID_SUBMISSION_ID', 'SUBMISSION_ID_REUSED', 'GAME_OVER'].includes(transition.code)) {
        await recordDailyInvalidGuess(
          existingPlayer,
          guess,
          UUID_RE.test(String(req.body.attemptId ?? '')) ? req.body.attemptId : crypto.randomUUID(),
        );
      }
      const error = submissionError(language, transition);
      return res.status(error.code === 'SUBMISSION_ID_REUSED' ? 409 : 400).json(gameplayError(
        error.code,
        error.message || error.error,
        error.submissionId ? { submissionId: error.submissionId } : {},
      ));
    }
    const {
      previousGameState,
      gameState: newGameState,
      normalizedGuess,
      playerState: transitionedPlayer,
    } = transition;
    state = {
      ...state,
      gameState: newGameState,
      language,
      ...(transitionedPlayer.pinyinSubmissionReceipt
        ? { pinyinSubmissionReceipt: transitionedPlayer.pinyinSubmissionReceipt }
        : {}),
      ...(puzzleVariant ? { puzzleVariant } : {}),
    };
    if (transition.idempotent) return res.json(state);
    await gameStateStore.set(roomId, dateKey, userId, state, language, puzzleVariant);

    const updatedPlayer = getPlayer(roomId, dateKey, userId, language, puzzleVariant) || transition.playerState;
    if (updatedPlayer) {
      await recordDailyGuessTransition(updatedPlayer, previousGameState, newGameState, normalizedGuess);
    }

    res.json(state);
  } catch (err) {
    console.error("GUESS error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// HINT: Apply one server-authoritative language-specific hint to an unsolved board
app.post("/api/game/hint", async (req, res) => {
  try {
    const { roomId, userId, boardIndex, hintType, dateKey: clientDateKey, language: reqLanguage, puzzleVariant: reqPuzzleVariant } = req.body;
    if (!roomId || !userId || !Number.isInteger(boardIndex) || typeof hintType !== 'string') {
      return res.status(400).json({ error: 'roomId, userId, boardIndex, and hintType required', code: 'INVALID_MESSAGE' });
    }
    if (!['ko', 'zh'].includes(reqLanguage)) {
      return res.status(400).json({ error: 'Hints are available only for Korean and Chinese games.', code: 'INVALID_LANGUAGE' });
    }
    const language = reqLanguage;
    const parsedVariant = parseGameplayRequest(language, reqPuzzleVariant);
    if (!parsedVariant.ok) {
      return res.status(400).json(gameplayError(parsedVariant.code, parsedVariant.message));
    }
    const puzzleVariant = parsedVariant.puzzleVariant;

    const dateKey = (clientDateKey && /^\d{4}-\d{2}-\d{2}$/.test(clientDateKey))
      ? clientDateKey
      : getTodayDateKey();
    const playerState = await getPlayerAsync(roomId, dateKey, userId, language, puzzleVariant);
    const legacyState = playerState ? null : await gameStateStore.get(roomId, dateKey, userId, language, puzzleVariant);
    const gameState = playerState?.gameState ?? legacyState?.gameState;
    if (!gameState) {
      return res.status(404).json({ error: 'No game found. Call /api/game/join first.', code: 'PLAYER_NOT_FOUND' });
    }

    const result = requestHint(gameState, boardIndex, hintType, Date.now());
    if (!result.ok) {
      const status = result.code === 'HINT_UNAVAILABLE'
        ? 422
        : (result.code === 'GAME_OVER' || result.code === 'BOARD_SOLVED' ? 409 : 400);
      return res.status(status).json({ error: result.message, code: result.code });
    }

    if (playerState) {
      const updatedPlayerState = result.duplicate
        ? { ...playerState, gameState: result.state }
        : { ...playerState, gameState: result.state, updatedAt: Date.now() };
      if (!result.duplicate) {
        setPlayer(updatedPlayerState);
        const hint = result.state.assistance?.hints?.find(
          (entry) => entry.boardIndex === boardIndex && entry.type === hintType,
        );
        await recordDailyHint(updatedPlayerState, hint);
        const room = getOrCreateRoom(roomId, dateKey, language, puzzleVariant);
        broadcastToRoomByKey(
          makeRoomKey(roomId, dateKey, language, puzzleVariant),
          { type: 'LEADERBOARD', leaderboard: room.leaderboard, language, puzzleVariant },
        );
      }
      return res.json({
        gameState: updatedPlayerState.gameState,
        gameMode: updatedPlayerState.mode,
        dateKey: updatedPlayerState.dateKey,
        language: updatedPlayerState.language,
        ...(updatedPlayerState.pinyinSubmissionReceipt
          ? { pinyinSubmissionReceipt: updatedPlayerState.pinyinSubmissionReceipt }
          : {}),
        ...(updatedPlayerState.puzzleVariant ? { puzzleVariant: updatedPlayerState.puzzleVariant } : {}),
      });
    }

    const state = { ...legacyState, gameState: result.state, language, ...(puzzleVariant ? { puzzleVariant } : {}) };
    await gameStateStore.set(roomId, dateKey, userId, state, language, puzzleVariant);
    return res.json(state);
  } catch (err) {
    console.error('HINT error:', err);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

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
