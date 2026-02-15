/** Supported languages */
export type Language = 'en' | 'ko';

/** Result of evaluating a single letter in a guess */
export type LetterResult = 'correct' | 'present' | 'absent';

/** Result of evaluating a full guess against a target word */
export type GuessResult = LetterResult[];

/** Jamo-level hint for a single syllable position (Korean only) */
export interface JamoHint {
    onset: LetterResult;
    vowel: LetterResult;
    coda: LetterResult | null; // null if no coda in either guess or target
}

/** Extended result for Korean evaluation — syllable-level + optional jamo hints */
export interface KoSyllableResult {
    syllable: LetterResult;       // Layer 1: whole syllable comparison
    jamoHints: JamoHint | null;   // Layer 2: only populated for non-correct syllables
}

/** State of a single board in Quordle */
export interface BoardState {
    targetWord: string;
    guesses: string[];
    results: GuessResult[];
    /** Korean jamo hints per guess — only present when language is 'ko' */
    koResults?: KoSyllableResult[][];
    solved: boolean;
    solvedOnGuess: number | null;
}

/** Full game state for Quordle (4 boards) */
export interface GameState {
    boards: [BoardState, BoardState, BoardState, BoardState];
    currentGuess: string;
    guessCount: number;
    maxGuesses: number;
    gameOver: boolean;
    won: boolean;
    language: Language;
}

/** Configuration for creating a new game */
export interface GameConfig {
    targetWords: [string, string, string, string];
    maxGuesses?: number;
    language?: Language;
}

/**
 * Per-board letter status for the keyboard 2×2 board indicator.
 * Index 0–3 corresponds to boards 0–3.
 * null means the letter has not been evaluated on that board (or board was already solved).
 */
export type BoardLetterStatuses = [LetterResult | null, LetterResult | null, LetterResult | null, LetterResult | null];

/** Language-specific configuration */
export interface LanguageConfig {
    wordLength: number;
    maxGuesses: number;
    validateCharRegex: RegExp;
    filterCharRegex: RegExp;
    answerWords: readonly string[];
    guessWords: ReadonlySet<string>;
}
