import { describe, expect, it } from 'vitest';
import { calculatePerformanceMetrics } from '../src/assistance.js';
import { isChineseHintAvailable, requestChineseHint } from '../src/chineseHints.js';
import { createGame, submitGuess } from '../src/game.js';
import { requestHint } from '../src/hints.js';
import { ZH_ANSWER_WORDS } from '../src/chineseLexicon.js';
import { ZH_HINT_METADATA } from '../src/zhHintMetadata.generated.js';

function chineseGame() {
    return createGame({ targetWords: ['学生', '学校', '老师', '朋友'], language: 'zh' });
}

describe('Chinese hints', () => {
    it('returns all four graduated payloads with their configured costs', () => {
        let game = chineseGame();
        const expected = [
            ['tone-pattern', ['2', '5'], 2],
            ['pinyin', 'xué sheng', 5],
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
        expect(requestChineseHint(game, 0, 'pinyin')).toMatchObject({
            ok: true,
            hint: { payload: 'nǚ rén' },
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
        expect(requestChineseHint(solved, 0, 'pinyin')).toMatchObject({ ok: false, code: 'BOARD_SOLVED' });
        solved.boards[0].solved = false;
        solved.gameOver = true;
        expect(requestChineseHint(solved, 0, 'pinyin')).toMatchObject({ ok: false, code: 'GAME_OVER' });
    });

    it('uses persisted hint costs in the unchanged score formula', () => {
        let game = chineseGame();
        for (const type of ['tone-pattern', 'pinyin', 'broad-meaning', 'reveal-first-character'] as const) {
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

    it('ships complete compact hint metadata for the exact answer allowlist', () => {
        expect(Object.keys(ZH_HINT_METADATA)).toHaveLength(64);
        expect(Object.keys(ZH_HINT_METADATA).sort()).toEqual([...ZH_ANSWER_WORDS].sort());
        Object.entries(ZH_HINT_METADATA).forEach(([word, hint]) => {
            expect(hint.firstCharacter).toBe(Array.from(word)[0]);
            expect(hint.tones).toHaveLength(2);
            expect(hint.meaning).not.toMatch(/\p{Script=Han}/u);
        });
    });
});
