// Types
export type {
    LetterResult,
    GuessResult,
    BoardState,
    GameState,
    GameConfig,
} from './types.js';

// Game logic
export {
    createGame,
    submitGuess,
    setCurrentGuess,
    validateGuess,
    getRemainingGuesses,
    getSolvedCount,
} from './game.js';

// Evaluator
export { evaluateGuess, isSolved } from './evaluator.js';

// Words and validation
export {
    WORD_LIST,
    GUESS_WORDS,
    isValidWord,
    isValidGuess,
    getRandomWord,
    getRandomWords,
    getQuordleWords,
} from './words.js';
