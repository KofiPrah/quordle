import { describe, expect, it } from 'vitest';
import { getDailyTargets } from '../src/daily.js';
import { createGame, setCurrentGuess, submitGuess, validateGuess } from '../src/game.js';
import { evaluateGuess } from '../src/evaluator.js';
import { isChineseAnswerWord, isValidChineseGuess, ZH_ANSWER_WORDS } from '../src/chineseLexicon.js';
import {
    findChinesePinyinCandidates,
    normalizePinyin,
    numericPinyinSyllableToMarked,
    numericPinyinToMarked,
    type ChinesePinyinIndex,
} from '../src/pinyin.js';

describe('Chinese lexicon and game mode', () => {
    it('ships the reviewed 64-word answer seed inside the accepted lexicon', () => {
        expect(ZH_ANSWER_WORDS).toHaveLength(64);
        expect(isChineseAnswerWord('学生')).toBe(true);
        expect(isValidChineseGuess('学生')).toBe(true);
        expect(isValidChineseGuess('中A')).toBe(false);
    });

    it('validates, limits, evaluates, and solves two-character Simplified Chinese guesses', () => {
        expect(validateGuess('学生', 'zh')).toEqual({ valid: true });
        expect(validateGuess('学生们', 'zh').valid).toBe(false);
        expect(validateGuess('學生', 'zh').valid).toBe(false);
        expect(validateGuess('学A', 'zh').valid).toBe(false);

        let game = createGame({ targetWords: ['学生', '学校', '老师', '朋友'], language: 'zh' });
        game = setCurrentGuess(game, '学A生校');
        expect(game.currentGuess).toBe('学生');
        game = submitGuess(game, '学生');
        expect(game.boards[0].solved).toBe(true);
        expect(game.boards[1].results[0]).toEqual(['correct', 'absent']);
        expect(game.boards[0].koResults).toBeUndefined();
        expect(evaluateGuess('哥哥', '大哥')).toEqual(['absent', 'correct']);
    });

    it('keeps Chinese dailies deterministic and independent without changing existing language seeds', () => {
        const zh = getDailyTargets('2026-08-06', 'zh');
        expect(zh).toHaveLength(4);
        expect(new Set(zh).size).toBe(4);
        expect(getDailyTargets('2026-08-06', 'zh')).toEqual(zh);
        expect(getDailyTargets('2026-08-06', 'en')).not.toEqual(zh);
        expect(getDailyTargets('2026-08-06', 'ko')).not.toEqual(zh);
        expect(zh).toEqual(['大学', '今天', '哥哥', '机场']);
        expect(getDailyTargets('2025-01-01', 'en')).toEqual(['quote', 'enter', 'curds', 'theft']);
        expect(getDailyTargets('2025-01-01', 'ko')).toEqual(['설계', '카누', '딸기', '책임']);
    });
});

describe('pinyin normalization and candidates', () => {
    const index: ChinesePinyinIndex = {
        candidates: {
            xuesheng: [
                { word: '学声', pinyinNumeric: 'xue2 sheng1', pinyinMarked: 'xué shēng', pinyinPlain: 'xue sheng', answerRank: null },
                { word: '学生', pinyinNumeric: 'xue2 sheng1', pinyinMarked: 'xué shēng', pinyinPlain: 'xue sheng', answerRank: 0 },
            ],
        },
    };

    it('treats plain, marked, numbered, spaced, and decomposed input as one lookup key', () => {
        expect(normalizePinyin('xuesheng')).toBe('xuesheng');
        expect(normalizePinyin('xuéshēng')).toBe('xuesheng');
        expect(normalizePinyin('xue2sheng1')).toBe('xuesheng');
        expect(normalizePinyin('xu\u0065\u0301 sheng')).toBe('xuesheng');
        expect(normalizePinyin("xue'-sheng")).toBe('xuesheng');
    });

    it('converts numeric tones, neutral tone, and umlaut forms for educational output', () => {
        expect(numericPinyinSyllableToMarked('xue2')).toBe('xué');
        expect(numericPinyinSyllableToMarked('nu:3')).toBe('nǚ');
        expect(numericPinyinSyllableToMarked('ma5')).toBe('ma');
        expect(numericPinyinToMarked('xue2 sheng1')).toBe('xué shēng');
    });

    it('returns the full homophone set with reviewed answers before other matches', () => {
        expect(findChinesePinyinCandidates('xuesheng', index).map((candidate) => candidate.word)).toEqual(['学生', '学声']);
        expect(findChinesePinyinCandidates('xuéshēng', index).map((candidate) => candidate.word)).toEqual(['学生', '学声']);
    });
});
