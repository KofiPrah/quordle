const MARKED_VOWELS: Record<string, { base: string; tone: number }> = {
    'ā': { base: 'a', tone: 1 }, 'á': { base: 'a', tone: 2 }, 'ǎ': { base: 'a', tone: 3 }, 'à': { base: 'a', tone: 4 },
    'ē': { base: 'e', tone: 1 }, 'é': { base: 'e', tone: 2 }, 'ě': { base: 'e', tone: 3 }, 'è': { base: 'e', tone: 4 },
    'ī': { base: 'i', tone: 1 }, 'í': { base: 'i', tone: 2 }, 'ǐ': { base: 'i', tone: 3 }, 'ì': { base: 'i', tone: 4 },
    'ō': { base: 'o', tone: 1 }, 'ó': { base: 'o', tone: 2 }, 'ǒ': { base: 'o', tone: 3 }, 'ò': { base: 'o', tone: 4 },
    'ū': { base: 'u', tone: 1 }, 'ú': { base: 'u', tone: 2 }, 'ǔ': { base: 'u', tone: 3 }, 'ù': { base: 'u', tone: 4 },
    'ǖ': { base: 'v', tone: 1 }, 'ǘ': { base: 'v', tone: 2 }, 'ǚ': { base: 'v', tone: 3 }, 'ǜ': { base: 'v', tone: 4 },
};

const TONE_MARKS: Record<string, readonly string[]> = {
    a: ['a', 'ā', 'á', 'ǎ', 'à'],
    e: ['e', 'ē', 'é', 'ě', 'è'],
    i: ['i', 'ī', 'í', 'ǐ', 'ì'],
    o: ['o', 'ō', 'ó', 'ǒ', 'ò'],
    u: ['u', 'ū', 'ú', 'ǔ', 'ù'],
    v: ['ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

function normalizeUmlaut(value: string): string {
    return value.replace(/u:/gu, 'v').replace(/ü/gu, 'v');
}

/** A compact, lower-case, tone-insensitive key used by the Chinese candidate index. */
export function normalizePinyin(input: string): string {
    const normalized = normalizeUmlaut(String(input ?? '').normalize('NFC').toLowerCase());
    let result = '';
    for (const character of normalized) {
        const marked = MARKED_VOWELS[character];
        if (marked) {
            result += marked.base;
        } else if (/^[a-z]$/u.test(character)) {
            result += character;
        }
    }
    return result;
}

/** Preserve written tones while removing harmless spacing differences for ranking. */
export function normalizePinyinToneSignature(input: string): string {
    return normalizeUmlaut(String(input ?? '').normalize('NFC').toLowerCase())
        .replace(/[\s'\-·]/gu, '');
}

export function numericPinyinSyllableToMarked(input: string): string {
    const match = /^([a-zA-Z]+(?::)?)([1-5])?$/u.exec(String(input ?? '').trim());
    if (!match) return '';
    const tone = Number(match[2] || 5);
    const syllable = normalizeUmlaut(match[1].toLowerCase());
    if (tone === 5) return syllable.replace(/v/gu, 'ü');

    const vowels = [...syllable]
        .map((character, index) => ({ character, index }))
        .filter(({ character }) => ['a', 'e', 'i', 'o', 'u', 'v'].includes(character));
    if (vowels.length === 0) return syllable;

    let markIndex = vowels[vowels.length - 1].index;
    const a = vowels.find(({ character }) => character === 'a');
    const e = vowels.find(({ character }) => character === 'e');
    const ou = syllable.indexOf('ou');
    if (a) markIndex = a.index;
    else if (e) markIndex = e.index;
    else if (ou >= 0) markIndex = ou;

    const characters = [...syllable];
    const vowel = characters[markIndex];
    characters[markIndex] = TONE_MARKS[vowel]?.[tone] ?? vowel;
    return characters.join('').replace(/v/gu, 'ü');
}

export function numericPinyinToMarked(input: string): string {
    return String(input ?? '')
        .trim()
        .split(/\s+/u)
        .map(numericPinyinSyllableToMarked)
        .filter(Boolean)
        .join(' ');
}

export function numericPinyinToPlain(input: string): string {
    return String(input ?? '')
        .trim()
        .split(/\s+/u)
        .map((syllable) => normalizePinyin(syllable).replace(/v/gu, 'ü'))
        .filter(Boolean)
        .join(' ');
}

export interface ChinesePinyinCandidate {
    word: string;
    pinyinNumeric: string;
    pinyinMarked: string;
    pinyinPlain: string;
    answerRank: number | null;
}

export interface ChinesePinyinIndex {
    candidates: Record<string, ChinesePinyinCandidate[]>;
}

export function findChinesePinyinCandidates(
    input: string,
    index: ChinesePinyinIndex | null | undefined,
): ChinesePinyinCandidate[] {
    const key = normalizePinyin(input);
    if (!key || !index?.candidates?.[key]) return [];
    const toneSignature = normalizePinyinToneSignature(input);
    return [...index.candidates[key]].sort((left, right) => {
        const leftExact = toneSignature === normalizePinyinToneSignature(left.pinyinNumeric)
            || toneSignature === normalizePinyinToneSignature(left.pinyinMarked);
        const rightExact = toneSignature === normalizePinyinToneSignature(right.pinyinNumeric)
            || toneSignature === normalizePinyinToneSignature(right.pinyinMarked);
        if (leftExact !== rightExact) return leftExact ? -1 : 1;
        const leftRank = left.answerRank ?? Number.MAX_SAFE_INTEGER;
        const rightRank = right.answerRank ?? Number.MAX_SAFE_INTEGER;
        if (leftRank !== rightRank) return leftRank - rightRank;
        const wordOrder = left.word.localeCompare(right.word, 'zh-Hans');
        return wordOrder || left.pinyinNumeric.localeCompare(right.pinyinNumeric, 'en');
    });
}
