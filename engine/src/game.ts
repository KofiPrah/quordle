import type {
    BoardLetterStatuses,
    BoardState,
    GameConfig,
    GameGuessValidation,
    GameState,
    JamoHint,
    JamoHintUnit,
    JamoSlot,
    Language,
    LetterResult,
} from './types.js';
import { evaluateGuess, isSolved } from './evaluator.js';
import { evaluateGuessKo, evaluateGuessSyllable } from './evaluatorKo.js';
import { getGameLanguageConfig } from './gameLanguageConfig.js';
import { expandHangulToJamoUnits, isHangulSyllable } from './jamo.js';
import { PINYIN_PUZZLE_VARIANT } from './chineseLexicon.js';
import { parseChinesePinyinInput } from './pinyin.js';
import { isValidChinesePinyinGuessKey } from './zhPinyinGuessKeys.generated.js';

const DEFAULT_MAX_GUESSES = 9;

function createBoardState(targetWord: string, targetId?: string): BoardState {
    return {
        targetWord: targetWord.toLowerCase(),
        ...(targetId ? { targetId } : {}),
        guesses: [],
        results: [],
        solved: false,
        solvedOnGuess: null,
    };
}

export function createGame(config: GameConfig): GameState {
    const language = config.language ?? 'en';
    const {
        targetWords,
        targetIds,
        puzzleVariant,
    } = config;
    const wordLength = config.wordLength
        ?? (puzzleVariant === PINYIN_PUZZLE_VARIANT
            ? targetWords[0].length
            : getGameLanguageConfig(language).wordLength);
    const langConfig = getGameLanguageConfig(language, wordLength, puzzleVariant);
    const maxGuesses = puzzleVariant === PINYIN_PUZZLE_VARIANT
        ? langConfig.maxGuesses
        : config.maxGuesses ?? langConfig.maxGuesses ?? DEFAULT_MAX_GUESSES;

    return {
        boards: [
            createBoardState(targetWords[0], targetIds?.[0]),
            createBoardState(targetWords[1], targetIds?.[1]),
            createBoardState(targetWords[2], targetIds?.[2]),
            createBoardState(targetWords[3], targetIds?.[3]),
        ],
        currentGuess: '',
        guessCount: 0,
        maxGuesses,
        gameOver: false,
        won: false,
        language,
        wordLength,
        ...(puzzleVariant ? { puzzleVariant } : {}),
        assistance: puzzleVariant === PINYIN_PUZZLE_VARIANT
            ? { scoringVersion: 2, puzzleVariant: PINYIN_PUZZLE_VARIANT, hints: [] }
            : { scoringVersion: 1, hints: [] },
    };
}

export function validateGuess(guess: string, language: Language = 'en'): { valid: boolean; error?: string } {
    const config = getGameLanguageConfig(language);
    if (Array.from(guess).length !== config.wordLength) {
        const units = language === 'ko' ? 'syllables' : language === 'zh' ? 'characters' : 'letters';
        return { valid: false, error: `Guess must be ${config.wordLength} ${units}` };
    }

    if (!config.validateCharRegex.test(guess)) {
        const error = language === 'ko'
            ? 'Guess must contain only Korean syllables'
            : language === 'zh'
                ? 'Guess must contain only Simplified Chinese characters'
                : 'Guess must contain only letters';
        return { valid: false, error };
    }

    if (language === 'zh' && !config.guessWords.has(guess.normalize('NFC'))) {
        return { valid: false, error: 'Not in the Chinese word list' };
    }

    return { valid: true };
}

export function validateGuessForGame(state: GameState, guess: string): GameGuessValidation {
    if (state.puzzleVariant === PINYIN_PUZZLE_VARIANT) {
        const parsed = parseChinesePinyinInput(guess);
        if (!parsed) {
            return { valid: false, code: 'INVALID_FORMAT', error: 'Enter exactly two valid Pinyin syllables.' };
        }
        if (parsed.key.length !== state.wordLength) {
            return {
                valid: false,
                code: 'INVALID_LENGTH',
                error: `Guess must be ${state.wordLength} letters.`,
            };
        }
        if (!isValidChinesePinyinGuessKey(parsed.key, state.wordLength)) {
            return { valid: false, code: 'NOT_IN_LIST', error: 'Not in the Pinyin word list.' };
        }
        return { valid: true, normalizedGuess: parsed.key };
    }

    const language = state.language || 'en';
    const validation = validateGuess(guess, language);
    if (!validation.valid) {
        const config = getGameLanguageConfig(language);
        const lengthMatches = Array.from(guess).length === config.wordLength;
        return {
            valid: false,
            code: lengthMatches ? 'INVALID_FORMAT' : 'INVALID_LENGTH',
            error: validation.error ?? 'Invalid guess.',
        };
    }
    return {
        valid: true,
        normalizedGuess: language === 'en' ? guess.toLowerCase() : guess.normalize('NFC'),
    };
}

