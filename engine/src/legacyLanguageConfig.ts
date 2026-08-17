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

const LANGUAGE_CONFIGS: Record<Language, LanguageConfig> = {
    en: {
        wordLength: 5,
        maxGuesses: 9,
        validateCharRegex: /^[a-zA-Z]+$/,
        filterCharRegex: /[^a-z]/g,
        answerWords: WORD_LIST,
        guessWords: new Set([...GUESS_WORDS, ...WORD_LIST]),
    },
    ko: {
        wordLength: 2,
        maxGuesses: 9,
        validateCharRegex: /^[\uAC00-\uD7A3]+$/,
        filterCharRegex: /[^\uAC00-\uD7A3]/g,
        answerWords: KO_ANSWER_WORDS,
        guessWords: koGuessWordsSet,
    },
    zh: {
        wordLength: 2,
        maxGuesses: 9,
        validateCharRegex: /^\p{Script=Han}+$/u,
        filterCharRegex: /[^\p{Script=Han}]/gu,
        answerWords: ZH_ANSWER_WORDS,
        guessWords: zhGuessWordsSet,
    },
};

export function getLegacyLanguageConfig(language: Language): LanguageConfig {
    return LANGUAGE_CONFIGS[language];
}

export function isValidLegacyGuessForLanguage(word: string, language: Language): boolean {
    return getLegacyLanguageConfig(language).guessWords.has(word);
}

export function getLegacyQuordleWordsForLanguage(language: Language): [string, string, string, string] {
    const words = getLegacyLanguageConfig(language).answerWords;
    if (words.length < 4) throw new Error(`Not enough words for language: ${language}`);
    const shuffled = [...words].sort(() => Math.random() - 0.5);
    return [shuffled[0], shuffled[1], shuffled[2], shuffled[3]];
}

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
