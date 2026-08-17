import { getLanguageConfig } from './languageConfig.js';
import {
    CHINESE_PINYIN_PUZZLE_ANSWERS,
    ENABLED_ZH_PINYIN_LENGTHS,
    PINYIN_PUZZLE_VARIANT,
    type ChinesePinyinPuzzleAnswer,
    type ChinesePinyinRound,
} from './chineseLexicon.js';
import type { Language } from './types.js';

/**
 * Converts a dateKey string to a numeric seed.
 * Uses a simple hash function (djb2) for consistent results.
 *
 * @param dateKey - The date key string (e.g., "2026-02-07")
 * @returns A 32-bit unsigned integer seed
 */
function dateKeyToSeed(dateKey: string): number {
    let hash = 5381;
    for (let i = 0; i < dateKey.length; i++) {
        // hash * 33 ^ charCode (djb2 algorithm)
        hash = ((hash << 5) + hash) ^ dateKey.charCodeAt(i);
    }
    // Ensure positive 32-bit integer
    return hash >>> 0;
}

/**
 * Mulberry32 - A simple and fast 32-bit seeded PRNG.
 * Produces deterministic pseudo-random numbers given the same seed.
 *
 * @param seed - The 32-bit seed value
 * @returns A function that returns the next pseudo-random number in [0, 1)
 */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Selects n distinct indices from an array using Fisher-Yates partial shuffle.
 * More efficient than full shuffle when n << array.length.
 *
 * @param length - The length of the source array
 * @param count - Number of distinct indices to select
 * @param random - A seeded random function returning [0, 1)
 * @returns Array of distinct indices
 */
function selectDistinctIndices(length: number, count: number, random: () => number): number[] {
    const indices: number[] = [];
    const used = new Set<number>();

    for (let i = 0; i < count; i++) {
        let idx: number;
        do {
            idx = Math.floor(random() * length);
        } while (used.has(idx));
        used.add(idx);
        indices.push(idx);
    }

    return indices;
}

function shuffleChinesePinyinBucket(
    length: number,
    random: () => number,
): ChinesePinyinPuzzleAnswer[] {
    const bucket = CHINESE_PINYIN_PUZZLE_ANSWERS.filter((answer) => answer.length === length);
    for (let index = bucket.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [bucket[index], bucket[swapIndex]] = [bucket[swapIndex], bucket[index]];
    }
    return bucket;
}

function selectChinesePinyinRound(random: () => number): ChinesePinyinRound {
    const length = ENABLED_ZH_PINYIN_LENGTHS[
        Math.floor(random() * ENABLED_ZH_PINYIN_LENGTHS.length)
    ];
    const answers = shuffleChinesePinyinBucket(length, random).slice(0, 4);
    if (answers.length !== 4
        || new Set(answers.map((answer) => answer.key)).size !== 4
        || new Set(answers.map((answer) => answer.id)).size !== 4) {
        throw new Error(`Chinese Pinyin length ${length} cannot produce four unique answers`);
    }
    return { variant: PINYIN_PUZZLE_VARIANT, length, answers };
}

export function getDailyChinesePinyinRound(dateKey: string): ChinesePinyinRound {
    return selectChinesePinyinRound(mulberry32(dateKeyToSeed(`${dateKey}:zh:${PINYIN_PUZZLE_VARIANT}`)));
}

export function getPracticeChinesePinyinRound(random: () => number = Math.random): ChinesePinyinRound {
    return selectChinesePinyinRound(random);
}

/**
 * Gets 4 deterministic target words for a given date key.
 * The same dateKey will always return the same 4 distinct words.
 *
 * Uses mulberry32 PRNG seeded from the dateKey for deterministic selection.
 * This is a pure function with no side effects.
 *
 * @param dateKey - A date string in "YYYY-MM-DD" format (or any unique string)
 * @returns A tuple of 4 distinct 5-letter words for the daily puzzle
 *
 * @example
 * ```ts
 * const targets = getDailyTargets('2026-02-07');
 * // Always returns the same 4 words for '2026-02-07'
 * ```
 */
export function getDailyTargets(dateKey: string, language: Language = 'en'): [string, string, string, string] {
    // Append language suffix to seed input so each language gets unique daily words.
    // English omits suffix for backward compatibility (same dailies as before).
    const seedInput = language === 'en' ? dateKey : `${dateKey}:${language}`;
    const seed = dateKeyToSeed(seedInput);
    const random = mulberry32(seed);
    const wordList = getLanguageConfig(language).answerWords;
    const indices = selectDistinctIndices(wordList.length, 4, random);

    return [
        wordList[indices[0]],
        wordList[indices[1]],
        wordList[indices[2]],
        wordList[indices[3]],
    ];
}
