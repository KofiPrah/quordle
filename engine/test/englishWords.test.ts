import { describe, expect, it } from 'vitest';
import { WORD_LIST, GUESS_WORDS, isValidGuess } from '../src/words.js';
import { getDailyTargets } from '../src/daily.js';

describe('expanded English vocabulary', () => {
    it('provides a larger, unique five-letter answer and guess pool', () => {
        expect(WORD_LIST.length).toBeGreaterThanOrEqual(2700);
        expect(GUESS_WORDS.length).toBeGreaterThan(16000);
        for (const list of [WORD_LIST, GUESS_WORDS]) {
            expect(new Set(list).size).toBe(list.length);
            expect(list.every(word => /^[a-z]{5}$/.test(word))).toBe(true);
        }
        expect(WORD_LIST.every(isValidGuess)).toBe(true);
        expect(WORD_LIST).toContain('otter');
        expect(WORD_LIST).toContain('tulip');
    });

    it('preserves older English daily puzzles', () => {
        expect(getDailyTargets('2025-01-01', 'en')).toEqual(['quote', 'enter', 'curds', 'theft']);
    });

    it('selects four distinct accepted answers after the expansion', () => {
        const targets = getDailyTargets('2026-10-12', 'en');
        expect(new Set(targets).size).toBe(4);
        expect(targets.every(isValidGuess)).toBe(true);
        expect(getDailyTargets('2026-10-12', 'en')).toEqual(targets);
        const futureAnswers = Array.from({ length: 20 }, (_, day) =>
            getDailyTargets(`2026-11-${String(day + 1).padStart(2, '0')}`, 'en')
        ).flat();
        expect(futureAnswers.some(word => WORD_LIST.indexOf(word) >= 1838)).toBe(true);
    });
});
