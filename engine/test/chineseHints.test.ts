import { describe, expect, it } from 'vitest';
import { calculatePerformanceMetrics } from '../src/assistance.js';
import { isChineseHintAvailable, requestChineseHint } from '../src/chineseHints.js';
import { createGame, submitGuess } from '../src/game.js';
import { requestHint } from '../src/hints.js';
import { CHINESE_PINYIN_PUZZLE_ANSWERS, PINYIN_PUZZLE_VARIANT } from '../src/chineseLexicon.js';
import { ZH_HINT_METADATA } from '../src/zhHintMetadata.generated.js';

function chineseGame() {
    return createGame({ targetWords: ['学生', '学校', '老师', '朋友'], language: 'zh' });
}

function pinyinGame() {
    return createGame({
        targetWords: ['xigua', 'fuqin', 'kafei', 'haizi'],
        targetIds: ['西瓜', '父亲', '咖啡', '孩子'],
        language: 'zh',
        puzzleVariant: PINYIN_PUZZLE_VARIANT,
        wordLength: 5,
    });
}

describe('Chinese Pinyin hints', () => {
    it('returns the persisted boundary index and broad meaning with version-2 costs', () => {
        const boundary = requestChineseHint(pinyinGame(), 0, 'syllable-boundary', 100);
        expect(boundary).toMatchObject({
            ok: true,
            duplicate: false,
            hint: { type: 'syllable-boundary', payload: 2, cost: 2, usedAt: 100 },
        });
        if (!boundary.ok) return;

        const meaning = requestChineseHint(boundary.state, 0, 'broad-meaning', 101);
        expect(meaning).toMatchObject({
            ok: true,
            hint: {
                payload: 'a large green-rinded fruit with a juicy interior',
                cost: 7,
                usedAt: 101,
            },
        });
        if (meaning.ok) expect(meaning.state.assistance).toMatchObject({ scoringVersion: 2, hints: expect.any(Array) });
    });

    it('reveals the lowest target position that has never been green', () => {
        const game = pinyinGame();
        game.boards[0].guesses = ['aaaaa', 'bbbbb'];
        game.boards[0].results = [
            ['correct', 'absent', 'correct', 'absent', 'absent'],
            ['absent', 'correct', 'absent', 'absent', 'absent'],
        ];

        expect(requestChineseHint(game, 0, 'reveal-letter', 200)).toMatchObject({
            ok: true,
            hint: { payload: { index: 3, letter: 'u' }, cost: 5, usedAt: 200 },
        });
    });

    it('never reveals the final unresolved position', () => {
        const game = pinyinGame();
        game.boards[0].guesses = ['xiguq'];
        game.boards[0].results = [['correct', 'correct', 'correct', 'correct', 'absent']];

        expect(isChineseHintAvailable(game, 0, 'reveal-letter')).toBe(false);
        expect(requestChineseHint(game, 0, 'reveal-letter')).toMatchObject({
            ok: false,
            code: 'HINT_UNAVAILABLE',
        });
        expect(game.assistance.hints).toHaveLength(0);
    });

    it('returns the original typed reveal payload and timestamp without charging twice', () => {
        const first = requestChineseHint(pinyinGame(), 0, 'reveal-letter', 300);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(isChineseHintAvailable(first.state, 0, 'reveal-letter')).toBe(false);
        first.state.boards[0].results = [['correct', 'absent', 'absent', 'absent', 'absent']];

        const repeated = requestChineseHint(first.state, 0, 'reveal-letter', 999);
        expect(repeated).toMatchObject({
            ok: true,
            duplicate: true,
            hint: { payload: { index: 0, letter: 'x' }, cost: 5, usedAt: 300 },
        });
        if (repeated.ok) expect(repeated.state.assistance.hints).toHaveLength(1);
    });

    it('rejects every retired Hanzi hint type in a Pinyin game', () => {
        for (const type of ['tone-pattern', 'pinyin-initials', 'reveal-first-character'] as const) {
            expect(isChineseHintAvailable(pinyinGame(), 0, type)).toBe(false);
            expect(requestChineseHint(pinyinGame(), 0, type)).toMatchObject({ ok: false, code: 'INVALID_HINT' });
        }
    });
});

