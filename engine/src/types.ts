/** Supported languages */
export type Language = 'en' | 'ko' | 'zh';

/** Versioned gameplay rules layered on top of a language. */
export type PuzzleVariant = 'pinyin-latin-v2';

/** Language-neutral learning metadata consumed by shared dictionary UI. */
export interface LanguageWord {
    id: string;
    language: Language;
    display: string;
    normalized: string;
    units: string[];
    translations: string[];
    definitions?: string[];
    romanization?: string;
    pronunciation?: string;
    partOfSpeech?: string[];
    tags?: string[];
    frequencyRank?: number;
    difficulty?: number;
    answerEligible: boolean;
    guessEligible: boolean;
}

/** Korean learning hints available during an active round. */
export type KoreanHintType = 'part-of-speech' | 'semantic-category' | 'batchim-count' | 'reveal-first-syllable';

/** Historical Hanzi Chinese hints retained for persisted version-1 games. */
export type LegacyChineseHintType = 'tone-pattern' | 'pinyin-initials' | 'broad-meaning' | 'reveal-first-character';

/** Chinese Pinyin hints available in version-2 games. */
export type PinyinChineseHintType = 'syllable-boundary' | 'reveal-letter' | 'broad-meaning';

export type ChineseHintType = LegacyChineseHintType | PinyinChineseHintType;

/** Every persisted scored hint type. */
export type HintType = KoreanHintType | ChineseHintType;

export interface RevealLetterHintPayload {
    index: number;
    letter: string;
}

/** Persisted result of one charged hint request. */
export interface HintUse {
    boardIndex: number;
    type: HintType;
    payload: string | string[] | number | RevealLetterHintPayload;
    cost: number;
    usedAt: number;
}

export type PinyinChineseHintUse =
    | (Omit<HintUse, 'type' | 'payload'> & { type: 'syllable-boundary'; payload: number })
    | (Omit<HintUse, 'type' | 'payload'> & { type: 'reveal-letter'; payload: RevealLetterHintPayload })
    | (Omit<HintUse, 'type' | 'payload'> & { type: 'broad-meaning'; payload: string });

/** Historical assistance history retained for Korean and Hanzi Chinese games. */
export interface LegacyAssistanceState {
    scoringVersion: 1;
    hints: HintUse[];
}

/** Variant-specific assistance history for Latin-letter Pinyin games. */
export interface PinyinAssistanceState {
    scoringVersion: 2;
    puzzleVariant: 'pinyin-latin-v2';
    hints: PinyinChineseHintUse[];
}

export type AssistanceState = LegacyAssistanceState | PinyinAssistanceState;

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
    targetId?: string;
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
    wordLength: number;
    puzzleVariant?: PuzzleVariant;
    assistance: AssistanceState;
}

/** Configuration for creating a new game */
export interface GameConfig {
    targetWords: [string, string, string, string];
    targetIds?: [string, string, string, string];
    maxGuesses?: number;
    language?: Language;
    wordLength?: number;
    puzzleVariant?: PuzzleVariant;
}

export type GuessValidationErrorCode = 'INVALID_FORMAT' | 'INVALID_LENGTH' | 'NOT_IN_LIST';

export type GameGuessValidation =
    | { valid: true; normalizedGuess: string }
    | { valid: false; code: GuessValidationErrorCode; error: string };

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
