import { describe, expect, it } from 'vitest';
import { composeHangul } from '../src/jamo.js';
import { backspaceKoIme, createKoImeState, getKoImeDisplayChar, processKoImeJamo } from '../src/koIme.js';

function applyImeInputs(inputs: string[]) {
    let state = createKoImeState();
    let committed = '';
    let display = '';

    for (const input of inputs) {
        const result = processKoImeJamo(state, input);
        state = result.state;
        committed += result.committed;
        display = result.display;
    }

    return { state, committed, display };
}

describe('koIme: compound vowels', () => {
    const cases = [
        { compound: 'ㅘ', first: 'ㅗ', second: 'ㅏ' },
        { compound: 'ㅙ', first: 'ㅗ', second: 'ㅐ' },
        { compound: 'ㅚ', first: 'ㅗ', second: 'ㅣ' },
        { compound: 'ㅝ', first: 'ㅜ', second: 'ㅓ' },
        { compound: 'ㅞ', first: 'ㅜ', second: 'ㅔ' },
        { compound: 'ㅟ', first: 'ㅜ', second: 'ㅣ' },
        { compound: 'ㅢ', first: 'ㅡ', second: 'ㅣ' },
    ] as const;

    for (const { compound, first, second } of cases) {
        it(`composes ${first} + ${second} into ${compound}`, () => {
            const result = applyImeInputs(['ㄱ', first, second]);

            expect(result.committed).toBe('');
            expect(result.display).toBe(composeHangul('ㄱ', compound));
            expect(getKoImeDisplayChar(result.state)).toBe(composeHangul('ㄱ', compound));
        });

        it(`backspace splits ${compound} back to ${first}`, () => {
            const composed = applyImeInputs(['ㄱ', first, second]);
            const backspaced = backspaceKoIme(composed.state);

            expect(backspaced.modified).toBe(true);
            expect(backspaced.display).toBe(composeHangul('ㄱ', first));
        });
    }
});
