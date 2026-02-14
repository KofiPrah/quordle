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
 * Layer 2: For a single non-green syllable position, compute jamo-level hints.
 *
 * Improvements over basic syllable matching:
 * - Cross-position consonant matching: onset jamo can match target codas and
 *   vice versa, since they represent the same consonant letter.
 * - Compound coda decomposition: target compound codas (e.g. ㄺ = ㄹ+ㄱ) are
 *   broken into components so individual consonants can be detected.
 *   Guess compound codas are also decomposed for 'present' checking.
 */
function computeJamoHints(
    guessSyllable: string,
    targetSyllable: string,
    allTargetVowelSet: Set<string>,
    allTargetConsonantSet: Set<string>,
): JamoHint {
    if (!isHangulSyllable(guessSyllable) || !isHangulSyllable(targetSyllable)) {
        return { onset: 'absent', vowel: 'absent', coda: null };
    }

    const g = decomposeHangul(guessSyllable);
    const t = decomposeHangul(targetSyllable);

    // Check onset — same-position match is 'correct', any consonant match is 'present'
    let onsetResult: LetterResult = 'absent';
    if (g.onset === t.onset) {
        onsetResult = 'correct';
    } else if (allTargetConsonantSet.has(g.onset)) {
        onsetResult = 'present';
    }

    // Check vowel — same-position match is 'correct', any vowel match is 'present'
    let vowelResult: LetterResult = 'absent';
    if (g.vowel === t.vowel) {
        vowelResult = 'correct';
    } else if (allTargetVowelSet.has(g.vowel)) {
        vowelResult = 'present';
    }

    // Check coda — cross-position consonant matching + compound coda decomposition
    let codaResult: LetterResult | null = null;
    if (g.coda !== null || t.coda !== null) {
        if (g.coda === null) {
            codaResult = 'absent'; // guess has no coda but target does
        } else if (g.coda === t.coda) {
            codaResult = 'correct';
        } else if (allTargetConsonantSet.has(g.coda)) {
            codaResult = 'present';
        } else {
            // Decompose guess compound coda and check if any component matches
            const split = splitCompoundCoda(g.coda);
            if (split && (allTargetConsonantSet.has(split[0]) || allTargetConsonantSet.has(split[1]))) {
                codaResult = 'present';
            } else {
                codaResult = 'absent';
            }
        }
    }

    return { onset: onsetResult, vowel: vowelResult, coda: codaResult };
}

/**
 * Full Korean evaluation: syllable-level results + jamo hints for non-green syllables.
 */
export function evaluateGuessKo(guess: string, target: string): KoSyllableResult[] {
    const syllableResults = evaluateGuessSyllable(guess, target);

    // Build target jamo sets for cross-position 'present' checking.
    // Consonant set includes onsets, codas, AND decomposed compound coda components.
    const allTargetVowelSet = new Set<string>();
    const allTargetConsonantSet = new Set<string>();

    for (const ch of target) {
        if (isHangulSyllable(ch)) {
            const d = decomposeHangul(ch);
            allTargetConsonantSet.add(d.onset);
            allTargetVowelSet.add(d.vowel);
            if (d.coda) {
                allTargetConsonantSet.add(d.coda);
                // Decompose compound codas so individual components are matchable
                const split = splitCompoundCoda(d.coda);
                if (split) {
                    allTargetConsonantSet.add(split[0]);
                    allTargetConsonantSet.add(split[1]);
                }
            }
        }
    }

    const results: KoSyllableResult[] = [];
    for (let i = 0; i < guess.length; i++) {
        if (syllableResults[i] === 'correct') {
            // Green syllable — no jamo hints needed
            results.push({ syllable: 'correct', jamoHints: null });
        } else {
            // Non-green — compute jamo-level hints with cross-position matching
            const jamoHints = computeJamoHints(
                guess[i],
                target[i],
                allTargetVowelSet,
                allTargetConsonantSet,
            );
            results.push({ syllable: syllableResults[i], jamoHints });
        }
    }

    return results;
}
