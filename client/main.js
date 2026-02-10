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
import { createGame, submitGuess, setCurrentGuess, validateGuess, getSolvedCount, computeKeyboardMap } from "../engine/src/game.ts";
import { evaluateGuess } from "../engine/src/evaluator.ts";
import { getQuordleWords, isValidGuess } from "../engine/src/words.ts";
import { getDailyTargets } from "../engine/src/daily.ts";

// Will eventually store the authenticated user's access_token
let auth;
let gameState;
let guessError = null; // Error message for invalid guesses
let gameMode = "daily"; // "daily" | "practice"
let uiScreen = "game"; // "game" | "results"

// Discord context for server-side persistence
let discordUserId = null;
let discordRoomId = null;
let discordGuildId = null;
let discordChannelId = null;
let userProfile = { displayName: 'Player', avatarUrl: null }; // Current user's profile info

// WebSocket connection
let ws = null;
let wsReconnectTimeout = null;
let leaderboard = []; // Current room leaderboard

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
      // Update leaderboard
      if (window.DEBUG_LEADERBOARD) {
        console.log('[LEADERBOARD DEBUG] Received message:', message);
        console.log('[LEADERBOARD DEBUG] message.leaderboard:', message.leaderboard);
        console.log('[LEADERBOARD DEBUG] leaderboard length:', message.leaderboard?.length);
      }
      leaderboard = message.leaderboard || [];
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
    guess
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
const STORAGE_KEY_DAILY = "quordle_daily";
const STORAGE_KEY_PRACTICE = "quordle_practice";

