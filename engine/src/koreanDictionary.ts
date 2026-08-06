/** A single English sense from the Korean Basic Dictionary snapshot. */
export interface DictionarySense {
    partOfSpeech: string;
    translations: string[];
    definition: string;
    sourceTargetCode: number;
    sourceUrl: string;
}

/** Learning metadata for one accepted two-syllable Korean word. */
export interface KoreanDictionaryEntry {
    word: string;
    normalized: string;
    units: [string, string];
    pronunciation?: string;
    romanization: string;
    senses: DictionarySense[];
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
