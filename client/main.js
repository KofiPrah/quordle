import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

// API URL - empty string for same-origin (required for Discord Activities due to CSP)
// Discord proxies requests from https://{client_id}.discordsays.com/ to your server
const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, ''); // Strip trailing slashes

// WebSocket URL - derive from API_URL or use same origin
const WS_URL = API_URL
  ? API_URL.replace(/^http/, 'ws') + '/ws'
  : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

// Import Quordle engine
import { createGame, submitGuess, setCurrentGuess, validateGuess, getSolvedCount, computeKeyboardBoardMap } from "../engine/src/game.ts";
import { evaluateGuess } from "../engine/src/evaluator.ts";
import { getQuordleWords, isValidGuess } from "../engine/src/words.ts";
import { getDailyTargets } from "../engine/src/daily.ts";
import { getLanguageConfig, isValidGuessForLanguage, getQuordleWordsForLanguage } from "../engine/src/languageConfig.ts";
import { canBeCoda, canBeOnset, combineCodas, combineVowels, expandHangulToJamoUnits, isConsonant, isHangulSyllable, isVowel, splitCompoundCoda, splitCompoundVowel } from "../engine/src/jamo.ts";
import { backspaceKoIme, createKoImeState, finalizeKoIme, getKoImeDisplayChar, processKoImeJamo } from "../engine/src/koIme.ts";
import {
  getRemainingGuessCount,
  partitionBoards,
  reconcileExpandedSolvedBoardIndex,
  reconcileSelectedBoardIndex,
  toggleExpandedSolvedBoardIndex,
} from "./src/boardLayout.js";

// Will eventually store the authenticated user's access_token
let auth;
let gameState;
let guessError = null; // Error message for invalid guesses
let gameMode = "daily"; // "daily" | "practice"
let uiScreen = "game"; // "game" | "results"
let currentLanguage = localStorage.getItem('quordle_language') || 'en'; // 'en' | 'ko'

// Discord context for server-side persistence
let discordUserId = null;
let discordRoomId = null;
let discordGuildId = null;
let discordChannelId = null;
let userProfile = { displayName: 'Player', avatarUrl: null }; // Current user's profile info

// WebSocket connection
let ws = null;
let wsReconnectTimeout = null;
let leaderboardEn = []; // English room leaderboard
let leaderboardKo = []; // Korean room leaderboard
let initialStateApplied = false; // Prevents double init from WS STATE + REST join race
const SESSION_TIMEOUT_MS = 45 * 60 * 1000;
const KEY_ENTER = "ENTER";
const KEY_BACKSPACE = "BACKSPACE";
const KEY_SHIFT = "SHIFT";
const KOREAN_SHIFT_MAP = Object.freeze({
  'ㅂ': 'ㅃ',
  'ㅈ': 'ㅉ',
  'ㄷ': 'ㄸ',
  'ㄱ': 'ㄲ',
  'ㅅ': 'ㅆ',
  'ㅐ': 'ㅒ',
  'ㅔ': 'ㅖ',
});
const KOREAN_SHIFT_OUTPUTS = new Set(Object.values(KOREAN_SHIFT_MAP));
let lastActivityAt = Date.now();
let inactivityTimer = null;
let expiredSessionSnapshot = null;
let koreanShiftActive = false;
let activityTrackingBound = false;
let activityViewportBound = false;
let viewportSyncFrame = null;
let leaderboardModalOpen = false;
let boardScrollTop = 0;
let selectedBoardIndex = null;
let expandedSolvedBoardIndex = null;
let boardUiGameIdentity = null;
let pendingBoardSelectionAnnouncement = '';

function resetBoardScrollPosition() {
  boardScrollTop = 0;
  const boardRegion = document.querySelector('.game-scroll-region');
  if (boardRegion) {
    boardRegion.scrollTop = 0;
  }
}

function resetBoardUiState() {
  selectedBoardIndex = null;
  expandedSolvedBoardIndex = null;
  boardUiGameIdentity = null;
  pendingBoardSelectionAnnouncement = '';
}

function getBoardUiGameIdentity() {
  if (!gameState?.boards) return null;
  const targets = gameState.boards.map((board) => board.targetWord).join('|');
  return `${currentLanguage}:${gameMode}:${targets}`;
}

function syncBoardUiState() {
  if (!gameState?.boards) return;

  const nextIdentity = getBoardUiGameIdentity();
  if (nextIdentity !== boardUiGameIdentity) {
    selectedBoardIndex = null;
    expandedSolvedBoardIndex = null;
    boardUiGameIdentity = nextIdentity;
  }

  const previousSelection = selectedBoardIndex;
  selectedBoardIndex = reconcileSelectedBoardIndex(gameState.boards, selectedBoardIndex);
  expandedSolvedBoardIndex = reconcileExpandedSolvedBoardIndex(gameState.boards, expandedSolvedBoardIndex);

  if (previousSelection !== null && selectedBoardIndex !== null && previousSelection !== selectedBoardIndex) {
    pendingBoardSelectionAnnouncement = `Board ${selectedBoardIndex + 1} selected`;
  }
}

function measureActivityViewportHeight() {
  const candidates = [
    ['visualViewport', window.visualViewport?.height],
    ['documentElement', document.documentElement.clientHeight],
    ['innerHeight', window.innerHeight],
  ];

  for (const [source, value] of candidates) {
    if (Number.isFinite(value) && value > 0) {
      return { height: Math.round(value), source };
    }
  }

  return { height: 0, source: 'unavailable' };
}

function logViewportMetrics(measurement) {
  if (window.DEBUG_VIEWPORT !== true) return;

  const body = document.body.getBoundingClientRect();
  const app = document.getElementById('app')?.getBoundingClientRect();
  const shell = document.querySelector('.quordle-container')?.getBoundingClientRect();
  const boards = document.querySelector('.game-scroll-region')?.getBoundingClientRect();
  const dock = document.querySelector('.game-input-dock')?.getBoundingClientRect();

  console.table({
    measurementSource: measurement.source,
    measuredHeight: measurement.height,
    innerHeight: window.innerHeight,
    visualViewportHeight: window.visualViewport?.height,
    discordSafeAreaTop: getComputedStyle(document.documentElement).getPropertyValue('--discord-safe-area-inset-top'),
    resolvedSafeAreaTop: getComputedStyle(document.documentElement).getPropertyValue('--app-safe-area-top'),
    documentClientHeight: document.documentElement.clientHeight,
    bodyHeight: body.height,
    appHeight: app?.height,
    shellHeight: shell?.height,
    boardRegionHeight: boards?.height,
    inputDockHeight: dock?.height,
  });
}

function syncActivityViewportHeight() {
  viewportSyncFrame = null;
  const measurement = measureActivityViewportHeight();
  if (measurement.height <= 0) return;

  document.documentElement.style.setProperty('--app-height', `${measurement.height}px`);
  requestAnimationFrame(() => logViewportMetrics(measurement));
}

function scheduleActivityViewportSync() {
  if (viewportSyncFrame !== null) return;
  viewportSyncFrame = requestAnimationFrame(syncActivityViewportHeight);
}

function setupActivityViewport() {
  if (activityViewportBound) return;
  activityViewportBound = true;

  scheduleActivityViewportSync();
  window.addEventListener('resize', scheduleActivityViewportSync, { passive: true });
  window.addEventListener('orientationchange', scheduleActivityViewportSync, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleActivityViewportSync, { passive: true });
  window.visualViewport?.addEventListener('scroll', scheduleActivityViewportSync, { passive: true });
}

