import { describe, it, expect } from 'vitest';
import { evaluateGuess, isSolved } from '../src/evaluator.js';

describe('evaluateGuess', () => {
    it('returns all correct for exact match', () => {
        const result = evaluateGuess('apple', 'apple');
        expect(result).toEqual(['correct', 'correct', 'correct', 'correct', 'correct']);
    });

    it('returns all absent for no matches', () => {
        const result = evaluateGuess('xxxxx', 'apple');
        expect(result).toEqual(['absent', 'absent', 'absent', 'absent', 'absent']);
    });

    it('marks correct letters in correct positions', () => {
        const result = evaluateGuess('applx', 'apple');
        expect(result).toEqual(['correct', 'correct', 'correct', 'correct', 'absent']);
    });

    it('marks present letters in wrong positions', () => {
        const result = evaluateGuess('elppa', 'apple');
        expect(result).toEqual(['present', 'present', 'correct', 'present', 'present']);
    });

    it('handles duplicate letters correctly - only marks as many as exist', () => {
        // Target has one 'l' at position 1, guess has two 'l's at positions 0 and 1
        const result = evaluateGuess('llama', 'plate');
        // Second 'l' (pos 1) is correct (exact match), first 'l' (pos 0) is absent (no remaining 'l's)
        expect(result[0]).toBe('absent');
        expect(result[1]).toBe('correct');
    });

    it('prioritizes correct over present for duplicate letters', () => {
        // Target: "pools" has two 'o's
        // Guess: "books" - first 'o' is correct, second 'o' is correct
        const result = evaluateGuess('poops', 'pools');
        expect(result).toEqual(['correct', 'correct', 'correct', 'absent', 'correct']);
    });

    it('is case insensitive', () => {
        const result = evaluateGuess('APPLE', 'apple');
        expect(result).toEqual(['correct', 'correct', 'correct', 'correct', 'correct']);
    });

    it('throws for mismatched lengths', () => {
        expect(() => evaluateGuess('app', 'apple')).toThrow();
    });
});

describe('isSolved', () => {
    it('returns true when all correct', () => {
        expect(isSolved(['correct', 'correct', 'correct', 'correct', 'correct'])).toBe(true);
    });

    it('returns false when any not correct', () => {
        expect(isSolved(['correct', 'present', 'correct', 'correct', 'correct'])).toBe(false);
        expect(isSolved(['correct', 'absent', 'correct', 'correct', 'correct'])).toBe(false);
    });
});
