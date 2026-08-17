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
import { applyValidatedGuess, createGame, setCurrentGuess, validateGuess, computeKeyboardBoardMap } from "../engine/src/game.ts";
import { isValidGuess } from "../engine/src/words.ts";
import { getDailyChinesePinyinRound, getDailyTargets, getPracticeChinesePinyinRound } from "../engine/src/daily.ts";
import { normalizePinyin, parseChinesePinyinInput } from "../engine/src/pinyin.ts";
import { toChineseDictionaryViewModel, toKoreanDictionaryViewModel } from "../engine/src/dictionaryViewModel.ts";
import { getLegacyLanguageConfig, getLegacyQuordleWordsForLanguage, isValidLegacyGuessForLanguage } from "../engine/src/legacyLanguageConfig.ts";
import { canBeCoda, canBeOnset, combineCodas, combineVowels, expandHangulToJamoUnits, isConsonant, isHangulSyllable, isVowel, splitCompoundCoda, splitCompoundVowel } from "../engine/src/jamo.ts";
import { backspaceKoIme, createKoImeState, finalizeKoIme, getKoImeDisplayChar, processKoImeJamo } from "../engine/src/koIme.ts";
import { classifyKoreanGuess, rankNearbyKoreanWords } from "../engine/src/nearbyWords.ts";
import { calculatePerformanceMetrics, HINT_COSTS, normalizeAssistanceState } from "../engine/src/assistance.ts";
import { isHintAvailable, requestHint } from "../engine/src/hints.ts";
import {
  getRemainingGuessCount,
  partitionBoards,
  reconcileExpandedSolvedBoardIndex,
  reconcileSelectedBoardIndex,
  toggleExpandedSolvedBoardIndex,
} from "./src/boardLayout.js";
import {
  escapeHtml,
  getDefaultDictionaryWord,
  getDictionaryEligibleWords,
  getKoreanDictionaryEntry,
  loadKoreanDictionarySnapshot,
  loadKoreanRecognitionSnapshot,
} from "./src/dictionary.js";
import { getSheetDragAction, renderOverlaySheet, trapOverlayFocus } from "./src/overlaySheet.js";
import { formatHintPayload, getBoardHintUse, getHintUiOptions } from "./src/hintUi.js";
import {
  createKoreanFeedback,
  createMessageFeedback,
  getFeedbackSuggestionWords,
  isKoreanDiscoveryRequestCurrent,
  toKoreanNearbySuggestions,
} from "./src/rejectedGuessFeedback.js";
import {
  buildLearningEvent,
  createOneTimeEventTracker,
  createStableLearningEventId,
  createLearningEventQueue,
  getOptimisticSavedWordToggle,
  getSavedWordButtonState,
  getSavedDictionarySupplementalWords,
  getSavedWordsForResults,
  readLocalSavedWords,
  removeLocalSavedWord,
  upsertLocalSavedWord,
} from "./src/learningData.js";
import {
  chineseDictionaryMetadata,
  getLoadedChineseDictionaryEntry,
  getPrimaryChinesePronunciation,
  loadChineseDictionaryEntries,
  loadChinesePinyinGuessKeys,
} from "./src/chineseDictionary.js";
import {
  appendChinesePinyinKey,
  backspaceChineseInput,
  beginChineseSubmission,
  CHINESE_PINYIN_PUZZLE_VARIANT,
  confirmChineseSubmission,
  createChineseInputState,
  getChineseDraftStorageKey,
  getChineseInputValue,
  getChineseSubmissionFailureOptions,
  getClientCompletionId,
  getClientGameStorageKey,
  getClientRoundId,
  isChineseSubmissionConfirmed,
  reconcileChineseSubmissionAgainstState,
  rejectChineseSubmission,
  rejectChineseSubmissionFromAuthoritativeError,
  updateChineseInput,
  withChinesePuzzleVariant,
} from "./src/chineseInput.js";

// Will eventually store the authenticated user's access_token
let auth;
let gameState;
let guessFeedback = null;
let gameMode = "daily"; // "daily" | "practice"
let uiScreen = "game"; // "game" | "results"
const SUPPORTED_LANGUAGES = new Set(['en', 'ko', 'zh']);
const storedLanguage = localStorage.getItem('quordle_language');
let currentLanguage = SUPPORTED_LANGUAGES.has(storedLanguage) ? storedLanguage : 'en';

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
let leaderboardZh = []; // Simplified Chinese room leaderboard
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
let imeState = createKoImeState();
let activityTrackingBound = false;
let activityViewportBound = false;
let viewportSyncFrame = null;
const OVERLAY_LEADERBOARD = 'leaderboard-modal';
const OVERLAY_DICTIONARY = 'dictionary-sheet';
const OVERLAY_HINT = 'hint-sheet';
let activeOverlay = null;
let overlaySize = 'half';
let overlayReturnFocusSelector = null;
let dictionarySnapshot = null;
let dictionaryLoadState = 'idle';
let dictionaryLoadError = null;
let dictionarySelectedWord = null;
let dictionaryEntrySource = 'dictionary';
let koreanRecognitionSnapshot = null;
let koreanNearbyCandidates = null;
let rejectedGuessRequestId = 0;
let chineseInputState = createChineseInputState();
let chineseGuessKeys = null;
let chineseGuessKeysLength = null;
let chineseGuessKeyRequestId = 0;
let chineseCompositionActive = false;
let chineseDictionaryLoadState = 'idle';
let chineseDictionaryLoadError = null;
let boardScrollTop = 0;
let selectedBoardIndex = null;
let expandedSolvedBoardIndex = null;
let boardUiGameIdentity = null;
let pendingBoardSelectionAnnouncement = '';
let pendingHintRequest = null;
let hintRequestError = null;
let hintRequestTimeout = null;
let guessRequestTimeout = null;
let appSessionToken = null;
let appSessionExpiresAt = 0;
let currentRoundId = null;
let roundStartedAt = null;
let savedWords = [];
let savedWordsLoadState = 'idle';
let savedWordsError = null;
let pendingSavedWord = null;
let learningFlushTimer = null;
let learningRetryDelayMs = 1000;
let reviewObserver = null;
const observedLearningEvents = createOneTimeEventTracker();
const LEARNING_QUEUE_OWNER_KEY = 'quordle_learning_events_owner_v1';

const learningEventQueue = createLearningEventQueue({
  storage: localStorage,
  send: async (events, options = {}) => {
    if (!appSessionToken || appSessionExpiresAt <= Date.now()) {
      throw new Error('Learning session unavailable');
    }
    const response = await fetch(`${API_URL}/api/analytics/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${appSessionToken}`,
      },
      body: JSON.stringify({ events }),
      keepalive: options.keepalive === true,
    });
    if (!response.ok) throw new Error(`Learning analytics request failed (${response.status})`);
    return response.json();
  },
});

function getLearningEventContext() {
  return {
    dateKey: getTodayDateKey(),
    language: currentLanguage,
    ...(currentLanguage === 'zh' ? { puzzleVariant: CHINESE_PINYIN_PUZZLE_VARIANT } : {}),
    mode: gameMode,
    roundId: currentRoundId || `${gameMode}:${getTodayDateKey()}:${currentLanguage}`,
    roundStartedAt: roundStartedAt || Date.now(),
  };
}

function claimLearningQueueForUser(userId) {
  if (!userId) return;
  try {
    const ownerId = createStableLearningEventId(`queue-owner:${userId}`);
    const previousOwner = localStorage.getItem(LEARNING_QUEUE_OWNER_KEY);
    if (previousOwner && previousOwner !== ownerId) learningEventQueue.clear();
    localStorage.setItem(LEARNING_QUEUE_OWNER_KEY, ownerId);
  } catch {
    learningEventQueue.clear();
  }
}

function scheduleLearningEventFlush(delayMs = 250) {
  if (!appSessionToken || appSessionExpiresAt <= Date.now() || learningFlushTimer) return;
  learningFlushTimer = setTimeout(() => {
    learningFlushTimer = null;
    learningEventQueue.flush()
      .then((result) => {
        learningRetryDelayMs = 1000;
        if (result.pending > 0) scheduleLearningEventFlush();
      })
      .catch((error) => {
        console.warn('[Learning] Analytics flush deferred:', error.message);
        scheduleLearningEventFlush(learningRetryDelayMs);
        learningRetryDelayMs = Math.min(learningRetryDelayMs * 2, 30_000);
      });
  }, delayMs);
}

function trackLearningEvent(type, details = {}, stableKey = null) {
  if (!appSessionToken) return;
  const context = getLearningEventContext();
  const eventId = stableKey
    ? createStableLearningEventId(
      stableKey === 'round-completed' && currentLanguage === 'zh'
        ? getClientCompletionId(context.roundId)
        : `client:${context.roundId}:${stableKey}`,
    )
    : undefined;
  if (eventId && !observedLearningEvents.claim(eventId)) return;
  const queued = learningEventQueue.enqueue(buildLearningEvent(type, context, { ...details, eventId }));
  if (queued) scheduleLearningEventFlush();
}

function getDictionarySupplementalWords() {
  if (currentLanguage !== 'ko') return [];
  return [
    ...getSafeFeedbackSuggestionWords(),
    ...getSavedDictionarySupplementalWords(gameState, savedWords),
  ];
}

function renderSaveWordButton(word, source = 'dictionary') {
  const pending = pendingSavedWord === word;
  const presentation = getSavedWordButtonState(savedWords, word, pending);
  const { saved } = presentation;
  const unavailable = savedWordsLoadState === 'loading'
    || savedWordsLoadState === 'idle'
    || savedWordsLoadState === 'error';
  return `<button
    class="save-word-button ${saved ? 'save-word-button-saved' : ''}"
    type="button"
    data-save-word="${escapeHtml(word)}"
    data-save-source="${escapeHtml(source)}"
    aria-pressed="${presentation.ariaPressed}"
    aria-label="${escapeHtml(presentation.ariaLabel)}"
    ${pending || unavailable ? 'disabled' : ''}
  >${escapeHtml(presentation.text)}</button>`;
}

async function toggleSavedWord(word, source = 'dictionary') {
  if (pendingSavedWord || savedWordsLoadState === 'loading' || savedWordsLoadState === 'idle') return;
  const normalized = word.normalize('NFC');
  const optimistic = getOptimisticSavedWordToggle(savedWords, normalized, source, Date.now(), currentLanguage);
  const { previous, existing } = optimistic;
  pendingSavedWord = normalized;
  savedWordsError = null;
  savedWords = optimistic.next;
  renderApp();
  setupKeyboardListeners();

  try {
    if (appSessionToken && savedWordsLoadState !== 'loaded-local') {
      const response = await fetch(`${API_URL}/api/learning/saved-words/${encodeURIComponent(normalized)}`, {
        method: existing ? 'DELETE' : 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${appSessionToken}`,
        },
        body: JSON.stringify({
          language: currentLanguage,
          ...(currentLanguage === 'zh' ? { puzzleVariant: CHINESE_PINYIN_PUZZLE_VARIANT } : {}),
          source,
          dateKey: getTodayDateKey(),
          mode: gameMode,
          roundId: currentRoundId,
        }),
      });
      if (!response.ok) throw new Error(`Saved Words update failed (${response.status})`);
      const payload = await response.json();
      if (!existing && payload.record) {
        savedWords = savedWords.map((entry) => entry.word === normalized ? payload.record : entry);
      }
      savedWordsLoadState = 'loaded-server';
    } else if (existing) {
      savedWords = removeLocalSavedWord(localStorage, normalized, currentLanguage);
      savedWordsLoadState = 'loaded-local';
    } else {
      savedWords = upsertLocalSavedWord(localStorage, normalized, source, Date.now(), currentLanguage);
      savedWordsLoadState = 'loaded-local';
    }
  } catch (error) {
    savedWords = previous;
    savedWordsError = 'Saved Words could not be updated. Please try again.';
    console.warn('[Learning] Saved Words update failed:', error.message);
  } finally {
    pendingSavedWord = null;
    renderApp();
    setupKeyboardListeners();
    if (activeOverlay) focusActiveOverlay();
    else requestAnimationFrame(() => {
      const selector = `[data-save-word="${CSS.escape(normalized)}"]`;
      (document.querySelector(selector) || document.querySelector('.saved-words-collection'))?.focus();
    });
  }
}

function loadLocalSavedWordState() {
  if (!['ko', 'zh'].includes(currentLanguage)) {
    savedWords = [];
    savedWordsLoadState = 'loaded-local';
    savedWordsError = null;
    return;
  }
  savedWords = readLocalSavedWords(localStorage, currentLanguage);
  savedWordsLoadState = 'loaded-local';
  savedWordsError = null;
}

async function loadSavedWords() {
  if (!['ko', 'zh'].includes(currentLanguage)) {
    savedWords = [];
    savedWordsLoadState = 'loaded-server';
    savedWordsError = null;
    return;
  }
  const requestedLanguage = currentLanguage;
  if (!appSessionToken) {
    if (discordSdk) {
      savedWordsLoadState = 'error';
      savedWordsError = 'Cross-device Saved Words are not configured.';
    } else {
      loadLocalSavedWordState();
    }
    return;
  }
  if (savedWordsLoadState === 'loading') return;
  savedWordsLoadState = 'loading';
  savedWordsError = null;
  try {
    const response = await fetch(`${API_URL}/api/learning/saved-words?language=${requestedLanguage}`, {
      headers: { Authorization: `Bearer ${appSessionToken}` },
    });
    if (!response.ok) throw new Error(`Saved Words request failed (${response.status})`);
    const payload = await response.json();
    if (currentLanguage !== requestedLanguage) return;
    savedWords = Array.isArray(payload.words) ? payload.words : [];
    savedWordsLoadState = 'loaded-server';
  } catch (error) {
    if (!discordSdk) {
      loadLocalSavedWordState();
    } else {
      savedWordsLoadState = 'error';
      savedWordsError = 'Cross-device Saved Words are temporarily unavailable.';
    }
    console.warn('[Learning] Failed to load Saved Words:', error.message);
  }
  if (currentLanguage === requestedLanguage && gameState) {
    renderApp();
    setupKeyboardListeners();
  }
}

async function requestDevLearningSession() {
  if (appSessionToken || !discordUserId) return;
  try {
    const response = await fetch(`${API_URL}/api/session/dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: discordUserId }),
    });
    if (!response.ok) throw new Error(`Dev session unavailable (${response.status})`);
    const payload = await response.json();
    appSessionToken = payload.app_session_token || null;
    appSessionExpiresAt = Number(payload.app_session_expires_at) || 0;
    await loadSavedWords();
    scheduleLearningEventFlush();
  } catch {
    loadLocalSavedWordState();
    if (gameState) {
      renderApp();
      setupKeyboardListeners();
    }
  }
}