// ========== WEBSOCKET CONNECTION ==========
function getUserProfile() {
  // Extract profile from Discord auth or fallback
  if (auth?.user) {
    const user = auth.user;
    const displayName = user.global_name || user.username || 'Player';
    let avatarUrl = null;

    // Build avatar URL: https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.png
    if (user.avatar) {
      const format = user.avatar.startsWith('a_') ? 'gif' : 'png';
      avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${format}`;
    }

    return { displayName, avatarUrl };
  }
  return userProfile;
}

function joinCurrentDailyRoom() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!discordUserId || !discordRoomId || gameMode === 'practice') return;

  const dateKey = getTodayDateKey();
  userProfile = getUserProfile();
  ws.send(JSON.stringify({
    type: 'JOIN',
    roomId: discordRoomId,
    dateKey,
    visibleUserId: discordUserId,
    profile: userProfile,
    guildId: discordGuildId,
    language: currentLanguage,
  }));
}

function connectWebSocket() {
  if (!discordUserId || !discordRoomId) return;
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log('Connecting to WebSocket:', WS_URL);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('WebSocket connected');
    // Don't send daily JOIN if we're in practice mode — it would overwrite the practice game
    if (gameMode === 'practice') {
      console.log('Skipping daily JOIN — currently in practice mode');
      return;
    }
    joinCurrentDailyRoom();
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleServerMessage(message);
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    // Auto-reconnect after 3 seconds
    if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = setTimeout(() => {
      if (discordUserId && discordRoomId) {
        connectWebSocket();
      }
    }, 3000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

function handleServerMessage(message) {
  console.log('Server message:', message.type, message);

  switch (message.type) {
    case 'STATE':
      // Ignore daily STATE messages while in practice mode to prevent overwriting the practice game
      if (gameMode === 'practice') {
        console.log('Ignoring STATE message — currently in practice mode');
        break;
      }
      // Update game state from server
      if (message.playerState && message.playerState.gameState) {
        const nextLanguage = message.playerState.language || currentLanguage;
        const normalizedState = normalizeRestoredGameState(message.playerState.gameState, nextLanguage);
        if (!normalizedState) {
          console.warn('Ignoring invalid STATE payload from server');
          break;
        }
        initialStateApplied = true;
        restoreSavedPayload({
          gameState: normalizedState,
          gameMode: message.playerState.mode || 'daily',
          language: nextLanguage,
          dateKey: message.playerState.dateKey || getTodayDateKey(),
          lastActiveAt: Date.now(),
          savedAt: Date.now(),
        }, { markActive: true });
        saveGameState();
        renderApp();
        setupKeyboardListeners();
      }
      break;

    case 'LEADERBOARD':
      // Update leaderboard for the appropriate language
      if (window.DEBUG_LEADERBOARD) {
        console.log('[LEADERBOARD DEBUG] Received message:', message);
        console.log('[LEADERBOARD DEBUG] message.leaderboard:', message.leaderboard);
        console.log('[LEADERBOARD DEBUG] leaderboard length:', message.leaderboard?.length);
      }
      {
        const lbLang = message.language || currentLanguage;
        if (lbLang === 'ko') {
          leaderboardKo = message.leaderboard || [];
        } else {
          leaderboardEn = message.leaderboard || [];
        }
      }
      // Also fetch the other language's leaderboard via REST
      fetchOtherLanguageLeaderboard();
      renderLeaderboard();
      break;

    case 'ROOM_EVENT':
      // Show toast for join/leave
      const action = message.event === 'join' ? 'joined' : 'left';
      // Don't show toast for own join
      if (message.visibleUserId !== discordUserId) {
        showToast(`Player ${action}`);
      }
      break;

    case 'ERROR':
      console.error('Server error:', message.code, message.message);
      guessError = message.message;
      renderApp();
      setupKeyboardListeners();
      break;
  }
}

function sendGuessViaWebSocket(guess) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket not connected');
    return false;
  }

  const dateKey = getTodayDateKey();
  ws.send(JSON.stringify({
    type: 'GUESS',
    roomId: discordRoomId,
    dateKey,
    visibleUserId: discordUserId,
    guess,
    language: currentLanguage,
  }));
  return true;
}

// ========== TOAST NOTIFICATIONS ==========
function showToast(message, duration = 3000) {
  // Remove existing toast
  const existingToast = document.querySelector('.toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  setTimeout(() => toast.classList.add('toast-visible'), 10);

  // Remove after duration
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ========== LOCAL STORAGE PERSISTENCE ==========
function getStorageKeyDaily(language = currentLanguage) { return `quordle_daily_${language}`; }
function getStorageKeyPractice(language = currentLanguage) { return `quordle_practice_${language}`; }
function getStorageKeyForMode(mode, language = currentLanguage) {
  return mode === "daily" ? getStorageKeyDaily(language) : getStorageKeyPractice(language);
}

function getSavedStateTimestamp(payload) {
  const ts = Number(payload?.lastActiveAt ?? payload?.savedAt);
  return Number.isFinite(ts) ? ts : Date.now();
}

const VALID_HINT_STATUSES = new Set(['correct', 'present', 'absent']);

function getBestHintStatus(units, slot) {
  let best = null;
  for (const unit of units) {
    if (!unit || unit.slot !== slot) continue;
    if (unit.status === 'correct') return 'correct';
    if (unit.status === 'present') best = 'present';
    if (unit.status === 'absent' && best === null) best = 'absent';
  }
  return best;
}

function synthesizeHintUnitsFromLegacy(syllable, hint) {
  if (!hint || !isHangulSyllable(syllable)) return [];

  return expandHangulToJamoUnits(syllable)
    .map((unit) => {
      const status = hint[unit.slot];
      return VALID_HINT_STATUSES.has(status) ? { ...unit, status } : null;
    })
    .filter(Boolean);
}

function normalizeJamoHint(hint, syllable) {
  if (!hint || typeof hint !== 'object') return null;

  const units = Array.isArray(hint.units)
    ? hint.units.filter((unit) => unit && typeof unit.jamo === 'string' && ['onset', 'vowel', 'coda'].includes(unit.slot) && VALID_HINT_STATUSES.has(unit.status))
    : synthesizeHintUnitsFromLegacy(syllable, hint);

  const onset = VALID_HINT_STATUSES.has(hint.onset) ? hint.onset : getBestHintStatus(units, 'onset');
  const vowel = VALID_HINT_STATUSES.has(hint.vowel) ? hint.vowel : getBestHintStatus(units, 'vowel');
  const coda = VALID_HINT_STATUSES.has(hint.coda) ? hint.coda : getBestHintStatus(units, 'coda');

  return {
    ...hint,
    units,
    ...(onset ? { onset } : {}),
    ...(vowel ? { vowel } : {}),
    coda,
  };
}

function normalizeKoResults(board) {
  if (!Array.isArray(board.koResults)) return board.koResults;

  return board.koResults.map((guessResults, guessIdx) => {
    if (!Array.isArray(guessResults)) return guessResults;

    return guessResults.map((syllableResult, syllIdx) => {
      if (!syllableResult || typeof syllableResult !== 'object') return syllableResult;
      const guessSyllable = board.guesses?.[guessIdx]?.[syllIdx] || '';

      return {
        ...syllableResult,
        jamoHints: syllableResult.jamoHints ? normalizeJamoHint(syllableResult.jamoHints, guessSyllable) : null,
      };
    });
  });
}

function normalizeRestoredGameState(state, language = currentLanguage) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.boards) || state.boards.length !== 4) {
    return null;
  }

  const languageConfig = getLanguageConfig(language);
  const boards = state.boards.map((board) => {
    if (!board || typeof board.targetWord !== 'string' || !Array.isArray(board.guesses) || !Array.isArray(board.results)) {
      return null;
    }
    return {
      ...board,
      guesses: board.guesses,
      results: board.results,
      koResults: language === 'ko' ? normalizeKoResults(board) : board.koResults,
      solved: Boolean(board.solved),
      solvedOnGuess: Number.isInteger(board.solvedOnGuess) ? board.solvedOnGuess : null,
    };
  });

  if (boards.some((board) => board === null)) {
    return null;
  }

  let currentGuess = typeof state.currentGuess === 'string' ? state.currentGuess : '';
  if (language === 'ko') {
    currentGuess = currentGuess.replace(languageConfig.filterCharRegex, '').slice(0, languageConfig.wordLength);
  } else {
    currentGuess = currentGuess.toLowerCase().replace(languageConfig.filterCharRegex, '').slice(0, languageConfig.wordLength);
  }

  const maxGuesses = Number.isFinite(state.maxGuesses) ? state.maxGuesses : languageConfig.maxGuesses;
  const guessCount = Number.isFinite(state.guessCount) ? state.guessCount : 0;
  const allSolved = boards.every((board) => board.solved);

  return {
    ...state,
    boards,
    currentGuess,
    maxGuesses,
    guessCount,
    gameOver: allSolved || guessCount >= maxGuesses,
    won: allSolved,
    language,
  };
}

function readSavedPayload(mode, language = currentLanguage) {
  try {
    const raw = localStorage.getItem(getStorageKeyForMode(mode, language));
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.gameState) {
      return null;
    }

    const payloadLanguage = parsed.language || parsed.gameState?.language || language;
    if (payloadLanguage !== language) {
      return null;
    }

    if (mode === "daily" && parsed.dateKey !== getTodayDateKey()) {
      return null;
    }

    const normalizedState = normalizeRestoredGameState(parsed.gameState, language);
    if (!normalizedState) {
      return null;
    }

    return {
      ...parsed,
      gameMode: mode,
      language,
      gameState: normalizedState,
      lastActiveAt: getSavedStateTimestamp(parsed),
      savedAt: Number.isFinite(Number(parsed.savedAt)) ? Number(parsed.savedAt) : Date.now(),
    };
  } catch (e) {
    console.warn(`Failed to load ${mode} game state:`, e);
    return null;
  }
}

function hasSavedPayloadExpired(payload) {
  return Date.now() - getSavedStateTimestamp(payload) >= SESSION_TIMEOUT_MS;
}

function setUiScreenFromGameState() {
  uiScreen = gameState?.gameOver ? "results" : "game";
}

function saveGameState({ overrideState = gameState, overrideMode = gameMode, overrideLanguage = currentLanguage } = {}) {
  if (!overrideState) return;

  try {
    const key = getStorageKeyForMode(overrideMode, overrideLanguage);
    const payload = {
      gameState: {
        ...overrideState,
        language: overrideLanguage,
      },
      gameMode: overrideMode,
      language: overrideLanguage,
      dateKey: overrideMode === "daily" ? getTodayDateKey() : null,
      lastActiveAt: lastActivityAt,
      savedAt: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (e) {
    console.warn("Failed to save game state:", e);
  }
}

function restoreSavedPayload(payload, { markActive = false } = {}) {
  if (!payload?.gameState) return false;

  currentLanguage = payload.language || currentLanguage;
  localStorage.setItem('quordle_language', currentLanguage);
  gameState = payload.gameState;
  gameMode = payload.gameMode || "daily";
  guessError = null;
  expiredSessionSnapshot = null;
  koreanShiftActive = false;
  imeReset();
  lastActivityAt = markActive ? Date.now() : getSavedStateTimestamp(payload);
  setUiScreenFromGameState();
  return true;
}

function loadGameState() {
  const payload = readSavedPayload("daily");
  if (!payload) {
    return "missing";
  }
  if (hasSavedPayloadExpired(payload)) {
    expiredSessionSnapshot = payload;
    return "expired";
  }
  return restoreSavedPayload(payload, { markActive: true }) ? "restored" : "missing";
}

function loadPracticeState() {
  const payload = readSavedPayload("practice");
  if (!payload) {
    return "missing";
  }
  if (hasSavedPayloadExpired(payload)) {
    expiredSessionSnapshot = payload;
    return "expired";
  }
  return restoreSavedPayload(payload, { markActive: true }) ? "restored" : "missing";
}

function clearGameStorage(language = currentLanguage) {
  try {
    localStorage.removeItem(getStorageKeyDaily(language));
    localStorage.removeItem(getStorageKeyPractice(language));
  } catch (e) {
    console.warn("Failed to clear game storage:", e);
  }
}

function expireCurrentSession() {
  if (!gameState || uiScreen === "expired") {
    return;
  }

  saveGameState();
  expiredSessionSnapshot = readSavedPayload(gameMode, currentLanguage) || {
    gameState: normalizeRestoredGameState(gameState, currentLanguage),
    gameMode,
    language: currentLanguage,
    dateKey: gameMode === "daily" ? getTodayDateKey() : null,
    lastActiveAt: lastActivityAt,
    savedAt: Date.now(),
  };

  guessError = null;
  koreanShiftActive = false;
  imeReset();
  uiScreen = "expired";
  renderApp();
  setupKeyboardListeners();
}

function scheduleInactivityTimeout() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }

  if (!gameState || uiScreen === "expired") {
    return;
  }

  const msRemaining = SESSION_TIMEOUT_MS - (Date.now() - lastActivityAt);
  if (msRemaining <= 0) {
    expireCurrentSession();
    return;
  }

  inactivityTimer = setTimeout(() => {
    inactivityTimer = null;
    expireCurrentSession();
  }, msRemaining);
}

function touchActivity() {
  if (!gameState || uiScreen === "expired") {
    return;
  }

  lastActivityAt = Date.now();
  scheduleInactivityTimeout();
}

function setupActivityTracking() {
  if (activityTrackingBound) return;
  activityTrackingBound = true;

  const markActive = () => {
    if (document.visibilityState === 'hidden' || uiScreen === "expired") {
      return;
    }
    touchActivity();
  };

  window.addEventListener('pointerdown', markActive, { passive: true });
  window.addEventListener('touchstart', markActive, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || uiScreen === "expired") {
      return;
    }
    touchActivity();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !gameState || uiScreen === "expired") {
      return;
    }
    if (Date.now() - lastActivityAt >= SESSION_TIMEOUT_MS) {
      expireCurrentSession();
      return;
    }
    touchActivity();
  });
}

// ========== SERVER-SIDE PERSISTENCE ==========
async function serverJoinGame() {
  if (!discordUserId || !discordRoomId) return null;
  try {
    const dateKey = getTodayDateKey();
    const response = await fetch(`${API_URL}/api/game/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: discordRoomId, userId: discordUserId, dateKey, language: currentLanguage }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.warn("Failed to join game on server:", e);
    return null;
  }
}

