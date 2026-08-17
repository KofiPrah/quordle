// Types
export type {
    Language,
    PuzzleVariant,
    LanguageWord,
    KoreanHintType,
    LegacyChineseHintType,
    PinyinChineseHintType,
    ChineseHintType,
    RevealLetterHintPayload,
    HintType,
    HintUse,
    PinyinChineseHintUse,
    AssistanceState,
    LegacyAssistanceState,
    PinyinAssistanceState,
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
    GuessValidationErrorCode,
    GameGuessValidation,
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
    ChineseDictionarySense,
    ChinesePronunciation,
    ChineseDictionaryEntry,
    ChineseDictionarySnapshot,
    ChineseDictionaryManifest,
} from './chineseDictionary.js';

export type {
    DictionaryViewSense,
    DictionaryViewModel,
} from './dictionaryViewModel.js';

export type {
    ChinesePinyinCandidate,
    ChinesePinyinIndex,
    ParsedChinesePinyinInput,
    ParsedChinesePinyinSyllable,
} from './pinyin.js';

export type {
    ChinesePinyinPuzzleAnswer,
    ChinesePinyinRound,
} from './chineseLexicon.js';

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

export type {
    ChineseHintErrorCode,
    ChineseHintResult,
} from './chineseHints.js';

// Game logic
export {
    createGame,
    submitGuess,
    validateGuessForGame,
    applyValidatedGuess,
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

// Simplified Chinese dictionary and pinyin utilities
export { getChineseDictionaryShardId } from './chineseDictionary.js';
export { toKoreanDictionaryViewModel, toChineseDictionaryViewModel } from './dictionaryViewModel.js';
export {
    normalizePinyin,
    normalizePinyinToneSignature,
    numericPinyinSyllableToMarked,
    numericPinyinToMarked,
    numericPinyinToPlain,
    findChinesePinyinCandidates,
    parseChinesePinyinInput,
} from './pinyin.js';

// Korean vocabulary discovery
export { classifyKoreanGuess, rankNearbyKoreanWords } from './nearbyWords.js';

// Assistance and language-specific learning hints
export {
    ASSISTANCE_SCORING_VERSION,
    PINYIN_ASSISTANCE_SCORING_VERSION,
    HINT_COSTS,
    KOREAN_HINT_TYPES,
    CHINESE_HINT_TYPES,
    PINYIN_CHINESE_HINT_TYPES,
    isHintTypeForLanguage,
    createEmptyAssistanceState,
    normalizeAssistanceState,
    findHintUse,
    appendHintUse,
    calculatePerformanceMetrics,
} from './assistance.js';
export { isKoreanHintAvailable, requestKoreanHint } from './koreanHints.js';
export { isChineseHintAvailable, requestChineseHint } from './chineseHints.js';
export { isHintAvailable, requestHint } from './hints.js';

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

export {
    CHINESE_LEXICON_SOURCE,
    ZH_ANSWER_WORDS,
    ZH_GUESS_WORDS_LIST,
    isValidChineseGuess,
    isChineseAnswerWord,
    PINYIN_PUZZLE_VARIANT,
    ENABLED_ZH_PINYIN_LENGTHS,
    CHINESE_PINYIN_PUZZLE_ANSWERS,
} from './chineseLexicon.js';

export {
    ZH_PINYIN_GUESS_KEYS_BY_LENGTH,
    isValidChinesePinyinGuessKey,
} from './zhPinyinGuessKeys.generated.js';

// Daily and practice selection
export {
    getDailyTargets,
    getDailyChinesePinyinRound,
    getPracticeChinesePinyinRound,
} from './daily.js';
