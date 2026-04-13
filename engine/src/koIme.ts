import {
    canBeCoda,
    canBeOnset,
    combineCodas,
    combineVowels,
    composeHangul,
    isConsonant,
    isVowel,
    splitCompoundCoda,
    splitCompoundVowel,
} from './jamo.js';

export interface KoImeState {
    onset: string | null;
    vowel: string | null;
    coda: string | null;
}

export interface KoImeProcessResult {
    state: KoImeState;
    committed: string;
    display: string;
}

export interface KoImeBackspaceResult {
    state: KoImeState;
    modified: boolean;
    display: string;
}

export function createKoImeState(): KoImeState {
    return { onset: null, vowel: null, coda: null };
}

export function getKoImeDisplayChar(state: KoImeState): string {
    if (!state.onset && !state.vowel) return '';
    if (state.onset && !state.vowel) return state.onset;
    if (state.onset && state.vowel) {
        return composeHangul(state.onset, state.vowel, state.coda);
    }
    return '';
}

export function finalizeKoIme(state: KoImeState): { state: KoImeState; committed: string } {
    return {
        state: createKoImeState(),
        committed: getKoImeDisplayChar(state),
    };
}

export function processKoImeJamo(state: KoImeState, jamo: string): KoImeProcessResult {
    if (isConsonant(jamo)) {
        if (!state.onset && !state.vowel) {
            const next = { ...state, onset: jamo };
            return { state: next, committed: '', display: jamo };
        }

        if (state.onset && !state.vowel) {
            const next = { ...createKoImeState(), onset: jamo };
            return { state: next, committed: state.onset, display: jamo };
        }

        if (state.onset && state.vowel && !state.coda) {
            if (canBeCoda(jamo)) {
                const next = { ...state, coda: jamo };
                return { state: next, committed: '', display: getKoImeDisplayChar(next) };
            }

            const committed = getKoImeDisplayChar(state);
            const next = { ...createKoImeState(), onset: jamo };
            return { state: next, committed, display: jamo };
        }

        if (state.onset && state.vowel && state.coda) {
            const compound = combineCodas(state.coda, jamo);
            if (compound && canBeCoda(compound)) {
                const next = { ...state, coda: compound };
                return { state: next, committed: '', display: getKoImeDisplayChar(next) };
            }

            const committed = getKoImeDisplayChar(state);
            const next = { ...createKoImeState(), onset: jamo };
            return { state: next, committed, display: jamo };
        }
    }

    if (isVowel(jamo)) {
        if (!state.onset && !state.vowel) {
            const next = { onset: 'ㅇ', vowel: jamo, coda: null };
            return { state: next, committed: '', display: getKoImeDisplayChar(next) };
        }

        if (state.onset && !state.vowel) {
            const next = { ...state, vowel: jamo };
            return { state: next, committed: '', display: getKoImeDisplayChar(next) };
        }

        if (state.onset && state.vowel && !state.coda) {
            const combined = combineVowels(state.vowel, jamo);
            if (combined) {
                const next = { ...state, vowel: combined };
                return { state: next, committed: '', display: getKoImeDisplayChar(next) };
            }

            const committed = getKoImeDisplayChar(state);
            const next = { onset: 'ㅇ', vowel: jamo, coda: null };
            return { state: next, committed, display: getKoImeDisplayChar(next) };
        }

        if (state.onset && state.vowel && state.coda) {
            const split = splitCompoundCoda(state.coda);
            let nextOnset: string;
            let committedState: KoImeState;

            if (split) {
                nextOnset = split[1];
                committedState = { ...state, coda: split[0] };
            } else {
                nextOnset = state.coda;
                committedState = { ...state, coda: null };
            }

            const committed = getKoImeDisplayChar(committedState);
            const next = {
                onset: canBeOnset(nextOnset) ? nextOnset : 'ㅇ',
                vowel: jamo,
                coda: null,
            };
            return { state: next, committed, display: getKoImeDisplayChar(next) };
        }
    }

    return { state: { ...state }, committed: '', display: getKoImeDisplayChar(state) };
}

export function backspaceKoIme(state: KoImeState): KoImeBackspaceResult {
    if (state.coda) {
        const split = splitCompoundCoda(state.coda);
        const next = { ...state, coda: split ? split[0] : null };
        return { state: next, modified: true, display: getKoImeDisplayChar(next) };
    }

    if (state.vowel) {
        const split = splitCompoundVowel(state.vowel);
        if (split) {
            const next = { ...state, vowel: split[0] };
            return { state: next, modified: true, display: getKoImeDisplayChar(next) };
        }

        const next = { ...state, vowel: null };
        return { state: next, modified: true, display: next.onset || '' };
    }

    if (state.onset) {
        const next = { ...state, onset: null };
        return { state: next, modified: true, display: '' };
    }

    return { state: { ...state }, modified: false, display: '' };
}
