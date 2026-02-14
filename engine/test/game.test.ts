import { describe, it, expect } from 'vitest';
import {
    createGame,
    submitGuess,
    setCurrentGuess,
    validateGuess,
    getRemainingGuesses,
    getSolvedCount,
    computeKeyboardMap,
    computeKeyboardBoardMap,
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

describe('computeKeyboardMap', () => {
    it('derives keyboard status from scored tiles with correct precedence', () => {
        // Bug scenario: BROTH against targets [BREAK, BROWN, QUEEN, BADGE]
        // B: correct in BREAK(pos0), BROWN(pos0), BADGE(pos0)
        // R: correct in BREAK(pos1), BROWN(pos1)
        // O: correct in BROWN(pos2)
        // T: absent in all
        // H: absent in all
        let game = createGame({
            targetWords: ['break', 'brown', 'queen', 'badge'],
        });

        game = submitGuess(game, 'broth');
        const keyMap = computeKeyboardMap(game);

        expect(keyMap['b']).toBe('correct');
        expect(keyMap['r']).toBe('correct');
        expect(keyMap['o']).toBe('correct');
        expect(keyMap['t']).toBe('absent');
        expect(keyMap['h']).toBe('absent');
    });

    it('only includes letters from submitted guesses', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        const keyMap = computeKeyboardMap(game);

        expect(Object.keys(keyMap)).toHaveLength(0);
    });

    it('applies max precedence across multiple boards', () => {
        let game = createGame({
            targetWords: ['crane', 'brain', 'plain', 'drain'],
        });

        game = submitGuess(game, 'train');
        const keyMap = computeKeyboardMap(game);

        // T: absent in crane, absent in brain, absent in plain, absent in drain
        expect(keyMap['t']).toBe('absent');
        // R: present in crane, correct in brain, present in plain, correct in drain
        expect(keyMap['r']).toBe('correct');
        // A: present in crane, correct in brain, correct in plain, correct in drain
        expect(keyMap['a']).toBe('correct');
        // I: absent in crane, correct in brain, correct in plain, correct in drain
        expect(keyMap['i']).toBe('correct');
        // N: present in crane, correct in brain, correct in plain, correct in drain
        expect(keyMap['n']).toBe('correct');
    });

    it('marks Q as absent after QUAIL when Q is not in any target', () => {
        // Bug reproduction: targets [DELTA, BLOCK, SPARE, APPLE], guess QUAIL
        // Q should be absent since it doesn't appear in any target word
        let game = createGame({
            targetWords: ['delta', 'block', 'spare', 'apple'],
        });

        // First solve board 2 (SPARE) to trigger the bug scenario
        game = submitGuess(game, 'spare');
        // Now guess QUAIL - Q should NOT inherit the 'correct' status from SPARE's result
        game = submitGuess(game, 'quail');

        const keyMap = computeKeyboardMap(game);

        // Q is not in any target word, so it must be absent
        expect(keyMap['q']).toBe('absent');
        // U is not in any target word, so it must be absent
        expect(keyMap['u']).toBe('absent');
        // A is present in DELTA, SPARE, APPLE and correct in SPARE (pos 2)
        expect(keyMap['a']).toBe('correct');
        // I is absent in all targets
        expect(keyMap['i']).toBe('absent');
        // L is present in DELTA, BLOCK, APPLE
        expect(keyMap['l']).toBe('present');
    });
});

describe('computeKeyboardBoardMap', () => {
    it('returns per-board statuses independently', () => {
        // targets: CRANE, BRAIN, PLAIN, DRAIN; guess: TRAIN
        // Board 0 (crane): t=absent, r=present, a=present, i=absent, n=present
        // Board 1 (brain): t=absent, r=correct, a=correct, i=correct, n=correct
        // Board 2 (plain): t=absent, r=absent, a=correct, i=correct, n=correct
        // Board 3 (drain): t=absent, r=correct, a=correct, i=correct, n=correct
        let game = createGame({
            targetWords: ['crane', 'brain', 'plain', 'drain'],
        });

        game = submitGuess(game, 'train');
        const boardMap = computeKeyboardBoardMap(game);

        // 't' is absent on all 4 boards
        expect(boardMap['t']).toEqual(['absent', 'absent', 'absent', 'absent']);
        // 'r': correct in crane(pos1), correct in brain(pos1), absent in plain, correct in drain(pos1)
        expect(boardMap['r']).toEqual(['correct', 'correct', 'absent', 'correct']);
        // 'a': correct in crane(pos2), correct in brain(pos2), correct in plain(pos2), correct in drain(pos2)
        expect(boardMap['a']).toEqual(['correct', 'correct', 'correct', 'correct']);
        // 'i': absent in crane, correct in brain(pos3), correct in plain(pos3), correct in drain(pos3)
        expect(boardMap['i']).toEqual(['absent', 'correct', 'correct', 'correct']);
        // 'n': present in crane, correct in brain(pos4), correct in plain(pos4), correct in drain(pos4)
        expect(boardMap['n']).toEqual(['present', 'correct', 'correct', 'correct']);
    });

    it('returns empty map before any guesses', () => {
        const game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        const boardMap = computeKeyboardBoardMap(game);
        expect(Object.keys(boardMap)).toHaveLength(0);
    });

    it('applies max precedence per board across multiple guesses', () => {
        let game = createGame({
            targetWords: ['apple', 'beach', 'chair', 'dance'],
        });

        // First guess: CRANE
        // Board 0 (apple): c=absent, r=absent, a=present, n=absent, e=present
        // Board 1 (beach): c=present, r=absent, a=present, n=absent, e=present
        game = submitGuess(game, 'crane');

        // Second guess: DANCE solves board 3
        // Board 0 (apple): d=absent, a=present, n=absent, c=absent, e=correct
        game = submitGuess(game, 'dance');

        const boardMap = computeKeyboardBoardMap(game);

        // 'a' on board 0: present from guess 1, present from guess 2 → present
        expect(boardMap['a'][0]).toBe('present');
        // 'e' on board 0: present from guess 1, correct from guess 2 → correct
        expect(boardMap['e'][0]).toBe('correct');
        // Board 3 is solved by guess 2 (dance = dance), 'c' goes from present (CRANE) to correct (DANCE)
        expect(boardMap['c'][3]).toBe('correct');
    });

    it('skips post-solve guesses for solved boards', () => {
        let game = createGame({
            targetWords: ['apple', 'apple', 'apple', 'beach'],
        });

        // Guess 1: APPLE solves boards 0, 1, 2
        game = submitGuess(game, 'apple');
        // Guess 2: BEACH — boards 0-2 are already solved, only board 3 matters
        game = submitGuess(game, 'beach');

        const boardMap = computeKeyboardBoardMap(game);

        // 'b' was only evaluated on board 3 (correct); boards 0-2 solved before guess 2
        expect(boardMap['b'][0]).toBeNull();
        expect(boardMap['b'][3]).toBe('correct');
    });
});
