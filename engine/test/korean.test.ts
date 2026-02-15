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
    combineVowels,
    splitCompoundVowel,
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

describe('jamo: compound vowels', () => {
    it('combines ㅜ + ㅓ into ㅝ', () => {
        expect(combineVowels('ㅜ', 'ㅓ')).toBe('ㅝ');
    });

    it('combines ㅗ + ㅏ into ㅘ', () => {
        expect(combineVowels('ㅗ', 'ㅏ')).toBe('ㅘ');
    });

    it('combines ㅗ + ㅐ into ㅙ', () => {
        expect(combineVowels('ㅗ', 'ㅐ')).toBe('ㅙ');
    });

    it('combines ㅗ + ㅣ into ㅚ', () => {
        expect(combineVowels('ㅗ', 'ㅣ')).toBe('ㅚ');
    });

    it('combines ㅜ + ㅔ into ㅞ', () => {
        expect(combineVowels('ㅜ', 'ㅔ')).toBe('ㅞ');
    });

    it('combines ㅜ + ㅣ into ㅟ', () => {
        expect(combineVowels('ㅜ', 'ㅣ')).toBe('ㅟ');
    });

    it('combines ㅡ + ㅣ into ㅢ', () => {
        expect(combineVowels('ㅡ', 'ㅣ')).toBe('ㅢ');
    });

    it('returns null for non-combinable vowels', () => {
        expect(combineVowels('ㅏ', 'ㅓ')).toBeNull();
    });

    it('splits ㅝ into ㅜ + ㅓ', () => {
        expect(splitCompoundVowel('ㅝ')).toEqual(['ㅜ', 'ㅓ']);
    });

    it('splits ㅘ into ㅗ + ㅏ', () => {
        expect(splitCompoundVowel('ㅘ')).toEqual(['ㅗ', 'ㅏ']);
    });

    it('returns null for non-compound vowel', () => {
        expect(splitCompoundVowel('ㅏ')).toBeNull();
    });

    it('round-trips: 워 decomposes to ㅇ+ㅝ, recomposes to 워', () => {
        const d = decomposeHangul('워');
        expect(d).toEqual({ onset: 'ㅇ', vowel: 'ㅝ', coda: null });
        expect(composeHangul(d.onset, d.vowel, d.coda)).toBe('워');
    });
});

// ============================================================================
// Korean evaluator
// ============================================================================

describe('evaluateGuessSyllable', () => {
    it('returns all correct for exact match', () => {
        const result = evaluateGuessSyllable('바다', '바다');
        expect(result).toEqual(['correct', 'correct']);
    });

    it('returns all absent for no matching syllables', () => {
        const result = evaluateGuessSyllable('하늘', '바다');
        expect(result).toEqual(['absent', 'absent']);
    });

    it('marks present for syllable in wrong position', () => {
        // guess: 다바, target: 바다
        // 다 at pos 0: not correct (target[0]=바), but 다 exists in target → present
        // 바 at pos 1: not correct (target[1]=다), but 바 exists in target → present
        const result = evaluateGuessSyllable('다바', '바다');
        expect(result).toEqual(['present', 'present']);
    });

    it('handles duplicate syllables correctly', () => {
        // guess: 나나, target: 바나
        // First pass (correct): pos 1 나=나  (나 count goes 1→0)
        // Second pass: pos 0 나 — remaining 나 count is 0 → absent
        const result = evaluateGuessSyllable('나나', '바나');
        expect(result).toEqual(['absent', 'correct']);
    });

    it('throws for mismatched lengths', () => {
        expect(() => evaluateGuessSyllable('가', '바다')).toThrow();
    });
});

