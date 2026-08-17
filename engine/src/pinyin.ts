import { ZH_PINYIN_SYLLABLES } from './zhPinyinSyllables.generated.js';

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
    return value.replace(/u:/gu, 'v').replace(/ü/gu, 'v').replace(/Ã¼/gu, 'v');
}

const PINYIN_SYLLABLE_SET = new Set(ZH_PINYIN_SYLLABLES);

export interface ParsedChinesePinyinSyllable {
    key: string;
    tone: number | null;
}

export interface ParsedChinesePinyinInput {
    key: string;
    syllables: [ParsedChinesePinyinSyllable, ParsedChinesePinyinSyllable];
}

function parsePinyinSyllable(source: string, numericTone: number | null): ParsedChinesePinyinSyllable | null {
    let key = '';
    let markedTone: number | null = null;
    for (const character of normalizeUmlaut(source.normalize('NFC').toLowerCase())) {
        const marked = MARKED_VOWELS[character];
        if (marked) {
            if (numericTone !== null || markedTone !== null) return null;
            key += marked.base;
            markedTone = marked.tone;
        } else if (/^[a-z]$/u.test(character)) {
            key += character;
        } else {
            return null;
        }
    }
    if (!key || !PINYIN_SYLLABLE_SET.has(key)) return null;
    return { key, tone: numericTone ?? markedTone };
}

function parsePlainPinyinPair(source: string): [ParsedChinesePinyinSyllable, ParsedChinesePinyinSyllable] | null {
    const characters = Array.from(source);
    for (let boundary = 1; boundary < characters.length; boundary += 1) {
        const first = parsePinyinSyllable(characters.slice(0, boundary).join(''), null);
        const second = parsePinyinSyllable(characters.slice(boundary).join(''), null);
        if (first && second) return [first, second];
    }
    return null;
}

/**
 * Parses exactly two Pinyin syllables without permitting lossy punctuation or mixed notation.
 * The returned key is the gameplay spelling: lowercase ASCII with `v` representing umlaut-u.
 */
export function parseChinesePinyinInput(input: string): ParsedChinesePinyinInput | null {
    const value = normalizeUmlaut(String(input ?? '').normalize('NFC').toLowerCase()).trim();
    if (!value) return null;
    const hasSeparators = /[\s'’\-·]/u.test(value);
    const parts = hasSeparators ? value.split(/[\s'’\-·]+/u) : [value];
    if (parts.some((part) => !part)) return null;
    const digits = value.match(/\d/gu) ?? [];
    if (digits.length > 0) {
        if (digits.some((digit) => !/^[1-5]$/u.test(digit)) || Object.keys(MARKED_VOWELS).some((marked) => value.includes(marked))) {
            return null;
        }
        const numericParts = hasSeparators
            ? parts.map((part) => /^([a-z]+)([1-5])$/u.exec(part))
            : [...value.matchAll(/([a-z]+)([1-5])/gu)];
        if (numericParts.length !== 2 || numericParts.some((match) => !match)
            || (!hasSeparators && numericParts.map((match) => match![0]).join('') !== value)) return null;
        const syllables = numericParts.map((match) => (
            parsePinyinSyllable(match![1], Number(match![2]))
        ));
        if (!syllables[0] || !syllables[1]) return null;
        return { key: `${syllables[0].key}${syllables[1].key}`, syllables: [syllables[0], syllables[1]] };
    }
    if (hasSeparators) {
        if (parts.length !== 2) return null;
        const first = parsePinyinSyllable(parts[0], null);
        const second = parsePinyinSyllable(parts[1], null);
        if (!first || !second) return null;
        return { key: `${first.key}${second.key}`, syllables: [first, second] };
    }
    const syllables = parsePlainPinyinPair(value);
    return syllables ? { key: `${syllables[0].key}${syllables[1].key}`, syllables } : null;
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