function clearPendingHintRequest() {
  pendingHintRequest = null;
  if (hintRequestTimeout) {
    clearTimeout(hintRequestTimeout);
    hintRequestTimeout = null;
  }
}

function clearGuessRequestTimeout() {
  if (!guessRequestTimeout) return;
  clearTimeout(guessRequestTimeout);
  guessRequestTimeout = null;
}

function rejectPendingChineseSubmission(message, options = {}) {
  const nextState = options.authoritative === true
    ? rejectChineseSubmissionFromAuthoritativeError(chineseInputState, message, options.submissionId)
    : rejectChineseSubmission(chineseInputState, message, options);
  if (nextState === chineseInputState) return false;
  clearGuessRequestTimeout();
  chineseInputState = nextState;
  syncChineseGuessState();
  persistChineseDraft();
  return true;
}

function reconcileChineseAuthoritativeState(playerState, normalizedState, language = currentLanguage) {
  const reconciliation = language === 'zh'
    ? reconcileChineseSubmissionAgainstState(chineseInputState, {
      ...playerState,
      gameState: normalizedState,
    })
    : { state: chineseInputState, status: 'none' };
  if (reconciliation.status === 'confirmed') clearGuessRequestTimeout();
  if (reconciliation.state !== chineseInputState) {
    chineseInputState = reconciliation.state;
    persistChineseDraft();
  }
  return reconciliation;
}

function startGuessRequestTimeout() {
  clearGuessRequestTimeout();
  guessRequestTimeout = setTimeout(() => {
    if (!chineseInputState.pendingSubmission) return;
    rejectPendingChineseSubmission(
      'The guess response timed out. Your Pinyin draft was preserved.',
      { retainSubmissionFingerprint: true },
    );
    joinCurrentDailyRoom();
    setMessageFeedback(chineseInputState.error, 'network-error');
    renderApp();
    setupKeyboardListeners();
    focusChineseInput();
  }, 8000);
}

function clearGuessFeedback() {
  rejectedGuessRequestId += 1;
  guessFeedback = null;
}

function setMessageFeedback(message, kind = 'error') {
  rejectedGuessRequestId += 1;
  guessFeedback = createMessageFeedback(message, kind);
}

function getSafeFeedbackSuggestionWords() {
  const unsolvedTargets = new Set(
    gameState?.boards
      ?.filter((board) => !board.solved)
      .map((board) => board.targetWord.normalize('NFC')) ?? [],
  );
  return getFeedbackSuggestionWords(guessFeedback)
    .map((word) => word.normalize('NFC'))
    .filter((word) => !unsolvedTargets.has(word));
}

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

function getChineseInputOptions() {
  return {
    wordLength: gameState?.wordLength ?? 0,
    guessKeys: chineseGuessKeysLength === gameState?.wordLength ? chineseGuessKeys : null,
    parseInput: parseChinesePinyinInput,
    normalizeInput: normalizePinyin,
  };
}

function getStoredChineseDraft() {
  if (currentLanguage !== 'zh' || !currentRoundId) return '';
  try {
    return localStorage.getItem(getChineseDraftStorageKey(currentRoundId)) ?? '';
  } catch {
    return '';
  }
}

function persistChineseDraft() {
  if (currentLanguage !== 'zh' || !currentRoundId) return;
  try {
    const key = getChineseDraftStorageKey(currentRoundId);
    if (chineseInputState.sourceText) localStorage.setItem(key, chineseInputState.sourceText);
    else localStorage.removeItem(key);
  } catch (error) {
    console.warn('Failed to persist Chinese Pinyin draft:', error);
  }
}

function resetChineseInput(value = '') {
  chineseInputState = updateChineseInput(createChineseInputState(), value, getChineseInputOptions());
  persistChineseDraft();
}

function syncChineseGuessState() {
  if (!gameState || currentLanguage !== 'zh') return;
  gameState = setCurrentGuess(gameState, chineseInputState.normalizedText || '');
}

function focusChineseInput() {
  requestAnimationFrame(() => {
    const input = document.querySelector('.chinese-guess-input');
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange?.(end, end);
  });
}

async function ensureChineseGuessKeysLoaded({ rerender = true } = {}) {
  if (currentLanguage !== 'zh' || gameState?.puzzleVariant !== CHINESE_PINYIN_PUZZLE_VARIANT) return null;
  const wordLength = gameState.wordLength;
  if (chineseGuessKeys && chineseGuessKeysLength === wordLength) return chineseGuessKeys;
  const requestId = chineseGuessKeyRequestId + 1;
  chineseGuessKeyRequestId = requestId;
  chineseGuessKeys = null;
  chineseGuessKeysLength = wordLength;
  chineseInputState = updateChineseInput(
    chineseInputState,
    chineseInputState.sourceText,
    getChineseInputOptions(),
  );
  try {
    const keys = await loadChinesePinyinGuessKeys(wordLength);
    if (requestId !== chineseGuessKeyRequestId
      || currentLanguage !== 'zh'
      || gameState?.wordLength !== wordLength) return null;
    chineseGuessKeys = keys;
    chineseInputState = updateChineseInput(
      chineseInputState,
      chineseInputState.sourceText,
      getChineseInputOptions(),
    );
    syncChineseGuessState();
    persistChineseDraft();
    return keys;
  } catch (error) {
    console.error('Failed to load Chinese Pinyin guess keys:', error);
    if (requestId !== chineseGuessKeyRequestId || currentLanguage !== 'zh') return null;
    chineseInputState = rejectChineseSubmission(chineseInputState, 'The Pinyin word list could not be loaded.');
    return null;
  } finally {
    if (rerender && requestId === chineseGuessKeyRequestId && currentLanguage === 'zh') {
      renderApp();
      setupKeyboardListeners();
      focusChineseInput();
    }
  }
}

function applyChineseInput(nextState) {
  chineseInputState = nextState;
  syncChineseGuessState();
  persistChineseDraft();
  renderApp();
  setupKeyboardListeners();
  focusChineseInput();
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
  ws.send(JSON.stringify(withChinesePuzzleVariant(currentLanguage, {
    type: 'JOIN',
    roomId: discordRoomId,
    dateKey,
    visibleUserId: discordUserId,
    profile: userProfile,
    guildId: discordGuildId,
    language: currentLanguage,
  })));
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
    if (currentLanguage === 'zh' && chineseInputState.pendingSubmission) {
      rejectPendingChineseSubmission(
        'Connection lost before the guess was confirmed.',
        { retainSubmissionFingerprint: true },
      );
      renderApp();
      setupKeyboardListeners();
    }
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
        const chineseReconciliation = reconcileChineseAuthoritativeState(
          message.playerState,
          normalizedState,
          nextLanguage,
        );
        const preserveChineseDraft = chineseReconciliation.status === 'unconfirmed'
          || chineseReconciliation.status === 'not-confirmed';
        initialStateApplied = true;
        clearPendingHintRequest();
        hintRequestError = null;
        restoreSavedPayload({
          gameState: normalizedState,
          gameMode: message.playerState.mode || 'daily',
          language: nextLanguage,
          dateKey: message.playerState.dateKey || getTodayDateKey(),
          lastActiveAt: Date.now(),
          savedAt: Date.now(),
        }, { markActive: true, preserveChineseDraft });
        saveGameState();
        renderApp();
        setupKeyboardListeners();
        if (activeOverlay) focusActiveOverlay();
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
        } else if (lbLang === 'zh') {
          leaderboardZh = message.leaderboard || [];
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
      if (pendingHintRequest || activeOverlay === OVERLAY_HINT) {
        clearPendingHintRequest();
        hintRequestError = message.message;
        renderApp();
        setupKeyboardListeners();
        if (activeOverlay === OVERLAY_HINT) focusActiveOverlay();
        break;
      }
      if (currentLanguage === 'zh') {
        rejectPendingChineseSubmission(
          message.message || 'The guess was not accepted.',
          { authoritative: true, submissionId: message.submissionId },
        );
      }
      setMessageFeedback(message.message, 'server-error');
      renderApp();
      setupKeyboardListeners();
      break;
  }
}

function sendGuessViaWebSocket(guess, submissionId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket not connected');
    return false;
  }

  const dateKey = getTodayDateKey();
  try {
    ws.send(JSON.stringify(withChinesePuzzleVariant(currentLanguage, {
      type: 'GUESS',
      roomId: discordRoomId,
      dateKey,
      visibleUserId: discordUserId,
      guess,
      ...(currentLanguage === 'zh' ? { submissionId } : {}),
      language: currentLanguage,
    })));
    return true;
  } catch (error) {
    console.warn('Failed to send guess over WebSocket:', error);
    return false;
  }
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
function getStorageKeyDaily(language = currentLanguage) { return getClientGameStorageKey('daily', language); }
function getStorageKeyPractice(language = currentLanguage) { return getClientGameStorageKey('practice', language); }
const ACTIVE_MODE_STORAGE_KEY = 'quordle_active_mode';

function getSavedActiveMode() {
  return localStorage.getItem(ACTIVE_MODE_STORAGE_KEY) === 'practice' ? 'practice' : 'daily';
}

function saveActiveMode(mode) {
  localStorage.setItem(ACTIVE_MODE_STORAGE_KEY, mode === 'practice' ? 'practice' : 'daily');
}

function getStorageKeyForMode(mode, language = currentLanguage) {
  return mode === "daily" ? getStorageKeyDaily(language) : getStorageKeyPractice(language);
}

function sendHintViaWebSocket(boardIndex, hintType) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(withChinesePuzzleVariant(currentLanguage, {
    type: 'HINT',
    roomId: discordRoomId,
    dateKey: getTodayDateKey(),
    visibleUserId: discordUserId,
    boardIndex,
    hintType,
    language: currentLanguage,
  })));
  return true;
}

