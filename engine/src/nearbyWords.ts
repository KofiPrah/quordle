import { expandHangulToJamoUnits } from './jamo.js';
import type { KoreanWordLevel } from './koreanDictionary.js';

export type { KoreanWordLevel } from './koreanDictionary.js';

export type KoreanGuessClassification = 'accepted' | 'recognized-unaccepted' | 'unrecognized';

export interface KoreanNearbyCandidate {
    word: string;
    level: KoreanWordLevel;
    answerEligible: boolean;
}

export interface KoreanNearbySuggestion {
    word: string;
    level: KoreanWordLevel;
    score: number;
    jamoDistance: number;
}

export interface KoreanNearbyOptions {
    excludedWords?: Iterable<string>;
    limit?: number;
}

const KOREAN_TWO_SYLLABLES = /^[\uAC00-\uD7A3]{2}$/u;
const LEVEL_RANK: Record<KoreanWordLevel, number> = {
    ungraded: 0,
    advanced: 1,
    intermediate: 2,
    beginner: 3,
};

function normalizeKoreanWord(word: string): string {
    return typeof word === 'string' ? word.normalize('NFC') : '';
}

function atomicJamo(word: string): string[] {
    return [...word].flatMap((syllable) => (
        expandHangulToJamoUnits(syllable).map((unit) => unit.jamo)
    ));
}

function editDistance(left: readonly string[], right: readonly string[]): number {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + substitutionCost,
            );
        }
        previous = current;
    }

    return previous[right.length];
}

function normalizeLevel(level: KoreanWordLevel | undefined): KoreanWordLevel {
    return level && level in LEVEL_RANK ? level : 'ungraded';
}

export function classifyKoreanGuess(
    word: string,
    acceptedWords: ReadonlySet<string>,
    recognizedWords: Readonly<Record<string, KoreanWordLevel>>,
): KoreanGuessClassification {
    const normalized = normalizeKoreanWord(word);
    if (!KOREAN_TWO_SYLLABLES.test(normalized)) return 'unrecognized';
    if (acceptedWords.has(normalized)) return 'accepted';
    return recognizedWords[normalized] ? 'recognized-unaccepted' : 'unrecognized';
}

export function rankNearbyKoreanWords(
    word: string,
    candidates: readonly KoreanNearbyCandidate[],
    options: KoreanNearbyOptions = {},
): KoreanNearbySuggestion[] {
    const normalized = normalizeKoreanWord(word);
    if (!KOREAN_TWO_SYLLABLES.test(normalized)) return [];

    const excluded = new Set(
        [normalized, ...(options.excludedWords ?? [])]
            .map(normalizeKoreanWord)
            .filter(Boolean),
    );
    const uniqueCandidates = new Map<string, KoreanNearbyCandidate>();

    for (const candidate of candidates) {
        const candidateWord = normalizeKoreanWord(candidate.word);
        if (!KOREAN_TWO_SYLLABLES.test(candidateWord) || excluded.has(candidateWord)) continue;
        const normalizedCandidate = {
            word: candidateWord,
            level: normalizeLevel(candidate.level),
            answerEligible: candidate.answerEligible === true,
        };
        const existing = uniqueCandidates.get(candidateWord);
        if (
            !existing
            || LEVEL_RANK[normalizedCandidate.level] > LEVEL_RANK[existing.level]
            || (normalizedCandidate.level === existing.level && normalizedCandidate.answerEligible && !existing.answerEligible)
        ) {
            uniqueCandidates.set(candidateWord, normalizedCandidate);
        }
    }

    const inputJamo = atomicJamo(normalized);
    const scored = [];

    for (const candidate of uniqueCandidates.values()) {
        const candidateJamo = atomicJamo(candidate.word);
        const jamoDistance = editDistance(inputJamo, candidateJamo);
        const maxJamoLength = Math.max(inputJamo.length, candidateJamo.length, 1);
        const jamoSimilarity = 1 - (jamoDistance / maxJamoLength);
        const firstSyllableMatch = normalized[0] === candidate.word[0];
        const secondSyllableMatch = normalized[1] === candidate.word[1];

        if (!firstSyllableMatch && !secondSyllableMatch && jamoSimilarity < 0.5) continue;

        const levelRank = LEVEL_RANK[candidate.level];
        const score = (
            (firstSyllableMatch ? 5 : 0)
            + (secondSyllableMatch ? 5 : 0)
            + (jamoSimilarity * 4)
            + ((levelRank / LEVEL_RANK.beginner) * 3)
            + (candidate.answerEligible ? 0.5 : 0)
        );

        scored.push({
            word: candidate.word,
            level: candidate.level,
            score,
            jamoDistance,
            answerEligible: candidate.answerEligible,
        });
    }

    scored.sort((left, right) => (
        right.score - left.score
        || left.jamoDistance - right.jamoDistance
        || LEVEL_RANK[right.level] - LEVEL_RANK[left.level]
        || Number(right.answerEligible) - Number(left.answerEligible)
        || left.word.localeCompare(right.word, 'ko')
    ));

    const limit = Math.min(3, Math.max(0, Math.floor(options.limit ?? 3)));
    return scored.slice(0, limit).map(({ answerEligible: _answerEligible, ...suggestion }) => suggestion);
}
