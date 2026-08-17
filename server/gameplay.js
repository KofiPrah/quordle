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

export function transitionPlayerGuess(playerState, sourceGuess, validators = {}, timestamp = Date.now()) {
  const previousGameState = playerState.gameState;
  const validation = validateDailyGuess(previousGameState, sourceGuess, validators);
  if (!validation.valid) return { ok: false, ...validation };

  const gameState = applyValidatedGuess(previousGameState, validation.normalizedGuess);
  const justCompleted = !previousGameState.gameOver && gameState.gameOver;
  return {
    ok: true,
    normalizedGuess: validation.normalizedGuess,
    previousGameState,
    gameState,
    newlySolvedTargetIds: getNewlySolvedTargetIds(previousGameState, gameState),
    justCompleted,
    playerState: {
      ...playerState,
      gameState,
      updatedAt: timestamp,
      finishedAt: justCompleted && !playerState.finishedAt ? timestamp : playerState.finishedAt,
    },
  };
}
