/**
 * Korean-specific evaluator with hybrid syllable-level + jamo-level hints.
 *
 * Layer 1: Whole syllable comparison (same as English letter comparison).
 * Layer 2: For non-green syllables, decompose into jamo (초성/중성/종성)
 *          and produce per-jamo correct/present/absent hints.
 */

import type { GuessResult, LetterResult, KoSyllableResult, JamoHint } from './types.js';
import { decomposeHangul, isHangulSyllable, splitCompoundCoda } from './jamo.js';

/**
 * Layer 1: Evaluate a Korean guess at the syllable block level.
 * Identical algorithm to the English evaluator, but operates on syllable characters.
 */
export function evaluateGuessSyllable(guess: string, target: string): GuessResult {
    if (guess.length !== target.length) {
        throw new Error(`Guess length (${guess.length}) must match target length (${target.length})`);
    }

    const result: LetterResult[] = new Array(guess.length).fill('absent');
    const targetCounts = new Map<string, number>();

    // Count syllables in target
    for (const ch of target) {
        targetCounts.set(ch, (targetCounts.get(ch) || 0) + 1);
    }

    // First pass: mark correct (exact position match)
    for (let i = 0; i < guess.length; i++) {
        if (guess[i] === target[i]) {
            result[i] = 'correct';
            targetCounts.set(guess[i], targetCounts.get(guess[i])! - 1);
        }
    }

    // Second pass: mark present (right syllable, wrong position)
    for (let i = 0; i < guess.length; i++) {
        if (result[i] === 'correct') continue;
        const remaining = targetCounts.get(guess[i]) || 0;
        if (remaining > 0) {
            result[i] = 'present';
            targetCounts.set(guess[i], remaining - 1);
        }
    }

    return result;
}

/**
 * Full Korean evaluation: syllable-level results + jamo hints for non-green syllables.
 *
 * Uses a two-pass counting algorithm (mirroring the English evaluator) to prevent
 * over-counting jamo. Each target jamo is counted, then consumed as green/yellow
 * matches are assigned — so a single ㄱ in the target can only produce one dot.
 *
 * Cross-position consonant matching is preserved: onset jamo can match target codas
 * and vice versa. Compound codas are decomposed into individual consonant components
 * for both target counting and guess matching.
 */
export function evaluateGuessKo(guess: string, target: string): KoSyllableResult[] {
    const syllableResults = evaluateGuessSyllable(guess, target);

    // Helpers for count maps
    const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);
    const dec = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) - 1);
    const has = (m: Map<string, number>, k: string) => (m.get(k) || 0) > 0;

    // --- Build target jamo count maps ---
    // Compound codas are decomposed into individual consonant components.
    const consonantCounts = new Map<string, number>();
    const vowelCounts = new Map<string, number>();

    for (const ch of target) {
        if (isHangulSyllable(ch)) {
            const d = decomposeHangul(ch);
            inc(consonantCounts, d.onset);
            inc(vowelCounts, d.vowel);
            if (d.coda) {
                const split = splitCompoundCoda(d.coda);
                if (split) {
                    inc(consonantCounts, split[0]);
                    inc(consonantCounts, split[1]);
                } else {
                    inc(consonantCounts, d.coda);
                }
            }
        }
    }

    // --- Pre-consume jamo from syllable-level green matches ---
    // A fully-correct syllable uses up all its target jamo from the pools.
    for (let i = 0; i < guess.length; i++) {
        if (syllableResults[i] === 'correct' && isHangulSyllable(target[i])) {
            const d = decomposeHangul(target[i]);
            dec(consonantCounts, d.onset);
            dec(vowelCounts, d.vowel);
            if (d.coda) {
                const split = splitCompoundCoda(d.coda);
                if (split) {
                    dec(consonantCounts, split[0]);
                    dec(consonantCounts, split[1]);
                } else {
                    dec(consonantCounts, d.coda);
                }
            }
        }
    }

    // --- Initialise jamo hints for every position ---
    const hints: (JamoHint | null)[] = [];
    for (let i = 0; i < guess.length; i++) {
        if (syllableResults[i] === 'correct') {
            hints.push(null);
        } else if (isHangulSyllable(guess[i]) && isHangulSyllable(target[i])) {
            const g = decomposeHangul(guess[i]);
            const t = decomposeHangul(target[i]);
            hints.push({
                onset: 'absent',
                vowel: 'absent',
                coda: (g.coda !== null || t.coda !== null) ? 'absent' : null,
            });
        } else {
            hints.push({ onset: 'absent', vowel: 'absent', coda: null });
        }
    }

    // --- Pass 1: green jamo (same-position match) — decrement counts ---
    for (let i = 0; i < guess.length; i++) {
        if (!hints[i] || !isHangulSyllable(guess[i]) || !isHangulSyllable(target[i])) continue;

        const g = decomposeHangul(guess[i]);
        const t = decomposeHangul(target[i]);
        const h = hints[i]!;

        if (g.onset === t.onset) {
            h.onset = 'correct';
            dec(consonantCounts, g.onset);
        }
        if (g.vowel === t.vowel) {
            h.vowel = 'correct';
            dec(vowelCounts, g.vowel);
        }
        if (g.coda !== null && t.coda !== null && g.coda === t.coda) {
            h.coda = 'correct';
            const split = splitCompoundCoda(g.coda);
            if (split) {
                dec(consonantCounts, split[0]);
                dec(consonantCounts, split[1]);
            } else {
                dec(consonantCounts, g.coda);
            }
        }
    }

    // --- Pass 2: yellow jamo (cross-position match) — decrement counts ---
    for (let i = 0; i < guess.length; i++) {
        if (!hints[i] || !isHangulSyllable(guess[i])) continue;

        const g = decomposeHangul(guess[i]);
        const h = hints[i]!;

        // Onset
        if (h.onset !== 'correct' && has(consonantCounts, g.onset)) {
            h.onset = 'present';
            dec(consonantCounts, g.onset);
        }

        // Vowel
        if (h.vowel !== 'correct' && has(vowelCounts, g.vowel)) {
            h.vowel = 'present';
            dec(vowelCounts, g.vowel);
        }

        // Coda
        if (h.coda !== null && h.coda !== 'correct' && g.coda !== null) {
            if (has(consonantCounts, g.coda)) {
                h.coda = 'present';
                dec(consonantCounts, g.coda);
            } else {
                // Decompose guess compound coda — check if any component matches
                const split = splitCompoundCoda(g.coda);
                if (split) {
                    const has0 = has(consonantCounts, split[0]);
                    const has1 = has(consonantCounts, split[1]);
                    if (has0 || has1) {
                        h.coda = 'present';
                        if (has0) dec(consonantCounts, split[0]);
                        if (has1) dec(consonantCounts, split[1]);
                    }
                }
            }
        }
    }

    // --- Build final results ---
    return hints.map((h, i) => ({
        syllable: syllableResults[i],
        jamoHints: syllableResults[i] === 'correct' ? null : h,
    }));
}