function saveGameState() {
  try {
    const key = gameMode === "daily" ? STORAGE_KEY_DAILY : STORAGE_KEY_PRACTICE;
    const payload = {
      gameState,
      gameMode,
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
    const dailyData = localStorage.getItem(STORAGE_KEY_DAILY);
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
    const practiceData = localStorage.getItem(STORAGE_KEY_PRACTICE);
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
    localStorage.removeItem(STORAGE_KEY_DAILY);
    localStorage.removeItem(STORAGE_KEY_PRACTICE);
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
      body: JSON.stringify({ roomId: discordRoomId, userId: discordUserId, dateKey }),
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
      body: JSON.stringify({ roomId: discordRoomId, userId: discordUserId, guess, dateKey }),
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
    // Only apply server state if we're still in daily mode (user may have switched to practice while awaiting)
    if (serverState && serverState.gameState && gameMode !== 'practice') {
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
  const targetWords = getDailyTargets(dateKey);
  gameState = createGame({ targetWords });
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

  // Minimal status bar when game is over (full results on Results screen)
  const statusHtml = gameState.gameOver
    ? `<div class="game-status game-status-done">
        ${gameState.won ? '🎉' : '💔'} ${gameState.won ? 'Won' : 'Lost'} · ${solvedCount}/4 · ${gameState.guessCount} guesses
        <button class="results-link-btn">View Results →</button>
      </div>`
    : `<div class="game-status">
        Solved: ${solvedCount}/4 | Guesses: ${gameState.guessCount}/${gameState.maxGuesses}
      </div>`;

  app.innerHTML = `
    <div class="quordle-container">
      <h1 class="game-title">Quordle${gameMode === 'practice' ? ' <span class="mode-badge">Practice</span>' : ''}</h1>
      
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
      
      ${renderKeyboard()}
    </div>
  `;
}

function renderResultsScreen() {
  const app = document.querySelector('#app');
  const solvedCount = gameState.boards.filter(b => b.solved).length;
  const icon = gameState.won ? '🎉' : '💔';
  const message = gameState.won ? 'You Won!' : 'Game Over';
  const bannerClass = gameState.won ? 'results-won' : 'results-lost';

  // Answers reveal (always show on results)
  const answersHtml = `
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
    <div class="quordle-container">
      <h1 class="game-title">Quordle${gameMode === 'practice' ? ' <span class="mode-badge">Practice</span>' : ''}</h1>
      
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

        ${gameMode === 'daily' ? '<div class="results-footer">Come back tomorrow for the next Daily</div>' : ''}
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

function renderLeaderboardContent() {
  if (!leaderboard || leaderboard.length === 0) {
    return `
      <div class="leaderboard">
        <h3 class="leaderboard-title">Leaderboard</h3>
        <div class="leaderboard-empty">No players yet</div>
      </div>
    `;
  }

  const entries = leaderboard.map((entry, i) => {
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

  return `
    <div class="leaderboard">
      <h3 class="leaderboard-title">Leaderboard</h3>
      ${entries}
    </div>
  `;
}

// renderBanner removed — game status is now inline in renderGameScreen,
// full results are in renderResultsScreen

function renderBoard(board, index) {
  const rows = [];
  const currentGuessIndex = gameState.guessCount; // 0-based index for current input row

  // Determine solve row index (0-based) if board is solved
  const solveRowIndex = board.solvedOnGuess !== null ? board.solvedOnGuess - 1 : null;

  // Submitted guesses (always condensed style)
  for (let i = 0; i < board.guesses.length; i++) {
    // If board is solved and this row is after the solve, show condensed empty
    if (solveRowIndex !== null && i > solveRowIndex) {
      rows.push(renderRow('     ', null, false, true)); // condensed empty
    } else {
      rows.push(renderRow(board.guesses[i], board.results[i], false, true)); // condensed with result
    }
  }

  // Current guess row (full tiles, only if board not solved and game not over)
  if (!board.solved && !gameState.gameOver && board.guesses.length < gameState.maxGuesses) {
    rows.push(renderRow(gameState.currentGuess.padEnd(5, ' '), null, true, false)); // full tiles
  }

  // Empty rows after current (condensed empty)
  const emptyRowStart = board.solved || gameState.gameOver ? board.guesses.length : board.guesses.length + 1;
  for (let i = emptyRowStart; i < gameState.maxGuesses; i++) {
    rows.push(renderRow('     ', null, false, true)); // condensed empty
  }

  const solvedClass = board.solved ? 'board-solved' : '';
  return `
    <div class="board ${solvedClass}">
      <div class="board-number">#${index + 1}</div>
      ${rows.join('')}
    </div>
  `;
}

function renderRow(guess, result, isCurrent = false, isCondensed = false) {
  const letters = guess.split('');
  const tiles = letters.map((letter, i) => {
    let tileClass = 'tile';
    if (result) {
      tileClass += ` tile-${result[i]}`;
    } else if (isCurrent && letter.trim()) {
      tileClass += ' tile-filled';
    }
    return `<div class="${tileClass}">${letter.trim().toUpperCase()}</div>`;
  }).join('');

  const rowClass = isCondensed ? 'row row-condensed' : 'row';
  return `<div class="${rowClass}">${tiles}</div>`;
}

function renderCurrentGuess() {
  if (gameState.gameOver) return '';
  const errorHtml = guessError
    ? `<div class="guess-error">${guessError}</div>`
    : '';
  return `
    <div class="current-guess-display">
      Current: <span class="guess-text">${gameState.currentGuess.toUpperCase() || '—'}</span>
      ${errorHtml}
    </div>
  `;
}

function renderKeyboard() {
  const rows = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫']
  ];

  const letterStates = computeKeyboardMap(gameState);

  return `
    <div class="keyboard">
      ${rows.map(row => `
        <div class="keyboard-row">
          ${row.map(key => {
    const stateClass = letterStates[key.toLowerCase()] ? `key-${letterStates[key.toLowerCase()]}` : '';
    const widthClass = key.length > 1 ? 'key-wide' : '';
    return `<button class="key ${stateClass} ${widthClass}" data-key="${key}">${key}</button>`;
  }).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function handleKeyPress(key) {
  if (gameState.gameOver) return;

  if (key === 'ENTER') {
    if (gameState.currentGuess.length === 5) {
      // Validate against word list using engine's isValidGuess
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
    guessError = null; // Clear error on input change
    gameState = setCurrentGuess(gameState, gameState.currentGuess.slice(0, -1));
    renderApp();
    setupKeyboardListeners();
  } else if (key.length === 1 && /^[A-Z]$/i.test(key)) {
    if (gameState.currentGuess.length < 5) {
      guessError = null; // Clear error on input change
      gameState = setCurrentGuess(gameState, gameState.currentGuess + key.toLowerCase());
      renderApp();
      setupKeyboardListeners();
    }
  }
}

async function submitGuessWithPersistence(guess) {
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

// Physical keyboard listener
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'Enter') {
    handleKeyPress('ENTER');
  } else if (e.key === 'Backspace') {
    handleKeyPress('BACKSPACE');
  } else if (/^[a-zA-Z]$/.test(e.key)) {
    handleKeyPress(e.key.toUpperCase());
  }
});

// Start a new practice round (random targets)
function startPracticeGame() {
  gameMode = "practice";
  uiScreen = "game";
  const targetWords = getQuordleWords();
  gameState = createGame({ targetWords });
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
  const dateKey = getTodayDateKey();
  const targetWords = getDailyTargets(dateKey);
  gameState = createGame({ targetWords });
  guessError = null;
  saveGameState();
  renderApp();
  setupKeyboardListeners();
}
window.resetGame = resetGame; // Keep for backwards compat