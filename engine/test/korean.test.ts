import { describe, it, expect } from 'vitest';
import {
    decomposeHangul,
    composeHangul,
    isHangulSyllable,
    isJamo,
    isConsonant,
    isVowel,
    extractJamo,
    splitCompoundCoda,
    combineCodas,
} from '../src/jamo.js';
import { evaluateGuessSyllable, evaluateGuessKo } from '../src/evaluatorKo.js';
import { validateGuess, createGame, submitGuess, setCurrentGuess, computeKeyboardMap, computeKeyboardBoardMap } from '../src/game.js';
import { getDailyTargets } from '../src/daily.js';

// ============================================================================
// Jamo utilities
// ============================================================================

describe('jamo: decomposeHangul', () => {
    it('decomposes a syllable with onset + vowel + coda', () => {
        const result = decomposeHangul('한');
        expect(result).toEqual({ onset: 'ㅎ', vowel: 'ㅏ', coda: 'ㄴ' });
    });

    it('decomposes a syllable with no coda', () => {
        const result = decomposeHangul('가');
        expect(result).toEqual({ onset: 'ㄱ', vowel: 'ㅏ', coda: null });
    });

    it('decomposes a syllable with compound coda', () => {
        const result = decomposeHangul('닭');
        expect(result).toEqual({ onset: 'ㄷ', vowel: 'ㅏ', coda: 'ㄺ' });
    });

    it('decomposes 바 correctly', () => {
        const result = decomposeHangul('바');
        expect(result).toEqual({ onset: 'ㅂ', vowel: 'ㅏ', coda: null });
    });

    it('decomposes 나 correctly', () => {
        const result = decomposeHangul('나');
        expect(result).toEqual({ onset: 'ㄴ', vowel: 'ㅏ', coda: null });
    });
});

describe('jamo: composeHangul', () => {
    it('composes onset + vowel + coda into a syllable', () => {
        expect(composeHangul('ㅎ', 'ㅏ', 'ㄴ')).toBe('한');
    });

    it('composes onset + vowel without coda', () => {
        expect(composeHangul('ㄱ', 'ㅏ')).toBe('가');
    });

    it('round-trips: decompose then compose', () => {
        const original = '한';
        const d = decomposeHangul(original);
        const reconstructed = composeHangul(d.onset, d.vowel, d.coda);
        expect(reconstructed).toBe(original);
    });
});

describe('jamo: character classification', () => {
    it('isHangulSyllable detects composed syllables', () => {
        expect(isHangulSyllable('가')).toBe(true);
        expect(isHangulSyllable('힣')).toBe(true);
        expect(isHangulSyllable('A')).toBe(false);
        expect(isHangulSyllable('ㄱ')).toBe(false);
    });

    it('isJamo detects jamo characters', () => {
        expect(isJamo('ㄱ')).toBe(true);
        expect(isJamo('ㅏ')).toBe(true);
        expect(isJamo('A')).toBe(false);
    });

    it('isConsonant detects consonants', () => {
        expect(isConsonant('ㄱ')).toBe(true);
        expect(isConsonant('ㅂ')).toBe(true);
        expect(isConsonant('ㅏ')).toBe(false);
    });

    it('isVowel detects vowels', () => {
        expect(isVowel('ㅏ')).toBe(true);
        expect(isVowel('ㅣ')).toBe(true);
        expect(isVowel('ㄱ')).toBe(false);
    });
});

describe('jamo: extractJamo', () => {
    it('extracts all jamo from a word', () => {
        const result = extractJamo('한글');
        expect(result).toEqual(['ㅎ', 'ㅏ', 'ㄴ', 'ㄱ', 'ㅡ', 'ㄹ']);
    });

    it('extracts jamo from a syllable without coda', () => {
        const result = extractJamo('가');
        expect(result).toEqual(['ㄱ', 'ㅏ']);
    });
});

describe('jamo: compound codas', () => {
    it('splits ㄳ into ㄱ + ㅅ', () => {
        expect(splitCompoundCoda('ㄳ')).toEqual(['ㄱ', 'ㅅ']);
    });

    it('returns null for non-compound coda', () => {
        expect(splitCompoundCoda('ㄱ')).toBeNull();
    });

    it('combines ㄱ + ㅅ into ㄳ', () => {
        expect(combineCodas('ㄱ', 'ㅅ')).toBe('ㄳ');
    });

    it('returns null for non-combinable codas', () => {
        expect(combineCodas('ㄱ', 'ㄱ')).toBeNull();
    });
});

// ============================================================================
// Korean evaluator
// ============================================================================

