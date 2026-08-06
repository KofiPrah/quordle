/** Supported languages */
export type Language = 'en' | 'ko';

/** Korean learning hints available during an active round. */
export type HintType = 'part-of-speech' | 'semantic-category' | 'batchim-count' | 'reveal-first-syllable';

/** Persisted result of one charged hint request. */
export interface HintUse {
    boardIndex: number;
    type: HintType;
    payload: string | string[] | number;
    cost: number;
    usedAt: number;
}

/** Versioned assistance history stored with a game. */
export interface AssistanceState {
    scoringVersion: 1;
    hints: HintUse[];
}

/** Result of evaluating a single letter in a guess */
export type LetterResult = 'correct' | 'present' | 'absent';

/** Result of evaluating a full guess against a target word */
export type GuessResult = LetterResult[];

/** Atomic jamo slot inside a Hangul syllable */
export type JamoSlot = 'onset' | 'vowel' | 'coda';

/** Atomic jamo hint unit for Korean evaluation */
export interface JamoHintUnit {
    jamo: string;
    slot: JamoSlot;
    status: LetterResult;
}

/** Jamo-level hint for a single syllable position (Korean only) */
export interface JamoHint {
    units: JamoHintUnit[];
    /** Legacy scalar fields kept for backwards compatibility with persisted games */
    onset?: LetterResult;
    vowel?: LetterResult;
    coda?: LetterResult | null;
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
    assistance: AssistanceState;
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
