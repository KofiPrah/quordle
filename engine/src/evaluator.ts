import type { GuessResult, LetterResult } from './types.js';

/**
 * Evaluates a guess against a target word.
 * Returns an array of LetterResults indicating correct/present/absent for each letter.
 *
 * Algorithm:
 * 1. First pass: mark all correct letters
 * 2. Second pass: mark present letters (accounting for letter frequency)
 */
export function evaluateGuess(guess: string, target: string): GuessResult {
    const guessLower = guess.toLowerCase();
    const targetLower = target.toLowerCase();

    if (guessLower.length !== targetLower.length) {
        throw new Error(`Guess length (${guessLower.length}) must match target length (${targetLower.length})`);
    }

    const result: LetterResult[] = new Array(guessLower.length).fill('absent');
    const targetLetterCounts = new Map<string, number>();

    // Count letters in target
    for (const letter of targetLower) {
        targetLetterCounts.set(letter, (targetLetterCounts.get(letter) || 0) + 1);
    }

    // First pass: mark correct letters
    for (let i = 0; i < guessLower.length; i++) {
        if (guessLower[i] === targetLower[i]) {
            result[i] = 'correct';
            targetLetterCounts.set(guessLower[i], targetLetterCounts.get(guessLower[i])! - 1);
        }
    }

    // Second pass: mark present letters
    for (let i = 0; i < guessLower.length; i++) {
        if (result[i] === 'correct') continue;

        const letter = guessLower[i];
        const remaining = targetLetterCounts.get(letter) || 0;

        if (remaining > 0) {
            result[i] = 'present';
            targetLetterCounts.set(letter, remaining - 1);
        }
    }

    return result;
}

/**
 * Checks if a guess result indicates a solved word (all correct)
 */
export function isSolved(result: GuessResult): boolean {
    return result.every((r) => r === 'correct');
}