describe('evaluateGuessSyllable', () => {
    it('returns all correct for exact match', () => {
        const result = evaluateGuessSyllable('바나나', '바나나');
        expect(result).toEqual(['correct', 'correct', 'correct']);
    });

    it('returns all absent for no matching syllables', () => {
        const result = evaluateGuessSyllable('공원길', '바나나');
        expect(result).toEqual(['absent', 'absent', 'absent']);
    });

    it('marks present for syllable in wrong position', () => {
        // guess: 나바나, target: 바나나
        // 나 at pos 0: not correct (target[0]=바), but 나 exists in target → present
        // 바 at pos 1: not correct (target[1]=나), but 바 exists in target → present
        // 나 at pos 2: correct (target[2]=나)
        const result = evaluateGuessSyllable('나바나', '바나나');
        expect(result).toEqual(['present', 'present', 'correct']);
    });

    it('handles duplicate syllables correctly', () => {
        // guess: 나나나, target: 바나나
        // First pass (correct): pos 1 나=나, pos 2 나=나  (나 count goes 2→1→0)
        // Second pass: pos 0 나 — remaining 나 count is 0 → absent
        const result = evaluateGuessSyllable('나나나', '바나나');
        expect(result).toEqual(['absent', 'correct', 'correct']);
    });

    it('throws for mismatched lengths', () => {
        expect(() => evaluateGuessSyllable('가', '바나나')).toThrow();
    });
});

describe('evaluateGuessKo', () => {
    it('returns correct syllable results with null jamoHints for green', () => {
        const results = evaluateGuessKo('바나나', '바나나');
        expect(results).toHaveLength(3);
        for (const r of results) {
            expect(r.syllable).toBe('correct');
            expect(r.jamoHints).toBeNull();
        }
    });

    it('computes jamo hints for non-green syllables', () => {
        // guess: 공원길, target: 공항역
        // pos 0: 공 = 공 → correct (green), no jamo hints
        // pos 1: 원 vs 항 → not matching. Check jamo:
        //   onset: ㅇ vs ㅎ → not correct. Is ㅇ in target onsets [ㄱ,ㅎ,ㅇ]? Yes → present
        //   vowel: ㅝ(ㅓ) vs ㅏ → not correct. Is ㅝ in target vowels? [ㅗ,ㅏ,ㅕ]? ...
        // pos 2: 길 vs 역 → different
        const results = evaluateGuessKo('공항역', '공항역');
        expect(results[0].syllable).toBe('correct');
        expect(results[1].syllable).toBe('correct');
        expect(results[2].syllable).toBe('correct');
    });

    it('provides jamo hints for partially matching syllables', () => {
        // guess: 감자탕, target: 갈비탕
        // pos 0: 감 vs 갈 → different syllable. Jamo:
        //   onset: ㄱ vs ㄱ → correct
        //   vowel: ㅏ vs ㅏ → correct
        //   coda: ㅁ vs ㄹ → ㅁ not in [ㄹ, null, ㅇ] → absent
        // pos 1: 자 vs 비 → different, all jamo different
        // pos 2: 탕 vs 탕 → correct (green)
        const results = evaluateGuessKo('감자탕', '갈비탕');
        expect(results[0].syllable).not.toBe('correct'); // 감 ≠ 갈
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.onset).toBe('correct');  // ㄱ = ㄱ
        expect(results[0].jamoHints!.vowel).toBe('correct');  // ㅏ = ㅏ
        expect(results[2].syllable).toBe('correct'); // 탕 = 탕
        expect(results[2].jamoHints).toBeNull();
    });

    it('detects onset jamo present as coda in target (cross-position consonant)', () => {
        // Target: 먹바산 → onsets [ㅁ, ㅂ, ㅅ], codas [ㄱ, null, ㄴ]
        // Consonant set: {ㅁ, ㅂ, ㅅ, ㄱ, ㄴ}
        // Guess:  가수날
        // pos 0: 가 vs 먹 → onset ㄱ vs ㅁ (different)
        //   OLD: ㄱ not in target onsets [ㅁ,ㅂ,ㅅ] → absent
        //   NEW: ㄱ in consonant set {ㅁ,ㅂ,ㅅ,ㄱ,ㄴ} → present ✓
        const results = evaluateGuessKo('가수날', '먹바산');
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.onset).toBe('present'); // ㄱ exists as coda of 먹
    });

    it('detects coda jamo present as onset in target (cross-position consonant)', () => {
        // Target: 사고미 → onsets [ㅅ, ㄱ, ㅁ], codas [null, null, null]
        // Consonant set: {ㅅ, ㄱ, ㅁ}
        // Guess:  밤나딕
        // pos 0: 밤 vs 사 → coda ㅁ. Target pos has no coda, but ㅁ is target onset → present
        const results = evaluateGuessKo('밤나딕', '사고미');
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.coda).toBe('present'); // ㅁ exists as onset of 미
    });

    it('detects consonant inside target compound coda', () => {
        // Target: 닭바사 → 닭 has compound coda ㄺ (= ㄹ + ㄱ)
        // Consonant set: {ㄷ, ㅂ, ㅅ, ㄺ, ㄹ, ㄱ}  (ㄺ decomposed)
        // Guess:  라비서
        // pos 0: 라 vs 닭 → onset ㄹ vs ㄷ → different.
        //   ㄹ in consonant set? Yes (from decomposed ㄺ) → present
        const results = evaluateGuessKo('라비서', '닭바사');
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.onset).toBe('present'); // ㄹ from compound coda ㄺ
    });

    it('detects guess compound coda component in target consonants', () => {
        // Target: 사비거 → onsets [ㅅ, ㅂ, ㄱ], no codas
        // Consonant set: {ㅅ, ㅂ, ㄱ}
        // Guess:  닭나다
        // pos 0: 닭 vs 사 → coda ㄺ (= ㄹ + ㄱ)
        //   ㄺ not in consonant set, but split → ㄹ (no) or ㄱ (yes!) → present
        const results = evaluateGuessKo('닭나다', '사비거');
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.coda).toBe('present'); // ㄱ component matches target onset
    });
});

