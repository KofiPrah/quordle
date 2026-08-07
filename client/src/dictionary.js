let snapshotPromise = null;
let loadedSnapshot = null;
let recognitionPromise = null;
let loadedRecognitionSnapshot = null;

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function loadKoreanDictionarySnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = import('../../engine/src/koDictionary.generated.json')
      .then((module) => {
        loadedSnapshot = module.default;
        return loadedSnapshot;
      })
      .catch((error) => {
        snapshotPromise = null;
        throw error;
      });
  }
  return snapshotPromise;
}

export function loadKoreanRecognitionSnapshot() {
  if (!recognitionPromise) {
    recognitionPromise = import('../../engine/src/koWordRecognition.generated.json')
      .then((module) => {
        loadedRecognitionSnapshot = module.default;
        return loadedRecognitionSnapshot;
      })
      .catch((error) => {
        recognitionPromise = null;
        throw error;
      });
  }
  return recognitionPromise;
}

export function getKoreanDictionaryEntry(word, snapshot = loadedSnapshot) {
  if (!snapshot?.entries || typeof word !== 'string') return null;
  return snapshot.entries[word.normalize('NFC')] ?? null;
}

function chronologicalSubmittedWords(gameState) {
  const words = [];
  const maxHistory = Math.max(0, ...gameState.boards.map((board) => board.guesses?.length ?? 0));
  for (let guessIndex = 0; guessIndex < maxHistory; guessIndex += 1) {
    const guess = gameState.boards.find((board) => board.guesses?.[guessIndex])?.guesses?.[guessIndex];
    if (guess) words.push(guess.normalize('NFC'));
  }
  return words;
}

export function getDictionaryEligibleWords(gameState, entries = null, supplementalWords = []) {
  if (!gameState || !['ko', 'zh'].includes(gameState.language) || !Array.isArray(gameState.boards)) return [];
  const eligible = [];
  const seen = new Set();
  const add = (word) => {
    const normalized = typeof word === 'string' ? word.normalize('NFC') : '';
    if (!normalized || seen.has(normalized) || (entries && !entries[normalized])) return;
    seen.add(normalized);
    eligible.push(normalized);
  };

  chronologicalSubmittedWords(gameState).forEach(add);
  gameState.boards.filter((board) => board.solved).forEach((board) => add(board.targetWord));
  if (gameState.gameOver) gameState.boards.forEach((board) => add(board.targetWord));
  supplementalWords.forEach(add);
  return eligible;
}

export function getKoreanRecognitionLevel(word, snapshot = loadedRecognitionSnapshot) {
  if (!snapshot?.words || typeof word !== 'string') return null;
  return snapshot.words[word.normalize('NFC')] ?? null;
}

export function getDefaultDictionaryWord(gameState, eligibleWords) {
  if (!Array.isArray(eligibleWords) || eligibleWords.length === 0) return null;
  const eligible = new Set(eligibleWords);
  const submitted = chronologicalSubmittedWords(gameState);
  for (let index = submitted.length - 1; index >= 0; index -= 1) {
    if (eligible.has(submitted[index])) return submitted[index];
  }
  return eligibleWords[0];
}
