// Types
export type {
    Language,
    LanguageWord,
    KoreanHintType,
    ChineseHintType,
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
} from './pinyin.js';

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
} from './pinyin.js';

// Korean vocabulary discovery
export { classifyKoreanGuess, rankNearbyKoreanWords } from './nearbyWords.js';

// Assistance and language-specific learning hints
export {
    ASSISTANCE_SCORING_VERSION,
    HINT_COSTS,
    KOREAN_HINT_TYPES,
    CHINESE_HINT_TYPES,
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
} from './chineseLexicon.js';

// Daily
export { getDailyTargets } from './daily.js';
