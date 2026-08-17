import {
  applyValidatedGuess,
  createGame,
  validateGuessForGame,
} from '@quordle/engine/game';
import { getDailyChinesePinyinRound } from '@quordle/engine/pinyinDaily';
import { PINYIN_PUZZLE_VARIANT } from './gameNamespace.js';

export const MAX_PINYIN_SUBMISSION_RECEIPTS = 9;

export function createDailyGame(dateKey, language, puzzleVariant, legacyTargets) {
  if (language === 'zh' && puzzleVariant === PINYIN_PUZZLE_VARIANT) {
    const round = getDailyChinesePinyinRound(dateKey);
    return createGame({
      targetWords: round.answers.map((answer) => answer.key),
      targetIds: round.answers.map((answer) => answer.id),
      language,
      puzzleVariant: PINYIN_PUZZLE_VARIANT,
      wordLength: round.length,
    });
  }
  return createGame({ targetWords: legacyTargets, language });
}

export function validateDailyGuess(gameState, sourceGuess, validators = {}) {
  const validation = validateGuessForGame(gameState, String(sourceGuess ?? ''));
  if (!validation.valid) return validation;

  const language = gameState.language || 'en';
  const accepted = language === 'en'
    ? validators.isAcceptedEnglishGuess?.(validation.normalizedGuess) !== false
    : language === 'ko'
      ? validators.isAcceptedKoreanGuess?.(validation.normalizedGuess) !== false
      : true;
  if (!accepted) {
    return {
      valid: false,
      code: 'NOT_IN_LIST',
      error: language === 'ko' ? 'Not in the Korean word list.' : 'Not in the word list.',
    };
  }
  return validation;
}

export function getNewlySolvedTargetIds(previousGameState, nextGameState) {
  const targets = [];
  for (let boardIndex = 0; boardIndex < nextGameState.boards.length; boardIndex += 1) {
    const before = previousGameState.boards[boardIndex];
    const after = nextGameState.boards[boardIndex];
    if (!before.solved && after.solved) targets.push(after.targetId || after.targetWord);
  }
  return targets;
}

function isPinyinPlayer(playerState) {
  return playerState?.language === 'zh'
    && playerState?.puzzleVariant === PINYIN_PUZZLE_VARIANT;
}

function normalizePinyinSubmissionReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.submissionId !== 'string'
    || value.submissionId.length === 0
    || value.submissionId.length > 128
    || typeof value.normalizedGuess !== 'string'
    || value.normalizedGuess.length === 0
    || !Number.isInteger(value.guessIndex)
    || value.guessIndex < 0) return null;
  return {
    submissionId: value.submissionId,
    normalizedGuess: value.normalizedGuess,
    guessIndex: value.guessIndex,
  };
}

export function getPinyinSubmissionReceipts(playerState) {
  if (!isPinyinPlayer(playerState)) return [];
  const receipts = [];
  const append = (candidate) => {
    const receipt = normalizePinyinSubmissionReceipt(candidate);
    if (!receipt) return;
    const duplicateIndex = receipts.findIndex((entry) => entry.submissionId === receipt.submissionId);
    if (duplicateIndex >= 0) receipts.splice(duplicateIndex, 1);
    receipts.push(receipt);
  };
  if (Array.isArray(playerState.pinyinSubmissionReceipts)) {
    playerState.pinyinSubmissionReceipts.forEach(append);
  }
  append(playerState.pinyinSubmissionReceipt);
  return receipts.slice(-MAX_PINYIN_SUBMISSION_RECEIPTS);
}

export function normalizePinyinPlayerSubmissionState(playerState) {
  if (!isPinyinPlayer(playerState)) return playerState;
  const pinyinSubmissionReceipts = getPinyinSubmissionReceipts(playerState);
  const pinyinSubmissionReceipt = pinyinSubmissionReceipts.at(-1);
  const normalizedPlayerState = { ...playerState };
  delete normalizedPlayerState.pinyinSubmissionReceipt;
  delete normalizedPlayerState.pinyinSubmissionReceipts;
  return {
    ...normalizedPlayerState,
    ...(pinyinSubmissionReceipt ? { pinyinSubmissionReceipt } : {}),
    pinyinSubmissionReceipts,
  };
}

export function transitionPlayerGuess(
  playerState,
  sourceGuess,
  validators = {},
  timestamp = Date.now(),
  submissionId,
) {
  const pinyinPlayer = isPinyinPlayer(playerState);
  const authoritativePlayerState = pinyinPlayer
    ? normalizePinyinPlayerSubmissionState(playerState)
    : playerState;
  const previousGameState = authoritativePlayerState.gameState;
  if (pinyinPlayer && (typeof submissionId !== 'string' || submissionId.length === 0 || submissionId.length > 128)) {
    return {
      ok: false,
      code: 'INVALID_SUBMISSION_ID',
      error: 'A valid submissionId is required for Pinyin guesses.',
    };
  }
  const validation = validateDailyGuess(previousGameState, sourceGuess, validators);
  const pinyinSubmissionReceipts = pinyinPlayer
    ? authoritativePlayerState.pinyinSubmissionReceipts
    : [];
  const previousReceipt = pinyinSubmissionReceipts.find((receipt) => receipt.submissionId === submissionId);
  if (previousReceipt) {
    if (!validation.valid || validation.normalizedGuess !== previousReceipt.normalizedGuess) {
      return {
        ok: false,
        code: 'SUBMISSION_ID_REUSED',
        error: 'submissionId was already used for a different Pinyin guess.',
        submissionId,
      };
    }
    return {
      ok: true,
      idempotent: true,
      submissionId,
      normalizedGuess: previousReceipt.normalizedGuess,
      previousGameState,
      gameState: previousGameState,
      newlySolvedTargetIds: [],
      justCompleted: false,
      playerState: authoritativePlayerState,
    };
  }
  if (!validation.valid) {
    return {
      ok: false,
      ...validation,
      ...(pinyinPlayer ? { submissionId } : {}),
    };
  }
  if (pinyinPlayer && previousGameState.gameOver) {
    return {
      ok: false,
      code: 'GAME_OVER',
      error: 'Game already over',
      submissionId,
    };
  }

  const gameState = applyValidatedGuess(previousGameState, validation.normalizedGuess);
  const justCompleted = !previousGameState.gameOver && gameState.gameOver;
  const pinyinSubmissionReceipt = pinyinPlayer ? {
    submissionId,
    normalizedGuess: validation.normalizedGuess,
    guessIndex: previousGameState.guessCount,
  } : null;
  const nextPinyinSubmissionReceipts = pinyinSubmissionReceipt
    ? [...pinyinSubmissionReceipts, pinyinSubmissionReceipt].slice(-MAX_PINYIN_SUBMISSION_RECEIPTS)
    : null;
  return {
    ok: true,
    idempotent: false,
    ...(pinyinPlayer ? { submissionId } : {}),
    normalizedGuess: validation.normalizedGuess,
    previousGameState,
    gameState,
    newlySolvedTargetIds: getNewlySolvedTargetIds(previousGameState, gameState),
    justCompleted,
    playerState: {
      ...authoritativePlayerState,
      gameState,
      ...(pinyinSubmissionReceipt ? { pinyinSubmissionReceipt } : {}),
      ...(nextPinyinSubmissionReceipts ? { pinyinSubmissionReceipts: nextPinyinSubmissionReceipts } : {}),
      updatedAt: timestamp,
      finishedAt: justCompleted && !authoritativePlayerState.finishedAt
        ? timestamp
        : authoritativePlayerState.finishedAt,
    },
  };
}
