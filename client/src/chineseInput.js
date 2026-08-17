export const CHINESE_PINYIN_PUZZLE_VARIANT = 'pinyin-latin-v2';

const VALIDATION_MESSAGES = Object.freeze({
  INVALID_FORMAT: 'Enter exactly two valid Pinyin syllables.',
  INVALID_LENGTH: (wordLength) => `Guess must be ${wordLength} letters.`,
  NOT_IN_LIST: 'Not in the Pinyin word list.',
  LOADING: 'The Pinyin word list is still loading.',
});

export function createChineseInputState() {
  return {
    sourceText: '',
    normalizedText: '',
    validationStatus: 'empty',
    validationCode: null,
    validationError: '',
    pendingSubmission: false,
    submissionGuessCount: null,
    error: '',
  };
}

export function getChineseInputValue(state) {
  return state?.sourceText ?? '';
}

export function updateChineseInput(state, value, options = {}) {
  if (state?.pendingSubmission) return state;
  const sourceText = String(value ?? '').slice(0, 64);
  if (!sourceText) return createChineseInputState();

  const wordLength = Number(options.wordLength);
  const parsed = typeof options.parseInput === 'function' ? options.parseInput(sourceText) : null;
  const normalizedText = parsed?.key
    ?? (typeof options.normalizeInput === 'function' ? options.normalizeInput(sourceText) : '');
  let validationStatus = 'invalid';
  let validationCode = 'INVALID_FORMAT';
  let validationError = VALIDATION_MESSAGES.INVALID_FORMAT;

  if (parsed && parsed.key.length !== wordLength) {
    validationCode = 'INVALID_LENGTH';
    validationError = VALIDATION_MESSAGES.INVALID_LENGTH(wordLength);
  } else if (parsed && !(options.guessKeys instanceof Set)) {
    validationStatus = 'loading';
    validationCode = null;
    validationError = VALIDATION_MESSAGES.LOADING;
  } else if (parsed && !options.guessKeys.has(parsed.key)) {
    validationCode = 'NOT_IN_LIST';
    validationError = VALIDATION_MESSAGES.NOT_IN_LIST;
  } else if (parsed) {
    validationStatus = 'valid';
    validationCode = null;
    validationError = '';
  }

  return {
    sourceText,
    normalizedText: normalizedText.slice(0, Number.isInteger(wordLength) ? wordLength : 64),
    validationStatus,
    validationCode,
    validationError,
    pendingSubmission: false,
    submissionGuessCount: null,
    error: '',
  };
}

export function appendChinesePinyinKey(state, key, options = {}) {
  return updateChineseInput(state, `${state?.sourceText ?? ''}${String(key ?? '').toLowerCase()}`, options);
}

export function backspaceChineseInput(state, options = {}) {
  const sourceText = Array.from(state?.sourceText ?? '').slice(0, -1).join('');
  return updateChineseInput(state, sourceText, options);
}

export function beginChineseSubmission(state, guessCount) {
  if (state?.pendingSubmission) return { state, submission: null };
  if (state?.validationStatus !== 'valid') {
    return {
      state: {
        ...state,
        pendingSubmission: false,
        error: state?.validationError || VALIDATION_MESSAGES.INVALID_FORMAT,
      },
      submission: null,
    };
  }
  const pendingState = {
    ...state,
    pendingSubmission: true,
    submissionGuessCount: Number.isInteger(guessCount) ? guessCount : 0,
    error: '',
  };
  return {
    state: pendingState,
    submission: {
      sourceText: pendingState.sourceText,
      normalizedText: pendingState.normalizedText,
    },
  };
}

export function rejectChineseSubmission(state, error) {
  return {
    ...state,
    pendingSubmission: false,
    submissionGuessCount: null,
    error: String(error || 'The guess was not accepted.'),
  };
}

export function confirmChineseSubmission() {
  return createChineseInputState();
}

export function isChineseSubmissionConfirmed(state, gameState) {
  if (!state?.pendingSubmission || !Number.isInteger(state.submissionGuessCount)) return false;
  if (!Number.isInteger(gameState?.guessCount) || gameState.guessCount <= state.submissionGuessCount) return false;
  return gameState.boards?.some((board) => (
    board?.guesses?.[state.submissionGuessCount] === state.normalizedText
  )) ?? false;
}

export function createChineseGuessKeyLoader(loadShard) {
  const cache = new Map();
  return async (wordLength) => {
    if (!Number.isInteger(wordLength) || wordLength < 4 || wordLength > 9) return new Set();
    if (!cache.has(wordLength)) {
      const pending = Promise.resolve(loadShard(wordLength))
        .then((keys) => new Set(Array.isArray(keys) ? keys : []))
        .catch((error) => {
          cache.delete(wordLength);
          throw error;
        });
      cache.set(wordLength, pending);
    }
    return cache.get(wordLength);
  };
}

export function withChinesePuzzleVariant(language, payload) {
  return language === 'zh'
    ? { ...payload, puzzleVariant: CHINESE_PINYIN_PUZZLE_VARIANT }
    : payload;
}

export function getClientGameStorageKey(mode, language) {
  const base = `quordle_${mode === 'daily' ? 'daily' : 'practice'}_${language}`;
  return language === 'zh' ? `${base}_${CHINESE_PINYIN_PUZZLE_VARIANT}` : base;
}

export function getClientRoundId({ mode, language, dateKey, instanceId }) {
  if (mode === 'daily') {
    const base = `daily:${dateKey}:${language}`;
    return language === 'zh' ? `${base}:${CHINESE_PINYIN_PUZZLE_VARIANT}` : base;
  }
  const base = `practice:${instanceId}`;
  return language === 'zh' ? `${base}:zh:${CHINESE_PINYIN_PUZZLE_VARIANT}` : base;
}

export function getChineseDraftStorageKey(roundId) {
  return `quordle_draft_zh_${CHINESE_PINYIN_PUZZLE_VARIANT}:${roundId}`;
}

export function getClientCompletionId(roundId) {
  return `client:${roundId}:round-completed`;
}