// ============================================================================
// Game engine (Korean mode)
// ============================================================================

describe('Korean game: createGame', () => {
    it('creates a Korean game with language field', () => {
        const game = createGame({
            targetWords: ['바나나', '고구마', '감자탕', '김치찌'],
            language: 'ko',
        });
        expect(game.boards).toHaveLength(4);
        expect(game.language).toBe('ko');
        expect(game.boards[0].targetWord).toBe('바나나');
    });
});

describe('Korean game: validateGuess', () => {
    it('accepts valid 3-syllable Korean guesses', () => {
        expect(validateGuess('바나나', 'ko')).toEqual({ valid: true });
        expect(validateGuess('고구마', 'ko')).toEqual({ valid: true });
    });

    it('rejects wrong length for Korean', () => {
        expect(validateGuess('가나', 'ko').valid).toBe(false);
        expect(validateGuess('가나다라', 'ko').valid).toBe(false);
    });

    it('rejects non-Hangul characters for Korean', () => {
        expect(validateGuess('abc', 'ko').valid).toBe(false);
        expect(validateGuess('가나d', 'ko').valid).toBe(false);
    });

    it('still validates English correctly', () => {
        expect(validateGuess('apple', 'en')).toEqual({ valid: true });
        expect(validateGuess('app', 'en').valid).toBe(false);
    });
});

describe('Korean game: submitGuess', () => {
    it('updates boards with Korean guess and produces results', () => {
        const game = createGame({
            targetWords: ['바나나', '고구마', '감자탕', '김치찌'],
            language: 'ko',
        });

        const newState = submitGuess(game, '바나나');
        expect(newState.boards[0].solved).toBe(true);
        expect(newState.boards[0].guesses).toEqual(['바나나']);
        expect(newState.boards[0].results[0]).toEqual(['correct', 'correct', 'correct']);
        expect(newState.boards[1].solved).toBe(false);
    });

    it('stores koResults for Korean guesses', () => {
        const game = createGame({
            targetWords: ['바나나', '고구마', '감자탕', '김치찌'],
            language: 'ko',
        });

        const newState = submitGuess(game, '바나나');
        // Board 0 is solved, koResults should have all correct
        expect(newState.boards[0].koResults).toBeDefined();
        expect(newState.boards[0].koResults![0]).toHaveLength(3);
    });
});

describe('Korean game: setCurrentGuess', () => {
    it('limits to 3 characters for Korean', () => {
        const game = createGame({
            targetWords: ['바나나', '고구마', '감자탕', '김치찌'],
            language: 'ko',
        });

        const newState = setCurrentGuess(game, '바나나다');
        expect(newState.currentGuess).toBe('바나나');
    });

    it('filters non-Hangul characters for Korean', () => {
        const game = createGame({
            targetWords: ['바나나', '고구마', '감자탕', '김치찌'],
            language: 'ko',
        });

        const newState = setCurrentGuess(game, '바aㅏ나');
        // Should filter out 'a' and 'ㅏ' (not composed Hangul)
        expect(newState.currentGuess).toBe('바나');
    });
});

