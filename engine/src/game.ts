import type { BoardState, GameConfig, GameState, LetterResult, Language } from './types.js';
import { evaluateGuess, isSolved } from './evaluator.js';
import { evaluateGuessKo, evaluateGuessSyllable } from './evaluatorKo.js';
import { getLanguageConfig } from './languageConfig.js';
import { decomposeHangul, isHangulSyllable } from './jamo.js';

const DEFAULT_MAX_GUESSES = 9;

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
    const { targetWords, maxGuesses = DEFAULT_MAX_GUESSES, language = 'en' } = config;

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
        language,
    };
}

/**
 * Validates a guess before submission
 */
export function validateGuess(guess: string, language: Language = 'en'): { valid: boolean; error?: string } {
    const config = getLanguageConfig(language);
    if (guess.length !== config.wordLength) {
        return { valid: false, error: `Guess must be ${config.wordLength} ${language === 'ko' ? 'syllables' : 'letters'}` };
    }

    if (!config.validateCharRegex.test(guess)) {
        return { valid: false, error: language === 'ko' ? 'Guess must contain only Korean syllables' : 'Guess must contain only letters' };
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

    const language = state.language || 'en';
    const validation = validateGuess(guess, language);
    if (!validation.valid) {
        return state;
    }

    const normalizedGuess = language === 'ko' ? guess : guess.toLowerCase();
    const newBoards = state.boards.map((board) => {
        if (board.solved) {
            // Board already solved, just add the guess for display
            const prevResult = board.results[board.results.length - 1];
            const prevKoResult = board.koResults?.[board.koResults.length - 1];
            return {
                ...board,
                guesses: [...board.guesses, normalizedGuess],
                results: [...board.results, prevResult], // Repeat last result
                ...(language === 'ko' && prevKoResult ? {
                    koResults: [...(board.koResults || []), prevKoResult],
                } : {}),
            };
        }

        if (language === 'ko') {
            // Korean: use syllable-level evaluator for main results, plus jamo hints
            const syllableResult = evaluateGuessSyllable(normalizedGuess, board.targetWord);
            const koResult = evaluateGuessKo(normalizedGuess, board.targetWord);
            const solved = isSolved(syllableResult);
            return {
                ...board,
                guesses: [...board.guesses, normalizedGuess],
                results: [...board.results, syllableResult],
                koResults: [...(board.koResults || []), koResult],
                solved,
                solvedOnGuess: solved ? state.guessCount + 1 : null,
            };
        } else {
            // English: use standard evaluator
            const result = evaluateGuess(normalizedGuess, board.targetWord);
            const solved = isSolved(result);
            return {
                ...board,
                guesses: [...board.guesses, normalizedGuess],
                results: [...board.results, result],
                solved,
                solvedOnGuess: solved ? state.guessCount + 1 : null,
            };
        }
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

    const language = state.language || 'en';
    const config = getLanguageConfig(language);
    let limited: string;

    if (language === 'ko') {
        // Korean: allow composed Hangul syllables, limit to wordLength syllable blocks
        limited = guess.replace(config.filterCharRegex, '').slice(0, config.wordLength);
    } else {
        limited = guess.slice(0, config.wordLength).toLowerCase().replace(config.filterCharRegex, '');
    }

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
 *
 * Note: Skips results for guesses made after a board was solved, since those
 * results are just repeats of the solving guess (not real evaluations).
 */
export function computeKeyboardMap(state: GameState): Record<string, LetterResult> {
    const statuses: Record<string, LetterResult> = {};
    const language = state.language || 'en';

    for (const board of state.boards) {
        for (let guessIdx = 0; guessIdx < board.guesses.length; guessIdx++) {
            // Skip results for guesses made after this board was solved.
            // solvedOnGuess is 1-indexed, so guessIdx >= solvedOnGuess means
            // this guess came after the solving guess.
            if (board.solvedOnGuess !== null && guessIdx >= board.solvedOnGuess) {
                continue;
            }

            const guess = board.guesses[guessIdx];
            const result = board.results[guessIdx];

            if (language === 'ko') {
                // Korean: key by individual jamo extracted from syllable blocks
                for (let syllIdx = 0; syllIdx < guess.length; syllIdx++) {
                    const ch = guess[syllIdx];
                    const tileStatus = result[syllIdx];
                    if (isHangulSyllable(ch)) {
                        const d = decomposeHangul(ch);
                        const jamos = [d.onset, d.vowel];
                        if (d.coda) jamos.push(d.coda);
                        for (const jamo of jamos) {
                            if (tileStatus === 'correct') {
                                statuses[jamo] = 'correct';
                            } else if (tileStatus === 'present' && statuses[jamo] !== 'correct') {
                                statuses[jamo] = 'present';
                            } else if (tileStatus === 'absent' && !statuses[jamo]) {
                                statuses[jamo] = 'absent';
                            }
                        }
                    }
                }
            } else {
                // English: key by letter character
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
    }

    return statuses;
}
