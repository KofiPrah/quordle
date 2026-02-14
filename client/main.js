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
import { isHangulSyllable, decomposeHangul, composeHangul, isConsonant, isVowel, canBeOnset, canBeCoda, combineCodas, splitCompoundCoda, ONSETS, VOWELS } from "../engine/src/jamo.ts";

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
    // Send JOIN message with profile and guild context (for announcements)
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
        initialStateApplied = true;
        gameState = message.playerState.gameState;
        gameMode = message.playerState.mode || 'daily';
        guessError = null;
        if (gameState.gameOver) uiScreen = "results";
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
function getStorageKeyDaily() { return `quordle_daily_${currentLanguage}`; }
function getStorageKeyPractice() { return `quordle_practice_${currentLanguage}`; }

function saveGameState() {
  try {
    const key = gameMode === "daily" ? getStorageKeyDaily() : getStorageKeyPractice();
    const payload = {
      gameState,
      gameMode,
      language: currentLanguage,
      dateKey: gameMode === "daily" ? getTodayDateKey() : null,
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (e) {
    console.warn("Failed to save game state:", e);
  }
}

function loadGameState() {
  // Try to restore daily first
  try {
    const dailyData = localStorage.getItem(getStorageKeyDaily());
    if (dailyData) {
      const parsed = JSON.parse(dailyData);
      const todayKey = getTodayDateKey();
      if (parsed.dateKey === todayKey && parsed.gameState) {
        gameState = parsed.gameState;
        gameMode = "daily";
        return true;
      }
    }
  } catch (e) {
    console.warn("Failed to load daily game state:", e);
  }
  return false;
}

function loadPracticeState() {
  try {
    const practiceData = localStorage.getItem(getStorageKeyPractice());
    if (practiceData) {
      const parsed = JSON.parse(practiceData);
      if (parsed.gameState) {
        gameState = parsed.gameState;
        gameMode = "practice";
        return true;
      }
    }
  } catch (e) {
    console.warn("Failed to load practice game state:", e);
  }
  return false;
}

function clearGameStorage() {
  try {
    localStorage.removeItem(getStorageKeyDaily());
    localStorage.removeItem(getStorageKeyPractice());
  } catch (e) {
    console.warn("Failed to clear game storage:", e);
  }
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

const discordSdk = new DiscordSDK(DISCORD_CLIENT_ID);

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

function initQuordleGame() {
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
      initialStateApplied = true;
      gameState = serverState.gameState;
      gameMode = serverState.gameMode || "daily";
      guessError = null;
      if (gameState.gameOver) uiScreen = "results";
      // Also save to localStorage as backup
      saveGameState();
      renderApp();
      setupKeyboardListeners();
      return;
    }
  }

  // Fallback: try to restore from localStorage
  if (loadGameState()) {
    guessError = null;
    if (gameState.gameOver) uiScreen = "results";
    renderApp();
    setupKeyboardListeners();
    return;
  }

  // No valid save, start fresh daily
  gameMode = "daily";
  const dateKey = getTodayDateKey();
  const targetWords = getDailyTargets(dateKey, currentLanguage);
  gameState = createGame({ targetWords, language: currentLanguage });
  guessError = null;
  saveGameState();
  renderApp();
  setupKeyboardListeners();
}

function renderApp() {
  if (uiScreen === "results") {
    renderResultsScreen();
  } else {
    renderGameScreen();
  }
}

// Keep backward compat alias
const renderGame = renderApp;

function renderGameScreen() {
  const app = document.querySelector('#app');
  const solvedCount = gameState.boards.filter(b => b.solved).length;
  const lang = currentLanguage;

  // Minimal status bar when game is over (full results on Results screen)
  const statusHtml = gameState.gameOver
    ? `<div class="game-status game-status-done">
        ${gameState.won ? '🎉' : '💔'} ${gameState.won ? 'Won' : 'Lost'} · ${solvedCount}/4 · ${gameState.guessCount} guesses
        <button class="results-link-btn">View Results →</button>
      </div>`
    : `<div class="game-status">
        Solved: ${solvedCount}/4 | Guesses: ${gameState.guessCount}/${gameState.maxGuesses}
      </div>`;

  // Language toggle
  const langToggle = `
    <div class="lang-toggle">
      <button class="lang-btn ${lang === 'en' ? 'lang-btn-active' : ''}" data-lang="en">🇺🇸 EN</button>
      <button class="lang-btn ${lang === 'ko' ? 'lang-btn-active' : ''}" data-lang="ko">🇰🇷 KO</button>
    </div>
  `;

  app.innerHTML = `
    <div class="quordle-container ${lang === 'ko' ? 'lang-ko' : 'lang-en'}">
      <div class="game-header">
        <h1 class="game-title">Quordle${gameMode === 'practice' ? ' <span class="mode-badge">Practice</span>' : ''}</h1>
        ${langToggle}
      </div>
      
      ${statusHtml}
      
      <div class="game-layout">
        <div class="boards-grid">
          ${gameState.boards.map((board, i) => renderBoard(board, i)).join('')}
        </div>
        
        <div class="leaderboard-panel" id="leaderboard-panel">
          ${renderLeaderboardContent()}
        </div>
      </div>
      
      ${renderCurrentGuess()}
      
      ${currentLanguage === 'ko' ? renderKoreanKeyboard() : renderKeyboard()}
    </div>
  `;
}

function renderResultsScreen() {
  const app = document.querySelector('#app');
  const solvedCount = gameState.boards.filter(b => b.solved).length;
  const icon = gameState.won ? '🎉' : '💔';
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
        ${langToggle}
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
      
      <div class="keyboard-spacer"></div>
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
    const statusIcon = entry.gameOver ? (entry.won ? '🏆' : '💀') : '🎮';
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
        <span class="leaderboard-status">${statusIcon}</span>
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
  const enHtml = renderSingleLeaderboard('🇺🇸 English Leaderboard', leaderboardEn);
  const koHtml = renderSingleLeaderboard('🇰🇷 Korean Leaderboard', leaderboardKo);

  // Show the current language's leaderboard first
  if (currentLanguage === 'ko') {
    return koHtml + enHtml;
  }
  return enHtml + koHtml;
}

// renderBanner removed — game status is now inline in renderGameScreen,
// full results are in renderResultsScreen

function renderBoard(board, index) {
  const rows = [];
  const currentGuessIndex = gameState.guessCount; // 0-based index for current input row
  const lang = currentLanguage;
  const wordLen = getLanguageConfig(lang).wordLength;
  const emptyStr = ' '.repeat(wordLen);

  // Determine solve row index (0-based) if board is solved
  const solveRowIndex = board.solvedOnGuess !== null ? board.solvedOnGuess - 1 : null;

  // Submitted guesses (always condensed style)
  for (let i = 0; i < board.guesses.length; i++) {
    // If board is solved and this row is after the solve, show condensed empty
    if (solveRowIndex !== null && i > solveRowIndex) {
      rows.push(renderRow(emptyStr, null, false, true, null)); // condensed empty
    } else {
      const koResult = (lang === 'ko' && board.koResults) ? board.koResults[i] : null;
      rows.push(renderRow(board.guesses[i], board.results[i], false, true, koResult)); // condensed with result
    }
  }

  // Current guess row (full tiles, only if board not solved and game not over)
  if (!board.solved && !gameState.gameOver && board.guesses.length < gameState.maxGuesses) {
    // Pad current guess for display
    const displayGuess = lang === 'ko'
      ? (gameState.currentGuess + compositionDisplayChar()).padEnd(wordLen, ' ')
      : gameState.currentGuess.padEnd(wordLen, ' ');
    rows.push(renderRow(displayGuess, null, true, false, null)); // full tiles
  }

  // Empty rows after current (condensed empty)
  const emptyRowStart = board.solved || gameState.gameOver ? board.guesses.length : board.guesses.length + 1;
  for (let i = emptyRowStart; i < gameState.maxGuesses; i++) {
    rows.push(renderRow(emptyStr, null, false, true, null)); // condensed empty
  }

  const solvedClass = board.solved ? 'board-solved' : '';
  return `
    <div class="board ${solvedClass}">
      <div class="board-number">#${index + 1}</div>
      ${rows.join('')}
    </div>
  `;
}

function renderRow(guess, result, isCurrent = false, isCondensed = false, koResult = null) {
  const lang = currentLanguage;
  const wordLen = getLanguageConfig(lang).wordLength;
  // For Korean, split by character. For English, split by letter.
  const chars = lang === 'ko' ? Array.from(guess.padEnd(wordLen, ' ')) : guess.padEnd(wordLen, ' ').split('');

  const tiles = chars.map((ch, i) => {
    let tileClass = 'tile';
    if (result) {
      tileClass += ` tile-${result[i]}`;
    } else if (isCurrent && ch.trim()) {
      tileClass += ' tile-filled';
    }

    // Display character
    const display = lang === 'ko' ? ch.trim() : ch.trim().toUpperCase();

    // Jamo hint indicators (Korean only, for non-correct scored tiles)
    let jamoHintHtml = '';
    if (lang === 'ko' && koResult && koResult[i] && koResult[i].jamoHints && result && result[i] !== 'correct') {
      const h = koResult[i].jamoHints;
      jamoHintHtml = `
        <div class="jamo-hints">
          <span class="jamo-dot jamo-${h.onset}" title="초성"></span>
          <span class="jamo-dot jamo-${h.vowel}" title="중성"></span>
          ${h.coda !== null ? `<span class="jamo-dot jamo-${h.coda}" title="종성"></span>` : ''}
        </div>
      `;
    }

    return `<div class="${tileClass}">${display}${jamoHintHtml}</div>`;
  }).join('');

  const rowClass = isCondensed ? 'row row-condensed' : 'row';
  return `<div class="${rowClass}">${tiles}</div>`;
}

function renderCurrentGuess() {
  if (gameState.gameOver) return '';
  const lang = currentLanguage;
  const displayText = lang === 'ko'
    ? (gameState.currentGuess + compositionDisplayChar()) || '—'
    : (gameState.currentGuess.toUpperCase() || '—');
  const errorHtml = guessError
    ? `<div class="guess-error">${guessError}</div>`
    : '';
  return `
    <div class="current-guess-display">
      Current: <span class="guess-text">${displayText}</span>
      ${errorHtml}
    </div>
  `;
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
    ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫']
  ];

  const boardStatuses = computeKeyboardBoardMap(gameState);

  return `
    <div class="keyboard">
      ${rows.map(row => `
        <div class="keyboard-row">
          ${row.map(key => {
    const lowerKey = key.toLowerCase();
    const widthClass = key.length > 1 ? 'key-wide' : '';
    const grid = key.length === 1 ? renderBoardGrid(boardStatuses, lowerKey) : '';
    return `<button class="key ${widthClass}" data-key="${key}">${grid}<span class="key-label">${key}</span></button>`;
  }).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

// ========== KOREAN KEYBOARD (두벌식) ==========
function renderKoreanKeyboard() {
  // Standard 2-set (두벌식) layout:
  // Row 1: ㅂ ㅈ ㄷ ㄱ ㅅ ㅛ ㅕ ㅑ ㅐ ㅔ
  // Row 2: ㅁ ㄴ ㅇ ㄹ ㅎ ㅗ ㅓ ㅏ ㅣ
  // Row 3: ENTER ㅋ ㅌ ㅊ ㅍ ㅠ ㅜ ㅡ ⌫
  // Row 4 (doubles): ㅃ ㅉ ㄸ ㄲ ㅆ (toggled via ⇧)
  const rows = [
    ['ㅂ', 'ㅈ', 'ㄷ', 'ㄱ', 'ㅅ', 'ㅛ', 'ㅕ', 'ㅑ', 'ㅐ', 'ㅔ'],
    ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
    ['ENTER', 'ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ', '⌫'],
    ['⇧', 'ㅃ', 'ㅉ', 'ㄸ', 'ㄲ', 'ㅆ'],
  ];

  const boardStatuses = computeKeyboardBoardMap(gameState);

  return `
    <div class="keyboard keyboard-ko">
      ${rows.map(row => `
        <div class="keyboard-row">
          ${row.map(key => {
    const isSpecial = (key === 'ENTER' || key === '⌫' || key === '⇧');
    const widthClass = isSpecial ? 'key-wide' : '';
    const grid = !isSpecial ? renderBoardGrid(boardStatuses, key) : '';
    return `<button class="key ${widthClass}" data-key="${key}">${grid}<span class="key-label">${key}</span></button>`;
  }).join('')}
        </div>
      `).join('')}
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

let imeState = {
  onset: null,    // onset jamo or null
  vowel: null,    // vowel jamo or null
  coda: null,     // coda jamo or null (single or compound)
};

function imeReset() {
  imeState = { onset: null, vowel: null, coda: null };
}

/** Get the currently composing character for display (partial syllable or jamo) */
function compositionDisplayChar() {
  if (!imeState.onset && !imeState.vowel) return '';
  if (imeState.onset && !imeState.vowel) return imeState.onset; // standalone jamo
  if (imeState.onset && imeState.vowel) {
    return composeHangul(imeState.onset, imeState.vowel, imeState.coda);
  }
  return '';
}

/** Finalize the current composition: append the composed syllable to currentGuess */
function imeFinalize() {
  const ch = compositionDisplayChar();
  imeReset();
  return ch;
}

/**
 * Process a jamo keypress through the IME.
 * Returns { committed: string, display: string } where:
 *   - committed: fully composed syllable(s) to append to gameState.currentGuess
 *   - display: the current in-progress composition character (for display only)
 */
function imeProcessJamo(jamo) {
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
      // Phase 2: Already have onset+vowel, new vowel — finalize and start new
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
function imeBackspace() {
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
    imeState.vowel = null;
    return { modified: true, display: imeState.onset || '' };
  }
  if (imeState.onset) {
    imeState.onset = null;
    return { modified: true, display: '' };
  }
  return { modified: false, display: '' };
}

function handleKeyPress(key) {
  if (gameState.gameOver) return;

  const lang = currentLanguage;
  const wordLen = getLanguageConfig(lang).wordLength;

  if (lang === 'ko') {
    // ===== Korean mode =====
    if (key === 'ENTER') {
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
    } else if (key === '⌫' || key === 'BACKSPACE') {
      guessError = null;
      const result = imeBackspace();
      if (!result.modified) {
        // IME was empty, remove last committed syllable
        gameState = setCurrentGuess(gameState, gameState.currentGuess.slice(0, -1));
      }
      renderApp();
      setupKeyboardListeners();
    } else if (key === '⇧') {
      // Shift key — handled by the double consonant keys directly
      return;
    } else if (isConsonant(key) || isVowel(key)) {
      // Check if we'd exceed word length with committed chars
      const { committed, display } = imeProcessJamo(key);
      if (committed) {
        if (gameState.currentGuess.length < wordLen) {
          gameState = setCurrentGuess(gameState, gameState.currentGuess + committed);
        }
      }
      guessError = null;
      renderApp();
      setupKeyboardListeners();
    }
  } else {
    // ===== English mode =====
    if (key === 'ENTER') {
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
    } else if (key === '⌫' || key === 'BACKSPACE') {
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
      gameState = serverState.gameState;
      if (gameState.gameOver) uiScreen = "results";
      saveGameState(); // Backup to localStorage
      renderApp();
      setupKeyboardListeners();
      return;
    }
  }

  // Fallback: local-only submission (practice mode or no server)
  gameState = submitGuess(gameState, guess);
  if (gameState.gameOver) uiScreen = "results";
  saveGameState();
  renderApp();
  setupKeyboardListeners();
}

function setupKeyboardListeners() {
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
      uiScreen = "game";
      startPracticeGame();
    });
  }

  // New practice game button (after practice game ends)
  const newGameBtn = document.querySelector('.new-game-btn');
  if (newGameBtn) {
    newGameBtn.addEventListener('click', () => {
      uiScreen = "game";
      startPracticeGame();
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

  if (e.key === 'Enter') {
    handleKeyPress('ENTER');
  } else if (e.key === 'Backspace') {
    handleKeyPress('BACKSPACE');
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
  gameMode = "practice";
  uiScreen = "game";
  initialStateApplied = false;
  imeReset();
  const targetWords = currentLanguage === 'ko'
    ? getQuordleWordsForLanguage('ko')
    : getQuordleWords();
  gameState = createGame({ targetWords, language: currentLanguage });
  guessError = null;
  saveGameState(); // Save new practice game
  renderApp();
  setupKeyboardListeners();
}
window.startPractice = startPracticeGame; // Keep for backwards compat

// Reset game - clears storage and starts fresh
function resetGame() {
  clearGameStorage();
  gameMode = "daily";
  uiScreen = "game";
  initialStateApplied = false;
  imeReset();
  const dateKey = getTodayDateKey();
  const targetWords = getDailyTargets(dateKey, currentLanguage);
  gameState = createGame({ targetWords, language: currentLanguage });
  guessError = null;
  saveGameState();
  renderApp();
  setupKeyboardListeners();
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
  imeReset();
  guessError = null;

  // Try to load existing game for the new language
  if (gameMode === 'daily') {
    if (!loadGameState()) {
      // No saved daily for this language, create new one
      const dateKey = getTodayDateKey();
      const targetWords = getDailyTargets(dateKey, currentLanguage);
      gameState = createGame({ targetWords, language: currentLanguage });
      saveGameState();
    }
    if (gameState.gameOver) uiScreen = "results";
    else uiScreen = "game";

    // Re-JOIN via WebSocket so the server creates/loads player state for the new language
    if (ws && ws.readyState === WebSocket.OPEN && discordUserId && discordRoomId) {
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
  } else {
    // Practice mode — start fresh for new language
    const targetWords = currentLanguage === 'ko'
      ? getQuordleWordsForLanguage('ko')
      : getQuordleWords();
    gameState = createGame({ targetWords, language: currentLanguage });
    uiScreen = "game";
    saveGameState();
  }

  renderApp();
  setupKeyboardListeners();
}
window.switchLanguage = switchLanguage;