async function serverSubmitGuess(guess) {
  if (!discordUserId || !discordRoomId) return null;
  try {
    const dateKey = getTodayDateKey();
    const response = await fetch(`${API_URL}/api/game/guess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: discordRoomId, userId: discordUserId, guess, dateKey, language: currentLanguage }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.warn("Failed to submit guess to server:", e);
    return null;
  }
}

const DISCORD_CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;
console.log('Discord Client ID:', DISCORD_CLIENT_ID ? 'present' : 'MISSING');

if (!DISCORD_CLIENT_ID) {
  console.error('VITE_DISCORD_CLIENT_ID is not set! Check your environment variables.');
}

function hasDiscordActivityContext() {
  const params = new URLSearchParams(window.location.search);
  return params.has('frame_id') && params.has('instance_id') && params.has('platform');
}

let discordSdk = null;

if (DISCORD_CLIENT_ID && hasDiscordActivityContext()) {
  try {
    discordSdk = new DiscordSDK(DISCORD_CLIENT_ID);
  } catch (err) {
    console.error("Discord SDK construction failed:", err);
  }
}

if (discordSdk) {
  setupDiscordSdk()
    .then(() => {
      console.log("Discord SDK is authenticated");
      initQuordleGame();
    })
    .catch((err) => {
      console.error("Discord SDK init failed:", err);
      // Dev mode fallback - use localStorage-persisted random IDs
      setupDevMode();
      initQuordleGame();
    });
} else {
  setupDevMode();
  initQuordleGame();
}

function setupDevMode() {
  console.log("Running in dev mode (no Discord SDK)");

  // Generate or retrieve persistent dev user ID
  let devUserId = localStorage.getItem('dev_user_id');
  if (!devUserId) {
    devUserId = 'dev-' + crypto.randomUUID().slice(0, 8);
    localStorage.setItem('dev_user_id', devUserId);
  }
  discordUserId = devUserId;

  // Use a fixed dev room or allow override via URL param
  const urlParams = new URLSearchParams(window.location.search);
  discordRoomId = urlParams.get('room') || 'dev-room';

  // Set dev mode profile
  userProfile = {
    displayName: 'Dev Player',
    avatarUrl: null
  };

  console.log(`Dev mode: userId=${discordUserId}, roomId=${discordRoomId}`);
}

async function setupDiscordSdk() {
  if (!discordSdk) {
    throw new Error("Discord SDK is unavailable outside the Discord activity iframe");
  }

  await discordSdk.ready();
  console.log("Discord SDK is ready");

  // Authorize with Discord Client
  const { code } = await discordSdk.commands.authorize({
    client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: [
      "identify",
      "guilds",
      "applications.commands"
    ],
  });

  // Retrieve an access_token from your activity's server
  const response = await fetch(`${API_URL}/api/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
    }),
  });
  const { access_token } = await response.json();

  // Authenticate with Discord client (using the access_token)
  auth = await discordSdk.commands.authenticate({
    access_token,
  });

  if (auth == null) {
    throw new Error("Authenticate command failed");
  }

  // Capture Discord context for server-side persistence
  discordUserId = auth.user?.id || null;
  discordGuildId = discordSdk.guildId || null;
  discordChannelId = discordSdk.channelId || null;
  // Use channelId as roomId (stable across activity restarts for state persistence)
  // instanceId changes per activity session, so using channelId ensures:
  // - Game state persists when player closes and reopens the activity
  // - Leaderboard shows all players who played in the same channel
  discordRoomId = discordSdk.channelId || discordSdk.instanceId || null;

  // Notify server when user leaves the activity
  setupLeaveNotification();
}

// ========== ACTIVITY LEAVE NOTIFICATION ==========
function setupLeaveNotification() {
  if (!discordUserId || !discordGuildId || !discordChannelId) {
    console.log('Leave notification not set up - missing Discord context');
    return;
  }

  const sendLeaveNotification = () => {
    // Use sendBeacon for reliability during page unload
    const payload = JSON.stringify({
      userId: discordUserId,
      guildId: discordGuildId,
      channelId: discordChannelId,
      dateKey: getTodayDateKey(),
      profile: userProfile,
      gameState: gameState ? {
        guessCount: gameState.guessCount,
        solvedCount: gameState.boards?.filter(b => b.solved).length || 0,
        gameOver: gameState.gameOver,
        won: gameState.won,
      } : null,
    });

    // sendBeacon is more reliable during unload than fetch
    navigator.sendBeacon(`${API_URL}/api/activity/leave`, payload);
    console.log('Sent leave notification');
  };

  // Handle page unload (closing activity)
  window.addEventListener('beforeunload', sendLeaveNotification);

  // Also handle visibility change (activity going to background on mobile)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      sendLeaveNotification();
    }
  });
}

// ========== QUORDLE GAME UI ==========

