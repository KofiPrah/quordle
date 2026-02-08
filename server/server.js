import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config({ path: "../.env" });

const app = express();
const port = 3001;

// Allow express to parse JSON bodies
app.use(express.json());

// ========== GAME STATE STORAGE ==========
// In-memory storage (swap to Redis later by replacing this object)
const gameStateStore = {
  /** @type {Map<string, object>} */
  _store: new Map(),

  _makeKey(roomId, dateKey, userId) {
    return `${roomId}:${dateKey}:${userId}`;
  },

  async get(roomId, dateKey, userId) {
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
    const { roomId, userId } = req.body;
    if (!roomId || !userId) {
      return res.status(400).json({ error: "roomId and userId required" });
    }

    const dateKey = getTodayDateKey();
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
    const { roomId, userId, guess } = req.body;
    if (!roomId || !userId || !guess) {
      return res.status(400).json({ error: "roomId, userId, and guess required" });
    }

    const dateKey = getTodayDateKey();
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

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
