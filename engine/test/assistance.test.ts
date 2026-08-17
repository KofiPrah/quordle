import { describe, expect, it } from 'vitest';
import {
    appendHintUse,
    calculatePerformanceMetrics,
    createEmptyAssistanceState,
    normalizeAssistanceState,
} from '../src/assistance.js';
import { createGame } from '../src/game.js';
import { PINYIN_PUZZLE_VARIANT } from '../src/chineseLexicon.js';
import type { HintUse } from '../src/types.js';

const hint: HintUse = {
    boardIndex: 0,
    type: 'part-of-speech',
    payload: ['noun'],
    cost: 2,
    usedAt: 100,
};

describe('assistance state', () => {
    it('normalizes missing and malformed legacy state', () => {
        expect(normalizeAssistanceState(undefined)).toEqual(createEmptyAssistanceState());
        expect(normalizeAssistanceState({ hints: [{ boardIndex: 9, type: 'bad' }] })).toEqual(createEmptyAssistanceState());
    });

    it('deduplicates a hint by board and type without charging twice', () => {
        const once = appendHintUse(undefined, hint);
        const twice = appendHintUse(once, { ...hint, cost: 999, usedAt: 200 });
        expect(twice.hints).toEqual([hint]);
    });

    it('preserves readable version-1 Korean and legacy Hanzi histories', () => {
        const legacy = normalizeAssistanceState({
            scoringVersion: 1,
            hints: [
                { boardIndex: 0, type: 'batchim-count', payload: 1, cost: 5, usedAt: 100 },
                { boardIndex: 1, type: 'tone-pattern', payload: ['2', '5'], cost: 2, usedAt: 101 },
            ],
        });

        expect(legacy).toEqual({
            scoringVersion: 1,
            hints: [
                { boardIndex: 0, type: 'batchim-count', payload: 1, cost: 5, usedAt: 100 },
                { boardIndex: 1, type: 'tone-pattern', payload: ['2', '5'], cost: 2, usedAt: 101 },
            ],
        });
    });

    it('restores only typed variant-specific payloads for version-2 Pinyin history', () => {
        const restored = normalizeAssistanceState({
            scoringVersion: 2,
            puzzleVariant: PINYIN_PUZZLE_VARIANT,
            hints: [
                { boardIndex: 0, type: 'syllable-boundary', payload: 3, cost: 2, usedAt: 100 },
                { boardIndex: 0, type: 'reveal-letter', payload: { index: 4, letter: 'h' }, cost: 5, usedAt: 101 },
                { boardIndex: 0, type: 'broad-meaning', payload: 'a learning clue', cost: 7, usedAt: 102 },
                { boardIndex: 1, type: 'reveal-letter', payload: 'wrong shape', cost: 5, usedAt: 103 },
                { boardIndex: 2, type: 'tone-pattern', payload: ['2', '5'], cost: 2, usedAt: 104 },
            ],
        });

        expect(restored).toEqual({
            scoringVersion: 2,
            puzzleVariant: PINYIN_PUZZLE_VARIANT,
            hints: [
                { boardIndex: 0, type: 'syllable-boundary', payload: 3, cost: 2, usedAt: 100 },
                { boardIndex: 0, type: 'reveal-letter', payload: { index: 4, letter: 'h' }, cost: 5, usedAt: 101 },
                { boardIndex: 0, type: 'broad-meaning', payload: 'a learning clue', cost: 7, usedAt: 102 },
            ],
        });
    });
});

describe('assisted score', () => {
    it('awards 25 per solved board and deducts excess guesses and hint costs', () => {
        const game = createGame({ targetWords: ['price', 'train', 'light', 'sound'] });
        game.boards.forEach((board) => { board.solved = true; });
        game.guessCount = 8;
        game.assistance = appendHintUse(game.assistance, {
            boardIndex: 0,
            type: 'reveal-first-syllable',
            payload: '가',
            cost: 10,
            usedAt: 100,
        });
        expect(calculatePerformanceMetrics(game)).toMatchObject({
            solvedCount: 4,
            guessCount: 8,
            hintCount: 1,
            hintPenalty: 10,
            assisted: true,
            score: 82,
        });
    });

    it('clamps scores at zero', () => {
        const game = createGame({ targetWords: ['price', 'train', 'light', 'sound'] });
        game.guessCount = 99;
        expect(calculatePerformanceMetrics(game).score).toBe(0);
    });

    it('does not penalize guesses at or below the solved-board count', () => {
        const game = createGame({ targetWords: ['price', 'train', 'light', 'sound'] });
        game.boards[0].solved = true;
        game.boards[1].solved = true;
        game.guessCount = 1;
        expect(calculatePerformanceMetrics(game).score).toBe(50);
    });
});
