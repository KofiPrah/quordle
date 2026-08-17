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
    submissionFingerprint: null,
    error: '',
  };
}

export function getChineseInputValue(state) {
  return state?.sourceText ?? '';
}

export function updateChineseInput(state, value, options = {}) {
  if (state?.pendingSubmission) return state;
  const sourceText = String(value ?? '').slice(0, 64);
  if (!sourceText) {
    return {
      ...createChineseInputState(),
      submissionFingerprint: state?.submissionFingerprint ?? null,
    };
  }

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
    submissionFingerprint: state?.submissionFingerprint ?? null,
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

export function beginChineseSubmission(state, guessCount, options = {}) {
  if (state?.pendingSubmission) return { state, submission: null };
  const guessIndex = Number.isInteger(guessCount) ? guessCount : 0;
  const retainedFingerprint = hasChineseSubmissionAwaitingConfirmation(state)
    ? state.submissionFingerprint
    : null;
  if (retainedFingerprint && retainedFingerprint.normalizedText !== state?.normalizedText) {
    return {
      state: {
        ...state,
        error: 'Checking the previous guess with the server before retrying.',
      },
      submission: null,
    };
  }
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
  const createSubmissionId = typeof options.createSubmissionId === 'function'
    ? options.createSubmissionId
    : () => globalThis.crypto?.randomUUID?.();
  const submissionId = retainedFingerprint?.submissionId || createSubmissionId();
  if (typeof submissionId !== 'string' || !submissionId) {
    return {
      state: {
        ...state,
        pendingSubmission: false,
        error: 'Unable to create a Pinyin submission identifier.',
      },
      submission: null,
    };
  }
  const pendingState = {
    ...state,
    pendingSubmission: true,
    submissionGuessCount: retainedFingerprint?.guessCount ?? guessIndex,
    submissionFingerprint: {
      submissionId,
      normalizedText: state.normalizedText,
      guessCount: retainedFingerprint?.guessCount ?? guessIndex,
    },
    error: '',
  };
  return {
    state: pendingState,
    submission: {
      sourceText: pendingState.sourceText,
      normalizedText: pendingState.normalizedText,
      submissionId,
    },
  };
}

export function rejectChineseSubmission(state, error, options = {}) {
  return {
    ...state,
    pendingSubmission: false,
    submissionGuessCount: null,
    submissionFingerprint: options.retainSubmissionFingerprint === true
      ? state?.submissionFingerprint ?? null
      : null,
    error: String(error || 'The guess was not accepted.'),
  };
}

export function rejectChineseSubmissionFromAuthoritativeError(state, error, submissionId) {
  if (!hasChineseSubmissionAwaitingConfirmation(state)) return state;
  if (state.submissionFingerprint.submissionId !== submissionId) return state;
  return rejectChineseSubmission(state, error);
}

export function getChineseSubmissionFailureOptions({
  status,
  code,
  requestSubmissionId,
  responseSubmissionId,
} = {}) {
  if (code === 'NETWORK_ERROR' || !Number.isInteger(status) || status >= 500) {
    return { retainSubmissionFingerprint: true };
  }
  return {
    authoritative: true,
    submissionId: responseSubmissionId || requestSubmissionId,
  };
}

export function confirmChineseSubmission() {
  return createChineseInputState();
}

export function hasChineseSubmissionAwaitingConfirmation(state) {
  const fingerprint = state?.submissionFingerprint;
  return typeof fingerprint?.normalizedText === 'string'
    && fingerprint.normalizedText.length > 0
    && typeof fingerprint.submissionId === 'string'
    && fingerprint.submissionId.length > 0
    && Number.isInteger(fingerprint.guessCount);
}

export function isChineseSubmissionConfirmed(state, playerState) {
  if (!hasChineseSubmissionAwaitingConfirmation(state)) return false;
  const { submissionId, normalizedText, guessCount } = state.submissionFingerprint;
  const receipt = playerState?.pinyinSubmissionReceipt;
  if (receipt?.submissionId !== submissionId
    || receipt.normalizedGuess !== normalizedText
    || receipt.guessIndex !== guessCount) return false;
  const gameState = playerState?.gameState;
  if (!Number.isInteger(gameState?.guessCount) || gameState.guessCount <= guessCount) return false;
  return gameState.boards?.some((board) => (
    board?.guesses?.[guessCount] === normalizedText
  )) ?? false;
}

export function reconcileChineseSubmissionAgainstState(state, playerState) {
  if (!hasChineseSubmissionAwaitingConfirmation(state)) return { state, status: 'none' };
  if (isChineseSubmissionConfirmed(state, playerState)) {
    return { state: confirmChineseSubmission(state), status: 'confirmed' };
  }
  return { state, status: 'unconfirmed' };
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