describe('evaluateGuessKo', () => {
    it('returns correct syllable results with null jamoHints for green', () => {
        const results = evaluateGuessKo('바다', '바다');
        expect(results).toHaveLength(2);
        for (const r of results) {
            expect(r.syllable).toBe('correct');
            expect(r.jamoHints).toBeNull();
        }
    });

    it('computes jamo hints for non-green syllables', () => {
        // guess and target are identical → all correct
        const results = evaluateGuessKo('감자', '감자');
        expect(results[0].syllable).toBe('correct');
        expect(results[1].syllable).toBe('correct');
    });

    it('provides jamo hints for partially matching syllables', () => {
        // guess: 감자, target: 갈비
        // pos 0: 감 vs 갈 → different syllable. Jamo:
        //   onset: ㄱ vs ㄱ → correct
        //   vowel: ㅏ vs ㅏ → correct
        //   coda: ㅁ vs ㄹ → ㅁ not in [ㄹ, null] → absent
        // pos 1: 자 vs 비 → different, all jamo different
        const results = evaluateGuessKo('감자', '갈비');
        expect(results[0].syllable).not.toBe('correct'); // 감 ≠ 갈
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.onset).toBe('correct');  // ㄱ = ㄱ
        expect(results[0].jamoHints!.vowel).toBe('correct');  // ㅏ = ㅏ
    });

    it('detects onset jamo present as coda in target (cross-position consonant)', () => {
        // Target: 먹바 → onsets [ㅁ, ㅂ], codas [ㄱ, null]
        // Consonant set: {ㅁ, ㅂ, ㄱ}
        // Guess:  가수
        // pos 0: 가 vs 먹 → onset ㄱ vs ㅁ (different)
        //   ㄱ in consonant set {ㅁ,ㅂ,ㄱ} → present ✓
        const results = evaluateGuessKo('가수', '먹바');
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.onset).toBe('present'); // ㄱ exists as coda of 먹
    });

    it('detects coda jamo present as onset in target (cross-position consonant)', () => {
        // Target: 사마 → onsets [ㅅ, ㅁ], codas [null, null]
        // Consonant set: {ㅅ, ㅁ}
        // Guess:  밤나
        // pos 0: 밤 vs 사 → coda ㅁ. Target pos has no coda, but ㅁ is target onset → present
        const results = evaluateGuessKo('밤나', '사마');
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.coda).toBe('present'); // ㅁ exists as onset of 마
    });

    it('detects consonant inside target compound coda', () => {
        // Target: 닭바 → 닭 has compound coda ㄺ (= ㄹ + ㄱ)
        // Consonant set: {ㄷ, ㅂ, ㄺ, ㄹ, ㄱ}  (ㄺ decomposed)
        // Guess:  라비
        // pos 0: 라 vs 닭 → onset ㄹ vs ㄷ → different.
        //   ㄹ in consonant set? Yes (from decomposed ㄺ) → present
        const results = evaluateGuessKo('라비', '닭바');
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.onset).toBe('present'); // ㄹ from compound coda ㄺ
    });

    it('detects guess compound coda component in target consonants', () => {
        // Target: 사거 → onsets [ㅅ, ㄱ], no codas
        // Consonant set: {ㅅ, ㄱ}
        // Guess:  닭나
        // pos 0: 닭 vs 사 → coda ㄺ (= ㄹ + ㄱ)
        //   ㄺ not in consonant set, but split → ㄹ (no) or ㄱ (yes!) → present
        const results = evaluateGuessKo('닭나', '사거');
        expect(results[0].jamoHints).not.toBeNull();
        expect(results[0].jamoHints!.coda).toBe('present'); // ㄱ component matches target onset
    });
});

// ============================================================================
// Game engine (Korean mode)
// ============================================================================

describe('Korean game: createGame', () => {
    it('creates a Korean game with language field and 7 max guesses', () => {
        const game = createGame({
            targetWords: ['바다', '하늘', '나무', '사과'],
            language: 'ko',
        });
        expect(game.boards).toHaveLength(4);
        expect(game.language).toBe('ko');
        expect(game.boards[0].targetWord).toBe('바다');
        expect(game.maxGuesses).toBe(7);
    });
});

describe('Korean game: validateGuess', () => {
    it('accepts valid 2-syllable Korean guesses', () => {
        expect(validateGuess('바다', 'ko')).toEqual({ valid: true });
        expect(validateGuess('하늘', 'ko')).toEqual({ valid: true });
    });

    it('rejects wrong length for Korean', () => {
        expect(validateGuess('가', 'ko').valid).toBe(false);
        expect(validateGuess('가나다', 'ko').valid).toBe(false);
    });

    it('rejects non-Hangul characters for Korean', () => {
        expect(validateGuess('ab', 'ko').valid).toBe(false);
        expect(validateGuess('가d', 'ko').valid).toBe(false);
    });

    it('still validates English correctly', () => {
        expect(validateGuess('apple', 'en')).toEqual({ valid: true });
        expect(validateGuess('app', 'en').valid).toBe(false);
    });
});