function reportDailyInvalidGuess(guess) {
  if (gameMode !== 'daily' || !discordUserId || !discordRoomId) return;
  const payload = withChinesePuzzleVariant(currentLanguage, {
    type: 'INVALID_GUESS_ATTEMPT',
    roomId: discordRoomId,
    dateKey: getTodayDateKey(),
    visibleUserId: discordUserId,
    guess,
    language: currentLanguage,
    attemptId: crypto.randomUUID(),
  });
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return;
  }
  fetch(`${API_URL}/api/game/invalid-guess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, userId: discordUserId }),
    keepalive: true,
  }).catch(() => {});
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

  if (language === 'zh' && state.puzzleVariant !== CHINESE_PINYIN_PUZZLE_VARIANT) return null;
  const restoredWordLength = Number(state.wordLength);
  const wordLength = Number.isInteger(restoredWordLength) && restoredWordLength > 0
    ? restoredWordLength
    : (language === 'zh' ? 0 : getLegacyLanguageConfig(language).wordLength);
  if (!wordLength) return null;
  const languageConfig = language === 'zh'
    ? { filterCharRegex: /[^a-z]/giu }
    : getLegacyLanguageConfig(language);
  const boards = state.boards.map((board) => {
    if (!board || typeof board.targetWord !== 'string' || !Array.isArray(board.guesses) || !Array.isArray(board.results)
      || (language === 'zh' && typeof board.targetId !== 'string')) {
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
  if (language === 'en') {
    currentGuess = currentGuess.toLowerCase().replace(languageConfig.filterCharRegex, '').slice(0, languageConfig.wordLength);
  } else {
    currentGuess = currentGuess.normalize('NFC').replace(languageConfig.filterCharRegex, '').slice(0, languageConfig.wordLength);
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
    wordLength,
    gameOver: allSolved || guessCount >= maxGuesses,
    won: allSolved,
    language,
    assistance: normalizeAssistanceState(state.assistance),
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
    if (language === 'zh' && (
      parsed.gameState?.puzzleVariant !== CHINESE_PINYIN_PUZZLE_VARIANT
      || (parsed.roundId && !parsed.roundId.endsWith(`:zh:${CHINESE_PINYIN_PUZZLE_VARIANT}`))
    )) return null;

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
      ...(overrideLanguage === 'zh' ? { puzzleVariant: CHINESE_PINYIN_PUZZLE_VARIANT } : {}),
      dateKey: overrideMode === "daily" ? getTodayDateKey() : null,
      roundId: currentRoundId,
      roundStartedAt,
      lastActiveAt: lastActivityAt,
      savedAt: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (e) {
    console.warn("Failed to save game state:", e);
  }
}

function restoreSavedPayload(payload, { markActive = false, preserveChineseDraft = false } = {}) {
  if (!payload?.gameState) return false;

  currentLanguage = payload.language || currentLanguage;
  localStorage.setItem('quordle_language', currentLanguage);
  gameState = payload.gameState;
  gameMode = payload.gameMode || "daily";
  currentRoundId = typeof payload.roundId === 'string' && payload.roundId
    ? payload.roundId
    : getClientRoundId({
      mode: gameMode,
      language: currentLanguage,
      dateKey: payload.dateKey || getTodayDateKey(),
      instanceId: crypto.randomUUID(),
    });
  if (currentLanguage === 'zh' && !currentRoundId.endsWith(`:zh:${CHINESE_PINYIN_PUZZLE_VARIANT}`)) return false;
  roundStartedAt = Number.isFinite(Number(payload.roundStartedAt))
    ? Number(payload.roundStartedAt)
    : Date.now();
  saveActiveMode(gameMode);
  clearGuessFeedback();
  expiredSessionSnapshot = null;
  koreanShiftActive = false;
  imeReset();
  if (currentLanguage === 'zh') {
    if (preserveChineseDraft) {
      syncChineseGuessState();
      persistChineseDraft();
    } else {
      resetChineseInput(getStoredChineseDraft());
    }
    ensureChineseGuessKeysLoaded();
  } else {
    resetChineseInput();
  }
  if (currentLanguage === 'zh') {
    ensureChineseDictionaryLoaded(getDictionaryEligibleWords(gameState));
  }
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
    if (language === 'zh' && currentRoundId) {
      localStorage.removeItem(getChineseDraftStorageKey(currentRoundId));
    }
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

  clearGuessFeedback();
  koreanShiftActive = false;
  resetOverlayState();
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
    if (document.visibilityState === 'hidden') {
      learningEventQueue.flush({ keepalive: true }).catch(() => {});
    }
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
      body: JSON.stringify(withChinesePuzzleVariant(currentLanguage, {
        roomId: discordRoomId,
        userId: discordUserId,
        dateKey,
        language: currentLanguage,
        guildId: discordGuildId,
        profile: userProfile,
      })),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.warn("Failed to join game on server:", e);
    return null;
  }
}

async function serverSubmitGuess(guess, submissionId) {
  if (!discordUserId || !discordRoomId) {
    return { ok: false, error: 'Server identity is unavailable.', code: 'PLAYER_NOT_FOUND' };
  }
  try {
    const dateKey = getTodayDateKey();
    const response = await fetch(`${API_URL}/api/game/guess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withChinesePuzzleVariant(currentLanguage, {
        roomId: discordRoomId,
        userId: discordUserId,
        guess,
        ...(currentLanguage === 'zh' ? { submissionId } : {}),
        dateKey,
        language: currentLanguage,
      })),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        error: data?.error || data?.message || 'The guess was not accepted.',
        code: data?.code || 'GUESS_REJECTED',
        submissionId: data?.submissionId,
        status: response.status,
      };
    }
    return { ok: true, data };
  } catch (e) {
    console.warn("Failed to submit guess to server:", e);
    return { ok: false, error: 'Network unavailable. Your Pinyin draft was preserved.', code: 'NETWORK_ERROR' };
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
      requestDevLearningSession();
    });
} else {
  setupDevMode();
  initQuordleGame();
  requestDevLearningSession();
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
  claimLearningQueueForUser(discordUserId);

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
  const tokenPayload = await response.json();
  const { access_token } = tokenPayload;
  appSessionToken = tokenPayload.app_session_token || null;
  appSessionExpiresAt = Number(tokenPayload.app_session_expires_at) || 0;

  // Authenticate with Discord client (using the access_token)
  auth = await discordSdk.commands.authenticate({
    access_token,
  });

  if (auth == null) {
    throw new Error("Authenticate command failed");
  }

  // Capture Discord context for server-side persistence
  discordUserId = auth.user?.id || null;
  claimLearningQueueForUser(discordUserId);
  discordGuildId = discordSdk.guildId || null;
  discordChannelId = discordSdk.channelId || null;
  // Use channelId as roomId (stable across activity restarts for state persistence)
  // instanceId changes per activity session, so using channelId ensures:
  // - Game state persists when player closes and reopens the activity
  // - Leaderboard shows all players who played in the same channel
  discordRoomId = discordSdk.channelId || discordSdk.instanceId || null;

  loadSavedWords();
  scheduleLearningEventFlush();

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
    const performance = gameState ? calculatePerformanceMetrics(gameState) : null;
    // Use sendBeacon for reliability during page unload
    const payload = JSON.stringify(withChinesePuzzleVariant(currentLanguage, {
      userId: discordUserId,
      guildId: discordGuildId,
      channelId: discordChannelId,
      dateKey: getTodayDateKey(),
      language: currentLanguage,
      profile: userProfile,
      gameState: gameState ? {
        guessCount: gameState.guessCount,
        solvedCount: gameState.boards?.filter(b => b.solved).length || 0,
        gameOver: gameState.gameOver,
        won: gameState.won,
        hintCount: performance.hintCount,
        hintPenalty: performance.hintPenalty,
        assisted: performance.assisted,
        score: performance.score,
      } : null,
    }));

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

async function serverRequestHint(boardIndex, hintType) {
  if (!discordUserId || !discordRoomId) return { error: 'Server identity is unavailable.', code: 'PLAYER_NOT_FOUND' };
  try {
    const response = await fetch(`${API_URL}/api/game/hint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withChinesePuzzleVariant(currentLanguage, {
        roomId: discordRoomId,
        userId: discordUserId,
        dateKey: getTodayDateKey(),
        language: currentLanguage,
        boardIndex,
        hintType,
      })),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { error: data?.error || 'Hint request failed.', code: data?.code || 'HINT_REQUEST_FAILED' };
    }
    return data;
  } catch (error) {
    console.warn('Failed to request hint from server:', error);
    return { error: 'Hint request failed. Check your connection and try again.', code: 'HINT_REQUEST_FAILED' };
  }
}

function createFreshClientGame(mode, dateKey = getTodayDateKey()) {
  if (currentLanguage === 'zh') {
    const round = mode === 'daily'
      ? getDailyChinesePinyinRound(dateKey)
      : getPracticeChinesePinyinRound();
    return createGame({
      targetWords: round.answers.map((answer) => answer.key),
      targetIds: round.answers.map((answer) => answer.id),
      language: 'zh',
      puzzleVariant: CHINESE_PINYIN_PUZZLE_VARIANT,
      wordLength: round.length,
    });
  }
  const targetWords = mode === 'daily'
    ? getDailyTargets(dateKey, currentLanguage)
    : getLegacyQuordleWordsForLanguage(currentLanguage);
  return createGame({ targetWords, language: currentLanguage });
}

function startNewDailyGame() {
  gameMode = "daily";
  saveActiveMode(gameMode);
  uiScreen = "game";
  resetOverlayState();
  resetBoardScrollPosition();
  resetBoardUiState();
  initialStateApplied = false;
  expiredSessionSnapshot = null;
  koreanShiftActive = false;
  imeReset();
  clearGuessRequestTimeout();
  const dateKey = getTodayDateKey();
  currentRoundId = getClientRoundId({ mode: 'daily', language: currentLanguage, dateKey });
  roundStartedAt = Date.now();
  gameState = createFreshClientGame('daily', dateKey);
  resetChineseInput();
  if (currentLanguage === 'zh') ensureChineseGuessKeysLoaded();
  clearGuessFeedback();
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
  saveActiveMode(gameMode);
  uiScreen = "game";
  resetOverlayState();
  resetBoardScrollPosition();
  resetBoardUiState();
  initialStateApplied = false;
  expiredSessionSnapshot = null;
  koreanShiftActive = false;
  imeReset();
  clearGuessRequestTimeout();
  currentRoundId = getClientRoundId({
    mode: 'practice',
    language: currentLanguage,
    instanceId: crypto.randomUUID(),
  });
  roundStartedAt = Date.now();
  gameState = createFreshClientGame('practice');
  resetChineseInput();
  if (currentLanguage === 'zh') ensureChineseGuessKeysLoaded();
  clearGuessFeedback();
  lastActivityAt = Date.now();
  saveGameState();
  trackLearningEvent('round_started', {}, 'round-started');
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
  if (getSavedActiveMode() === 'practice') {
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
  }

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
        const chineseReconciliation = reconcileChineseAuthoritativeState(
          serverState,
          normalizedState,
          nextLanguage,
        );
        const preserveChineseDraft = chineseReconciliation.status === 'unconfirmed';
        initialStateApplied = true;
        restoreSavedPayload({
          gameState: normalizedState,
          gameMode: serverState.gameMode || "daily",
          language: nextLanguage,
          dateKey: serverState.dateKey || getTodayDateKey(),
          lastActiveAt: Date.now(),
          savedAt: Date.now(),
        }, { markActive: true, preserveChineseDraft });
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
  if (uiScreen !== 'results' && reviewObserver) {
    reviewObserver.disconnect();
    reviewObserver = null;
  }
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
    : lang === 'zh'
      ? getChineseInputValue(chineseInputState)
      : gameState.currentGuess.toUpperCase();
  return display || '-';
}

function renderChineseGuessControl() {
  const value = getChineseInputValue(chineseInputState);
  return `<label class="chinese-input-wrap" for="chinese-guess-input">
    <span class="sr-only">Pinyin guess</span>
    <input
      class="chinese-guess-input"
      id="chinese-guess-input"
      type="text"
      inputmode="text"
      autocomplete="off"
      autocapitalize="none"
      spellcheck="false"
      maxlength="64"
      value="${escapeHtml(value)}"
      aria-describedby="chinese-input-help"
      ${gameState.gameOver || chineseInputState.pendingSubmission ? 'disabled' : ''}
    />
  </label>`;
}

function renderChineseInputHelp() {
  if (currentLanguage !== 'zh') return '';
  if (chineseInputState.error) {
    return `<div class="chinese-candidate-status chinese-candidate-error" id="chinese-input-help" role="alert">${escapeHtml(chineseInputState.error)}</div>`;
  }
  if (chineseInputState.pendingSubmission) {
    return '<div class="chinese-candidate-status" id="chinese-input-help" role="status">Submitting Pinyin guess…</div>';
  }
  if (!chineseInputState.sourceText) {
    return '<div class="chinese-input-help" id="chinese-input-help">Type exactly two Pinyin syllables.</div>';
  }
  if (chineseInputState.validationStatus === 'loading') {
    return '<div class="chinese-candidate-status" id="chinese-input-help" role="status">Loading the Pinyin word list…</div>';
  }
  return '<div class="chinese-input-help" id="chinese-input-help">Press Enter to submit the normalized Pinyin letters.</div>';
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
  const open = activeOverlay === OVERLAY_LEADERBOARD;
  return `
    <button
      class="leaderboard-trigger"
      type="button"
      aria-haspopup="dialog"
      aria-expanded="${open}"
      aria-controls="${OVERLAY_LEADERBOARD}"
    >
      <span class="leaderboard-trigger-icon" aria-hidden="true">&#127942;</span>
      <span class="leaderboard-trigger-label">Scores</span>
    </button>
  `;
}

function renderLeaderboardModal() {
  if (activeOverlay !== OVERLAY_LEADERBOARD) return '';
  return renderOverlaySheet({
    id: OVERLAY_LEADERBOARD,
    title: 'Leaderboards',
    body: `<div id="leaderboard-panel">${renderLeaderboardContent()}</div>`,
    size: overlaySize,
    className: 'leaderboard-modal',
  });
}

function openLeaderboardModal() {
  if (activeOverlay) return;
  activeOverlay = OVERLAY_LEADERBOARD;
  overlaySize = 'half';
  overlayReturnFocusSelector = '.leaderboard-trigger';
  renderApp();
  setupKeyboardListeners();
  focusActiveOverlay();
}

function focusActiveOverlay() {
  requestAnimationFrame(() => {
    const overlay = document.querySelector(`[data-overlay-sheet="${activeOverlay}"]`);
    const preferred = activeOverlay === OVERLAY_DICTIONARY
      ? overlay?.querySelector('.dictionary-word-select, .dictionary-retry, .overlay-sheet-close')
      : activeOverlay === OVERLAY_HINT
        ? overlay?.querySelector('.hint-option:not([disabled]), .overlay-sheet-close')
        : overlay?.querySelector('.overlay-sheet-close');
    preferred?.focus();
  });
}

function closeActiveOverlay() {
  if (!activeOverlay) return;
  const returnSelector = overlayReturnFocusSelector;
  activeOverlay = null;
  overlaySize = 'half';
  overlayReturnFocusSelector = null;
  renderApp();
  setupKeyboardListeners();
  if (returnSelector) {
    requestAnimationFrame(() => document.querySelector(returnSelector)?.focus());
  }
}

function resetOverlayState() {
  activeOverlay = null;
  overlaySize = 'half';
  overlayReturnFocusSelector = null;
  dictionarySelectedWord = null;
  dictionaryEntrySource = 'dictionary';
  clearPendingHintRequest();
  hintRequestError = null;
}

function ensureKoreanDictionaryLoaded() {
  if (dictionarySnapshot || dictionaryLoadState === 'loading') return;
  dictionaryLoadState = 'loading';
  dictionaryLoadError = null;
  loadKoreanDictionarySnapshot()
    .then((snapshot) => {
      dictionarySnapshot = snapshot;
      dictionaryLoadState = 'loaded';
      const eligible = getDictionaryEligibleWords(
        gameState,
        snapshot.entries,
        getDictionarySupplementalWords(),
      );
      if (!eligible.includes(dictionarySelectedWord)) {
        dictionarySelectedWord = getDefaultDictionaryWord(gameState, eligible);
      }
      if (currentLanguage === 'ko') {
        renderApp();
        setupKeyboardListeners();
        if (activeOverlay) focusActiveOverlay();
      }
    })
    .catch((error) => {
      console.error('Failed to load Korean dictionary snapshot:', error);
      dictionaryLoadState = 'error';
      dictionaryLoadError = 'Dictionary data could not be loaded.';
      if (currentLanguage === 'ko') {
        renderApp();
        setupKeyboardListeners();
        if (activeOverlay) focusActiveOverlay();
      }
    });
}

function ensureChineseDictionaryLoaded(words = null) {
  const eligibleWords = words ?? getDictionaryEligibleWords(gameState);
  const missingWords = eligibleWords.filter((word) => !getLoadedChineseDictionaryEntry(word));
  if (missingWords.length === 0) {
    chineseDictionaryLoadState = 'loaded';
    chineseDictionaryLoadError = null;
    return;
  }
  if (chineseDictionaryLoadState === 'loading') return;
  chineseDictionaryLoadState = 'loading';
  chineseDictionaryLoadError = null;
  loadChineseDictionaryEntries(missingWords)
    .then(() => {
      chineseDictionaryLoadState = 'loaded';
      if (currentLanguage === 'zh') {
        renderApp();
        setupKeyboardListeners();
        if (activeOverlay) focusActiveOverlay();
      }
    })
    .catch((error) => {
      console.error('Failed to load Chinese dictionary data:', error);
      chineseDictionaryLoadState = 'error';
      chineseDictionaryLoadError = 'Dictionary data could not be loaded.';
      if (currentLanguage === 'zh') {
        renderApp();
        setupKeyboardListeners();
        if (activeOverlay) focusActiveOverlay();
      }
    });
}

function renderLearningControls() {
  if (!['ko', 'zh'].includes(currentLanguage)) return '';
  const eligibleWords = getDictionaryEligibleWords(gameState);
  const dictionaryDisabled = eligibleWords.length === 0;
  const hintDisabled = gameState.gameOver || !Number.isInteger(selectedBoardIndex);
  return `
    <div class="learning-controls">
      <button
        class="dictionary-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-controls="${OVERLAY_DICTIONARY}"
        aria-expanded="${activeOverlay === OVERLAY_DICTIONARY}"
        ${dictionaryDisabled ? 'disabled' : ''}
        aria-label="${dictionaryDisabled ? `Submit a valid ${currentLanguage === 'zh' ? 'Chinese' : 'Korean'} word to use the dictionary` : `Open dictionary for submitted ${currentLanguage === 'zh' ? 'Chinese' : 'Korean'} words`}"
      >${currentLanguage === 'zh' ? 'Dictionary' : '사전'} <span aria-hidden="true">⌕</span></button>
      <button
        class="hint-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-controls="${OVERLAY_HINT}"
        aria-expanded="${activeOverlay === OVERLAY_HINT}"
        ${hintDisabled ? 'disabled' : ''}
        aria-label="${hintDisabled ? 'Hints are unavailable' : `Open hints for selected board ${selectedBoardIndex + 1}`}"
      >${currentLanguage === 'ko' ? '힌트' : 'Hints'} <span aria-hidden="true">?</span></button>
    </div>
  `;
}

function openHintOverlay() {
  if (activeOverlay || !['ko', 'zh'].includes(currentLanguage) || gameState.gameOver || !Number.isInteger(selectedBoardIndex)) return;
  hintRequestError = null;
  activeOverlay = OVERLAY_HINT;
  overlaySize = 'half';
  overlayReturnFocusSelector = '.hint-trigger';
  renderApp();
  setupKeyboardListeners();
  focusActiveOverlay();
}

function renderHintResult(type, payload) {
  const formatted = formatHintPayload(currentLanguage, type, payload);
  if (!formatted) return '';
  const lang = type === 'reveal-first-syllable'
    ? ' lang="ko"'
    : type === 'reveal-first-character'
      ? ' lang="zh-Hans"'
      : '';
  return `<div class="hint-option-result" role="status" aria-live="polite"${lang}>${escapeHtml(formatted)}</div>`;
}

function renderHintOverlay() {
  if (activeOverlay !== OVERLAY_HINT) return '';
  const boardIndex = selectedBoardIndex;
  const board = Number.isInteger(boardIndex) ? gameState.boards[boardIndex] : null;
  if (!board || board.solved || gameState.gameOver) {
    return renderOverlaySheet({
      id: OVERLAY_HINT,
      title: currentLanguage === 'ko' ? 'Hints · 힌트' : 'Hints',
      body: '<div class="hint-status">Select an unsolved board to use hints.</div>',
      size: overlaySize,
      className: 'hint-sheet',
    });
  }

  const options = getHintUiOptions(currentLanguage).map((option) => {
    const used = getBoardHintUse(gameState.assistance, boardIndex, option.type);
    const available = used || isHintAvailable(gameState, boardIndex, option.type);
    const pending = pendingHintRequest === `${boardIndex}:${option.type}`;
    const disabled = Boolean(used) || !available || pendingHintRequest !== null;
    const status = used ? 'Used' : pending ? 'Requesting…' : available ? `−${HINT_COSTS[option.type]} points` : 'Unavailable';
    return `
      <article class="hint-option-card ${used ? 'hint-option-used' : ''} ${!available ? 'hint-option-unavailable' : ''}">
        <button
          class="hint-option"
          type="button"
          data-hint-type="${option.type}"
          ${disabled ? 'disabled' : ''}
          aria-label="${escapeHtml(option.label)}, ${escapeHtml(status)}"
        >
          <span class="hint-option-heading">
            <strong>${escapeHtml(option.label)}</strong>
            <span>${escapeHtml(status)}</span>
          </span>
          <span class="hint-option-description">${escapeHtml(option.description)}</span>
        </button>
        ${used ? renderHintResult(option.type, used.payload) : ''}
      </article>
    `;
  }).join('');
  const performance = calculatePerformanceMetrics(gameState);
  const error = hintRequestError
    ? `<div class="hint-error" role="alert">${escapeHtml(hintRequestError)}</div>`
    : '';
  const body = `
    <div class="hint-sheet-summary">
      <strong>Selected board #${boardIndex + 1}</strong>
      <span>${performance.hintCount} ${performance.hintCount === 1 ? 'hint' : 'hints'} used · ${performance.hintPenalty} points in penalties</span>
    </div>
    ${error}
    <div class="hint-options">${options}</div>
  `;
  return renderOverlaySheet({
    id: OVERLAY_HINT,
    title: currentLanguage === 'ko' ? 'Hints · 힌트' : 'Hints',
    body,
    size: overlaySize,
    className: 'hint-sheet',
  });
}

async function requestBoardHint(boardIndex, hintType) {
  if (pendingHintRequest || !['ko', 'zh'].includes(currentLanguage)) return;
  const requestKey = `${boardIndex}:${hintType}`;
  pendingHintRequest = requestKey;
  hintRequestError = null;
  renderApp();
  setupKeyboardListeners();

  if (gameMode === 'daily' && discordUserId && discordRoomId) {
    if (sendHintViaWebSocket(boardIndex, hintType)) {
      hintRequestTimeout = setTimeout(() => {
        if (pendingHintRequest !== requestKey) return;
        clearPendingHintRequest();
        hintRequestError = 'The hint response timed out. Retrying is safe and will not charge twice.';
        renderApp();
        setupKeyboardListeners();
        if (activeOverlay === OVERLAY_HINT) focusActiveOverlay();
      }, 8000);
      return;
    }

    const serverState = await serverRequestHint(boardIndex, hintType);
    clearPendingHintRequest();
    if (serverState?.error) {
      hintRequestError = serverState.error;
    } else if (serverState?.gameState) {
      const nextLanguage = serverState.language || currentLanguage;
      const normalizedState = normalizeRestoredGameState(serverState.gameState, nextLanguage);
      if (normalizedState) {
        const chineseReconciliation = reconcileChineseAuthoritativeState(
          serverState,
          normalizedState,
          nextLanguage,
        );
        restoreSavedPayload({
          gameState: normalizedState,
          gameMode: serverState.gameMode || gameMode,
          language: nextLanguage,
          dateKey: serverState.dateKey || getTodayDateKey(),
          lastActiveAt: Date.now(),
          savedAt: Date.now(),
        }, {
          markActive: true,
          preserveChineseDraft: chineseReconciliation.status === 'unconfirmed',
        });
        saveGameState();
      } else {
        hintRequestError = 'The server returned an invalid hint state.';
      }
    }
    renderApp();
    setupKeyboardListeners();
    if (activeOverlay === OVERLAY_HINT) focusActiveOverlay();
    return;
  }

  const result = requestHint(gameState, boardIndex, hintType, Date.now());
  clearPendingHintRequest();
  if (!result.ok) {
    hintRequestError = result.message;
  } else {
    gameState = result.state;
    saveGameState();
    if (!result.duplicate) {
      trackLearningEvent('hint_used', { boardIndex, hintType }, `hint:${boardIndex}:${hintType}`);
    }
  }
  renderApp();
  setupKeyboardListeners();
  if (activeOverlay === OVERLAY_HINT) focusActiveOverlay();
}

function openDictionary(word = null, returnFocusSelector = '.dictionary-trigger') {
  if (activeOverlay && activeOverlay !== OVERLAY_DICTIONARY) return;
  const eligibleWords = getDictionaryEligibleWords(
    gameState,
    currentLanguage === 'ko' ? (dictionarySnapshot?.entries ?? null) : null,
    getDictionarySupplementalWords(),
  );
  if (eligibleWords.length === 0) return;
  dictionarySelectedWord = eligibleWords.includes(word)
    ? word
    : getDefaultDictionaryWord(gameState, eligibleWords);
  dictionaryEntrySource = returnFocusSelector.includes('nearby-word')
    ? 'nearby'
    : (gameState.gameOver ? 'post-game' : 'dictionary');
  activeOverlay = OVERLAY_DICTIONARY;
  overlaySize = 'half';
  overlayReturnFocusSelector = returnFocusSelector;
  if (currentLanguage === 'ko') ensureKoreanDictionaryLoaded();
  else ensureChineseDictionaryLoaded(eligibleWords);
  trackLearningEvent('dictionary_opened', {
    ...(dictionarySelectedWord ? { word: dictionarySelectedWord } : {}),
    surface: dictionaryEntrySource,
  });
  if (dictionarySelectedWord) {
    trackLearningEvent('definition_viewed', {
      word: dictionarySelectedWord,
      surface: dictionaryEntrySource,
    });
  }
  renderApp();
  setupKeyboardListeners();
  focusActiveOverlay();
}

function renderDictionarySense(sense, index) {
  const translations = sense.translations.map(escapeHtml).join('; ');
  return `
    <li class="dictionary-sense">
      <div class="dictionary-sense-heading">
        <span class="dictionary-sense-number">${index + 1}</span>
        <strong>${translations}</strong>
        ${sense.partOfSpeech ? `<span class="dictionary-part-of-speech">${escapeHtml(sense.partOfSpeech)}</span>` : ''}
        ${sense.sourceUrl ? `<a class="dictionary-sense-source" href="${escapeHtml(sense.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a>` : ''}
      </div>
      ${sense.definition ? `<p>${escapeHtml(sense.definition)}</p>` : ''}
    </li>
  `;
}

function renderDictionaryEntry(entry, source = dictionaryEntrySource) {
  if (!entry) return '<div class="dictionary-empty">No dictionary entry is available for this word.</div>';
  const view = currentLanguage === 'zh'
    ? toChineseDictionaryViewModel(entry)
    : toKoreanDictionaryViewModel(entry);
  const languageTag = view.language === 'zh' ? 'zh-Hans' : 'ko';
  const alternateForms = view.alternateForms.length > 0
    ? `<div class="dictionary-pronunciation"><span>Traditional</span> <span lang="zh-Hant">${view.alternateForms.map(escapeHtml).join(' · ')}</span></div>`
    : '';
  return `
    <article class="dictionary-entry dictionary-entry-${view.language}">
      <div class="dictionary-word-row">
        <h3 lang="${languageTag}">${escapeHtml(view.display)}</h3>
        ${view.romanization ? `<span class="dictionary-romanization">${escapeHtml(view.romanization)}</span>` : ''}
        ${renderSaveWordButton(view.normalized, source)}
      </div>
      ${alternateForms}
      ${view.numericPronunciation ? `<div class="dictionary-pronunciation"><span>Numbered pinyin</span> ${escapeHtml(view.numericPronunciation)}</div>` : ''}
      ${view.pronunciation && view.language === 'ko' && view.pronunciation !== view.display
        ? `<div class="dictionary-pronunciation"><span>Pronunciation</span> <span lang="ko">${escapeHtml(view.pronunciation)}</span></div>`
        : ''}
      <ol class="dictionary-senses">
        ${view.senses.map(renderDictionarySense).join('')}
      </ol>
    </article>
  `;
}

function renderDictionaryAttribution() {
  if (currentLanguage === 'zh') {
    const metadata = chineseDictionaryMetadata;
    return `<footer class="dictionary-attribution">
      Chinese dictionary data derived from
      <a href="${escapeHtml(metadata.dictionaryUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(metadata.source)}</a>
      (${escapeHtml(metadata.sourceUpdatedAt)}; SHA-256 ${escapeHtml(metadata.sourceSha256)}), licensed under
      <a href="${escapeHtml(metadata.licenseUrl)}" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>.
    </footer>`;
  }
  const metadata = dictionarySnapshot?.metadata;
  if (!metadata) return '';
  return `
    <footer class="dictionary-attribution">
      Definitions and translations from
      <a href="${escapeHtml(metadata.dictionaryUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(metadata.source)}</a>.
      <a href="${escapeHtml(metadata.licenseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(metadata.license)}</a>.
    </footer>
  `;
}

function renderDictionaryOverlay() {
  if (activeOverlay !== OVERLAY_DICTIONARY) return '';
  let body;
  const isChinese = currentLanguage === 'zh';
  const loadState = isChinese ? chineseDictionaryLoadState : dictionaryLoadState;
  const loadError = isChinese ? chineseDictionaryLoadError : dictionaryLoadError;
  if (loadState === 'error') {
    body = `<div class="dictionary-status" role="alert">
      <p>${escapeHtml(loadError)}</p>
      <button class="dictionary-retry" type="button">Retry</button>
    </div>`;
  } else if ((!isChinese && !dictionarySnapshot) || (isChinese && loadState !== 'loaded')) {
    body = '<div class="dictionary-status" role="status">Loading dictionary…</div>';
  } else {
    const eligibleWords = getDictionaryEligibleWords(
      gameState,
      isChinese ? null : dictionarySnapshot.entries,
      getDictionarySupplementalWords(),
    );
    const selectedWord = eligibleWords.includes(dictionarySelectedWord)
      ? dictionarySelectedWord
      : getDefaultDictionaryWord(gameState, eligibleWords);
    dictionarySelectedWord = selectedWord;
    const options = eligibleWords.map((word) => (
      `<option value="${escapeHtml(word)}" ${word === selectedWord ? 'selected' : ''}>${escapeHtml(word)}</option>`
    )).join('');
    body = eligibleWords.length === 0
      ? `<div class="dictionary-status">Submit a valid ${isChinese ? 'Chinese' : 'Korean'} word to view its meaning.</div>`
      : `<div class="dictionary-toolbar">
          <label for="dictionary-word-select">Available word</label>
          <select class="dictionary-word-select" id="dictionary-word-select">${options}</select>
        </div>
        ${renderDictionaryEntry(isChinese ? getLoadedChineseDictionaryEntry(selectedWord) : getKoreanDictionaryEntry(selectedWord, dictionarySnapshot), dictionaryEntrySource)}
        ${renderDictionaryAttribution()}`;
  }

  return renderOverlaySheet({
    id: OVERLAY_DICTIONARY,
    title: isChinese ? 'Dictionary · 词典' : 'Dictionary · 사전',
    body,
    size: overlaySize,
    className: 'dictionary-sheet',
  });
}

function bindActiveOverlayInteractions() {
  if (!activeOverlay) return;
  const overlayId = activeOverlay;
  const overlay = document.querySelector(`[data-overlay-sheet="${overlayId}"]`);
  const backdrop = document.querySelector(`[data-overlay-backdrop="${overlayId}"]`);
  if (!overlay || !backdrop) return;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeActiveOverlay();
  });
  overlay.querySelectorAll(`[data-overlay-close="${overlayId}"]`).forEach((button) => {
    button.addEventListener('click', closeActiveOverlay);
  });
  overlay.querySelectorAll(`[data-overlay-size-toggle="${overlayId}"]`).forEach((button) => {
    button.addEventListener('click', () => {
      overlaySize = overlaySize === 'full' ? 'half' : 'full';
      renderApp();
      setupKeyboardListeners();
      requestAnimationFrame(() => document.querySelector(`[data-overlay-size-toggle="${overlayId}"]`)?.focus());
    });
  });
  overlay.addEventListener('keydown', (event) => trapOverlayFocus(event, overlay, closeActiveOverlay));

  const handle = overlay.querySelector('.overlay-sheet-handle');
  if (handle) {
    let dragStartY = null;
    handle.addEventListener('pointerdown', (event) => {
      dragStartY = event.clientY;
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointerup', (event) => {
      if (dragStartY === null) return;
      const action = getSheetDragAction(dragStartY, event.clientY, overlaySize);
      dragStartY = null;
      if (action === 'dismiss') {
        closeActiveOverlay();
      } else if (action === 'expand' || action === 'collapse') {
        overlaySize = action === 'expand' ? 'full' : 'half';
        renderApp();
        setupKeyboardListeners();
        focusActiveOverlay();
      }
    });
    handle.addEventListener('pointercancel', () => { dragStartY = null; });
  }

  const wordSelect = overlay.querySelector('.dictionary-word-select');
  if (wordSelect) {
    wordSelect.addEventListener('change', () => {
      const eligibleWords = getDictionaryEligibleWords(
        gameState,
        currentLanguage === 'ko' ? (dictionarySnapshot?.entries ?? null) : null,
        getDictionarySupplementalWords(),
      );
      if (!eligibleWords.includes(wordSelect.value)) return;
      dictionarySelectedWord = wordSelect.value;
      dictionaryEntrySource = getSafeFeedbackSuggestionWords().includes(dictionarySelectedWord)
        ? 'nearby'
        : (gameState.gameOver ? 'post-game' : 'dictionary');
      trackLearningEvent('definition_viewed', {
        word: dictionarySelectedWord,
        surface: dictionaryEntrySource,
      });
      renderApp();
      setupKeyboardListeners();
      requestAnimationFrame(() => document.querySelector('.dictionary-word-select')?.focus());
    });
  }

  const retry = overlay.querySelector('.dictionary-retry');
  if (retry) {
    retry.addEventListener('click', () => {
      dictionaryLoadState = 'idle';
      dictionaryLoadError = null;
      chineseDictionaryLoadState = 'idle';
      chineseDictionaryLoadError = null;
      if (currentLanguage === 'ko') ensureKoreanDictionaryLoaded();
      else ensureChineseDictionaryLoaded();
      renderApp();
      setupKeyboardListeners();
      focusActiveOverlay();
    });
  }
}

function renderGuessFeedback() {
  const safeSuggestionWords = new Set(getSafeFeedbackSuggestionWords());
  const suggestions = (guessFeedback?.suggestions ?? [])
    .filter((suggestion) => safeSuggestionWords.has(suggestion.word.normalize('NFC')));
  const kind = guessFeedback?.kind ?? 'empty';
  const message = guessFeedback?.message ?? '';
  const suggestionAnnouncement = suggestions.length > 0
    ? `${suggestions.length} nearby word suggestions available.`
    : '';
  const suggestionButtons = suggestions.map((suggestion) => `
    <button
      class="nearby-word-button"
      type="button"
      data-nearby-word="${escapeHtml(suggestion.word)}"
      aria-label="Open dictionary for ${escapeHtml(suggestion.word)}, ${escapeHtml(suggestion.gloss)}, ${escapeHtml(suggestion.levelLabel)}"
    >
      <span class="nearby-word-korean" lang="ko">${escapeHtml(suggestion.word)}</span>
      <span class="nearby-word-gloss">${escapeHtml(suggestion.gloss)}</span>
    </button>
  `).join('');

  return `
    <div class="guess-feedback-region">
      <div class="guess-error-slot" aria-live="polite" aria-atomic="true">
        ${message ? `<div class="guess-feedback guess-feedback-${escapeHtml(kind)}">${escapeHtml(message)}</div>` : ''}
        ${suggestionAnnouncement ? `<span class="sr-only">${escapeHtml(suggestionAnnouncement)}</span>` : ''}
      </div>
      ${suggestionButtons
        ? `<div class="nearby-words" aria-label="Nearby valid Korean words">${suggestionButtons}</div>`
        : ''}
    </div>
  `;
}

function renderGameScreen() {
  const app = document.querySelector('#app');
  syncBoardUiState();
  const solvedCount = gameState.boards.filter(b => b.solved).length;
  const lang = currentLanguage;
  const currentGuessDisplay = getCurrentGuessDisplayText();
  const currentGuessControl = lang === 'zh'
    ? renderChineseGuessControl()
    : `<span class="guess-text">${currentGuessDisplay}</span>`;
  const selectionAnnouncement = pendingBoardSelectionAnnouncement;
  pendingBoardSelectionAnnouncement = '';
  const errorHtml = renderGuessFeedback();

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
            ${currentGuessControl}
          </div>
        </div>
        ${errorHtml}
      </div>`;

  // Language toggle
  const langToggle = `
    <div class="lang-toggle">
      <button class="lang-btn ${lang === 'en' ? 'lang-btn-active' : ''}" data-lang="en">🇺🇸 EN</button>
      <button class="lang-btn ${lang === 'ko' ? 'lang-btn-active' : ''}" data-lang="ko">🇰🇷 KO</button>
      <button class="lang-btn ${lang === 'zh' ? 'lang-btn-active' : ''}" data-lang="zh">🇨🇳 ZH</button>
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
    <div class="quordle-container lang-${lang}">
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
        ${renderChineseInputHelp()}
        ${renderLearningControls()}
        ${currentLanguage === 'ko' ? renderKoreanKeyboard() : renderKeyboard()}
      </section>

      ${renderLeaderboardModal()}
      ${renderDictionaryOverlay()}
      ${renderHintOverlay()}
    </div>
  `;

  const boardRegion = app.querySelector('.game-scroll-region');
  if (boardRegion) {
    boardRegion.scrollTop = boardScrollTop;
  }
}

function renderKoreanLearningReview() {
  ensureKoreanDictionaryLoaded();
  if (dictionaryLoadState === 'error') {
    return `<div class="answers-reveal korean-learning-review">
      <div class="answers-title">정답 · Answer review</div>
      <div class="dictionary-status" role="alert">
        <p>${escapeHtml(dictionaryLoadError)}</p>
        <button class="dictionary-inline-retry" type="button">Retry</button>
      </div>
    </div>`;
  }
  if (!dictionarySnapshot) {
    return `<div class="answers-reveal korean-learning-review">
      <div class="answers-title">정답 · Answer review</div>
      <div class="dictionary-status" role="status">Loading answer meanings…</div>
    </div>`;
  }

  const cards = gameState.boards.map((board, index) => {
    const entry = getKoreanDictionaryEntry(board.targetWord, dictionarySnapshot);
    if (!entry) {
      return `<article class="learning-card ${board.solved ? 'answer-solved' : 'answer-missed'}" data-review-word="${escapeHtml(board.targetWord)}">
        <div class="learning-card-header"><span>#${index + 1}</span><strong lang="ko">${escapeHtml(board.targetWord)}</strong></div>
        <p>Definition unavailable for this legacy round.</p>
      </article>`;
    }
    const [primary, ...additional] = entry.senses;
    return `<article class="learning-card ${board.solved ? 'answer-solved' : 'answer-missed'}" data-review-word="${escapeHtml(entry.word)}">
      <div class="learning-card-header">
        <span class="learning-card-number">#${index + 1}</span>
        <div><strong lang="ko">${escapeHtml(entry.word)}</strong><span>${escapeHtml(entry.romanization)}</span></div>
        <span class="answer-status" aria-label="${board.solved ? 'Solved' : 'Missed'}">${board.solved ? '✓' : '✗'}</span>
      </div>
      <div class="learning-card-primary">
        <strong>${primary.translations.map(escapeHtml).join('; ')}</strong>
        <span>${escapeHtml(primary.partOfSpeech)}</span>
        <p>${escapeHtml(primary.definition)}</p>
      </div>
      ${additional.length > 0 ? `<details class="learning-card-more">
        <summary>${additional.length} more ${additional.length === 1 ? 'meaning' : 'meanings'}</summary>
        <ol>${additional.map((sense, senseIndex) => renderDictionarySense(sense, senseIndex + 1)).join('')}</ol>
      </details>` : ''}
      <div class="learning-card-actions">
        <button
          class="learning-card-open"
          type="button"
          data-dictionary-word="${escapeHtml(entry.word)}"
          aria-label="Open full dictionary entry for ${escapeHtml(entry.word)}"
        >Full entry</button>
        ${renderSaveWordButton(entry.word, 'post-game')}
      </div>
    </article>`;
  }).join('');

  return `<div class="answers-reveal korean-learning-review">
    <div class="answers-title">정답 · Answer review</div>
    <div class="learning-card-list">${cards}</div>
    ${renderDictionaryAttribution()}
  </div>`;
}

function renderChineseLearningReview() {
  const answerWords = gameState.boards.map((board) => board.targetId).filter(Boolean);
  ensureChineseDictionaryLoaded(answerWords);
  if (chineseDictionaryLoadState === 'error') {
    return `<div class="answers-reveal chinese-learning-review">
      <div class="answers-title">答案 · Answer review</div>
      <div class="dictionary-status" role="alert">
        <p>${escapeHtml(chineseDictionaryLoadError)}</p>
        <button class="dictionary-inline-retry" type="button">Retry</button>
      </div>
    </div>`;
  }
  if (answerWords.some((word) => !getLoadedChineseDictionaryEntry(word))) {
    return `<div class="answers-reveal chinese-learning-review">
      <div class="answers-title">答案 · Answer review</div>
      <div class="dictionary-status" role="status">Loading answer meanings…</div>
    </div>`;
  }

  const cards = gameState.boards.map((board, index) => {
    const targetId = board.targetId;
    const entry = getLoadedChineseDictionaryEntry(targetId);
    const primary = getPrimaryChinesePronunciation(entry);
    const [firstSense, ...additional] = entry?.senses ?? [];
    return `<article class="learning-card ${board.solved ? 'answer-solved' : 'answer-missed'}" data-review-word="${escapeHtml(targetId)}">
      <div class="learning-card-header">
        <span class="learning-card-number">#${index + 1}</span>
        <div><strong lang="zh-Hans">${escapeHtml(entry?.word ?? targetId)}</strong><span>${escapeHtml(primary?.pinyinMarked ?? '')}</span></div>
        <span class="answer-status" aria-label="${board.solved ? 'Solved' : 'Missed'}">${board.solved ? '✓' : '✗'}</span>
      </div>
      ${firstSense ? `<div class="learning-card-primary"><strong>${(firstSense.glosses ?? []).map(escapeHtml).join('; ')}</strong></div>` : '<p>Definition unavailable.</p>'}
      ${additional.length > 0 ? `<details class="learning-card-more">
        <summary>${additional.length} more ${additional.length === 1 ? 'meaning' : 'meanings'}</summary>
        <ol>${additional.map((sense) => `<li>${(sense.glosses ?? []).map(escapeHtml).join('; ')}</li>`).join('')}</ol>
      </details>` : ''}
      <div class="learning-card-actions">
        <button class="learning-card-open" type="button" data-dictionary-word="${escapeHtml(entry.word)}">Full entry</button>
        ${renderSaveWordButton(entry.word, 'post-game')}
      </div>
    </article>`;
  }).join('');

  return `<div class="answers-reveal chinese-learning-review">
    <div class="answers-title">答案 · Answer review</div>
    <div class="learning-card-list">${cards}</div>
    ${renderDictionaryAttribution()}
  </div>`;
}

function renderSavedWordsCollection() {
  if (!['ko', 'zh'].includes(currentLanguage) || !gameState?.gameOver) return '';
  if (savedWordsLoadState === 'idle' || savedWordsLoadState === 'loading') {
    return `<section class="saved-words-collection" aria-labelledby="saved-words-title">
      <div class="answers-title" id="saved-words-title">Saved Words</div>
      <div class="dictionary-status" role="status">Loading saved vocabulary…</div>
    </section>`;
  }
  if (savedWordsLoadState === 'error') {
    return `<section class="saved-words-collection" aria-labelledby="saved-words-title">
      <div class="answers-title" id="saved-words-title">Saved Words</div>
      <div class="dictionary-status" role="alert">
        <p>${escapeHtml(savedWordsError || 'Saved Words are unavailable.')}</p>
        <button class="saved-words-retry" type="button">Retry</button>
      </div>
    </section>`;
  }
  if (currentLanguage === 'ko' && !dictionarySnapshot) {
    ensureKoreanDictionaryLoaded();
    return `<section class="saved-words-collection" aria-labelledby="saved-words-title">
      <div class="answers-title" id="saved-words-title">Saved Words</div>
      <div class="dictionary-status" role="status">Loading saved vocabulary…</div>
    </section>`;
  }
  if (currentLanguage === 'zh') {
    const savedChineseWords = savedWords.map((record) => record.word);
    ensureChineseDictionaryLoaded(savedChineseWords);
    if (savedChineseWords.some((word) => !getLoadedChineseDictionaryEntry(word))) {
      return `<section class="saved-words-collection" aria-labelledby="saved-words-title">
        <div class="answers-title" id="saved-words-title">Saved Words</div>
        <div class="dictionary-status" role="status">Loading saved vocabulary…</div>
      </section>`;
    }
  }
  const dictionaryEntries = currentLanguage === 'ko'
    ? dictionarySnapshot.entries
    : Object.fromEntries(savedWords.map((record) => [record.word, getLoadedChineseDictionaryEntry(record.word)]).filter(([, entry]) => entry));
  const collection = getSavedWordsForResults(gameState, savedWords, dictionaryEntries);
  const storageNote = savedWordsLoadState === 'loaded-local'
    ? '<p class="saved-words-storage-note">Saved on this device only.</p>'
    : '';
  const cards = collection.map((record) => {
    const entry = currentLanguage === 'ko'
      ? getKoreanDictionaryEntry(record.word, dictionarySnapshot)
      : getLoadedChineseDictionaryEntry(record.word);
    const primarySense = entry?.senses?.[0];
    if (!entry || !primarySense) return '';
    const label = currentLanguage === 'ko'
      ? entry.romanization
      : getPrimaryChinesePronunciation(entry)?.pinyinMarked;
    const translations = currentLanguage === 'ko' ? primarySense.translations : primarySense.glosses;
    return `<article class="saved-word-card">
      <div class="saved-word-copy">
        <strong lang="${currentLanguage === 'ko' ? 'ko' : 'zh-Hans'}">${escapeHtml(entry.word)}</strong>
        <span>${escapeHtml(label)}</span>
        <p>${(translations ?? []).map(escapeHtml).join('; ')}</p>
      </div>
      <div class="saved-word-actions">
        <button type="button" class="learning-card-open" data-dictionary-word="${escapeHtml(entry.word)}">Full entry</button>
        ${renderSaveWordButton(entry.word, 'post-game')}
      </div>
    </article>`;
  }).join('');
  return `<section class="saved-words-collection" aria-labelledby="saved-words-title" tabindex="-1">
    <div class="answers-title" id="saved-words-title">Saved Words <span>${collection.length}</span></div>
    ${storageNote}
    ${savedWordsError ? `<p class="saved-words-inline-error" role="alert">${escapeHtml(savedWordsError)}</p>` : ''}
    ${cards || `<p class="saved-words-empty">Save ${currentLanguage === 'zh' ? 'Chinese' : 'Korean'} words from the dictionary or answer review to build your collection.</p>`}
  </section>`;
}

function setupPostGameReviewObserver() {
  reviewObserver?.disconnect();
  reviewObserver = null;
  if (!['ko', 'zh'].includes(currentLanguage) || !gameState?.gameOver || typeof IntersectionObserver !== 'function') return;
  reviewObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.5) return;
      const word = entry.target.dataset.reviewWord;
      if (word) {
        trackLearningEvent('review_word_viewed', { word, surface: 'post-game' }, `review-word:${word}`);
      }
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.5 });
  document.querySelectorAll('[data-review-word]').forEach((card) => reviewObserver.observe(card));
}

