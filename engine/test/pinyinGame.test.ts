import { describe, expect, it } from 'vitest';
import {
    getDailyChinesePinyinRound,
    getDailyTargets,
    getPracticeChinesePinyinRound,
} from '../src/daily.js';
import { ENABLED_ZH_PINYIN_LENGTHS, PINYIN_PUZZLE_VARIANT } from '../src/chineseLexicon.js';
import { getLanguageConfig } from '../src/languageConfig.js';
import * as engine from '../src/index.js';
import {
    applyValidatedGuess,
    createGame,
    setCurrentGuess,
    submitGuess,
    validateGuessForGame,
} from '../src/game.js';

function createPinyinGame(targetWords: [string, string, string, string], targetIds?: [string, string, string, string]) {
    return createGame({
        targetWords,
        ...(targetIds ? { targetIds } : {}),
        language: 'zh',
        puzzleVariant: PINYIN_PUZZLE_VARIANT,
        wordLength: targetWords[0].length,
    });
}

describe('Chinese Pinyin round selection', () => {
    it('enables exactly the approved 5, 6, and 7 letter Pinyin buckets', () => {
        expect(ENABLED_ZH_PINYIN_LENGTHS).toEqual([5, 6, 7]);
    });

    it('exports the authoritative selection, validation, and transition surface', () => {
        expect(engine.getDailyChinesePinyinRound).toBe(getDailyChinesePinyinRound);
        expect(engine.getPracticeChinesePinyinRound).toBe(getPracticeChinesePinyinRound);
        expect(engine.validateGuessForGame).toBe(validateGuessForGame);
        expect(engine.applyValidatedGuess).toBe(applyValidatedGuess);
    });

    it('selects a deterministic enabled length before shuffling four unique daily answers', () => {
        const round = getDailyChinesePinyinRound('2026-08-17');

        expect(round).toMatchObject({
            variant: PINYIN_PUZZLE_VARIANT,
            length: 6,
        });
        expect(round.answers.map(({ id, key }) => ({ id, key }))).toEqual([
            { id: '去年', key: 'qunian' },
            { id: '姐姐', key: 'jiejie' },
            { id: '公司', key: 'gongsi' },
            { id: '篮球', key: 'lanqiu' },
        ]);
        expect(getDailyChinesePinyinRound('2026-08-17')).toEqual(round);
        expect(new Set(round.answers.map((answer) => answer.key)).size).toBe(4);
        expect(new Set(round.answers.map((answer) => answer.id)).size).toBe(4);
        expect(round.answers.every((answer) => answer.length === round.length)).toBe(true);
    });

    it('chooses practice length first and returns four entries from that bucket', () => {
        const randomValues = [0.4, 0.9, 0.1, 0.7, 0.2, 0.8, 0.3, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0];
        let index = 0;
        const round = getPracticeChinesePinyinRound(() => randomValues[index++] ?? 0);

        expect(round.variant).toBe(PINYIN_PUZZLE_VARIANT);
        expect(round.length).toBe(6);
        expect(ENABLED_ZH_PINYIN_LENGTHS).toContain(round.length);
        expect(round.answers).toHaveLength(4);
        expect(new Set(round.answers.map((answer) => answer.key)).size).toBe(4);
        expect(new Set(round.answers.map((answer) => answer.id)).size).toBe(4);
        expect(round.answers.every((answer) => answer.length === round.length)).toBe(true);
    });

    it('preserves historical English and Korean daily fixtures', () => {
        expect(getDailyTargets('2025-01-01', 'en')).toEqual(['quote', 'enter', 'curds', 'theft']);
        expect(getDailyTargets('2025-01-01', 'ko')).toEqual(['설계', '카누', '딸기', '책임']);
    });
});

describe('Chinese Pinyin game state', () => {
    it('provides a per-game Pinyin language configuration without changing legacy Chinese', () => {
        const pinyin = getLanguageConfig('zh', 8, PINYIN_PUZZLE_VARIANT);

        expect(pinyin.wordLength).toBe(8);
        expect(pinyin.maxGuesses).toBe(9);
        expect(pinyin.validateCharRegex.test('xuesheng')).toBe(true);
        expect(pinyin.guessWords.has('xuesheng')).toBe(true);
        expect(getLanguageConfig('zh').wordLength).toBe(2);
    });

    it.each([
        [5, ['fuqin', 'kafei', 'haizi', 'baise'], ['父亲', '咖啡', '孩子', '白色']],
        [6, ['qunian', 'jiejie', 'gongsi', 'lanqiu'], ['去年', '姐姐', '公司', '篮球']],
        [7, ['pingguo', 'mianbao', 'diannao', 'dianshi'], ['苹果', '面包', '电脑', '电视']],
    ] as const)('creates a %i-letter version-2 game with target identities and nine guesses', (wordLength, targetWords, targetIds) => {
        const game = createGame({
            targetWords: [...targetWords],
            targetIds: [...targetIds],
            language: 'zh',
            puzzleVariant: PINYIN_PUZZLE_VARIANT,
            wordLength,
        });

        expect(game).toMatchObject({
            language: 'zh',
            puzzleVariant: PINYIN_PUZZLE_VARIANT,
            wordLength,
            maxGuesses: 9,
            assistance: { scoringVersion: 2, puzzleVariant: PINYIN_PUZZLE_VARIANT, hints: [] },
        });
        expect(game.boards.map((board) => board.targetId)).toEqual(targetIds);
        expect(game.boards.map((board) => board.targetWord)).toEqual(targetWords);
    });

    it('limits a Pinyin draft using the current game length and Latin tile alphabet', () => {
        const game = createGame({
            targetWords: ['qunian', 'jiejie', 'gongsi', 'lanqiu'],
            targetIds: ['去年', '姐姐', '公司', '篮球'],
            language: 'zh',
            puzzleVariant: PINYIN_PUZZLE_VARIANT,
            wordLength: 6,
        });

        expect(setCurrentGuess(game, 'QU-NIANx').currentGuess).toBe('qunian');
    });

    it('keeps the Pinyin attempt budget authoritative at nine', () => {
        const game = createGame({
            targetWords: ['qunian', 'jiejie', 'gongsi', 'lanqiu'],
            language: 'zh',
            puzzleVariant: PINYIN_PUZZLE_VARIANT,
            wordLength: 6,
            maxGuesses: 12,
        });

        expect(game.maxGuesses).toBe(9);
    });
});

