/**
 * Korean Hangul Jamo decomposition/composition utilities.
 *
 * Korean syllable blocks (가–힣, U+AC00–U+D7A3) are composed of:
 *   - 초성 (onset/initial consonant): 19 values
 *   - 중성 (vowel/medial): 21 values
 *   - 종성 (coda/final consonant): 28 values (index 0 = no coda)
 *
 * Formula: syllableCode = 0xAC00 + (onset * 21 + vowel) * 28 + coda
 */

// Onset (초성) consonants — 19 entries
export const ONSETS = [
    'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
    'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

// Vowel (중성) — 21 entries
export const VOWELS = [
    'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
    'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ',
    'ㅣ',
] as const;

// Coda (종성) — 28 entries (index 0 = no coda)
export const CODAS = [
    '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ',
    'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ',
    'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

const HANGUL_BASE = 0xAC00;
const VOWEL_COUNT = 21;
const CODA_COUNT = 28;

export interface DecomposedSyllable {
    onset: string;
    vowel: string;
    coda: string | null; // null = no coda (종성 없음)
}

/** Check if a character is a composed Hangul syllable block (가–힣) */
export function isHangulSyllable(char: string): boolean {
    const code = char.charCodeAt(0);
    return code >= 0xAC00 && code <= 0xD7A3;
}

/** Check if a character is a compatibility jamo (ㄱ–ㅎ, ㅏ–ㅣ, U+3131–U+3163) */
export function isJamo(char: string): boolean {
    const code = char.charCodeAt(0);
    return code >= 0x3131 && code <= 0x3163;
}

/** Check if a character is a consonant jamo (ㄱ–ㅎ, U+3131–U+314E) */
export function isConsonant(char: string): boolean {
    const code = char.charCodeAt(0);
    return code >= 0x3131 && code <= 0x314E;
}

/** Check if a character is a vowel jamo (ㅏ–ㅣ, U+314F–U+3163) */
export function isVowel(char: string): boolean {
    const code = char.charCodeAt(0);
    return code >= 0x314F && code <= 0x3163;
}

/**
 * Decompose a composed Hangul syllable block into its jamo components.
 * e.g., '한' → { onset: 'ㅎ', vowel: 'ㅏ', coda: 'ㄴ' }
 *        '가' → { onset: 'ㄱ', vowel: 'ㅏ', coda: null }
 */
export function decomposeHangul(syllable: string): DecomposedSyllable {
    if (!isHangulSyllable(syllable)) {
        throw new Error(`Not a Hangul syllable: ${syllable} (U+${syllable.charCodeAt(0).toString(16)})`);
    }

    const code = syllable.charCodeAt(0) - HANGUL_BASE;
    const onsetIndex = Math.floor(code / (VOWEL_COUNT * CODA_COUNT));
    const vowelIndex = Math.floor((code % (VOWEL_COUNT * CODA_COUNT)) / CODA_COUNT);
    const codaIndex = code % CODA_COUNT;

    return {
        onset: ONSETS[onsetIndex],
        vowel: VOWELS[vowelIndex],
        coda: codaIndex === 0 ? null : CODAS[codaIndex],
    };
}

/**
 * Compose jamo components into a Hangul syllable block.
 * e.g., ('ㅎ', 'ㅏ', 'ㄴ') → '한'
 *        ('ㄱ', 'ㅏ')      → '가'
 */
export function composeHangul(onset: string, vowel: string, coda?: string | null): string {
    const onsetIndex = ONSETS.indexOf(onset as typeof ONSETS[number]);
    const vowelIndex = VOWELS.indexOf(vowel as typeof VOWELS[number]);
    const codaIndex = coda ? CODAS.indexOf(coda as typeof CODAS[number]) : 0;

    if (onsetIndex === -1) throw new Error(`Invalid onset: ${onset}`);
    if (vowelIndex === -1) throw new Error(`Invalid vowel: ${vowel}`);
    if (codaIndex === -1) throw new Error(`Invalid coda: ${coda}`);

    const code = HANGUL_BASE + (onsetIndex * VOWEL_COUNT + vowelIndex) * CODA_COUNT + codaIndex;
    return String.fromCharCode(code);
}

/**
 * Get all unique jamo from a Hangul word (for keyboard coloring).
 * Returns an array of jamo characters extracted from each syllable.
 */
export function extractJamo(word: string): string[] {
    const jamo: string[] = [];
    for (const char of word) {
        if (isHangulSyllable(char)) {
            const d = decomposeHangul(char);
            jamo.push(d.onset, d.vowel);
            if (d.coda) jamo.push(d.coda);
        }
    }
    return jamo;
}

// ========== IME COMPOSITION HELPERS ==========

/**
 * Mapping from compatibility consonant jamo to onset index.
 * Not all compatibility consonants are valid as onsets or codas.
 */
const COMPAT_CONSONANT_TO_ONSET: Record<string, number> = {};
ONSETS.forEach((c, i) => { COMPAT_CONSONANT_TO_ONSET[c] = i; });

const COMPAT_CONSONANT_TO_CODA: Record<string, number> = {};
CODAS.forEach((c, i) => { if (c) COMPAT_CONSONANT_TO_CODA[c] = i; });

/** Check if a compatibility consonant can serve as an onset (초성) */
export function canBeOnset(char: string): boolean {
    return char in COMPAT_CONSONANT_TO_ONSET;
}

/** Check if a compatibility consonant can serve as a coda (종성) */
export function canBeCoda(char: string): boolean {
    return char in COMPAT_CONSONANT_TO_CODA;
}

// Compound codas that split when followed by a vowel
// e.g., ㄳ → ㄱ (stays as coda) + ㅅ (becomes next onset)
const COMPOUND_CODA_SPLIT: Record<string, [string, string]> = {
    'ㄳ': ['ㄱ', 'ㅅ'],
    'ㄵ': ['ㄴ', 'ㅈ'],
    'ㄶ': ['ㄴ', 'ㅎ'],
    'ㄺ': ['ㄹ', 'ㄱ'],
    'ㄻ': ['ㄹ', 'ㅁ'],
    'ㄼ': ['ㄹ', 'ㅂ'],
    'ㄽ': ['ㄹ', 'ㅅ'],
    'ㄾ': ['ㄹ', 'ㅌ'],
    'ㄿ': ['ㄹ', 'ㅍ'],
    'ㅀ': ['ㄹ', 'ㅎ'],
    'ㅄ': ['ㅂ', 'ㅅ'],
};

/** Split a compound coda into [remaining coda, next onset]. Returns null if not compound. */
export function splitCompoundCoda(coda: string): [string, string] | null {
    return COMPOUND_CODA_SPLIT[coda] || null;
}

// Two consonants that combine into a compound coda
const CODA_COMBINATIONS: Record<string, Record<string, string>> = {
    'ㄱ': { 'ㅅ': 'ㄳ' },
    'ㄴ': { 'ㅈ': 'ㄵ', 'ㅎ': 'ㄶ' },
    'ㄹ': { 'ㄱ': 'ㄺ', 'ㅁ': 'ㄻ', 'ㅂ': 'ㄼ', 'ㅅ': 'ㄽ', 'ㅌ': 'ㄾ', 'ㅍ': 'ㄿ', 'ㅎ': 'ㅀ' },
    'ㅂ': { 'ㅅ': 'ㅄ' },
};

/** Try to combine two consonants into a compound coda. Returns null if not combinable. */
export function combineCodas(first: string, second: string): string | null {
    return CODA_COMBINATIONS[first]?.[second] || null;
}
