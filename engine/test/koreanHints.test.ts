import { describe, expect, it } from 'vitest';
import { createGame } from '../src/game.js';
import { requestKoreanHint } from '../src/koreanHints.js';

describe('Korean hints', () => {
    it('returns each supported payload with its configured cost', () => {
        let game = createGame({ targetWords: ['가격', '기차', '기계', '기본'], language: 'ko' });
        const expected = [
            ['part-of-speech', ['noun'], 2],
            ['semantic-category', expect.any(Array), 3],
            ['batchim-count', 1, 5],
            ['reveal-first-syllable', '가', 10],
        ] as const;
        expected.forEach(([type, payload, cost], index) => {
            const result = requestKoreanHint(game, 0, type, 100 + index);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.hint.payload).toEqual(payload);
            expect(result.hint.cost).toBe(cost);
            game = result.state;
        });
        expect(game.assistance.hints).toHaveLength(4);
    });

    it('is idempotent for a repeated board/type request', () => {
        const game = createGame({ targetWords: ['가격', '기차', '기계', '기본'], language: 'ko' });
        const first = requestKoreanHint(game, 0, 'part-of-speech', 100);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const repeated = requestKoreanHint(first.state, 0, 'part-of-speech', 200);
        expect(repeated).toMatchObject({ ok: true, duplicate: true, hint: { cost: 2, usedAt: 100 } });
        if (repeated.ok) expect(repeated.state.assistance.hints).toHaveLength(1);
    });

    it('counts Unicode Hangul codas across both syllables', () => {
        let game = createGame({ targetWords: ['가게', '가격', '각본', '기본'], language: 'ko' });
        const expectedCounts = [0, 1, 2];
        expectedCounts.forEach((expected, boardIndex) => {
            const result = requestKoreanHint(game, boardIndex, 'batchim-count', 100 + boardIndex);
            expect(result).toMatchObject({ ok: true, hint: { payload: expected, cost: 5 } });
            if (result.ok) game = result.state;
        });
        expect(game.assistance.hints).toHaveLength(3);
    });

    it('rejects English, solved boards, finished games, and unavailable categories without charging', () => {
        const english = createGame({ targetWords: ['price', 'train', 'light', 'sound'] });
        expect(requestKoreanHint(english, 0, 'part-of-speech')).toMatchObject({ ok: false, code: 'INVALID_LANGUAGE' });

        const korean = createGame({ targetWords: ['가격', '기차', '기계', '기본'], language: 'ko' });
        korean.boards[0].solved = true;
        expect(requestKoreanHint(korean, 0, 'part-of-speech')).toMatchObject({ ok: false, code: 'BOARD_SOLVED' });
        korean.boards[0].solved = false;
        korean.gameOver = true;
        expect(requestKoreanHint(korean, 0, 'part-of-speech')).toMatchObject({ ok: false, code: 'GAME_OVER' });

        const missing = createGame({ targetWords: ['기계', '가격', '기차', '기본'], language: 'ko' });
        expect(requestKoreanHint(missing, 0, 'semantic-category')).toMatchObject({ ok: false, code: 'HINT_UNAVAILABLE' });
        expect(missing.assistance.hints).toHaveLength(0);
    });
});
