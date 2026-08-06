// Types
export type {
    Language,
    HintType,
    HintUse,
    AssistanceState,
    LetterResult,
    GuessResult,
    JamoSlot,
    JamoHintUnit,
    JamoHint,
    KoSyllableResult,
    BoardState,
    BoardLetterStatuses,
    GameState,
    GameConfig,
    LanguageConfig,
} from './types.js';

export type {
    DictionarySense,
    SemanticCategory,
    KoreanDictionaryEntry,
    KoreanDictionarySnapshot,
    KoreanRecognitionSnapshot,
} from './koreanDictionary.js';

export type {
    KoreanWordLevel,
    KoreanGuessClassification,
    KoreanNearbyCandidate,
    KoreanNearbySuggestion,
    KoreanNearbyOptions,
} from './nearbyWords.js';

export type {
    PerformanceMetrics,
} from './assistance.js';

export type {
    KoreanHintErrorCode,
    KoreanHintResult,
} from './koreanHints.js';

// Game logic
export {
    createGame,
    submitGuess,
    setCurrentGuess,
    validateGuess,
    getRemainingGuesses,
    getSolvedCount,
    computeKeyboardMap,
    computeKeyboardBoardMap,
} from './game.js';

// Evaluator (English)
export { evaluateGuess, isSolved } from './evaluator.js';

// Evaluator (Korean)
export { evaluateGuessKo, evaluateGuessSyllable } from './evaluatorKo.js';

// Korean vocabulary discovery
export { classifyKoreanGuess, rankNearbyKoreanWords } from './nearbyWords.js';

// Assistance and Korean learning hints
export {
    ASSISTANCE_SCORING_VERSION,
    HINT_COSTS,
    createEmptyAssistanceState,
    normalizeAssistanceState,
    findHintUse,
    appendHintUse,
    calculatePerformanceMetrics,
} from './assistance.js';
export { isKoreanHintAvailable, requestKoreanHint } from './koreanHints.js';

// Jamo utilities
export {
    decomposeHangul,
    composeHangul,
    isHangulSyllable,
    isJamo,
    isConsonant,
    isVowel,
    extractJamo,
    canBeOnset,
    canBeCoda,
    splitCompoundCoda,
    combineCodas,
    combineVowels,
    splitCompoundVowel,
    expandDecomposedSyllableToJamoUnits,
    expandHangulToJamoUnits,
    ONSETS,
    VOWELS,
    CODAS,
} from './jamo.js';

// Korean IME helpers
export {
    createKoImeState,
    getKoImeDisplayChar,
    finalizeKoIme,
    processKoImeJamo,
    backspaceKoIme,
} from './koIme.js';

// Words and validation (English — backward compat)
export {
    WORD_LIST,
    GUESS_WORDS,
    isValidWord,
    isValidGuess,
    getRandomWord,
    getRandomWords,
    getQuordleWords,
} from './words.js';

// Language config
export {
    getLanguageConfig,
    isValidGuessForLanguage,
    isValidWordForLanguage,
    getQuordleWordsForLanguage,
} from './languageConfig.js';

export {
    KOREAN_LEXICON_SOURCE,
    isValidKoreanGuess,
    isKoreanAnswerWord,
} from './koreanLexicon.js';

// Daily
export { getDailyTargets } from './daily.js';