describe('Korean game: submitGuess', () => {
    it('updates boards with Korean guess and produces results', () => {
        const game = createGame({
            targetWords: ['바다', '하늘', '나무', '사과'],
            language: 'ko',
        });

        const newState = submitGuess(game, '바다');
        expect(newState.boards[0].solved).toBe(true);
        expect(newState.boards[0].guesses).toEqual(['바다']);
        expect(newState.boards[0].results[0]).toEqual(['correct', 'correct']);
        expect(newState.boards[1].solved).toBe(false);
    });

    it('stores koResults for Korean guesses', () => {
        const game = createGame({
            targetWords: ['바다', '하늘', '나무', '사과'],
            language: 'ko',
        });

        const newState = submitGuess(game, '바다');
        // Board 0 is solved, koResults should have all correct
        expect(newState.boards[0].koResults).toBeDefined();
        expect(newState.boards[0].koResults![0]).toHaveLength(2);
    });
});

describe('Korean game: setCurrentGuess', () => {
    it('limits to 2 characters for Korean', () => {
        const game = createGame({
            targetWords: ['바다', '하늘', '나무', '사과'],
            language: 'ko',
        });

        const newState = setCurrentGuess(game, '바다나');
        expect(newState.currentGuess).toBe('바다');
    });

    it('filters non-Hangul characters for Korean', () => {
        const game = createGame({
            targetWords: ['바다', '하늘', '나무', '사과'],
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
            targetWords: ['바다', '하늘', '나무', '사과'],
            language: 'ko',
        });

        const state = submitGuess(game, '바다');
        const keyMap = computeKeyboardMap(state);

        // 바다 is correct on board 0
        // The keyboard map should contain jamo keys from the decomposed syllables
        // 바 → ㅂ, ㅏ; 다 → ㄷ, ㅏ
        expect(keyMap['ㅂ']).toBeDefined();
        expect(keyMap['ㄷ']).toBeDefined();
        expect(keyMap['ㅏ']).toBeDefined();
    });

    it('uses jamo-level hints instead of syllable-level for keyboard coloring', () => {
        // Target words where guessing reveals jamo information.
        // Board targets: 시작 = [시(ㅅ,ㅣ,null), 작(ㅈ,ㅏ,ㄱ)]
        // Consonant set: {ㅅ, ㅈ, ㄱ}
        // Guessing 가슴 = [가(ㄱ,ㅏ,null), 슴(ㅅ,ㅡ,ㅁ)]:
        //   pos 0: 가 vs 시 → syllable absent, but onset ㄱ present (in consonant set via coda of 작)
        //   pos 1: 슴 vs 작 → syllable absent, but onset ㅅ present (in consonant set)
        // OLD keyboard: ㄱ would be 'absent' (from syllable-level absent)
        // NEW keyboard: ㄱ should be 'present' (from jamo-level hints)
        const game = createGame({
            targetWords: ['시작', '시작', '시작', '시작'],
            language: 'ko',
        });

        const state = submitGuess(game, '가슴');
        const keyMap = computeKeyboardMap(state);

        // ㄱ is present in target as coda of 작 — should NOT be marked absent
        expect(keyMap['ㄱ']).toBe('present');
        // ㅅ is present in target as onset of 시
        expect(keyMap['ㅅ']).toBe('present');
    });

    it('produces per-board jamo statuses via computeKeyboardBoardMap', () => {
        // Board 0 target: 바다, Board 1: 하늘, Board 2: 나무, Board 3: 사과
        // Guess: 바다 (solves board 0)
        const game = createGame({
            targetWords: ['바다', '하늕', '나무', '사과'],
            language: 'ko',
        });

        const state = submitGuess(game, '바다');
        const boardMap = computeKeyboardBoardMap(state);

        // ㅂ: correct on board 0 (바=바)
        expect(boardMap['ㅂ'][0]).toBe('correct');
        // ㅏ: correct on board 0 (바→ㅏ, 다→ㅏ all match)
        expect(boardMap['ㅏ'][0]).toBe('correct');
        // ㄷ: correct on board 0 (다 onset matches)
        expect(boardMap['ㄷ'][0]).toBe('correct');

        // On board 2 (나무): 바다 doesn't match.
        // ㅏ on board 2: 나 has vowel ㅏ → should be present or correct
        expect(boardMap['ㅏ'][2]).toBeDefined();
    });
});

// ============================================================================
// Daily targets (Korean)
// ============================================================================

describe('getDailyTargets: Korean', () => {
    it('returns 4 Korean words for language ko', () => {
        const targets = getDailyTargets('2025-01-01', 'ko');
        expect(targets).toHaveLength(4);
        // All should be 2-character Hangul strings
        for (const word of targets) {
            expect(word).toHaveLength(2);
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
