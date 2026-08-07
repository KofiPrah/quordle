import type { Language, LanguageConfig } from './types.js';
import { WORD_LIST, GUESS_WORDS } from './words.js';
import {
    KO_ANSWER_WORDS,
    KO_GUESS_WORDS_LIST,
    koAnswerWordsSet,
    koGuessWordsSet,
} from './koreanLexicon.js';
import {
    ZH_ANSWER_WORDS,
    ZH_GUESS_WORDS_LIST,
    zhAnswerWordsSet,
    zhGuessWordsSet,
} from './chineseLexicon.js';

// ========== ENGLISH CONFIG ==========
const enGuessWordsSet = new Set([...GUESS_WORDS, ...WORD_LIST]);

const EN_CONFIG: LanguageConfig = {
    wordLength: 5,
    maxGuesses: 9,
    validateCharRegex: /^[a-zA-Z]+$/,
    filterCharRegex: /[^a-z]/g,
    answerWords: WORD_LIST,
    guessWords: enGuessWordsSet,
};

// ========== KOREAN CONFIG ==========
const KO_CONFIG: LanguageConfig = {
    wordLength: 2,
    maxGuesses: 9,
    validateCharRegex: /^[\uAC00-\uD7A3]+$/,      // composed Hangul syllables only
    filterCharRegex: /[^\uAC00-\uD7A3]/g,           // strip non-Hangul
    answerWords: KO_ANSWER_WORDS,
    guessWords: koGuessWordsSet,
};

// ========== SIMPLIFIED CHINESE CONFIG ==========
const ZH_CONFIG: LanguageConfig = {
    wordLength: 2,
    maxGuesses: 9,
    validateCharRegex: /^\p{Script=Han}+$/u,
    filterCharRegex: /[^\p{Script=Han}]/gu,
    answerWords: ZH_ANSWER_WORDS,
    guessWords: zhGuessWordsSet,
};

// ========== LOOKUP ==========
const LANGUAGE_CONFIGS: Record<Language, LanguageConfig> = {
    en: EN_CONFIG,
    ko: KO_CONFIG,
    zh: ZH_CONFIG,
};

export function getLanguageConfig(language: Language): LanguageConfig {
    return LANGUAGE_CONFIGS[language];
}

/** Validate that a guess is acceptable for the given language */
export function isValidGuessForLanguage(word: string, language: Language): boolean {
    const config = getLanguageConfig(language);
    return config.guessWords.has(word);
}

/** Validate that a word is in the answer list for the given language */
export function isValidWordForLanguage(word: string, language: Language): boolean {
    const config = getLanguageConfig(language);
    return config.answerWords.includes(word);
}

/** Get N random words for the given language (for practice mode) */
export function getQuordleWordsForLanguage(language: Language): [string, string, string, string] {
    const config = getLanguageConfig(language);
    const words = config.answerWords;
    if (words.length < 4) {
        throw new Error(`Not enough words for language: ${language}`);
    }
    const shuffled = [...words].sort(() => Math.random() - 0.5);
    return [shuffled[0], shuffled[1], shuffled[2], shuffled[3]];
}

// Re-export the Korean word lists for server-side use
export {
    KO_ANSWER_WORDS,
    KO_GUESS_WORDS_LIST,
    koAnswerWordsSet,
    koGuessWordsSet,
    ZH_ANSWER_WORDS,
    ZH_GUESS_WORDS_LIST,
    zhAnswerWordsSet,
    zhGuessWordsSet,
};
