import type { ChineseDictionaryEntry } from './chineseDictionary.js';
import type { KoreanDictionaryEntry } from './koreanDictionary.js';
import type { LanguageWord } from './types.js';

export interface DictionaryViewSense {
    translations: string[];
    definition?: string;
    partOfSpeech?: string;
    sourceUrl?: string;
}

export interface DictionaryViewModel extends LanguageWord {
    language: 'ko' | 'zh';
    alternateForms: string[];
    senses: DictionaryViewSense[];
    numericPronunciation?: string;
}

export function toKoreanDictionaryViewModel(entry: KoreanDictionaryEntry): DictionaryViewModel {
    return {
        id: `ko:${entry.normalized}`,
        language: 'ko',
        display: entry.word,
        normalized: entry.normalized,
        units: [...entry.units],
        translations: [...new Set(entry.senses.flatMap((sense) => sense.translations))],
        definitions: entry.senses.map((sense) => sense.definition).filter(Boolean),
        romanization: entry.romanization,
        pronunciation: entry.pronunciation,
        partOfSpeech: [...new Set(entry.senses.map((sense) => sense.partOfSpeech).filter(Boolean))],
        tags: entry.semanticCategories.flatMap((category) => [category.korean, category.english]),
        answerEligible: entry.answerEligible,
        guessEligible: entry.guessEligible,
        alternateForms: [],
        senses: entry.senses.map((sense) => ({
            translations: [...sense.translations],
            definition: sense.definition,
            partOfSpeech: sense.partOfSpeech,
            sourceUrl: sense.sourceUrl,
        })),
    };
}

export function toChineseDictionaryViewModel(entry: ChineseDictionaryEntry): DictionaryViewModel {
    const pronunciation = entry.pronunciations[0];
    return {
        id: `zh:${entry.normalized}`,
        language: 'zh',
        display: entry.word,
        normalized: entry.normalized,
        units: [...entry.units],
        translations: [...entry.translations],
        romanization: pronunciation?.pinyinMarked,
        pronunciation: pronunciation?.pinyinMarked,
        numericPronunciation: pronunciation?.pinyinNumeric,
        answerEligible: entry.answerEligible,
        guessEligible: entry.guessEligible,
        alternateForms: [...entry.traditional].filter((word) => word !== entry.word),
        senses: entry.senses.map((sense) => ({ translations: [...sense.glosses] })),
    };
}
