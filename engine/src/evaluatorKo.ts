/**
 * Korean-specific evaluator with hybrid syllable-level + jamo-level hints.
 *
 * Layer 1: Whole syllable comparison (same as English letter comparison).
 * Layer 2: For non-green syllables, expand into atomic jamo units and score
 *          those units with count-limited correct/present/absent feedback.
 */

import type {
    GuessResult,
    JamoHint,
    JamoHintUnit,
    JamoSlot,
    KoSyllableResult,
    LetterResult,
} from './types.js';
import { expandHangulToJamoUnits, isHangulSyllable } from './jamo.js';

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

    for (const ch of target) {
        targetCounts.set(ch, (targetCounts.get(ch) || 0) + 1);
    }

    for (let i = 0; i < guess.length; i++) {
        if (guess[i] === target[i]) {
            result[i] = 'correct';
            targetCounts.set(guess[i], targetCounts.get(guess[i])! - 1);
        }
    }

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

type UnitWithStatus = JamoHintUnit;

interface SyllableHintState {
    units: UnitWithStatus[];
    targetUnits: Array<{ jamo: string; slot: JamoSlot }>;
}

const SLOT_ORDER: JamoSlot[] = ['onset', 'vowel', 'coda'];

const inc = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) || 0) + 1);
const dec = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) || 0) - 1);
const has = (map: Map<string, number>, key: string) => (map.get(key) || 0) > 0;

function getPool(slot: JamoSlot, consonantCounts: Map<string, number>, vowelCounts: Map<string, number>) {
    return slot === 'vowel' ? vowelCounts : consonantCounts;
}

function getSlotIndexes(units: Array<{ slot: JamoSlot }>, slot: JamoSlot): number[] {
    const indexes: number[] = [];
    for (let i = 0; i < units.length; i++) {
        if (units[i].slot === slot) indexes.push(i);
    }
    return indexes;
}

function getBestStatus(units: JamoHintUnit[], slot: JamoSlot): LetterResult | null {
    let best: LetterResult | null = null;
    for (const unit of units) {
        if (unit.slot !== slot) continue;
        if (unit.status === 'correct') return 'correct';
        if (unit.status === 'present') best = 'present';
        if (unit.status === 'absent' && best === null) best = 'absent';
    }
    return best;
}

function buildJamoHint(units: JamoHintUnit[]): JamoHint {
    const hint: JamoHint = {
        units: units.map((unit) => ({ ...unit })),
    };

    const onset = getBestStatus(units, 'onset');
    const vowel = getBestStatus(units, 'vowel');
    const coda = getBestStatus(units, 'coda');

    if (onset !== null) hint.onset = onset;
    if (vowel !== null) hint.vowel = vowel;
    hint.coda = coda;

    return hint;
}

/**
 * Full Korean evaluation: syllable-level results + atomic jamo hints for non-green syllables.
 *
 * Uses a two-pass counting algorithm to avoid over-counting. Target consonant/vowel
 * units are counted, consumed by whole-syllable greens, then consumed by same-position
 * atomic-unit greens, and finally by cross-position atomic-unit yellows.
 */
export function evaluateGuessKo(guess: string, target: string): KoSyllableResult[] {
    const syllableResults = evaluateGuessSyllable(guess, target);

    const consonantCounts = new Map<string, number>();
    const vowelCounts = new Map<string, number>();

    for (const ch of target) {
        if (!isHangulSyllable(ch)) continue;
        for (const unit of expandHangulToJamoUnits(ch)) {
            inc(getPool(unit.slot, consonantCounts, vowelCounts), unit.jamo);
        }
    }

    for (let i = 0; i < guess.length; i++) {
        if (syllableResults[i] !== 'correct' || !isHangulSyllable(target[i])) continue;
        for (const unit of expandHangulToJamoUnits(target[i])) {
            dec(getPool(unit.slot, consonantCounts, vowelCounts), unit.jamo);
        }
    }

    const hintStates: (SyllableHintState | null)[] = [];
    for (let i = 0; i < guess.length; i++) {
        if (syllableResults[i] === 'correct') {
            hintStates.push(null);
            continue;
        }

        const guessUnits = isHangulSyllable(guess[i])
            ? expandHangulToJamoUnits(guess[i]).map((unit) => ({ ...unit, status: 'absent' as LetterResult }))
            : [];
        const targetUnits = isHangulSyllable(target[i])
            ? expandHangulToJamoUnits(target[i])
            : [];

        hintStates.push({
            units: guessUnits,
            targetUnits,
        });
    }

    for (let i = 0; i < hintStates.length; i++) {
        const hintState = hintStates[i];
        if (!hintState) continue;

        for (const slot of SLOT_ORDER) {
            const guessIndexes = getSlotIndexes(hintState.units, slot);
            const targetIndexes = getSlotIndexes(hintState.targetUnits, slot);
            const sharedLength = Math.min(guessIndexes.length, targetIndexes.length);

            for (let slotIdx = 0; slotIdx < sharedLength; slotIdx++) {
                const guessIndex = guessIndexes[slotIdx];
                const targetIndex = targetIndexes[slotIdx];
                const guessUnit = hintState.units[guessIndex];
                const targetUnit = hintState.targetUnits[targetIndex];

                if (guessUnit.jamo !== targetUnit.jamo) continue;

                guessUnit.status = 'correct';
                dec(getPool(slot, consonantCounts, vowelCounts), guessUnit.jamo);
            }
        }
    }

    for (const hintState of hintStates) {
        if (!hintState) continue;

        for (const unit of hintState.units) {
            if (unit.status === 'correct') continue;
            const pool = getPool(unit.slot, consonantCounts, vowelCounts);
            if (has(pool, unit.jamo)) {
                unit.status = 'present';
                dec(pool, unit.jamo);
            }
        }
    }

    return hintStates.map((hintState, index) => ({
        syllable: syllableResults[index],
        jamoHints: syllableResults[index] === 'correct'
            ? null
            : buildJamoHint(hintState?.units || []),
    }));
}