export function submitGuess(state: GameState, guess: string): GameState {
    if (state.gameOver) {
        return state;
    }

    const validation = validateGuessForGame(state, guess);
    if (!validation.valid) {
        return state;
    }

    return applyValidatedGuess(state, validation.normalizedGuess);
}

export function applyValidatedGuess(state: GameState, normalizedGuess: string): GameState {
    if (state.gameOver) {
        return state;
    }

    const language = state.language || 'en';
    const newBoards = state.boards.map((board) => {
        if (board.solved) {
            const prevResult = board.results[board.results.length - 1];
            const prevKoResult = board.koResults?.[board.koResults.length - 1];
            return {
                ...board,
                guesses: [...board.guesses, normalizedGuess],
                results: [...board.results, prevResult],
                ...(language === 'ko' && prevKoResult ? {
                    koResults: [...(board.koResults || []), prevKoResult],
                } : {}),
            };
        }

        if (language === 'ko') {
            const syllableResult = evaluateGuessSyllable(normalizedGuess, board.targetWord);
            const koResult = evaluateGuessKo(normalizedGuess, board.targetWord);
            const solved = isSolved(syllableResult);
            return {
                ...board,
                guesses: [...board.guesses, normalizedGuess],
                results: [...board.results, syllableResult],
                koResults: [...(board.koResults || []), koResult],
                solved,
                solvedOnGuess: solved ? state.guessCount + 1 : null,
            };
        }

        const result = evaluateGuess(normalizedGuess, board.targetWord);
        const solved = isSolved(result);
        return {
            ...board,
            guesses: [...board.guesses, normalizedGuess],
            results: [...board.results, result],
            solved,
            solvedOnGuess: solved ? state.guessCount + 1 : null,
        };
    }) as [BoardState, BoardState, BoardState, BoardState];

    const newGuessCount = state.guessCount + 1;
    const allSolved = newBoards.every((board) => board.solved);
    const outOfGuesses = newGuessCount >= state.maxGuesses;
    const gameOver = allSolved || outOfGuesses;

    return {
        ...state,
        boards: newBoards,
        currentGuess: '',
        guessCount: newGuessCount,
        gameOver,
        won: allSolved,
    };
}

export function setCurrentGuess(state: GameState, guess: string): GameState {
    if (state.gameOver) {
        return state;
    }

    const language = state.language || 'en';
    const config = getGameLanguageConfig(language);
    let limited: string;

    if (state.puzzleVariant === PINYIN_PUZZLE_VARIANT) {
        limited = guess.toLowerCase().replace(/[^a-z]/gu, '').slice(0, state.wordLength);
    } else if (language === 'ko' || language === 'zh') {
        limited = guess.replace(config.filterCharRegex, '').slice(0, config.wordLength);
    } else {
        limited = guess.slice(0, config.wordLength).toLowerCase().replace(config.filterCharRegex, '');
    }

    return {
        ...state,
        currentGuess: limited,
    };
}

export function getRemainingGuesses(state: GameState): number {
    return state.maxGuesses - state.guessCount;
}

export function getSolvedCount(state: GameState): number {
    return state.boards.filter((board) => board.solved).length;
}

function synthesizeLegacyHintUnits(syllable: string, hint: JamoHint | null | undefined): JamoHintUnit[] {
    if (!hint || !isHangulSyllable(syllable)) return [];

    const slotStatuses: Partial<Record<JamoSlot, LetterResult | null | undefined>> = {
        onset: hint.onset,
        vowel: hint.vowel,
        coda: hint.coda,
    };

    return expandHangulToJamoUnits(syllable)
        .map((unit) => {
            const status = slotStatuses[unit.slot];
            return status ? { ...unit, status } : null;
        })
        .filter((unit): unit is JamoHintUnit => unit !== null);
}

