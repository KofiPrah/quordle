import {
  applyValidatedGuess,
  createGame,
  validateGuessForGame,
} from '@quordle/engine/game';
import { getDailyChinesePinyinRound } from '@quordle/engine/pinyinDaily';
import { PINYIN_PUZZLE_VARIANT } from './gameNamespace.js';

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

export function transitionPlayerGuess(
  playerState,
  sourceGuess,
  validators = {},
  timestamp = Date.now(),
  submissionId,
) {
  const previousGameState = playerState.gameState;
  const pinyinPlayer = isPinyinPlayer(playerState);
  if (pinyinPlayer && (typeof submissionId !== 'string' || submissionId.length === 0 || submissionId.length > 128)) {
    return {
      ok: false,
      code: 'INVALID_SUBMISSION_ID',
      error: 'A valid submissionId is required for Pinyin guesses.',
    };
  }
  const validation = validateDailyGuess(previousGameState, sourceGuess, validators);
  const previousReceipt = pinyinPlayer ? playerState.pinyinSubmissionReceipt : null;
  if (previousReceipt && previousReceipt.submissionId === submissionId) {
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
      playerState,
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
      ...playerState,
      gameState,
      ...(pinyinSubmissionReceipt ? { pinyinSubmissionReceipt } : {}),
      updatedAt: timestamp,
      finishedAt: justCompleted && !playerState.finishedAt ? timestamp : playerState.finishedAt,
    },
  };
}
