export interface ChineseDictionarySense {
    glosses: string[];
}

export interface ChinesePronunciation {
    pinyinNumeric: string;
    pinyinMarked: string;
    pinyinPlain: string;
    tones: [number, number];
}

export interface ChineseDictionaryEntry {
    word: string;
    normalized: string;
    display: string;
    simplified: string;
    traditional: string[];
    units: [string, string];
    pronunciations: ChinesePronunciation[];
    senses: ChineseDictionarySense[];
    translations: string[];
    answerEligible: boolean;
    guessEligible: boolean;
}

export interface ChineseDictionarySnapshot {
    metadata: {
        source: string;
        notice: string;
        dictionaryUrl: string;
        license: string;
        licenseUrl: string;
        sourceMode: string;
        sourceUpdatedAt: string;
        sourceSha256: string;
    };
    entries: Record<string, ChineseDictionaryEntry>;
}

export interface ChineseDictionaryManifest {
    metadata: ChineseDictionarySnapshot['metadata'];
    entryCount: number;
    shardCount: number;
    shards: string[];
}

export function getChineseDictionaryShardId(word: string, shardCount = 64): string {
    const first = Array.from(String(word ?? '').normalize('NFC'))[0];
    if (!first) return '00';
    const bucket = (first.codePointAt(0) ?? 0) % shardCount;
    return bucket.toString(16).padStart(2, '0');
}
