import { WORD_LIST } from './words.js';

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
export function getDailyTargets(dateKey: string): [string, string, string, string] {
    const seed = dateKeyToSeed(dateKey);
    const random = mulberry32(seed);
    const indices = selectDistinctIndices(WORD_LIST.length, 4, random);

    return [
        WORD_LIST[indices[0]],
        WORD_LIST[indices[1]],
        WORD_LIST[indices[2]],
        WORD_LIST[indices[3]],
    ];
}