function renderResultsScreen() {
  const app = document.querySelector('#app');
  const performance = calculatePerformanceMetrics(gameState);
  const solvedCount = performance.solvedCount;
  const icon = gameState.won ? 'Solved' : 'Finished';
  const message = gameState.won ? 'You Won!' : 'Game Over';
  const bannerClass = gameState.won ? 'results-won' : 'results-lost';
  const lang = currentLanguage;
  if (['ko', 'zh'].includes(lang)) trackLearningEvent('post_game_review_opened', {}, 'post-game-review-opened');

  // Language toggle
  const langToggle = `
    <div class="lang-toggle">
      <button class="lang-btn ${lang === 'en' ? 'lang-btn-active' : ''}" data-lang="en">🇺🇸 EN</button>
      <button class="lang-btn ${lang === 'ko' ? 'lang-btn-active' : ''}" data-lang="ko">🇰🇷 KO</button>
      <button class="lang-btn ${lang === 'zh' ? 'lang-btn-active' : ''}" data-lang="zh">🇨🇳 ZH</button>
    </div>
  `;

  // Answers reveal (always show on results)
  const answersHtml = lang === 'ko' ? renderKoreanLearningReview() : lang === 'zh' ? renderChineseLearningReview() : `
    <div class="answers-reveal">
      <div class="answers-title">Answers</div>
      <div class="answers-list">
        ${gameState.boards.map((board, i) => `
          <div class="answer-item ${board.solved ? 'answer-solved' : 'answer-missed'}">
            <span class="answer-number">#${i + 1}</span>
            <span class="answer-word">${board.targetWord.toUpperCase()}</span>
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
    <div class="quordle-container lang-${lang}">
      <div class="game-header">
        <h1 class="game-title">Quordle${gameMode === 'practice' ? ' <span class="mode-badge">Practice</span>' : ''}</h1>
        <div class="game-header-actions">
          ${langToggle}
          ${renderLeaderboardButton()}
        </div>
      </div>
      
      <div class="results-screen">
        <div class="results-card ${bannerClass} ${['ko', 'zh'].includes(lang) ? 'results-card-learning' : ''}">
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
            <div class="results-stat">
              <span class="results-stat-value">${performance.hintCount}</span>
              <span class="results-stat-label">hints</span>
            </div>
            <div class="results-stat">
              <span class="results-stat-value">${performance.score}</span>
              <span class="results-stat-label">score</span>
            </div>
          </div>
          <div class="results-assistance ${performance.assisted ? 'results-assisted' : 'results-unassisted'}">
            ${performance.assisted ? `Assisted · ${performance.hintPenalty}-point hint penalty` : 'Unassisted'}
          </div>
          ${answersHtml}
          ${renderSavedWordsCollection()}
        </div>
        
        <div class="results-actions">
          ${backBtn}
          ${gameMode === 'daily' ? practiceBtn : newPracticeBtn}
        </div>

        ${gameMode === 'daily' ? `<div class="results-footer">${lang === 'ko' ? '내일 다시 도전하세요!' : 'Come back tomorrow for the next Daily'}</div>` : ''}
      </div>
      
      ${renderLeaderboardModal()}
      ${renderDictionaryOverlay()}
    </div>
  `;
  requestAnimationFrame(setupPostGameReviewObserver);
}

function renderExpiredScreen() {
  const app = document.querySelector('#app');
  const snapshot = expiredSessionSnapshot;
  const snapshotState = snapshot?.gameState;
  const solvedCount = snapshotState?.boards?.filter((board) => board.solved).length || 0;
  const guessCount = snapshotState?.guessCount || 0;
  const maxGuesses = snapshotState?.maxGuesses || getLegacyLanguageConfig(currentLanguage).maxGuesses;
  const sessionLabel = snapshot?.gameMode === 'practice' ? 'Practice Session Expired' : 'Daily Session Expired';
  const resumeButton = snapshot
    ? `<button class="results-btn results-btn-primary resume-session-btn">Resume Saved Game</button>`
    : '';

  app.innerHTML = `
    <div class="quordle-container lang-${currentLanguage}">
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

/** Fetch the other languages' leaderboards via REST API. */
function fetchOtherLanguageLeaderboard() {
  if (!discordRoomId) return;
  const dateKey = getTodayDateKey();
  ['en', 'ko', 'zh'].filter((language) => language !== currentLanguage).forEach((language) => {
    const url = `${API_URL}/api/room/${discordRoomId}/${dateKey}/leaderboard?language=${language}`;
    fetch(url)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.leaderboard) return;
        if (language === 'ko') leaderboardKo = data.leaderboard;
        else if (language === 'zh') leaderboardZh = data.leaderboard;
        else leaderboardEn = data.leaderboard;
        renderLeaderboard();
      })
      .catch(err => console.warn(`Failed to fetch ${language} leaderboard:`, err));
  });
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
    const hintCount = Number.isFinite(entry.hintCount) ? entry.hintCount : 0;
    const score = Number.isFinite(entry.score)
      ? entry.score
      : Math.max(0, (25 * entry.solvedCount) - (2 * Math.max(0, entry.guessCount - entry.solvedCount)));
    const assisted = entry.assisted === true || hintCount > 0;
    const avatarHtml = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(displayName)}" class="leaderboard-avatar" onerror="this.style.display='none'" />`
      : `<div class="leaderboard-avatar-placeholder"></div>`;

    return `
      <div class="leaderboard-entry ${isYou ? 'leaderboard-entry-you' : ''} ${entry.gameOver ? 'leaderboard-entry-done' : ''}">
        <span class="leaderboard-rank">#${i + 1}</span>
        <span class="leaderboard-status ${statusClass}" title="${statusLabel}" aria-label="${statusLabel}"></span>
        <div class="leaderboard-profile">
          ${avatarHtml}
          <span class="leaderboard-name">${escapeHtml(displayName)}${youBadge}</span>
        </div>
        <span class="leaderboard-solved">${entry.solvedCount}/4</span>
        <span class="leaderboard-score" aria-label="Score ${score}">${score}p</span>
        <span class="leaderboard-hints ${assisted ? 'leaderboard-assisted' : 'leaderboard-unassisted'}" aria-label="${assisted ? `${hintCount} hints used` : 'Unassisted'}">${assisted ? `${hintCount}h` : 'U'}</span>
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
  const zhHtml = renderSingleLeaderboard('Chinese Leaderboard', leaderboardZh);

  // Show the current language's leaderboard first
  if (currentLanguage === 'ko') return koHtml + zhHtml + enHtml;
  if (currentLanguage === 'zh') return zhHtml + koHtml + enHtml;
  return enHtml + koHtml + zhHtml;
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
  const answer = currentLanguage === 'en'
    ? board.targetWord.toUpperCase()
    : currentLanguage === 'zh'
      ? board.targetId
      : board.targetWord;
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
        ${currentLanguage === 'zh' ? `<span class="solved-board-pinyin">${escapeHtml(board.targetWord.toUpperCase())}</span>` : ''}
        <span class="solved-board-meta">${solvedGuessCount} ${solvedGuessCount === 1 ? 'guess' : 'guesses'}</span>
        <span class="solved-board-chevron" aria-hidden="true">${expanded ? '▴' : '▾'}</span>
      </button>
      ${['ko', 'zh'].includes(currentLanguage) ? `<button
        class="solved-board-meaning"
        type="button"
        data-dictionary-word="${escapeHtml(currentLanguage === 'zh' ? board.targetId : board.targetWord)}"
        aria-label="Open meaning for ${escapeHtml(currentLanguage === 'zh' ? board.targetId : board.targetWord)}"
      >Meaning</button>` : ''}
      ${historyHtml}
    </article>
  `;
}

