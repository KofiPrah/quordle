// Types
export type {
    Language,
    LetterResult,
    GuessResult,
    JamoHint,
    KoSyllableResult,
    BoardState,
    GameState,
    GameConfig,
    LanguageConfig,
} from './types.js';

// Game logic
export {
    createGame,
    submitGuess,
    setCurrentGuess,
    validateGuess,
    getRemainingGuesses,
    getSolvedCount,
    computeKeyboardMap,
} from './game.js';

// Evaluator (English)
export { evaluateGuess, isSolved } from './evaluator.js';

// Evaluator (Korean)
export { evaluateGuessKo, evaluateGuessSyllable } from './evaluatorKo.js';

// Jamo utilities
export {
    decomposeHangul,
    composeHangul,
    isHangulSyllable,
    isJamo,
    isConsonant,
    isVowel,
    extractJamo,
    canBeOnset,
    canBeCoda,
    splitCompoundCoda,
    combineCodas,
    ONSETS,
    VOWELS,
    CODAS,
} from './jamo.js';

// Words and validation (English — backward compat)
export {
    WORD_LIST,
    GUESS_WORDS,
    isValidWord,
    isValidGuess,
    getRandomWord,
    getRandomWords,
    getQuordleWords,
} from './words.js';

// Language config
export {
    getLanguageConfig,
    isValidGuessForLanguage,
    isValidWordForLanguage,
    getQuordleWordsForLanguage,
} from './languageConfig.js';

// Daily
export { getDailyTargets } from './daily.js';
