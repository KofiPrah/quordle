import type { Language, LanguageConfig, PuzzleVariant } from './types.js';
import {
    CHINESE_PINYIN_PUZZLE_ANSWERS,
    PINYIN_PUZZLE_VARIANT,
    ZH_ANSWER_WORDS,
    zhGuessWordsSet,
} from './chineseLexicon.js';
import { KO_ANSWER_WORDS, koGuessWordsSet } from './koreanLexicon.js';

const EMPTY_WORDS: readonly string[] = Object.freeze([]);
const EMPTY_WORD_SET: ReadonlySet<string> = new Set();

const LANGUAGE_CONFIGS: Record<Language, LanguageConfig> = {
    en: {
        wordLength: 5,
        maxGuesses: 9,
        validateCharRegex: /^[a-zA-Z]+$/,
        filterCharRegex: /[^a-z]/g,
        answerWords: EMPTY_WORDS,
        guessWords: EMPTY_WORD_SET,
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

const PINYIN_CONFIGS = new Map<number, LanguageConfig>();

/** Runtime-safe game configuration: unlike the full lexicon config, this has no Vite raw-text imports. */
export function getGameLanguageConfig(
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
            guessWords: EMPTY_WORD_SET,
        };
        PINYIN_CONFIGS.set(wordLength, config);
        return config;
    }
    return LANGUAGE_CONFIGS[language];
}
