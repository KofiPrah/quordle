import {
    KO_ANSWER_WORDS,
    KO_GUESS_WORDS_LIST,
    KOREAN_LEXICON_SOURCE,
} from './koLexicon.generated.js';

const koAnswerWordsSet = new Set(KO_ANSWER_WORDS);
const koGuessWordsSet = new Set([...KO_GUESS_WORDS_LIST, ...KO_ANSWER_WORDS]);

export function isValidKoreanGuess(word: string): boolean {
    return typeof word === 'string' && koGuessWordsSet.has(word.normalize('NFC'));
}

export function isKoreanAnswerWord(word: string): boolean {
    return typeof word === 'string' && koAnswerWordsSet.has(word.normalize('NFC'));
}

export {
    KO_ANSWER_WORDS,
    KO_GUESS_WORDS_LIST,
    KOREAN_LEXICON_SOURCE,
    koAnswerWordsSet,
    koGuessWordsSet,
};
