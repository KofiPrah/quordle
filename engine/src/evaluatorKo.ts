/**
 * Korean-specific evaluator with hybrid syllable-level + jamo-level hints.
 *
 * Layer 1: Whole syllable comparison (same as English letter comparison).
 * Layer 2: For non-green syllables, decompose into jamo (초성/중성/종성)
 *          and produce per-jamo correct/present/absent hints.
 */

import type { GuessResult, LetterResult, KoSyllableResult, JamoHint } from './types.js';
import { decomposeHangul, isHangulSyllable } from './jamo.js';

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
 * Compares the guess syllable's onset/vowel/coda against all target syllables
 * at the same position first (for 'correct'), then against remaining target jamo (for 'present').
 */
function computeJamoHints(
    guessSyllable: string,
    targetSyllable: string,
    allTargetOnsets: string[],
    allTargetVowels: string[],
    allTargetCodas: (string | null)[],
): JamoHint {
    if (!isHangulSyllable(guessSyllable) || !isHangulSyllable(targetSyllable)) {
        return { onset: 'absent', vowel: 'absent', coda: null };
    }

    const g = decomposeHangul(guessSyllable);
    const t = decomposeHangul(targetSyllable);

    // Check onset
    let onsetResult: LetterResult = 'absent';
    if (g.onset === t.onset) {
        onsetResult = 'correct';  // same onset in same position
    } else if (allTargetOnsets.includes(g.onset)) {
        onsetResult = 'present';  // onset exists elsewhere in target
    }

    // Check vowel
    let vowelResult: LetterResult = 'absent';
    if (g.vowel === t.vowel) {
        vowelResult = 'correct';
    } else if (allTargetVowels.includes(g.vowel)) {
        vowelResult = 'present';
    }

    // Check coda
    let codaResult: LetterResult | null = null;
    if (g.coda !== null || t.coda !== null) {
        if (g.coda === null) {
            codaResult = 'absent'; // guess has no coda but target does
        } else if (t.coda === null) {
            // guess has coda but target position doesn't — check if it exists elsewhere
            const nonNullCodas = allTargetCodas.filter(c => c !== null) as string[];
            codaResult = nonNullCodas.includes(g.coda) ? 'present' : 'absent';
        } else if (g.coda === t.coda) {
            codaResult = 'correct';
        } else {
            const nonNullCodas = allTargetCodas.filter(c => c !== null) as string[];
            codaResult = nonNullCodas.includes(g.coda) ? 'present' : 'absent';
        }
    }

    return { onset: onsetResult, vowel: vowelResult, coda: codaResult };
}

/**
 * Full Korean evaluation: syllable-level results + jamo hints for non-green syllables.
 */
export function evaluateGuessKo(guess: string, target: string): KoSyllableResult[] {
    const syllableResults = evaluateGuessSyllable(guess, target);

    // Pre-extract all target jamo for 'present' checking
    const allTargetOnsets: string[] = [];
    const allTargetVowels: string[] = [];
    const allTargetCodas: (string | null)[] = [];

    for (const ch of target) {
        if (isHangulSyllable(ch)) {
            const d = decomposeHangul(ch);
            allTargetOnsets.push(d.onset);
            allTargetVowels.push(d.vowel);
            allTargetCodas.push(d.coda);
        }
    }

    const results: KoSyllableResult[] = [];
    for (let i = 0; i < guess.length; i++) {
        if (syllableResults[i] === 'correct') {
            // Green syllable — no jamo hints needed
            results.push({ syllable: 'correct', jamoHints: null });
        } else {
            // Non-green — compute jamo-level hints
            const jamoHints = computeJamoHints(
                guess[i],
                target[i],
                allTargetOnsets,
                allTargetVowels,
                allTargetCodas,
            );
            results.push({ syllable: syllableResults[i], jamoHints });
        }
    }

    return results;
}