describe('Chinese hints', () => {
    it('reconstructs every historical version-1 pinyin-initials payload', () => {
        const mismatches = CHINESE_PINYIN_PUZZLE_ANSWERS.flatMap((answer) => {
            const game = createGame({
                targetWords: [answer.hanzi, answer.hanzi, answer.hanzi, answer.hanzi],
                language: 'zh',
            });
            const result = requestChineseHint(game, 0, 'pinyin-initials', 100);
            const actual = result.ok ? result.hint.payload : result;
            const expected = [...ZH_HINT_METADATA[answer.hanzi as keyof typeof ZH_HINT_METADATA].pinyinInitials];
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [{ id: answer.id, expected, actual }];
        });

        expect(mismatches).toEqual([]);
    });

    it('returns all four graduated payloads with their configured costs', () => {
        let game = chineseGame();
        const expected = [
            ['tone-pattern', ['2', '5'], 2],
            ['pinyin-initials', ['x', 'sh'], 5],
            ['broad-meaning', 'a person enrolled in a course of learning', 7],
            ['reveal-first-character', '学', 10],
        ] as const;
        expected.forEach(([type, payload, cost], index) => {
            const result = requestChineseHint(game, 0, type, 100 + index);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.hint.payload).toEqual(payload);
            expect(result.hint.cost).toBe(cost);
            game = result.state;
        });
        expect(game.assistance.hints).toHaveLength(4);
    });

    it('uses the canonical first pronunciation and preserves neutral tone 5', () => {
        const game = createGame({ targetWords: ['女人', '学生', '学校', '老师'], language: 'zh' });
        expect(requestChineseHint(game, 0, 'pinyin-initials')).toMatchObject({
            ok: true,
            hint: { payload: ['n', 'r'] },
        });
        expect(requestChineseHint(game, 1, 'tone-pattern')).toMatchObject({
            ok: true,
            hint: { payload: ['2', '5'] },
        });
    });

    it('is idempotent for a repeated board and hint type', () => {
        const first = requestChineseHint(chineseGame(), 0, 'tone-pattern', 100);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const repeated = requestChineseHint(first.state, 0, 'tone-pattern', 200);
        expect(repeated).toMatchObject({ ok: true, duplicate: true, hint: { cost: 2, usedAt: 100 } });
        if (repeated.ok) expect(repeated.state.assistance.hints).toHaveLength(1);
    });

    it('does not charge a first-character reveal that feedback already confirms', () => {
        const game = submitGuess(chineseGame(), '学校');
        expect(game.boards[0].results[0][0]).toBe('correct');
        expect(isChineseHintAvailable(game, 0, 'reveal-first-character')).toBe(false);
        expect(requestChineseHint(game, 0, 'reveal-first-character')).toMatchObject({
            ok: false,
            code: 'HINT_UNAVAILABLE',
        });
        expect(game.assistance.hints).toHaveLength(0);
    });

    it('returns a purchased first-character reveal after later feedback confirms it', () => {
        const purchased = requestChineseHint(chineseGame(), 0, 'reveal-first-character', 100);
        expect(purchased.ok).toBe(true);
        if (!purchased.ok) return;
        const withFeedback = submitGuess(purchased.state, '学校');
        const repeated = requestChineseHint(withFeedback, 0, 'reveal-first-character', 200);
        expect(repeated).toMatchObject({
            ok: true,
            duplicate: true,
            hint: { payload: '学', cost: 10, usedAt: 100 },
        });
        if (repeated.ok) expect(repeated.state.assistance.hints).toHaveLength(1);
    });

    it('rejects English, language-mismatched types, solved boards, and finished games', () => {
        const english = createGame({ targetWords: ['price', 'train', 'light', 'sound'] });
        expect(requestHint(english, 0, 'tone-pattern')).toMatchObject({ ok: false, code: 'INVALID_LANGUAGE' });
        expect(requestHint(chineseGame(), 0, 'part-of-speech')).toMatchObject({ ok: false, code: 'INVALID_HINT' });

        const solved = chineseGame();
        solved.boards[0].solved = true;
        expect(requestChineseHint(solved, 0, 'pinyin-initials')).toMatchObject({ ok: false, code: 'BOARD_SOLVED' });
        solved.boards[0].solved = false;
        solved.gameOver = true;
        expect(requestChineseHint(solved, 0, 'pinyin-initials')).toMatchObject({ ok: false, code: 'GAME_OVER' });
    });

    it('uses persisted hint costs in the unchanged score formula', () => {
        let game = chineseGame();
        for (const type of ['tone-pattern', 'pinyin-initials', 'broad-meaning', 'reveal-first-character'] as const) {
            const result = requestChineseHint(game, 0, type);
            expect(result.ok).toBe(true);
            if (result.ok) game = result.state;
        }
        game = submitGuess(game, '学生');
        expect(calculatePerformanceMetrics(game)).toMatchObject({
            solvedCount: 1,
            hintCount: 4,
            hintPenalty: 24,
            assisted: true,
            score: 1,
        });
    });

    it('represents a vowel-initial syllable without exposing its pinyin', () => {
        const game = createGame({ targetWords: ['儿子', '学生', '学校', '老师'], language: 'zh' });
        expect(requestChineseHint(game, 0, 'pinyin-initials')).toMatchObject({
            ok: true,
            hint: { payload: ['∅', 'z'] },
        });
    });
});
