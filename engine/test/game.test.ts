import { describe, it, expect } from 'vitest';
import {
    createGame,
    submitGuess,
    setCurrentGuess,
    validateGuess,
    getRemainingGuesses,
    getSolvedCount,
} from '../src/game.js';

describe('createGame', () => {
    it('creates a game with 4 boards', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        expect(game.boards).toHaveLength(4);
        expect(game.boards[0].targetWord).toBe('apple');
        expect(game.boards[1].targetWord).toBe('beach');
        expect(game.boards[2].targetWord).toBe('chair');
        expect(game.boards[3].targetWord).toBe('dance');
    });

    it('initializes with default max guesses of 9', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        expect(game.maxGuesses).toBe(9);
    });

    it('allows custom max guesses', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
            maxGuesses: 12,
        });

        expect(game.maxGuesses).toBe(12);
    });

    it('starts with empty state', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        expect(game.currentGuess).toBe('');
        expect(game.guessCount).toBe(0);
        expect(game.gameOver).toBe(false);
        expect(game.won).toBe(false);
    });
});

describe('validateGuess', () => {
    it('accepts valid 5-letter words', () => {
        expect(validateGuess('apple')).toEqual({ valid: true });
        expect(validateGuess('BEACH')).toEqual({ valid: true });
    });

    it('rejects wrong length', () => {
        expect(validateGuess('app').valid).toBe(false);
        expect(validateGuess('apples').valid).toBe(false);
    });

    it('rejects non-letter characters', () => {
        expect(validateGuess('app1e').valid).toBe(false);
        expect(validateGuess('app-e').valid).toBe(false);
    });
});

describe('submitGuess', () => {
    it('updates all boards with the guess', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        const newState = submitGuess(game, 'crane');

        expect(newState.boards[0].guesses).toEqual(['crane']);
        expect(newState.boards[1].guesses).toEqual(['crane']);
        expect(newState.boards[2].guesses).toEqual(['crane']);
        expect(newState.boards[3].guesses).toEqual(['crane']);
    });

    it('increments guess count', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        const newState = submitGuess(game, 'crane');
        expect(newState.guessCount).toBe(1);
    });

    it('clears current guess after submission', () => {
        let game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });
        game = setCurrentGuess(game, 'crane');
        game = submitGuess(game, 'crane');

        expect(game.currentGuess).toBe('');
    });

    it('marks board as solved when guessed correctly', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        const newState = submitGuess(game, 'apple');

        expect(newState.boards[0].solved).toBe(true);
        expect(newState.boards[0].solvedOnGuess).toBe(1);
        expect(newState.boards[1].solved).toBe(false);
    });

    it('ends game when all boards solved', () => {
        let game = createGame({
            targetWords: ['apple', 'apple', 'apple', 'apple'],
        });

        game = submitGuess(game, 'apple');

        expect(game.gameOver).toBe(true);
        expect(game.won).toBe(true);
    });

    it('ends game when out of guesses', () => {
        let game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
            maxGuesses: 2,
        });

        game = submitGuess(game, 'xxxxx');
        game = submitGuess(game, 'yyyyy');

        expect(game.gameOver).toBe(true);
        expect(game.won).toBe(false);
    });

    it('ignores guesses after game over', () => {
        let game = createGame({
            targetWords: ['apple', 'apple', 'apple', 'apple'],
        });

        game = submitGuess(game, 'apple'); // Game over
        const finalCount = game.guessCount;

        game = submitGuess(game, 'beach');

        expect(game.guessCount).toBe(finalCount);
    });
});

describe('setCurrentGuess', () => {
    it('updates current guess', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        const newState = setCurrentGuess(game, 'cra');
        expect(newState.currentGuess).toBe('cra');
    });

    it('limits to 5 characters', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        const newState = setCurrentGuess(game, 'cranes');
        expect(newState.currentGuess).toBe('crane');
    });

    it('converts to lowercase', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        const newState = setCurrentGuess(game, 'CRANE');
        expect(newState.currentGuess).toBe('crane');
    });

    it('strips non-letter characters', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        const newState = setCurrentGuess(game, 'cr4ne');
        expect(newState.currentGuess).toBe('crne');
    });
});

describe('getRemainingGuesses', () => {
    it('returns correct remaining count', () => {
        let game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
            maxGuesses: 9,
        });

        expect(getRemainingGuesses(game)).toBe(9);

        game = submitGuess(game, 'crane');
        expect(getRemainingGuesses(game)).toBe(8);
    });
});

describe('getSolvedCount', () => {
    it('returns number of solved boards', () => {
        let game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        expect(getSolvedCount(game)).toBe(0);

        game = submitGuess(game, 'apple');
        expect(getSolvedCount(game)).toBe(1);

        game = submitGuess(game, 'beach');
        expect(getSolvedCount(game)).toBe(2);
    });
});
