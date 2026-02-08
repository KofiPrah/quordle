import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

// Import Quordle engine
import { createGame, submitGuess, setCurrentGuess, validateGuess, getSolvedCount } from "../engine/src/game.ts";
import { evaluateGuess } from "../engine/src/evaluator.ts";
import { getQuordleWords, isValidGuess } from "../engine/src/words.ts";
import { getDailyTargets } from "../engine/src/daily.ts";

// Will eventually store the authenticated user's access_token
let auth;
let gameState;
let guessError = null; // Error message for invalid guesses
let gameMode = "daily"; // "daily" | "practice"

// Discord context for server-side persistence
let discordUserId = null;
let discordRoomId = null;

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
    const response = await fetch("/api/game/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: discordRoomId, userId: discordUserId }),
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
    const response = await fetch("/api/game/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: discordRoomId, userId: discordUserId, guess }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.warn("Failed to submit guess to server:", e);
    return null;
  }
}

const discordSdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

setupDiscordSdk()
  .then(() => {
    console.log("Discord SDK is authenticated");
    initQuordleGame();
  })
  .catch((err) => {
    console.error("Discord SDK init failed:", err);
    document.querySelector('#app').innerHTML = `
      <div style="padding:16px;color:#f66;">
        <h2>Activity failed to start</h2>
        <pre>${String(err)}</pre>
      </div>
    `;
  });

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
  const response = await fetch("/api/token", {
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
  // Use instanceId as roomId (unique per activity instance in a channel)
  discordRoomId = discordSdk.instanceId || discordSdk.channelId || null;
}

// ========== QUORDLE GAME UI ==========

function getTodayDateKey() {
  const today = new Date();
  return today.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function initQuordleGame() {
  // For daily mode, try server-side persistence first
  initDailyFromServer();
}

async function initDailyFromServer() {
  // Try to get state from server (for daily mode with Discord context)
  if (discordUserId && discordRoomId) {
    const serverState = await serverJoinGame();
    if (serverState && serverState.gameState) {
      gameState = serverState.gameState;
      gameMode = serverState.gameMode || "daily";
      guessError = null;
      // Also save to localStorage as backup
      saveGameState();
      renderGame();
      setupKeyboardListeners();
      return;
    }
  }

  // Fallback: try to restore from localStorage
  if (loadGameState()) {
    guessError = null;
    renderGame();
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
  renderGame();
  setupKeyboardListeners();
}

function renderGame() {
  const app = document.querySelector('#app');
  const solvedCount = gameState.boards.filter(b => b.solved).length;

  app.innerHTML = `
    <div class="quordle-container">
      <h1 class="game-title">Quordle${gameMode === 'practice' ? ' <span class="mode-badge">Practice</span>' : ''}</h1>
      
      ${renderBanner(solvedCount)}
      
      <div class="boards-grid">
        ${gameState.boards.map((board, i) => renderBoard(board, i)).join('')}
      </div>
      
      ${renderCurrentGuess()}
      
      ${renderKeyboard()}
      
      ${gameMode === 'practice' && gameState.gameOver ? '<button class="new-game-btn">New Practice Round</button>' : ''}
    </div>
  `;
}

function renderBanner(solvedCount) {
  if (gameState.gameOver) {
    const bannerClass = gameState.won ? 'banner-won' : 'banner-lost';
    const message = gameState.won ? '🎉 You Won!' : '💔 Game Over';

    // Show answers when lost (optionally also when won)
    const answersHtml = !gameState.won ? `
      <div class="answers-reveal">
        <div class="answers-title">The answers were:</div>
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
    ` : '';

    // Daily mode: show "come back tomorrow" CTA + practice button
    const dailyCtaHtml = gameMode === 'daily' ? `
      <div class="daily-cta">
        <div class="daily-cta-primary">Come back tomorrow for the next Daily</div>
        <button class="practice-btn">Play Practice Round</button>
      </div>
    ` : '';

    return `
      <div class="game-banner ${bannerClass}">
        <div class="banner-title">${message}</div>
        <div class="banner-subtitle">Solved ${solvedCount} of 4 boards in ${gameState.guessCount} guesses</div>
        ${answersHtml}
        ${dailyCtaHtml}
      </div>
    `;
  }
  return `
    <div class="game-status">
      Solved: ${solvedCount}/4 | Guesses: ${gameState.guessCount}/${gameState.maxGuesses}
      <button class="reset-btn" title="Clear saved progress">Reset</button>
    </div>
  `;
}

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

  const letterStates = getLetterStates();

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

function getLetterStates() {
  const states = {};
  for (const board of gameState.boards) {
    for (let i = 0; i < board.guesses.length; i++) {
      const guess = board.guesses[i];
      const result = board.results[i];
      for (let j = 0; j < guess.length; j++) {
        const letter = guess[j];
        const state = result[j];
        // Priority: correct > present > absent
        if (state === 'correct') {
          states[letter] = 'correct';
        } else if (state === 'present' && states[letter] !== 'correct') {
          states[letter] = 'present';
        } else if (state === 'absent' && !states[letter]) {
          states[letter] = 'absent';
        }
      }
    }
  }
  return states;
}

function handleKeyPress(key) {
  if (gameState.gameOver) return;

  if (key === 'ENTER') {
    if (gameState.currentGuess.length === 5) {
      // Validate against word list using engine's isValidGuess
      if (!isValidGuess(gameState.currentGuess)) {
        guessError = 'Not in word list';
        renderGame();
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
    renderGame();
    setupKeyboardListeners();
  } else if (key.length === 1 && /^[A-Z]$/i.test(key)) {
    if (gameState.currentGuess.length < 5) {
      guessError = null; // Clear error on input change
      gameState = setCurrentGuess(gameState, gameState.currentGuess + key.toLowerCase());
      renderGame();
      setupKeyboardListeners();
    }
  }
}

async function submitGuessWithPersistence(guess) {
  // For daily mode with Discord context, use server
  if (gameMode === "daily" && discordUserId && discordRoomId) {
    const serverState = await serverSubmitGuess(guess);
    if (serverState && serverState.gameState) {
      gameState = serverState.gameState;
      saveGameState(); // Backup to localStorage
      renderGame();
      setupKeyboardListeners();
      return;
    }
  }

  // Fallback: local-only submission
  gameState = submitGuess(gameState, guess);
  saveGameState();
  renderGame();
  setupKeyboardListeners();
}

function setupKeyboardListeners() {
  // On-screen keyboard
  document.querySelectorAll('.key').forEach(btn => {
    btn.addEventListener('click', () => {
      handleKeyPress(btn.dataset.key);
    });
  });

  // Practice button
  const practiceBtn = document.querySelector('.practice-btn');
  if (practiceBtn) {
    practiceBtn.addEventListener('click', startPracticeGame);
  }

  // New practice game button (after practice game ends)
  const newGameBtn = document.querySelector('.new-game-btn');
  if (newGameBtn) {
    newGameBtn.addEventListener('click', startPracticeGame);
  }

  // Reset button
  const resetBtn = document.querySelector('.reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetGame);
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
  const targetWords = getQuordleWords();
  gameState = createGame({ targetWords });
  guessError = null;
  saveGameState(); // Save new practice game
  renderGame();
  setupKeyboardListeners();
}
window.startPractice = startPracticeGame; // Keep for backwards compat

// Reset game - clears storage and starts fresh
function resetGame() {
  clearGameStorage();
  gameMode = "daily";
  const dateKey = getTodayDateKey();
  const targetWords = getDailyTargets(dateKey);
  gameState = createGame({ targetWords });
  guessError = null;
  saveGameState();
  renderGame();
  setupKeyboardListeners();
}
window.resetGame = resetGame; // Keep for backwards compat