function getHintUnitsForSyllable(syllable: string, hint: JamoHint | null | undefined): JamoHintUnit[] {
    if (!hint) return [];
    if (Array.isArray(hint.units) && hint.units.length > 0) {
        return hint.units;
    }
    return synthesizeLegacyHintUnits(syllable, hint);
}

function getKeyboardUnitsForSyllable(syllable: string, syllableStatus: LetterResult, hint: JamoHint | null | undefined): JamoHintUnit[] {
    if (!isHangulSyllable(syllable)) return [];
    if (syllableStatus === 'correct') {
        return expandHangulToJamoUnits(syllable).map((unit) => ({ ...unit, status: 'correct' as LetterResult }));
    }

    const hintUnits = getHintUnitsForSyllable(syllable, hint);
    if (hintUnits.length > 0) {
        return hintUnits;
    }

    return expandHangulToJamoUnits(syllable).map((unit) => ({ ...unit, status: syllableStatus }));
}

export function computeKeyboardMap(state: GameState): Record<string, LetterResult> {
    const statuses: Record<string, LetterResult> = {};
    const language = state.language || 'en';

    const applyStatus = (key: string, status: LetterResult) => {
        if (status === 'correct') {
            statuses[key] = 'correct';
        } else if (status === 'present' && statuses[key] !== 'correct') {
            statuses[key] = 'present';
        } else if (status === 'absent' && !statuses[key]) {
            statuses[key] = 'absent';
        }
    };

    for (const board of state.boards) {
        for (let guessIdx = 0; guessIdx < board.guesses.length; guessIdx++) {
            if (board.solvedOnGuess !== null && guessIdx >= board.solvedOnGuess) {
                continue;
            }

            const guess = board.guesses[guessIdx];
            const result = board.results[guessIdx];

            if (language === 'ko') {
                const koResults = board.koResults;
                for (let syllIdx = 0; syllIdx < guess.length; syllIdx++) {
                    const syllable = guess[syllIdx];
                    if (!isHangulSyllable(syllable)) continue;

                    const koResult = koResults?.[guessIdx]?.[syllIdx];
                    const units = getKeyboardUnitsForSyllable(syllable, result[syllIdx], koResult?.jamoHints || null);
                    for (const unit of units) {
                        applyStatus(unit.jamo, unit.status);
                    }
                }
            } else {
                for (let letterIdx = 0; letterIdx < guess.length; letterIdx++) {
                    applyStatus(guess[letterIdx], result[letterIdx]);
                }
            }
        }
    }

    return statuses;
}

export function computeKeyboardBoardMap(state: GameState): Record<string, BoardLetterStatuses> {
    const boardStatuses: Record<string, BoardLetterStatuses> = {};
    const language = state.language || 'en';

    const ensure = (key: string): BoardLetterStatuses => {
        if (!boardStatuses[key]) {
            boardStatuses[key] = [null, null, null, null];
        }
        return boardStatuses[key];
    };

    const applyBoardStatus = (key: string, boardIdx: number, status: LetterResult) => {
        const entry = ensure(key);
        const current = entry[boardIdx];
        if (status === 'correct') {
            entry[boardIdx] = 'correct';
        } else if (status === 'present' && current !== 'correct') {
            entry[boardIdx] = 'present';
        } else if (status === 'absent' && current === null) {
            entry[boardIdx] = 'absent';
        }
    };

    for (let boardIdx = 0; boardIdx < state.boards.length; boardIdx++) {
        const board = state.boards[boardIdx];
        for (let guessIdx = 0; guessIdx < board.guesses.length; guessIdx++) {
            if (board.solvedOnGuess !== null && guessIdx >= board.solvedOnGuess) {
                continue;
            }

            const guess = board.guesses[guessIdx];
            const result = board.results[guessIdx];

            if (language === 'ko') {
                const koResults = board.koResults;
                for (let syllIdx = 0; syllIdx < guess.length; syllIdx++) {
                    const syllable = guess[syllIdx];
                    if (!isHangulSyllable(syllable)) continue;

                    const koResult = koResults?.[guessIdx]?.[syllIdx];
                    const units = getKeyboardUnitsForSyllable(syllable, result[syllIdx], koResult?.jamoHints || null);
                    for (const unit of units) {
                        applyBoardStatus(unit.jamo, boardIdx, unit.status);
                    }
                }
            } else {
                for (let letterIdx = 0; letterIdx < guess.length; letterIdx++) {
                    applyBoardStatus(guess[letterIdx], boardIdx, result[letterIdx]);
                }
            }
        }
    }

    return boardStatuses;
}
