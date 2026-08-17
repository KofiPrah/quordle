import {
    CHINESE_LEXICON_SOURCE,
    ZH_ANSWER_WORDS,
    ZH_GUESS_WORDS_LIST,
} from './zhLexicon.generated.js';
import { ZH_PINYIN_PUZZLE_ANSWERS } from './zhPinyinPuzzleCatalog.generated.js';

export const PINYIN_PUZZLE_VARIANT = 'pinyin-latin-v2' as const;
export const ENABLED_ZH_PINYIN_LENGTHS = [5, 6, 7] as const;

export interface ChinesePinyinPuzzleAnswer {
    id: string;
    hanzi: string;
    key: string;
    pinyinMarked: string;
    pinyinNumeric: string;
    tones: readonly [number, number];
    syllableBoundary: number;
    broadMeaning: string;
    length: number;
    answerEligible: true;
}

export interface ChinesePinyinRound {
    variant: typeof PINYIN_PUZZLE_VARIANT;
    length: number;
    answers: readonly ChinesePinyinPuzzleAnswer[];
}

export const CHINESE_PINYIN_PUZZLE_ANSWERS: readonly ChinesePinyinPuzzleAnswer[] = ZH_PINYIN_PUZZLE_ANSWERS;

const zhAnswerWordsSet = new Set(ZH_ANSWER_WORDS);
const zhGuessWordsSet = new Set([...ZH_GUESS_WORDS_LIST, ...ZH_ANSWER_WORDS]);

export function isValidChineseGuess(word: string): boolean {
    return typeof word === 'string' && zhGuessWordsSet.has(word.normalize('NFC'));
}

export function isChineseAnswerWord(word: string): boolean {
    return typeof word === 'string' && zhAnswerWordsSet.has(word.normalize('NFC'));
}

export {
    CHINESE_LEXICON_SOURCE,
    ZH_ANSWER_WORDS,
    ZH_GUESS_WORDS_LIST,
    zhAnswerWordsSet,
    zhGuessWordsSet,
};
