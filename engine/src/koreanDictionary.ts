/** A single English sense from the Korean Basic Dictionary snapshot. */
export interface DictionarySense {
    partOfSpeech: string;
    translations: string[];
    definition: string;
    sourceTargetCode: number;
    sourceUrl: string;
}

/** Bilingual semantic category supplied by KRDICT. */
export interface SemanticCategory {
    korean: string;
    english: string;
}

/** Learning metadata for one accepted two-syllable Korean word. */
export interface KoreanDictionaryEntry {
    word: string;
    normalized: string;
    units: [string, string];
    pronunciation?: string;
    romanization: string;
    senses: DictionarySense[];
    semanticCategories: SemanticCategory[];
    answerEligible: boolean;
    guessEligible: boolean;
}

export interface KoreanDictionarySnapshot {
    metadata: {
        source: string;
        notice: string;
        dictionaryUrl: string;
        license: string;
        licenseUrl: string;
        sourceMode: string;
        sourceUpdatedAt?: string;
    };
    entries: Record<string, KoreanDictionaryEntry>;
}

export type KoreanWordLevel = 'beginner' | 'intermediate' | 'advanced' | 'ungraded';

/** Compact offline catalog used to distinguish recognized Korean words. */
export interface KoreanRecognitionSnapshot {
    metadata: KoreanDictionarySnapshot['metadata'];
    words: Record<string, KoreanWordLevel>;
}