function renderActiveBoard(board, index) {
  const rows = [];
  const lang = currentLanguage;
  const wordLen = gameState.wordLength;

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
  const hintsEnabled = ['ko', 'zh'].includes(currentLanguage);
  const selected = hintsEnabled && selectedBoardIndex === index;
  const headerId = `board-header-${index}`;
  const headerHtml = hintsEnabled
    ? `<button
        class="board-select-button"
        id="${headerId}"
        type="button"
        data-select-board="${index}"
        aria-pressed="${selected}"
        aria-label="Select board ${index + 1} for hints${selected ? ', currently selected' : ''}"
      >
        <span>#${index + 1}</span>
        <span class="board-selected-indicator">${selected ? 'Selected' : 'Select'}</span>
      </button>`
    : `<div class="board-static-header" id="${headerId}"><span>#${index + 1}</span></div>`;

  return `
    <section class="board board-active ${selected ? 'board-selected' : ''}" aria-labelledby="${headerId}">
      ${headerHtml}
      ${rows.join('')}
      ${remainingHtml}
    </section>
  `;
}

function renderRow(guess, result, isCurrent = false, isCondensed = false, koResult = null) {
  const lang = currentLanguage;
  const wordLen = gameState.wordLength;
  const chars = lang === 'en' ? guess.padEnd(wordLen, ' ').split('') : Array.from(guess.padEnd(wordLen, ' '));

  const tiles = chars.map((ch, i) => {
    let tileClass = 'tile';
    if (result) {
      tileClass += ` tile-${result[i]}`;
    } else if (isCurrent && ch.trim()) {
      tileClass += ' tile-filled';
    }

    const display = ['en', 'zh'].includes(lang) ? ch.trim().toUpperCase() : ch.trim();

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
  const wordLen = getLegacyLanguageConfig('ko').wordLength;
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

function getKoreanNearbyCandidates(dictionary, recognition) {
  if (koreanNearbyCandidates && koreanRecognitionSnapshot === recognition) return koreanNearbyCandidates;
  koreanRecognitionSnapshot = recognition;
  koreanNearbyCandidates = Object.values(dictionary?.entries ?? {}).map((entry) => ({
    word: entry.word,
    level: recognition?.words?.[entry.word] ?? 'ungraded',
    answerEligible: entry.answerEligible === true,
  }));
  return koreanNearbyCandidates;
}

async function resolveRejectedKoreanGuess(word) {
  const sourceWord = String(word ?? '').normalize('NFC');
  reportDailyInvalidGuess(sourceWord);
  const requestId = rejectedGuessRequestId + 1;
  rejectedGuessRequestId = requestId;
  guessFeedback = createKoreanFeedback('loading', [], sourceWord);
  renderApp();
  setupKeyboardListeners();

  try {
    const [dictionary, recognition] = await Promise.all([
      loadKoreanDictionarySnapshot(),
      loadKoreanRecognitionSnapshot(),
    ]);

    if (!isKoreanDiscoveryRequestCurrent({
      requestId,
      activeRequestId: rejectedGuessRequestId,
      sourceWord,
      currentWord: gameState?.currentGuess,
      currentLanguage,
      gameOver: gameState?.gameOver,
    })) return;

    dictionarySnapshot = dictionary;
    dictionaryLoadState = 'loaded';
    dictionaryLoadError = null;
    const acceptedWords = new Set(Object.keys(dictionary.entries ?? {}));
    const classification = classifyKoreanGuess(sourceWord, acceptedWords, recognition.words ?? {});
    const excludedWords = gameState.boards
      .filter((board) => !board.solved)
      .map((board) => board.targetWord);
    const ranked = rankNearbyKoreanWords(
      sourceWord,
      getKoreanNearbyCandidates(dictionary, recognition),
      { excludedWords, limit: 3 },
    );
    const suggestions = toKoreanNearbySuggestions(ranked, dictionary.entries);
    const feedbackKind = classification === 'unrecognized'
      ? 'unrecognized'
      : 'recognized-unaccepted';
    guessFeedback = createKoreanFeedback(feedbackKind, suggestions, sourceWord);
    if (gameMode === 'practice') {
      trackLearningEvent('invalid_guess_submitted', {
        classification: feedbackKind,
        ...(feedbackKind === 'recognized-unaccepted' ? { word: sourceWord } : {}),
      });
    }
    renderApp();
    setupKeyboardListeners();
  } catch (error) {
    console.error('Failed to load Korean word discovery data:', error);
    if (!isKoreanDiscoveryRequestCurrent({
      requestId,
      activeRequestId: rejectedGuessRequestId,
      sourceWord,
      currentWord: gameState?.currentGuess,
      currentLanguage,
      gameOver: gameState?.gameOver,
    })) return;

    guessFeedback = createKoreanFeedback('load-failure', [], sourceWord);
    if (gameMode === 'practice') {
      trackLearningEvent('invalid_guess_submitted', { classification: 'unrecognized' });
    }
    renderApp();
    setupKeyboardListeners();
  }
}

async function submitChineseDraft() {
  if (chineseInputState.pendingSubmission) return;
  if (!chineseGuessKeys || chineseGuessKeysLength !== gameState.wordLength) {
    await ensureChineseGuessKeysLoaded({ rerender: false });
  }
  const attempt = beginChineseSubmission(chineseInputState, gameState.guessCount);
  chineseInputState = attempt.state;
  syncChineseGuessState();
  persistChineseDraft();
  if (!attempt.submission) {
    setMessageFeedback(chineseInputState.error, 'word-list-error');
    if (chineseInputState.validationCode) {
      if (gameMode === 'daily') reportDailyInvalidGuess(chineseInputState.sourceText);
      else trackLearningEvent('invalid_guess_submitted', {
        classification: chineseInputState.validationCode.toLowerCase().replaceAll('_', '-'),
      });
    }
    renderApp();
    setupKeyboardListeners();
    focusChineseInput();
    return;
  }
  clearGuessFeedback();
  renderApp();
  setupKeyboardListeners();
  await submitChineseGuessWithPersistence(attempt.submission);
}

function handleKeyPress(key) {
  if (!gameState || gameState.gameOver || uiScreen === "expired" || activeOverlay) return;

  const lang = currentLanguage;
  const wordLen = gameState.wordLength;

  if (lang === 'zh') {
    if (key === KEY_ENTER) {
      submitChineseDraft();
    } else if (key === KEY_BACKSPACE) {
      clearGuessFeedback();
      applyChineseInput(backspaceChineseInput(chineseInputState, getChineseInputOptions()));
    } else if (key.length === 1 && /^[A-Z]$/i.test(key)) {
      clearGuessFeedback();
      applyChineseInput(appendChinesePinyinKey(chineseInputState, key, getChineseInputOptions()));
    }
  } else if (lang === 'ko') {
    // ===== Korean mode =====
    if (key === KEY_SHIFT) {
      koreanShiftActive = !koreanShiftActive;
      clearGuessFeedback();
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
        if (!isValidLegacyGuessForLanguage(gameState.currentGuess, 'ko')) {
          resolveRejectedKoreanGuess(gameState.currentGuess);
          return;
        }
        const validation = validateGuess(gameState.currentGuess, 'ko');
        if (validation.valid) {
          clearGuessFeedback();
          submitGuessWithPersistence(gameState.currentGuess);
        }
      }
    } else if (key === KEY_BACKSPACE) {
      clearGuessFeedback();
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
      clearGuessFeedback();
      renderApp();
      setupKeyboardListeners();
    }
  } else {
    // ===== English mode =====
    if (key === KEY_ENTER) {
      if (gameState.currentGuess.length === wordLen) {
        if (!isValidGuess(gameState.currentGuess)) {
          setMessageFeedback('Not in word list', 'word-list-error');
          if (gameMode === 'daily') reportDailyInvalidGuess(gameState.currentGuess);
          else trackLearningEvent('invalid_guess_submitted', { classification: 'not-in-list' });
          renderApp();
          setupKeyboardListeners();
          return;
        }
        const validation = validateGuess(gameState.currentGuess);
        if (validation.valid) {
          clearGuessFeedback();
          submitGuessWithPersistence(gameState.currentGuess);
        }
      }
    } else if (key === KEY_BACKSPACE) {
      clearGuessFeedback();
      gameState = setCurrentGuess(gameState, gameState.currentGuess.slice(0, -1));
      renderApp();
      setupKeyboardListeners();
    } else if (key.length === 1 && /^[A-Z]$/i.test(key)) {
      if (gameState.currentGuess.length < wordLen) {
        clearGuessFeedback();
        gameState = setCurrentGuess(gameState, gameState.currentGuess + key.toLowerCase());
        renderApp();
        setupKeyboardListeners();
      }
    }
  }
}

function recordPracticeGuessTransition(previousState, nextState, guess) {
  const guessNumber = nextState.guessCount;
  const isPinyin = nextState.puzzleVariant === CHINESE_PINYIN_PUZZLE_VARIANT;
  trackLearningEvent(
    'valid_guess_submitted',
    isPinyin ? { guessKey: guess } : { word: guess },
    `guess:${guessNumber}`,
  );
  nextState.boards.forEach((board, boardIndex) => {
    if (!previousState.boards[boardIndex].solved && board.solved) {
      trackLearningEvent('board_solved', {
        boardIndex,
        word: isPinyin ? board.targetId : board.targetWord,
      }, `board-solved:${boardIndex}:${guessNumber}`);
    }
  });
  if (!previousState.gameOver && nextState.gameOver) {
    nextState.boards.forEach((board, boardIndex) => {
      if (!board.solved) {
        trackLearningEvent('board_failed', {
          boardIndex,
          word: isPinyin ? board.targetId : board.targetWord,
        }, `board-failed:${boardIndex}`);
      }
    });
    const performance = calculatePerformanceMetrics(nextState);
    trackLearningEvent('round_completed', {
      metrics: {
        won: nextState.won,
        assisted: performance.assisted,
        guessCount: performance.guessCount,
        score: performance.score,
        solvedCount: performance.solvedCount,
        failedCount: 4 - performance.solvedCount,
      },
    }, 'round-completed');
  }
}

async function submitChineseGuessWithPersistence(submission) {
  const previousGameState = gameState;
  if (gameMode === 'daily' && discordUserId && discordRoomId) {
    if (sendGuessViaWebSocket(submission.sourceText, submission.submissionId)) {
      startGuessRequestTimeout();
      return;
    }

    const result = await serverSubmitGuess(submission.sourceText, submission.submissionId);
    if (!result.ok) {
      rejectPendingChineseSubmission(result.error, getChineseSubmissionFailureOptions({
        status: result.status,
        code: result.code,
        requestSubmissionId: submission.submissionId,
        responseSubmissionId: result.submissionId,
      }));
      setMessageFeedback(result.error, result.code === 'NETWORK_ERROR' ? 'network-error' : 'server-error');
      renderApp();
      setupKeyboardListeners();
      focusChineseInput();
      return;
    }
    const serverState = result.data;
    const nextLanguage = serverState?.language || currentLanguage;
    const normalizedState = normalizeRestoredGameState(serverState?.gameState, nextLanguage);
    if (!normalizedState || !isChineseSubmissionConfirmed(chineseInputState, {
      ...serverState,
      gameState: normalizedState,
    })) {
      const message = 'The server did not confirm this guess. Your Pinyin draft was preserved.';
      rejectPendingChineseSubmission(message, { retainSubmissionFingerprint: true });
      setMessageFeedback(message, 'server-error');
      renderApp();
      setupKeyboardListeners();
      focusChineseInput();
      return;
    }

    chineseInputState = confirmChineseSubmission(chineseInputState);
    persistChineseDraft();
    restoreSavedPayload({
      gameState: normalizedState,
      gameMode: serverState.gameMode || gameMode,
      language: nextLanguage,
      dateKey: serverState.dateKey || getTodayDateKey(),
      lastActiveAt: Date.now(),
      savedAt: Date.now(),
    }, { markActive: true });
    saveGameState();
    renderApp();
    setupKeyboardListeners();
    return;
  }

  const nextState = applyValidatedGuess(previousGameState, submission.normalizedText);
  if (nextState.guessCount <= previousGameState.guessCount) {
    const message = 'The Pinyin guess was not accepted. Your draft was preserved.';
    rejectPendingChineseSubmission(message);
    setMessageFeedback(message, 'word-list-error');
    renderApp();
    setupKeyboardListeners();
    focusChineseInput();
    return;
  }
  gameState = nextState;
  if (gameMode === 'practice') {
    recordPracticeGuessTransition(previousGameState, nextState, submission.normalizedText);
  }
  chineseInputState = confirmChineseSubmission(chineseInputState);
  persistChineseDraft();
  setUiScreenFromGameState();
  saveGameState();
  renderApp();
  setupKeyboardListeners();
}

async function submitGuessWithPersistence(guess) {
  // Immediately clear currentGuess to prevent double-submit.
  // In the WS path, state update is async (server responds with STATE),
  // so without this, a rapid second Enter press would pass the length === 5
  // guard in handleKeyPress and send the same guess again.
  clearGuessFeedback();
  gameState = setCurrentGuess(gameState, '');
  const previousGameState = gameState;
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
    const serverResult = await serverSubmitGuess(guess);
    const serverState = serverResult.ok ? serverResult.data : null;
    if (serverState?.gameState) {
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
  gameState = applyValidatedGuess(gameState, guess);
  if (gameMode === 'practice') recordPracticeGuessTransition(previousGameState, gameState, guess);
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
        hintRequestError = null;
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

  const dictionaryTrigger = document.querySelector('.dictionary-trigger:not([disabled])');
  if (dictionaryTrigger) {
    dictionaryTrigger.addEventListener('click', () => openDictionary(null, '.dictionary-trigger'));
  }

  const hintTrigger = document.querySelector('.hint-trigger:not([disabled])');
  if (hintTrigger) {
    hintTrigger.addEventListener('click', openHintOverlay);
  }

  document.querySelectorAll('[data-hint-type]:not([disabled])').forEach((button) => {
    button.addEventListener('click', () => {
      const hintType = button.dataset.hintType;
      if (!Number.isInteger(selectedBoardIndex) || !hintType) return;
      requestBoardHint(selectedBoardIndex, hintType);
    });
  });

  document.querySelectorAll('[data-dictionary-word]').forEach((button) => {
    button.addEventListener('click', () => {
      const word = button.dataset.dictionaryWord;
      if (!word) return;
      openDictionary(word, `[data-dictionary-word="${CSS.escape(word)}"]`);
    });
  });

  document.querySelectorAll('[data-nearby-word]').forEach((button) => {
    button.addEventListener('click', () => {
      const word = button.dataset.nearbyWord;
      if (!word || !getSafeFeedbackSuggestionWords().includes(word.normalize('NFC'))) return;
      trackLearningEvent('nearby_suggestion_selected', { word, surface: 'rejected-guess' });
      openDictionary(word, `[data-nearby-word="${CSS.escape(word)}"]`);
    });
  });

  document.querySelectorAll('[data-save-word]:not([disabled])').forEach((button) => {
    button.addEventListener('click', () => {
      const word = button.dataset.saveWord;
      if (!word) return;
      toggleSavedWord(word, button.dataset.saveSource || 'dictionary');
    });
  });

  const inlineRetry = document.querySelector('.dictionary-inline-retry');
  if (inlineRetry) {
    inlineRetry.addEventListener('click', () => {
      dictionaryLoadState = 'idle';
      dictionaryLoadError = null;
      chineseDictionaryLoadState = 'idle';
      chineseDictionaryLoadError = null;
      if (currentLanguage === 'ko') ensureKoreanDictionaryLoaded();
      else if (currentLanguage === 'zh') ensureChineseDictionaryLoaded(
        gameState.boards.map((board) => board.targetId).filter(Boolean),
      );
      renderApp();
      setupKeyboardListeners();
    });
  }

  const savedWordsRetry = document.querySelector('.saved-words-retry');
  if (savedWordsRetry) {
    savedWordsRetry.addEventListener('click', () => {
      if (appSessionToken) loadSavedWords();
      else if (!discordSdk) loadLocalSavedWordState();
      renderApp();
      setupKeyboardListeners();
    });
  }

  bindActiveOverlayInteractions();

  const chineseInput = document.querySelector('.chinese-guess-input');
  if (chineseInput) {
    chineseInput.addEventListener('compositionstart', () => {
      chineseCompositionActive = true;
    });
    chineseInput.addEventListener('compositionend', () => {
      chineseCompositionActive = false;
      clearGuessFeedback();
      applyChineseInput(updateChineseInput(
        chineseInputState,
        chineseInput.value,
        getChineseInputOptions(),
      ));
    });
    chineseInput.addEventListener('input', () => {
      if (chineseCompositionActive) return;
      clearGuessFeedback();
      applyChineseInput(updateChineseInput(
        chineseInputState,
        chineseInput.value,
        getChineseInputOptions(),
      ));
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

  if (activeOverlay) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeActiveOverlay();
    }
    return;
  }

  if (currentLanguage === 'zh' && e.target?.matches?.('.chinese-guess-input')) {
    if (e.isComposing || chineseCompositionActive) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      handleKeyPress(KEY_ENTER);
    }
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    handleKeyPress(KEY_ENTER);
  } else if (e.key === 'Backspace') {
    e.preventDefault();
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
    e.preventDefault();
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
  if (!SUPPORTED_LANGUAGES.has(newLang) || newLang === currentLanguage) return;

  // Save current game before switching
  saveGameState();

  // Switch language
  currentLanguage = newLang;
  localStorage.setItem('quordle_language', newLang);
  resetOverlayState();
  resetBoardScrollPosition();
  resetBoardUiState();
  expiredSessionSnapshot = null;
  koreanShiftActive = false;
  imeReset();
  clearGuessRequestTimeout();
  chineseGuessKeyRequestId += 1;
  chineseGuessKeys = null;
  chineseGuessKeysLength = null;
  chineseInputState = createChineseInputState();
  clearGuessFeedback();
  savedWords = [];
  savedWordsLoadState = 'idle';
  savedWordsError = null;
  pendingSavedWord = null;
  loadSavedWords();

  // Try to load existing game for the new language
  if (gameMode === 'daily') {
    const loadStatus = loadGameState();
    if (loadStatus === "expired") {
      uiScreen = "expired";
    } else if (loadStatus !== "restored") {
      // No saved daily for this language, create new one
      const dateKey = getTodayDateKey();
      currentRoundId = getClientRoundId({ mode: 'daily', language: currentLanguage, dateKey });
      roundStartedAt = Date.now();
      gameState = createFreshClientGame('daily', dateKey);
      resetChineseInput();
      if (currentLanguage === 'zh') ensureChineseGuessKeysLoaded();
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
      currentRoundId = getClientRoundId({
        mode: 'practice',
        language: currentLanguage,
        instanceId: crypto.randomUUID(),
      });
      roundStartedAt = Date.now();
      gameState = createFreshClientGame('practice');
      resetChineseInput();
      if (currentLanguage === 'zh') ensureChineseGuessKeysLoaded();
      uiScreen = "game";
      lastActivityAt = Date.now();
      saveGameState();
      trackLearningEvent('round_started', {}, 'round-started');
    }
  }

  renderApp();
  setupKeyboardListeners();
}
window.switchLanguage = switchLanguage;
