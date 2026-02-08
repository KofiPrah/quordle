import type { BoardState, GameConfig, GameState, LetterResult } from './types.js';
import { evaluateGuess, isSolved } from './evaluator.js';

const DEFAULT_MAX_GUESSES = 9;
const WORD_LENGTH = 5;

/**
 * Creates an initial board state for a single word
 */
function createBoardState(targetWord: string): BoardState {
    return {
        targetWord: targetWord.toLowerCase(),
        guesses: [],
        results: [],
        solved: false,
        solvedOnGuess: null,
    };
}

/**
 * Creates a new Quordle game state
 */
export function createGame(config: GameConfig): GameState {
    const { targetWords, maxGuesses = DEFAULT_MAX_GUESSES } = config;

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

/**
 * Validates a guess before submission
 */
export function validateGuess(guess: string): { valid: boolean; error?: string } {
    if (guess.length !== WORD_LENGTH) {
        return { valid: false, error: `Guess must be ${WORD_LENGTH} letters` };
    }

    if (!/^[a-zA-Z]+$/.test(guess)) {
        return { valid: false, error: 'Guess must contain only letters' };
    }

    return { valid: true };
}

/**
 * Submits a guess and returns the updated game state.
 * This is a pure function - it returns a new state object.
 */
export function submitGuess(state: GameState, guess: string): GameState {
    if (state.gameOver) {
        return state;
    }

    const validation = validateGuess(guess);
    if (!validation.valid) {
        return state;
    }

    const normalizedGuess = guess.toLowerCase();
    const newBoards = state.boards.map((board) => {
        if (board.solved) {
            // Board already solved, just add the guess for display
            return {
                ...board,
                guesses: [...board.guesses, normalizedGuess],
                results: [...board.results, board.results[board.results.length - 1]], // Repeat last result
            };
        }

        const result = evaluateGuess(normalizedGuess, board.targetWord);
        const solved = isSolved(result);

        return {
            ...board,
            guesses: [...board.guesses, normalizedGuess],
            results: [...board.results, result],
            solved,
            solvedOnGuess: solved ? state.guessCount + 1 : null,
        };
    }) as [BoardState, BoardState, BoardState, BoardState];

    const newGuessCount = state.guessCount + 1;
    const allSolved = newBoards.every((b) => b.solved);
    const outOfGuesses = newGuessCount >= state.maxGuesses;
    const gameOver = allSolved || outOfGuesses;

    return {
        ...state,
        boards: newBoards,
        currentGuess: '',
        guessCount: newGuessCount,
        gameOver,
        won: allSolved,
    };
}

/**
 * Updates the current guess (for typing)
 */
export function setCurrentGuess(state: GameState, guess: string): GameState {
    if (state.gameOver) {
        return state;
    }

    const limited = guess.slice(0, WORD_LENGTH).toLowerCase().replace(/[^a-z]/g, '');

    return {
        ...state,
        currentGuess: limited,
    };
}

/**
 * Gets the number of remaining guesses
 */
export function getRemainingGuesses(state: GameState): number {
    return state.maxGuesses - state.guessCount;
}

/**
 * Gets the number of solved boards
 */
export function getSolvedCount(state: GameState): number {
    return state.boards.filter((b) => b.solved).length;
}

/**
 * Computes keyboard letter statuses derived from all scored tile results.
 * For each guessed letter, looks across all boards and all submitted guesses
 * and assigns the max status using precedence: correct > present > absent.
 * Only letters that appear in submitted guesses will have a status.
 */
export function computeKeyboardMap(state: GameState): Record<string, LetterResult> {
    const statuses: Record<string, LetterResult> = {};

    for (const board of state.boards) {
        for (let guessIdx = 0; guessIdx < board.guesses.length; guessIdx++) {
            const guess = board.guesses[guessIdx];
            const result = board.results[guessIdx];

            for (let letterIdx = 0; letterIdx < guess.length; letterIdx++) {
                const letter = guess[letterIdx];
                const tileStatus = result[letterIdx];

                // Apply max precedence: correct > present > absent
                if (tileStatus === 'correct') {
                    statuses[letter] = 'correct';
                } else if (tileStatus === 'present' && statuses[letter] !== 'correct') {
                    statuses[letter] = 'present';
                } else if (tileStatus === 'absent' && !statuses[letter]) {
                    statuses[letter] = 'absent';
                }
            }
        }
    }

    return statuses;
}
