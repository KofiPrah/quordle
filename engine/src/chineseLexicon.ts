import {
    CHINESE_LEXICON_SOURCE,
    ZH_ANSWER_WORDS,
    ZH_GUESS_WORDS_LIST,
} from './zhLexicon.generated.js';

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