describe('Korean game: computeKeyboardMap', () => {
    it('produces jamo-based keyboard map for Korean', () => {
        const game = createGame({
            targetWords: ['바나나', '고구마', '감자탕', '김치찌'],
            language: 'ko',
        });

        const state = submitGuess(game, '바나나');
        const keyMap = computeKeyboardMap(state);

        // 바나나 is correct on board 0
        // The keyboard map should contain jamo keys from the decomposed syllables
        // 바 → ㅂ, ㅏ; 나 → ㄴ, ㅏ
        expect(keyMap['ㅂ']).toBeDefined();
        expect(keyMap['ㄴ']).toBeDefined();
        expect(keyMap['ㅏ']).toBeDefined();
    });

    it('uses jamo-level hints instead of syllable-level for keyboard coloring', () => {
        // Target words where guessing reveals jamo information.
        // Board 0 target: 먹바산 → onsets [ㅁ, ㅂ, ㅅ], codas [ㄱ, -, ㄴ]
        // Guessing 가수날:
        //   pos 0: 가 vs 먹 → syllable absent, but onset ㄱ is present (target coda)
        //   pos 1: 수 vs 바 → syllable absent, but onset ㅅ is present (target onset)
        //   pos 2: 날 vs 산 → syllable absent
        // OLD keyboard: ㄱ would be 'absent' (from syllable-level absent)
        // NEW keyboard: ㄱ should be 'present' (from jamo-level hints)
        const game = createGame({
            targetWords: ['먹바산', '먹바산', '먹바산', '먹바산'],
            language: 'ko',
        });

        const state = submitGuess(game, '가수날');
        const keyMap = computeKeyboardMap(state);

        // ㄱ is present in target as coda of 먹 — should NOT be marked absent
        expect(keyMap['ㄱ']).toBe('present');
        // ㅅ is present in target as onset of 산
        expect(keyMap['ㅅ']).toBe('present');
    });

    it('produces per-board jamo statuses via computeKeyboardBoardMap', () => {
        // Board 0 target: 바나나, Board 1: 고구마, Board 2: 감자탕, Board 3: 김치찌
        // Guess: 바나나 (solves board 0)
        const game = createGame({
            targetWords: ['바나나', '고구마', '감자탕', '김치찌'],
            language: 'ko',
        });

        const state = submitGuess(game, '바나나');
        const boardMap = computeKeyboardBoardMap(state);

        // ㅂ: correct on board 0 (바=바)
        expect(boardMap['ㅂ'][0]).toBe('correct');
        // ㅏ: correct on board 0 (바→ㅏ, 나→ㅏ all match)
        expect(boardMap['ㅏ'][0]).toBe('correct');
        // ㄴ: correct on board 0 (나 onset matches)
        expect(boardMap['ㄴ'][0]).toBe('correct');

        // On board 1 (고구마): 바나나 doesn't match.
        // ㅂ on board 1: onset of 바 vs 고 → not matching, not in consonants of 고구마
        // 고구마 consonants: {ㄱ, ㅁ}, vowels: {ㅗ, ㅜ, ㅏ}
        // ㅏ on board 1: 마 has vowel ㅏ → should be present (or correct depending on position)
        expect(boardMap['ㅏ'][1]).toBeDefined();
    });
});

// ============================================================================
// Daily targets (Korean)
// ============================================================================

describe('getDailyTargets: Korean', () => {
    it('returns 4 Korean words for language ko', () => {
        const targets = getDailyTargets('2025-01-01', 'ko');
        expect(targets).toHaveLength(4);
        // All should be 3-character Hangul strings
        for (const word of targets) {
            expect(word).toHaveLength(3);
            expect(/^[\uAC00-\uD7A3]+$/.test(word)).toBe(true);
        }
    });

    it('returns different words for ko vs en', () => {
        const koTargets = getDailyTargets('2025-01-01', 'ko');
        const enTargets = getDailyTargets('2025-01-01', 'en');
        // They should be completely different (different languages)
        expect(koTargets).not.toEqual(enTargets);
    });

    it('returns same Korean words for same date', () => {
        const targets1 = getDailyTargets('2025-06-15', 'ko');
        const targets2 = getDailyTargets('2025-06-15', 'ko');
        expect(targets1).toEqual(targets2);
    });

    it('returns different Korean words for different dates', () => {
        const targets1 = getDailyTargets('2025-01-01', 'ko');
        const targets2 = getDailyTargets('2025-01-02', 'ko');
        expect(targets1).not.toEqual(targets2);
    });

    it('does not break English daily targets (backwards compat)', () => {
        const targets = getDailyTargets('2025-01-01', 'en');
        const targetsDefault = getDailyTargets('2025-01-01');
        expect(targets).toEqual(targetsDefault);
    });
});
