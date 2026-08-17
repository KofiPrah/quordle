import type { Language, LanguageConfig, PuzzleVariant } from './types.js';
import {
    CHINESE_PINYIN_PUZZLE_ANSWERS,
    PINYIN_PUZZLE_VARIANT,
} from './chineseLexicon.js';
import { ZH_PINYIN_GUESS_KEYS_BY_LENGTH } from './zhPinyinGuessKeys.generated.js';
import {
    getLegacyLanguageConfig,
    getLegacyQuordleWordsForLanguage,
    isValidLegacyGuessForLanguage,
} from './legacyLanguageConfig.js';

const PINYIN_CONFIGS = new Map<number, LanguageConfig>();

export function getLanguageConfig(
    language: Language,
    wordLength?: number,
    puzzleVariant?: PuzzleVariant,
): LanguageConfig {
    if (language === 'zh' && puzzleVariant === PINYIN_PUZZLE_VARIANT && wordLength !== undefined) {
        const existing = PINYIN_CONFIGS.get(wordLength);
        if (existing) return existing;
        const config: LanguageConfig = {
            wordLength,
            maxGuesses: 9,
            validateCharRegex: /^[a-z]+$/iu,
            filterCharRegex: /[^a-z]/giu,
            answerWords: CHINESE_PINYIN_PUZZLE_ANSWERS
                .filter((answer) => answer.length === wordLength)
                .map((answer) => answer.key),
            guessWords: new Set(ZH_PINYIN_GUESS_KEYS_BY_LENGTH[wordLength] ?? []),
        };
        PINYIN_CONFIGS.set(wordLength, config);
        return config;
    }
    return getLegacyLanguageConfig(language);
}

export function isValidGuessForLanguage(word: string, language: Language): boolean {
    return isValidLegacyGuessForLanguage(word, language);
}

export function isValidWordForLanguage(word: string, language: Language): boolean {
    return getLegacyLanguageConfig(language).answerWords.includes(word);
}

export function getQuordleWordsForLanguage(language: Language): [string, string, string, string] {
    return getLegacyQuordleWordsForLanguage(language);
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
} from './legacyLanguageConfig.js';