function getTodayDateKey() {
  // Use America/Chicago timezone for consistent daily reset across all users
  const now = new Date();
  const chicagoTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const year = chicagoTime.getFullYear();
  const month = String(chicagoTime.getMonth() + 1).padStart(2, '0');
  const day = String(chicagoTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`; // "YYYY-MM-DD" in America/Chicago
}

function startNewDailyGame() {
  gameMode = "daily";
  uiScreen = "game";
  leaderboardModalOpen = false;
  resetBoardScrollPosition();
  resetBoardUiState();
  initialStateApplied = false;
  expiredSessionSnapshot = null;
  koreanShiftActive = false;
  imeReset();
  const dateKey = getTodayDateKey();
  const targetWords = getDailyTargets(dateKey, currentLanguage);
  gameState = createGame({ targetWords, language: currentLanguage });
  guessError = null;
  lastActivityAt = Date.now();
  saveGameState();
  renderApp();
  setupKeyboardListeners();

  if (discordUserId && discordRoomId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    } else {
      joinCurrentDailyRoom();
    }
  }
}

function startNewPracticeGame() {
  gameMode = "practice";
  uiScreen = "game";
  leaderboardModalOpen = false;
  resetBoardScrollPosition();
  resetBoardUiState();
  initialStateApplied = false;
  expiredSessionSnapshot = null;
  koreanShiftActive = false;
  imeReset();
  const targetWords = currentLanguage === 'ko'
    ? getQuordleWordsForLanguage('ko')
    : getQuordleWords();
  gameState = createGame({ targetWords, language: currentLanguage });
  guessError = null;
  lastActivityAt = Date.now();
  saveGameState();
  renderApp();
  setupKeyboardListeners();
}

function resumeExpiredSession() {
  if (!expiredSessionSnapshot) return;
  if (!restoreSavedPayload(expiredSessionSnapshot, { markActive: true })) {
    expiredSessionSnapshot = null;
    return;
  }

  saveGameState();
  renderApp();
  setupKeyboardListeners();

  if (gameMode === "daily" && discordUserId && discordRoomId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    } else {
      joinCurrentDailyRoom();
    }
  }
}

function initQuordleGame() {
  setupActivityViewport();
  setupActivityTracking();
  // For daily mode, try server-side persistence first
  initDailyFromServer();
}

async function initDailyFromServer() {
  // Try to get state from server via WebSocket (for daily mode with Discord context)
  if (discordUserId && discordRoomId) {
    // Connect WebSocket - it will send JOIN and receive STATE
    connectWebSocket();

    // Also do REST fallback in case WebSocket takes time
    const serverState = await serverJoinGame();
    // Only apply server state if WS hasn't already delivered it (prevents double init)
    // and if we're still in daily mode (user may have switched to practice while awaiting)
    if (serverState && serverState.gameState && gameMode !== 'practice' && !initialStateApplied) {
      const nextLanguage = serverState.language || currentLanguage;
      const normalizedState = normalizeRestoredGameState(serverState.gameState, nextLanguage);
      if (!normalizedState) {
        console.warn('Ignoring invalid REST state payload from server');
      } else {
        initialStateApplied = true;
        restoreSavedPayload({
          gameState: normalizedState,
          gameMode: serverState.gameMode || "daily",
          language: nextLanguage,
          dateKey: serverState.dateKey || getTodayDateKey(),
          lastActiveAt: Date.now(),
          savedAt: Date.now(),
        }, { markActive: true });
        // Also save to localStorage as backup
        saveGameState();
        renderApp();
        setupKeyboardListeners();
        return;
      }
    }
  }

  // Fallback: try to restore from localStorage
  const dailyLoadState = loadGameState();
  if (dailyLoadState === "restored") {
    saveGameState();
    renderApp();
    setupKeyboardListeners();
    return;
  }
  if (dailyLoadState === "expired") {
    uiScreen = "expired";
    renderApp();
    setupKeyboardListeners();
    return;
  }

  const practiceLoadState = loadPracticeState();
  if (practiceLoadState === "restored") {
    saveGameState();
    renderApp();
    setupKeyboardListeners();
    return;
  }
  if (practiceLoadState === "expired") {
    uiScreen = "expired";
    renderApp();
    setupKeyboardListeners();
    return;
  }

  // No valid save, start fresh daily
  startNewDailyGame();
}

function renderApp() {
  const currentBoardRegion = document.querySelector('.game-scroll-region');
  if (currentBoardRegion) {
    boardScrollTop = currentBoardRegion.scrollTop;
  }

  if (uiScreen === "expired") {
    renderExpiredScreen();
  } else if (uiScreen === "results") {
    renderResultsScreen();
  } else {
    renderGameScreen();
  }
  scheduleActivityViewportSync();
  scheduleInactivityTimeout();
}

// Keep backward compat alias
const renderGame = renderApp;

function getCurrentGuessDisplayText() {
  const lang = currentLanguage;
  const display = lang === 'ko'
    ? `${gameState.currentGuess}${compositionDisplayChar()}`
    : gameState.currentGuess.toUpperCase();
  return display || '-';
}

function renderResultsLinkButton() {
  return `
    <button class="results-link-btn" type="button" aria-label="View results" title="View results">
      <span class="results-link-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false">
          <rect x="2" y="13" width="12" height="1" rx="0.5" fill="currentColor"></rect>
          <rect x="3" y="8" width="2.25" height="4.5" rx="1" fill="currentColor"></rect>
          <rect x="6.875" y="5.5" width="2.25" height="7" rx="1" fill="currentColor"></rect>
          <rect x="10.75" y="2.5" width="2.25" height="10" rx="1" fill="currentColor"></rect>
        </svg>
      </span>
      <span class="results-link-label">Results</span>
    </button>
  `;
}

function renderLeaderboardButton() {
  return `
    <button
      class="leaderboard-trigger"
      type="button"
      aria-haspopup="dialog"
      aria-expanded="${leaderboardModalOpen}"
      aria-controls="leaderboard-modal"
    >
      <span class="leaderboard-trigger-icon" aria-hidden="true">&#127942;</span>
      <span class="leaderboard-trigger-label">Scores</span>
    </button>
  `;
}

function renderLeaderboardModal() {
  if (!leaderboardModalOpen) return '';

  return `
    <div class="leaderboard-modal-backdrop">
      <section
        class="leaderboard-modal"
        id="leaderboard-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leaderboard-modal-title"
      >
        <div class="leaderboard-modal-header">
          <h2 class="leaderboard-modal-title" id="leaderboard-modal-title">Leaderboards</h2>
          <button class="leaderboard-modal-close" type="button" aria-label="Close leaderboards">&times;</button>
        </div>
        <div class="leaderboard-modal-content" id="leaderboard-panel">
          ${renderLeaderboardContent()}
        </div>
      </section>
    </div>
  `;
}

function openLeaderboardModal() {
  if (leaderboardModalOpen) return;
  leaderboardModalOpen = true;
  renderApp();
  setupKeyboardListeners();
  requestAnimationFrame(() => document.querySelector('.leaderboard-modal-close')?.focus());
}

function closeLeaderboardModal() {
  if (!leaderboardModalOpen) return;
  leaderboardModalOpen = false;
  renderApp();
  setupKeyboardListeners();
  requestAnimationFrame(() => document.querySelector('.leaderboard-trigger')?.focus());
}

function renderGameScreen() {
  const app = document.querySelector('#app');
  syncBoardUiState();
  const solvedCount = gameState.boards.filter(b => b.solved).length;
  const lang = currentLanguage;
  const currentGuessDisplay = getCurrentGuessDisplayText();
  const selectionAnnouncement = pendingBoardSelectionAnnouncement;
  pendingBoardSelectionAnnouncement = '';
  const errorHtml = `
    <div class="guess-error-slot" aria-live="polite" aria-atomic="true">
      ${guessError ? `<div class="guess-error">${guessError}</div>` : ''}
    </div>
  `;

  // Single compact status row for both active and finished games.
  const statusHtml = gameState.gameOver
    ? `<div class="game-status-wrap">
        <div class="game-status game-status-done">
          <div class="game-status-main">
            <span class="game-status-badge ${gameState.won ? 'game-status-badge-won' : 'game-status-badge-lost'}">${gameState.won ? 'Won' : 'Lost'}</span>
          </div>
          ${renderResultsLinkButton()}
        </div>
      </div>`
    : `<div class="game-status-wrap">
        <div class="game-status game-status-live">
          <div class="game-status-main">
            <span class="game-status-label">Current</span>
            <span class="guess-text">${currentGuessDisplay}</span>
          </div>
        </div>
        ${errorHtml}
      </div>`;

  // Language toggle
  const langToggle = `
    <div class="lang-toggle">
      <button class="lang-btn ${lang === 'en' ? 'lang-btn-active' : ''}" data-lang="en">🇺🇸 EN</button>
      <button class="lang-btn ${lang === 'ko' ? 'lang-btn-active' : ''}" data-lang="ko">🇰🇷 KO</button>
    </div>
  `;
  const headerStats = `
    <div class="game-header-stats" aria-label="Game progress">
      <span class="game-header-stat" aria-label="${solvedCount} of 4 boards solved">
        <strong>${solvedCount}/4</strong><span class="game-header-stat-label">Solved</span>
      </span>
      <span class="game-header-stat" aria-label="${gameState.guessCount} of ${gameState.maxGuesses} guesses used">
        <strong>${gameState.guessCount}/${gameState.maxGuesses}</strong><span class="game-header-stat-label">Guesses</span>
      </span>
    </div>
  `;

  app.innerHTML = `
    <div class="quordle-container ${lang === 'ko' ? 'lang-ko' : 'lang-en'}">
      <div class="game-header">
        <h1 class="game-title">Quordle${gameMode === 'practice' ? ' <span class="mode-badge">Practice</span>' : ''}</h1>
        <div class="game-header-actions">
          ${langToggle}
          ${headerStats}
          ${renderLeaderboardButton()}
        </div>
      </div>

      <main class="boards-grid game-scroll-region" aria-label="Quordle boards">
        ${renderBoardRegion()}
      </main>

      <div class="sr-only" aria-live="polite" aria-atomic="true">${selectionAnnouncement}</div>

      <section class="game-input-dock" aria-label="Guess controls">
        ${statusHtml}
        ${currentLanguage === 'ko' ? renderKoreanKeyboard() : renderKeyboard()}
      </section>

      ${renderLeaderboardModal()}
    </div>
  `;

  const boardRegion = app.querySelector('.game-scroll-region');
  if (boardRegion) {
    boardRegion.scrollTop = boardScrollTop;
  }
}

function renderResultsScreen() {
  const app = document.querySelector('#app');
  const solvedCount = gameState.boards.filter(b => b.solved).length;
  const icon = gameState.won ? 'Solved' : 'Finished';
  const message = gameState.won ? 'You Won!' : 'Game Over';
  const bannerClass = gameState.won ? 'results-won' : 'results-lost';
  const lang = currentLanguage;

  // Language toggle
  const langToggle = `
    <div class="lang-toggle">
      <button class="lang-btn ${lang === 'en' ? 'lang-btn-active' : ''}" data-lang="en">🇺🇸 EN</button>
      <button class="lang-btn ${lang === 'ko' ? 'lang-btn-active' : ''}" data-lang="ko">🇰🇷 KO</button>
    </div>
  `;

  // Answers reveal (always show on results)
  const answersHtml = `
    <div class="answers-reveal">
      <div class="answers-title">${lang === 'ko' ? '정답' : 'Answers'}</div>
      <div class="answers-list">
        ${gameState.boards.map((board, i) => `
          <div class="answer-item ${board.solved ? 'answer-solved' : 'answer-missed'}">
            <span class="answer-number">#${i + 1}</span>
            <span class="answer-word">${lang === 'ko' ? board.targetWord : board.targetWord.toUpperCase()}</span>
            ${board.solved ? '<span class="answer-status">✓</span>' : '<span class="answer-status">✗</span>'}
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // CTA buttons
  const practiceBtn = `<button class="results-btn results-btn-primary practice-btn">Play Practice Round</button>`;
  const backBtn = `<button class="results-btn results-btn-secondary back-to-puzzle-btn">← Back to Puzzle</button>`;
  const newPracticeBtn = gameMode === 'practice'
    ? `<button class="results-btn results-btn-primary new-game-btn">New Practice Round</button>`
    : '';

  app.innerHTML = `
    <div class="quordle-container ${lang === 'ko' ? 'lang-ko' : 'lang-en'}">
      <div class="game-header">
        <h1 class="game-title">Quordle${gameMode === 'practice' ? ' <span class="mode-badge">Practice</span>' : ''}</h1>
        <div class="game-header-actions">
          ${langToggle}
          ${renderLeaderboardButton()}
        </div>
      </div>
      
      <div class="results-screen">
        <div class="results-card ${bannerClass}">
          <div class="results-icon">${icon}</div>
          <div class="results-message">${message}</div>
          <div class="results-stats">
            <div class="results-stat">
              <span class="results-stat-value">${solvedCount}</span>
              <span class="results-stat-label">of 4 solved</span>
            </div>
            <div class="results-stat">
              <span class="results-stat-value">${gameState.guessCount}</span>
              <span class="results-stat-label">guesses</span>
            </div>
          </div>
          ${answersHtml}
        </div>
        
        <div class="results-actions">
          ${backBtn}
          ${gameMode === 'daily' ? practiceBtn : newPracticeBtn}
        </div>

        ${gameMode === 'daily' ? `<div class="results-footer">${lang === 'ko' ? '내일 다시 도전하세요!' : 'Come back tomorrow for the next Daily'}</div>` : ''}
      </div>
      
      ${renderLeaderboardModal()}
    </div>
  `;
}

function renderExpiredScreen() {
  const app = document.querySelector('#app');
  const snapshot = expiredSessionSnapshot;
  const snapshotState = snapshot?.gameState;
  const solvedCount = snapshotState?.boards?.filter((board) => board.solved).length || 0;
  const guessCount = snapshotState?.guessCount || 0;
  const maxGuesses = snapshotState?.maxGuesses || getLanguageConfig(currentLanguage).maxGuesses;
  const sessionLabel = snapshot?.gameMode === 'practice' ? 'Practice Session Expired' : 'Daily Session Expired';
  const resumeButton = snapshot
    ? `<button class="results-btn results-btn-primary resume-session-btn">Resume Saved Game</button>`
    : '';

  app.innerHTML = `
    <div class="quordle-container ${currentLanguage === 'ko' ? 'lang-ko' : 'lang-en'}">
      <div class="game-header">
        <h1 class="game-title">Quordle</h1>
        <div class="game-header-actions">
          ${renderLeaderboardButton()}
        </div>
      </div>

      <div class="results-screen">
        <div class="results-card session-expired-card">
          <div class="results-icon">${sessionLabel}</div>
          <div class="results-message">Inactive for 45 minutes</div>
          <div class="results-footer">Your latest board was saved before the session expired.</div>
          <div class="results-stats">
            <div class="results-stat">
              <span class="results-stat-value">${solvedCount}</span>
              <span class="results-stat-label">of 4 solved</span>
            </div>
            <div class="results-stat">
              <span class="results-stat-value">${guessCount}/${maxGuesses}</span>
              <span class="results-stat-label">guesses</span>
            </div>
          </div>
        </div>

        <div class="results-actions">
          ${resumeButton}
          <button class="results-btn results-btn-secondary start-daily-btn">Start Daily</button>
          <button class="results-btn results-btn-secondary start-practice-btn">Start Practice</button>
        </div>
      </div>

      ${renderLeaderboardModal()}
    </div>
  `;
}

function renderLeaderboard() {
  const panel = document.getElementById('leaderboard-panel');
  if (panel) {
    panel.innerHTML = renderLeaderboardContent();
  }
}

/** Fetch the other language's leaderboard via REST API */
function fetchOtherLanguageLeaderboard() {
  if (!discordRoomId) return;
  const dateKey = getTodayDateKey();
  const otherLang = currentLanguage === 'ko' ? 'en' : 'ko';
  const url = `${API_URL}/api/room/${discordRoomId}/${dateKey}/leaderboard?language=${otherLang}`;
  fetch(url)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (data && data.leaderboard) {
        if (otherLang === 'ko') {
          leaderboardKo = data.leaderboard;
        } else {
          leaderboardEn = data.leaderboard;
        }
        renderLeaderboard();
      }
    })
    .catch(err => console.warn('Failed to fetch other language leaderboard:', err));
}

function renderLeaderboardEntries(leaderboard) {
  return leaderboard.map((entry, i) => {
    const isYou = entry.visibleUserId === discordUserId;
    const statusLabel = entry.gameOver ? (entry.won ? 'Won' : 'Lost') : 'Playing';
    const statusClass = entry.gameOver
      ? (entry.won ? 'leaderboard-status-won' : 'leaderboard-status-lost')
      : 'leaderboard-status-live';
    const youBadge = isYou ? ' <span class="you-badge">(You)</span>' : '';

    // Get display name and avatar from profile, with fallback to visibleUserId
    const profile = entry.profile || {};
    const displayName = profile.displayName || entry.visibleUserId.slice(0, 8);
    const avatarUrl = profile.avatarUrl;
    const avatarHtml = avatarUrl
      ? `<img src="${avatarUrl}" alt="${displayName}" class="leaderboard-avatar" onerror="this.style.display='none'" />`
      : `<div class="leaderboard-avatar-placeholder"></div>`;

    return `
      <div class="leaderboard-entry ${isYou ? 'leaderboard-entry-you' : ''} ${entry.gameOver ? 'leaderboard-entry-done' : ''}">
        <span class="leaderboard-rank">#${i + 1}</span>
        <span class="leaderboard-status ${statusClass}" title="${statusLabel}" aria-label="${statusLabel}"></span>
        <div class="leaderboard-profile">
          ${avatarHtml}
          <span class="leaderboard-name">${displayName}${youBadge}</span>
        </div>
        <span class="leaderboard-score">${entry.solvedCount}/4</span>
        <span class="leaderboard-guesses">${entry.guessCount}g</span>
      </div>
    `;
  }).join('');
}

function renderSingleLeaderboard(title, leaderboard) {
  if (!leaderboard || leaderboard.length === 0) {
    return `
      <div class="leaderboard">
        <h3 class="leaderboard-title">${title}</h3>
        <div class="leaderboard-empty">No players yet</div>
      </div>
    `;
  }
  return `
    <div class="leaderboard">
      <h3 class="leaderboard-title">${title}</h3>
      ${renderLeaderboardEntries(leaderboard)}
    </div>
  `;
}

function renderLeaderboardContent() {
  const enHtml = renderSingleLeaderboard('English Leaderboard', leaderboardEn);
  const koHtml = renderSingleLeaderboard('Korean Leaderboard', leaderboardKo);

  // Show the current language's leaderboard first
  if (currentLanguage === 'ko') {
    return koHtml + enHtml;
  }
  return enHtml + koHtml;
}

// renderBanner removed — game status is now inline in renderGameScreen,
// full results are in renderResultsScreen

function renderBoardRegion() {
  const { active, solved } = partitionBoards(gameState.boards);
  const solvedHtml = solved.length > 0
    ? `<section class="solved-boards-strip" aria-label="Solved boards">
        ${solved.map(({ board, index }) => renderSolvedBoardCard(board, index)).join('')}
      </section>`
    : '';
  const activeHtml = active.length > 0
    ? `<section class="active-boards-grid" data-active-count="${active.length}" aria-label="Active boards">
        ${active.map(({ board, index }) => renderActiveBoard(board, index)).join('')}
      </section>`
    : '';

  return `<div class="boards-stage">${solvedHtml}${activeHtml}</div>`;
}

function renderSolvedBoardCard(board, index) {
  const expanded = expandedSolvedBoardIndex === index;
  const solvedGuessCount = board.solvedOnGuess ?? board.guesses.length;
  const answer = currentLanguage === 'ko' ? board.targetWord : board.targetWord.toUpperCase();
  const historyId = `solved-board-history-${index}`;
  const rows = [];
  const visibleGuessCount = Math.min(solvedGuessCount, board.guesses.length);
  for (let guessIndex = 0; guessIndex < visibleGuessCount; guessIndex += 1) {
    const koResult = currentLanguage === 'ko' && board.koResults ? board.koResults[guessIndex] : null;
    rows.push(renderRow(board.guesses[guessIndex], board.results[guessIndex], false, true, koResult));
  }
  const historyHtml = `<div class="solved-board-history" id="${historyId}" ${expanded ? '' : 'hidden'}>${rows.join('')}</div>`;

  return `
    <article class="solved-board-card ${expanded ? 'solved-board-card-expanded' : ''}">
      <button
        class="solved-board-toggle"
        type="button"
        data-toggle-solved-board="${index}"
        aria-expanded="${expanded}"
        aria-controls="${historyId}"
        aria-label="${expanded ? 'Collapse' : 'Expand'} solved board ${index + 1}, ${answer}, solved in ${solvedGuessCount} guesses"
      >
        <span class="solved-board-check" aria-hidden="true">✓</span>
        <span class="solved-board-number">#${index + 1}</span>
        <strong class="solved-board-answer">${answer}</strong>
        <span class="solved-board-meta">${solvedGuessCount} ${solvedGuessCount === 1 ? 'guess' : 'guesses'}</span>
        <span class="solved-board-chevron" aria-hidden="true">${expanded ? '▴' : '▾'}</span>
      </button>
      ${historyHtml}
    </article>
  `;
}

function renderActiveBoard(board, index) {
  const rows = [];
  const lang = currentLanguage;
  const wordLen = getLanguageConfig(lang).wordLength;

  for (let i = 0; i < board.guesses.length; i++) {
    const koResult = (lang === 'ko' && board.koResults) ? board.koResults[i] : null;
    rows.push(renderRow(board.guesses[i], board.results[i], false, true, koResult));
  }

  if (!gameState.gameOver && board.guesses.length < gameState.maxGuesses) {
    const displayGuess = lang === 'ko'
      ? (gameState.currentGuess + compositionDisplayChar()).padEnd(wordLen, ' ')
      : gameState.currentGuess.padEnd(wordLen, ' ');
    rows.push(renderRow(displayGuess, null, true, false, null));
  }

  const remainingGuesses = getRemainingGuessCount(gameState.maxGuesses, gameState.guessCount);
  const remainingHtml = !gameState.gameOver && remainingGuesses > 0
    ? `<div class="board-remaining" aria-label="${remainingGuesses} guesses remaining">
        <span class="board-remaining-mark" aria-hidden="true"></span>
        <span>${remainingGuesses} ${remainingGuesses === 1 ? 'guess' : 'guesses'} remaining</span>
      </div>`
    : '';
  const selected = selectedBoardIndex === index;
  const headerId = `board-header-${index}`;

  return `
    <section class="board board-active ${selected ? 'board-selected' : ''}" aria-labelledby="${headerId}">
      <button
        class="board-select-button"
        id="${headerId}"
        type="button"
        data-select-board="${index}"
        aria-pressed="${selected}"
        aria-label="Select board ${index + 1}${selected ? ', currently selected' : ''}"
      >
        <span>#${index + 1}</span>
        <span class="board-selected-indicator">${selected ? 'Selected' : 'Select'}</span>
      </button>
      ${rows.join('')}
      ${remainingHtml}
    </section>
  `;
}

function renderRow(guess, result, isCurrent = false, isCondensed = false, koResult = null) {
  const lang = currentLanguage;
  const wordLen = getLanguageConfig(lang).wordLength;
  const chars = lang === 'ko' ? Array.from(guess.padEnd(wordLen, ' ')) : guess.padEnd(wordLen, ' ').split('');

  const tiles = chars.map((ch, i) => {
    let tileClass = 'tile';
    if (result) {
      tileClass += ` tile-${result[i]}`;
    } else if (isCurrent && ch.trim()) {
      tileClass += ' tile-filled';
    }

    const display = lang === 'ko' ? ch.trim() : ch.trim().toUpperCase();

    let jamoHintHtml = '';
    if (lang === 'ko' && koResult && koResult[i] && koResult[i].jamoHints && result && result[i] !== 'correct') {
      const hint = normalizeJamoHint(koResult[i].jamoHints, ch);
      const units = hint?.units || [];
      if (units.length > 0) {
        tileClass += ' tile-with-jamo';
        jamoHintHtml = `
          <div class="jamo-hints" data-unit-count="${units.length}">
            ${units.map((unit) => `<span class="jamo-dot jamo-dot-${unit.status}" title="${unit.slot}: ${unit.jamo}"></span>`).join('')}
          </div>
        `;
      }
    }

    return `<div class="${tileClass}">${display}${jamoHintHtml}</div>`;
  }).join('');

  const rowClass = isCondensed ? 'row row-condensed' : 'row';
  return `<div class="${rowClass}">${tiles}</div>`;
}

function renderBoardGrid(boardStatuses, key) {
  const entry = boardStatuses[key];
  if (!entry || entry.every(s => s === null)) return '';
  const dotClass = (status) => status ? `kbd-${status}` : '';
  return `<span class="key-board-grid">${entry.map((s, i) => `<span class="kbd-dot ${dotClass(s)}" data-board="${i}"></span>`).join('')
    }</span>`;
}

function renderKeyboard() {
  const rows = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    [KEY_ENTER, 'Z', 'X', 'C', 'V', 'B', 'N', 'M', KEY_BACKSPACE]
  ];

  const boardStatuses = computeKeyboardBoardMap(gameState);

  return `
    <div class="keyboard">
      ${rows.map(row => `
        <div class="keyboard-row">
          ${row.map(key => {
    const isSpecial = key === KEY_ENTER || key === KEY_BACKSPACE;
    const lowerKey = isSpecial ? null : key.toLowerCase();
    const widthClass = isSpecial ? 'key-wide' : '';
    const grid = lowerKey ? renderBoardGrid(boardStatuses, lowerKey) : '';
    const label = key === KEY_BACKSPACE ? '⌫' : key;
    return `<button class="key ${widthClass}" data-key="${key}">${grid}<span class="key-label">${label}</span></button>`;
  }).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

// ========== KOREAN KEYBOARD (두벌식) ==========
function renderKoreanKeyboard() {
  const rows = [
    ['ㅂ', 'ㅈ', 'ㄷ', 'ㄱ', 'ㅅ', 'ㅛ', 'ㅕ', 'ㅑ', 'ㅐ', 'ㅔ'],
    ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
    [KEY_ENTER, 'ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ', KEY_BACKSPACE],
  ];

  const boardStatuses = computeKeyboardBoardMap(gameState);

  return `
    <div class="keyboard keyboard-ko">
      ${rows.map(row => `
        <div class="keyboard-row">
          ${row.map(key => {
    const renderedKey = koreanShiftActive && KOREAN_SHIFT_MAP[key] ? KOREAN_SHIFT_MAP[key] : key;
    const isSpecial = renderedKey === KEY_ENTER || renderedKey === KEY_BACKSPACE;
    const widthClass = isSpecial ? 'key-wide' : '';
    const grid = !isSpecial ? renderBoardGrid(boardStatuses, renderedKey) : '';
    const label = renderedKey === KEY_BACKSPACE ? '⌫' : renderedKey;
    return `<button class="key ${widthClass}" data-key="${renderedKey}">${grid}<span class="key-label">${label}</span></button>`;
  }).join('')}
        </div>
      `).join('')}
      <div class="ko-shift-row">
        <button class="key key-wide key-shift ${koreanShiftActive ? 'active' : ''}" data-key="${KEY_SHIFT}">
          <span class="key-label">Shift</span>
        </button>
      </div>
    </div>
  `;
}

// ========== HANGUL IME COMPOSITION ENGINE ==========
// State machine for composing Korean syllables from jamo input.
// Composition phases:
//   0: empty
//   1: onset only (ㄱ displayed as standalone jamo)
//   2: onset + vowel → composed syllable (가)
//   3: onset + vowel + coda → composed syllable with coda (간)
//   4: onset + vowel + compound coda → composed syllable with compound coda (갈ㅂ→값)

let imeState = createKoImeState();

function imeReset() {
  imeState = createKoImeState();
}

/** Get the currently composing character for display (partial syllable or jamo) */
function compositionDisplayChar() {
  return getKoImeDisplayChar(imeState);
}

/** Finalize the current composition: append the composed syllable to currentGuess */
function imeFinalize() {
  const result = finalizeKoIme(imeState);
  imeState = result.state;
  return result.committed;
}

/**
 * Process a jamo keypress through the IME.
 * Returns { committed: string, display: string } where:
 *   - committed: fully composed syllable(s) to append to gameState.currentGuess
 *   - display: the current in-progress composition character (for display only)
 */
function imeProcessJamoLegacy(jamo) {
  const wordLen = getLanguageConfig('ko').wordLength;
  const currentLen = gameState.currentGuess.length;

  if (isConsonant(jamo)) {
    if (!imeState.onset && !imeState.vowel) {
      // Phase 0 → 1: Start with onset
      imeState.onset = jamo;
      return { committed: '', display: jamo };
    }
    if (imeState.onset && !imeState.vowel) {
      // Phase 1: Already have onset, new consonant replaces it
      // (or if doubles entry like ㄱ→ㄲ, handled by shift key sending ㄲ directly)
      const fin = imeState.onset;
      imeReset();
      imeState.onset = jamo;
      // If we're at word limit, don't commit the previous standalone onset
      if (currentLen >= wordLen) {
        imeReset();
        return { committed: '', display: '' };
      }
      return { committed: fin, display: jamo };
    }
    if (imeState.onset && imeState.vowel && !imeState.coda) {
      // Phase 2 → 3: Add coda
      if (canBeCoda(jamo)) {
        imeState.coda = jamo;
        return { committed: '', display: compositionDisplayChar() };
      } else {
        // Not a valid coda — finalize current, start new onset
        const committed = imeFinalize();
        imeState.onset = jamo;
        return { committed, display: jamo };
      }
    }
    if (imeState.onset && imeState.vowel && imeState.coda) {
      // Phase 3 → try compound coda, or finalize + new onset
      const compound = combineCodas(imeState.coda, jamo);
      if (compound && canBeCoda(compound)) {
        imeState.coda = compound;
        return { committed: '', display: compositionDisplayChar() };
      }
      // Can't combine — finalize current syllable, start new one
      const committed = imeFinalize();
      imeState.onset = jamo;
      return { committed, display: jamo };
    }
  }

  if (isVowel(jamo)) {
    if (!imeState.onset && !imeState.vowel) {
      // Phase 0: vowel without onset — Korean syllables need onset, use ㅇ (silent)
      imeState.onset = 'ㅇ';
      imeState.vowel = jamo;
      return { committed: '', display: compositionDisplayChar() };
    }
    if (imeState.onset && !imeState.vowel) {
      // Phase 1 → 2: onset + vowel = composed syllable
      imeState.vowel = jamo;
      return { committed: '', display: compositionDisplayChar() };
    }
    if (imeState.onset && imeState.vowel && !imeState.coda) {
      // Phase 2: Already have onset+vowel, new vowel — try compound vowel first
      const combined = combineVowels(imeState.vowel, jamo);
      if (combined) {
        imeState.vowel = combined;
        return { committed: '', display: compositionDisplayChar() };
      }
      // Can't combine — finalize and start new
      const committed = imeFinalize();
      imeState.onset = 'ㅇ';
      imeState.vowel = jamo;
      return { committed, display: compositionDisplayChar() };
    }
    if (imeState.onset && imeState.vowel && imeState.coda) {
      // Phase 3: onset+vowel+coda, new vowel → coda becomes next onset
      // Check for compound coda split first
      const split = splitCompoundCoda(imeState.coda);
      let nextOnset;
      if (split) {
        // Compound coda: first part stays, second becomes next onset
        imeState.coda = split[0];
        nextOnset = split[1];
      } else {
        // Simple coda moves to become next onset
        nextOnset = imeState.coda;
        imeState.coda = null;
      }
      const committed = imeFinalize();
      imeState.onset = canBeOnset(nextOnset) ? nextOnset : 'ㅇ';
      imeState.vowel = jamo;
      return { committed, display: compositionDisplayChar() };
    }
  }

  return { committed: '', display: '' };
}

/** Handle backspace in Korean IME mode */
function imeBackspaceLegacy() {
  if (imeState.coda) {
    // Remove coda (or shrink compound coda)
    const split = splitCompoundCoda(imeState.coda);
    if (split) {
      imeState.coda = split[0]; // Keep first part of compound
    } else {
      imeState.coda = null;
    }
    return { modified: true, display: compositionDisplayChar() };
  }
  if (imeState.vowel) {
    // Check if vowel is compound — split it instead of removing entirely
    const vSplit = splitCompoundVowel(imeState.vowel);
    if (vSplit) {
      imeState.vowel = vSplit[0];
      return { modified: true, display: compositionDisplayChar() };
    }
    imeState.vowel = null;
    return { modified: true, display: imeState.onset || '' };
  }
  if (imeState.onset) {
    imeState.onset = null;
    return { modified: true, display: '' };
  }
  return { modified: false, display: '' };
}

function imeProcessJamo(jamo) {
  const result = processKoImeJamo(imeState, jamo);
  imeState = result.state;
  return { committed: result.committed, display: result.display };
}

function imeBackspace() {
  const result = backspaceKoIme(imeState);
  imeState = result.state;
  return { modified: result.modified, display: result.display };
}

function handleKeyPress(key) {
  if (!gameState || gameState.gameOver || uiScreen === "expired" || leaderboardModalOpen) return;

  const lang = currentLanguage;
  const wordLen = getLanguageConfig(lang).wordLength;

  if (lang === 'ko') {
    // ===== Korean mode =====
    if (key === KEY_SHIFT) {
      koreanShiftActive = !koreanShiftActive;
      guessError = null;
      renderApp();
      setupKeyboardListeners();
      return;
    }

    if (key === KEY_ENTER) {
      koreanShiftActive = false;
      // Finalize any IME composition first
      const finalChar = imeFinalize();
      if (finalChar) {
        gameState = setCurrentGuess(gameState, gameState.currentGuess + finalChar);
      }
      if (gameState.currentGuess.length === wordLen) {
        if (!isValidGuessForLanguage(gameState.currentGuess, 'ko')) {
          guessError = '단어 목록에 없습니다';
          renderApp();
          setupKeyboardListeners();
          return;
        }
        const validation = validateGuess(gameState.currentGuess, 'ko');
        if (validation.valid) {
          guessError = null;
          submitGuessWithPersistence(gameState.currentGuess);
        }
      }
    } else if (key === KEY_BACKSPACE) {
      guessError = null;
      const result = imeBackspace();
      if (!result.modified) {
        // IME was empty, remove last committed syllable
        gameState = setCurrentGuess(gameState, gameState.currentGuess.slice(0, -1));
      }
      renderApp();
      setupKeyboardListeners();
    } else if (isConsonant(key) || isVowel(key)) {
      // Check if we'd exceed word length with committed chars
      const { committed } = imeProcessJamo(key);
      if (committed) {
        if (gameState.currentGuess.length < wordLen) {
          gameState = setCurrentGuess(gameState, gameState.currentGuess + committed);
        }
      }
      if (KOREAN_SHIFT_OUTPUTS.has(key)) {
        koreanShiftActive = false;
      }
      guessError = null;
      renderApp();
      setupKeyboardListeners();
    }
  } else {
    // ===== English mode =====
    if (key === KEY_ENTER) {
      if (gameState.currentGuess.length === wordLen) {
        if (!isValidGuess(gameState.currentGuess)) {
          guessError = 'Not in word list';
          renderApp();
          setupKeyboardListeners();
          return;
        }
        const validation = validateGuess(gameState.currentGuess);
        if (validation.valid) {
          guessError = null;
          submitGuessWithPersistence(gameState.currentGuess);
        }
      }
    } else if (key === KEY_BACKSPACE) {
      guessError = null;
      gameState = setCurrentGuess(gameState, gameState.currentGuess.slice(0, -1));
      renderApp();
      setupKeyboardListeners();
    } else if (key.length === 1 && /^[A-Z]$/i.test(key)) {
      if (gameState.currentGuess.length < wordLen) {
        guessError = null;
        gameState = setCurrentGuess(gameState, gameState.currentGuess + key.toLowerCase());
        renderApp();
        setupKeyboardListeners();
      }
    }
  }
}

async function submitGuessWithPersistence(guess) {
  // Immediately clear currentGuess to prevent double-submit.
  // In the WS path, state update is async (server responds with STATE),
  // so without this, a rapid second Enter press would pass the length === 5
  // guard in handleKeyPress and send the same guess again.
  gameState = setCurrentGuess(gameState, '');
  koreanShiftActive = false;
  renderApp();
  setupKeyboardListeners();

  // For daily mode with Discord context, use WebSocket (server-authoritative)
  if (gameMode === "daily" && discordUserId && discordRoomId) {
    // Try WebSocket first (preferred, real-time)
    if (sendGuessViaWebSocket(guess)) {
      // Server will respond with STATE message, which triggers render
      return;
    }

    // Fallback to REST if WebSocket not connected
    const serverState = await serverSubmitGuess(guess);
    if (serverState && serverState.gameState) {
      const nextLanguage = serverState.language || currentLanguage;
      const normalizedState = normalizeRestoredGameState(serverState.gameState, nextLanguage);
      if (!normalizedState) {
        console.warn('Ignoring invalid REST guess payload from server');
        return;
      }

      restoreSavedPayload({
        gameState: normalizedState,
        gameMode: serverState.gameMode || gameMode,
        language: nextLanguage,
        dateKey: serverState.dateKey || getTodayDateKey(),
        lastActiveAt: Date.now(),
        savedAt: Date.now(),
      }, { markActive: true });
      saveGameState(); // Backup to localStorage
      renderApp();
      setupKeyboardListeners();
      return;
    }
  }

  // Fallback: local-only submission (practice mode or no server)
  gameState = submitGuess(gameState, guess);
  setUiScreenFromGameState();
  saveGameState();
  renderApp();
  setupKeyboardListeners();
}

function setupKeyboardListeners() {
  const boardRegion = document.querySelector('.game-scroll-region');
  if (boardRegion) {
    boardRegion.addEventListener('scroll', () => {
      boardScrollTop = boardRegion.scrollTop;
    }, { passive: true });
  }

  document.querySelectorAll('[data-select-board]').forEach((button) => {
    button.addEventListener('click', () => {
      const boardIndex = Number(button.dataset.selectBoard);
      if (!Number.isInteger(boardIndex) || gameState.boards[boardIndex]?.solved) return;
      if (selectedBoardIndex !== boardIndex) {
        selectedBoardIndex = boardIndex;
        pendingBoardSelectionAnnouncement = `Board ${boardIndex + 1} selected`;
      }
      renderApp();
      setupKeyboardListeners();
      requestAnimationFrame(() => document.querySelector(`[data-select-board="${boardIndex}"]`)?.focus());
    });
  });

  document.querySelectorAll('[data-toggle-solved-board]').forEach((button) => {
    button.addEventListener('click', () => {
      const boardIndex = Number(button.dataset.toggleSolvedBoard);
      expandedSolvedBoardIndex = toggleExpandedSolvedBoardIndex(
        gameState.boards,
        expandedSolvedBoardIndex,
        boardIndex,
      );
      renderApp();
      setupKeyboardListeners();
      requestAnimationFrame(() => document.querySelector(`[data-toggle-solved-board="${boardIndex}"]`)?.focus());
    });
  });

  const leaderboardTrigger = document.querySelector('.leaderboard-trigger');
  if (leaderboardTrigger) {
    leaderboardTrigger.addEventListener('click', openLeaderboardModal);
  }

  const leaderboardClose = document.querySelector('.leaderboard-modal-close');
  if (leaderboardClose) {
    leaderboardClose.addEventListener('click', closeLeaderboardModal);
  }

  const leaderboardBackdrop = document.querySelector('.leaderboard-modal-backdrop');
  if (leaderboardBackdrop) {
    leaderboardBackdrop.addEventListener('click', (event) => {
      if (event.target === leaderboardBackdrop) {
        closeLeaderboardModal();
      }
    });
  }

  const leaderboardModal = document.querySelector('.leaderboard-modal');
  if (leaderboardModal) {
    leaderboardModal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLeaderboardModal();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = Array.from(leaderboardModal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  // On-screen keyboard
  document.querySelectorAll('.key').forEach(btn => {
    btn.addEventListener('click', () => {
      handleKeyPress(btn.dataset.key);
    });
  });

  // Language toggle buttons
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newLang = btn.dataset.lang;
      if (newLang && newLang !== currentLanguage) {
        switchLanguage(newLang);
      }
    });
  });

  // Practice button (on results screen)
  const practiceBtn = document.querySelector('.practice-btn');
  if (practiceBtn) {
    practiceBtn.addEventListener('click', () => {
      startNewPracticeGame();
    });
  }

  // New practice game button (after practice game ends)
  const newGameBtn = document.querySelector('.new-game-btn');
  if (newGameBtn) {
    newGameBtn.addEventListener('click', () => {
      startNewPracticeGame();
    });
  }

  // Back to puzzle button (results → game screen with frozen boards)
  const backBtn = document.querySelector('.back-to-puzzle-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      uiScreen = "game";
      renderApp();
      setupKeyboardListeners();
    });
  }

  // View results link on game screen (when game is over)
  const resultsLink = document.querySelector('.results-link-btn');
  if (resultsLink) {
    resultsLink.addEventListener('click', () => {
      uiScreen = "results";
      renderApp();
      setupKeyboardListeners();
    });
  }

  const resumeBtn = document.querySelector('.resume-session-btn');
  if (resumeBtn) {
    resumeBtn.addEventListener('click', () => {
      resumeExpiredSession();
    });
  }

  const startDailyBtn = document.querySelector('.start-daily-btn');
  if (startDailyBtn) {
    startDailyBtn.addEventListener('click', () => {
      startNewDailyGame();
    });
  }

  const startPracticeBtn = document.querySelector('.start-practice-btn');
  if (startPracticeBtn) {
    startPracticeBtn.addEventListener('click', () => {
      startNewPracticeGame();
    });
  }
}

// ========== QWERTY → 두벌식 (Dubeolsik) MAPPING ==========
// Maps physical QWERTY keys to Korean jamo so users can type Korean
// without switching their OS keyboard layout.
const QWERTY_TO_JAMO = {
  // Lowercase (unshifted)
  'q': 'ㅂ', 'w': 'ㅈ', 'e': 'ㄷ', 'r': 'ㄱ', 't': 'ㅅ',
  'y': 'ㅛ', 'u': 'ㅕ', 'i': 'ㅑ', 'o': 'ㅐ', 'p': 'ㅔ',
  'a': 'ㅁ', 's': 'ㄴ', 'd': 'ㅇ', 'f': 'ㄹ', 'g': 'ㅎ',
  'h': 'ㅗ', 'j': 'ㅓ', 'k': 'ㅏ', 'l': 'ㅣ',
  'z': 'ㅋ', 'x': 'ㅌ', 'c': 'ㅊ', 'v': 'ㅍ',
  'b': 'ㅠ', 'n': 'ㅜ', 'm': 'ㅡ',
  // Uppercase (shifted) — double consonants + compound vowels
  'Q': 'ㅃ', 'W': 'ㅉ', 'E': 'ㄸ', 'R': 'ㄲ', 'T': 'ㅆ',
  'O': 'ㅒ', 'P': 'ㅖ',
};

// Physical keyboard listener
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (leaderboardModalOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLeaderboardModal();
    }
    return;
  }

  if (e.key === 'Enter') {
    handleKeyPress(KEY_ENTER);
  } else if (e.key === 'Backspace') {
    handleKeyPress(KEY_BACKSPACE);
  } else if (currentLanguage === 'ko') {
    const ch = e.key;
    // First, try QWERTY → jamo mapping (for users typing on English keyboard)
    const mapped = QWERTY_TO_JAMO[ch];
    if (mapped) {
      e.preventDefault();
      handleKeyPress(mapped);
    }
    // Also accept raw jamo from a physical Korean keyboard / OS IME
    else if (ch.length === 1 && (isConsonant(ch) || isVowel(ch))) {
      e.preventDefault();
      handleKeyPress(ch);
    }
  } else if (/^[a-zA-Z]$/.test(e.key)) {
    handleKeyPress(e.key.toUpperCase());
  }
});

// Start a new practice round (random targets)
function startPracticeGame() {
  startNewPracticeGame();
}
window.startPractice = startPracticeGame; // Keep for backwards compat

// Reset game - clears storage and starts fresh
function resetGame() {
  clearGameStorage();
  startNewDailyGame();
}
window.resetGame = resetGame; // Keep for backwards compat

// Switch language mode
function switchLanguage(newLang) {
  if (newLang === currentLanguage) return;

  // Save current game before switching
  saveGameState();

  // Switch language
  currentLanguage = newLang;
  localStorage.setItem('quordle_language', newLang);
  leaderboardModalOpen = false;
  resetBoardScrollPosition();
  resetBoardUiState();
  expiredSessionSnapshot = null;
  koreanShiftActive = false;
  imeReset();
  guessError = null;

  // Try to load existing game for the new language
  if (gameMode === 'daily') {
    const loadStatus = loadGameState();
    if (loadStatus === "expired") {
      uiScreen = "expired";
    } else if (loadStatus !== "restored") {
      // No saved daily for this language, create new one
      const dateKey = getTodayDateKey();
      const targetWords = getDailyTargets(dateKey, currentLanguage);
      gameState = createGame({ targetWords, language: currentLanguage });
      lastActivityAt = Date.now();
      saveGameState();
      uiScreen = "game";
    }
    if (loadStatus === "restored") {
      setUiScreenFromGameState();
      saveGameState();
    }

    // Re-JOIN via WebSocket so the server creates/loads player state for the new language
    if (loadStatus !== "expired" && ws && ws.readyState === WebSocket.OPEN && discordUserId && discordRoomId) {
      joinCurrentDailyRoom();
    }
  } else {
    // Practice mode — start fresh for new language
    const loadStatus = loadPracticeState();
    if (loadStatus === "expired") {
      uiScreen = "expired";
    } else if (loadStatus === "restored") {
      setUiScreenFromGameState();
      saveGameState();
    } else {
      const targetWords = currentLanguage === 'ko'
        ? getQuordleWordsForLanguage('ko')
        : getQuordleWords();
      gameState = createGame({ targetWords, language: currentLanguage });
      uiScreen = "game";
      lastActivityAt = Date.now();
      saveGameState();
    }
  }

  renderApp();
  setupKeyboardListeners();
}
window.switchLanguage = switchLanguage;