describe('authoritative Chinese Pinyin validation and transition', () => {
    it('returns stable format, length, and generated-list failures in that order', () => {
        const game = createPinyinGame(['qunian', 'jiejie', 'gongsi', 'lanqiu']);

        expect(validateGuessForGame(game, 'xue/sheng')).toMatchObject({ valid: false, code: 'INVALID_FORMAT' });
        expect(validateGuessForGame(game, 'xue sheng')).toMatchObject({ valid: false, code: 'INVALID_LENGTH' });
        expect(validateGuessForGame(game, 'mi miao')).toMatchObject({ valid: false, code: 'NOT_IN_LIST' });
    });

    it.each([
        [4, 'nü ér', 'nver'],
        [8, 'xué shēng', 'xuesheng'],
        [9, 'xiang1 jiao1', 'xiangjiao'],
    ] as const)('supports strict normalization and generated validation at engine length %i', (wordLength, source, normalizedGuess) => {
        const game = createGame({
            targetWords: [normalizedGuess, normalizedGuess, normalizedGuess, normalizedGuess],
            language: 'zh',
            puzzleVariant: PINYIN_PUZZLE_VARIANT,
            wordLength,
        });

        expect(validateGuessForGame(game, source)).toEqual({ valid: true, normalizedGuess });
    });

    it('collapses a homophone spelling into one playable normalized guess', () => {
        const game = createPinyinGame(['aiyou', 'fuqin', 'kafei', 'haizi']);
        expect(validateGuessForGame(game, 'ai you')).toEqual({ valid: true, normalizedGuess: 'aiyou' });
    });

    it('does not consume or append an invalid submission', () => {
        const game = createPinyinGame(['qunian', 'jiejie', 'gongsi', 'lanqiu']);
        const rejected = submitGuess(game, 'mi miao');

        expect(rejected).toBe(game);
        expect(rejected.guessCount).toBe(0);
        expect(rejected.boards.every((board) => board.guesses.length === 0)).toBe(true);
    });

    it('appends one validated key and evaluates every board with duplicate-aware letter counts', () => {
        const game = createPinyinGame(['jiejin', 'jiejie', 'gongsi', 'lanqiu']);
        const next = applyValidatedGuess(game, 'jiejie');

        expect(next.guessCount).toBe(1);
        expect(next.boards.every((board) => board.guesses[0] === 'jiejie')).toBe(true);
        expect(next.boards[0].results[0]).toEqual([
            'correct', 'correct', 'correct', 'correct', 'correct', 'absent',
        ]);
        expect(next.boards[1]).toMatchObject({ solved: true, solvedOnGuess: 1 });
    });

    it.each([
        [['fuqin', 'kafei', 'haizi', 'baise'], 'fuqin'],
        [['qunian', 'jiejie', 'gongsi', 'lanqiu'], 'qunian'],
        [['pingguo', 'mianbao', 'diannao', 'dianshi'], 'pingguo'],
    ] as const)('ends an unsolved enabled-length game on its ninth accepted guess', (targetWords, acceptedGuess) => {
        let game = createPinyinGame([...targetWords]);
        for (let attempt = 0; attempt < 9; attempt += 1) {
            game = submitGuess(game, acceptedGuess);
        }

        expect(game).toMatchObject({ guessCount: 9, maxGuesses: 9, gameOver: true, won: false });
    });

    it.each([
        [['fuqin', 'kafei', 'haizi', 'baise']],
        [['qunian', 'jiejie', 'gongsi', 'lanqiu']],
        [['pingguo', 'mianbao', 'diannao', 'dianshi']],
    ] as const)('submits and solves every board in an enabled-length game', (targetWords) => {
        let game = createPinyinGame([...targetWords]);
        for (const target of targetWords) game = submitGuess(game, target);

        expect(game).toMatchObject({ guessCount: 4, gameOver: true, won: true });
        expect(game.boards.every((board) => board.solved && board.results.every(
            (result) => result.length === game.wordLength,
        ))).toBe(true);
    });
});
