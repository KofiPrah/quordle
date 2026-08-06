import { describe, expect, it } from 'vitest';
import {
    KO_ANSWER_WORDS,
    KO_GUESS_WORDS_LIST,
    isKoreanAnswerWord,
    isValidKoreanGuess,
} from '../src/koreanLexicon.js';

describe('canonical Korean lexicon', () => {
    it('keeps every answer in the accepted guess list', () => {
        const guesses = new Set(KO_GUESS_WORDS_LIST);
        expect(KO_ANSWER_WORDS.every((word) => guesses.has(word))).toBe(true);
    });

    it('rejects well-formed Hangul words outside the metadata-backed list', () => {
        expect(isValidKoreanGuess('기관')).toBe(true);
        expect(isKoreanAnswerWord('기관')).toBe(true);
        expect(isValidKoreanGuess('쀍쀍')).toBe(false);
    });
});
