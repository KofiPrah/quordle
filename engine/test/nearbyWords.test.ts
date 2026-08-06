import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    classifyKoreanGuess,
    rankNearbyKoreanWords,
    type KoreanNearbyCandidate,
} from '../src/nearbyWords.js';

function candidate(
    word: string,
    level: KoreanNearbyCandidate['level'] = 'ungraded',
    answerEligible = false,
): KoreanNearbyCandidate {
    return { word, level, answerEligible };
}

describe('classifyKoreanGuess', () => {
    const accepted = new Set(['기차']);
    const recognized = { 기차: 'beginner', 기품: 'advanced' } as const;

    it('distinguishes accepted, recognized-unaccepted, and unrecognized words', () => {
        expect(classifyKoreanGuess('기차', accepted, recognized)).toBe('accepted');
        expect(classifyKoreanGuess('기품', accepted, recognized)).toBe('recognized-unaccepted');
        expect(classifyKoreanGuess('학일', accepted, recognized)).toBe('unrecognized');
    });

    it('normalizes NFC input and rejects malformed input', () => {
        expect(classifyKoreanGuess('기품'.normalize('NFD'), accepted, recognized)).toBe('recognized-unaccepted');
        expect(classifyKoreanGuess('가', accepted, recognized)).toBe('unrecognized');
        expect(classifyKoreanGuess('ab', accepted, recognized)).toBe('unrecognized');
    });
});

describe('rankNearbyKoreanWords', () => {
    it('prioritizes close syllable matches and beginner vocabulary', () => {
        const results = rankNearbyKoreanWords('학일', [
            candidate('기일', 'beginner'),
            candidate('학원', 'intermediate'),
            candidate('학생', 'beginner', true),
            candidate('호떡', 'beginner', true),
        ]);

        expect(results.map((result) => result.word)).toEqual(['학생', '기일', '학원']);
    });

    it('uses atomic jamo distance for one-jamo and compound-vowel neighbors', () => {
        const simple = rankNearbyKoreanWords('기분', [candidate('기본'), candidate('호떡')]);
        const compound = rankNearbyKoreanWords('과자', [candidate('고자'), candidate('호떡')]);

        expect(simple).toHaveLength(1);
        expect(simple[0]).toMatchObject({ word: '기본', jamoDistance: 1 });
        expect(compound).toHaveLength(1);
        expect(compound[0]).toMatchObject({ word: '고자', jamoDistance: 1 });
    });

    it('uses learning level and answer eligibility as deterministic tie-break signals', () => {
        const levelResults = rankNearbyKoreanWords('가나', [
            candidate('가라', 'advanced'),
            candidate('가다', 'beginner'),
        ]);
        expect(levelResults[0].word).toBe('가다');

        const answerResults = rankNearbyKoreanWords('가나', [
            candidate('가라', 'intermediate'),
            candidate('가다', 'intermediate', true),
        ]);
        expect(answerResults[0].word).toBe('가다');
    });

    it('filters irrelevant, duplicate, input, and explicitly excluded words', () => {
        const results = rankNearbyKoreanWords('기분', [
            candidate('기분', 'beginner'),
            candidate('기본', 'advanced'),
            candidate('기본', 'beginner'),
            candidate('기법', 'beginner'),
            candidate('호떡', 'beginner'),
        ], { excludedWords: ['기법'] });

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ word: '기본', level: 'beginner' });
    });

    it('returns no more than three results and is independent of candidate order', () => {
        const candidates = [
            candidate('가다', 'beginner'),
            candidate('가라', 'beginner'),
            candidate('가마', 'beginner'),
            candidate('가사', 'beginner'),
        ];
        const forward = rankNearbyKoreanWords('가나', candidates);
        const reverse = rankNearbyKoreanWords('가나', [...candidates].reverse());

        expect(forward).toHaveLength(3);
        expect(reverse).toEqual(forward);
    });

    it('classifies and suggests from the checked-in offline snapshots without exposing exclusions', () => {
        const dictionary = JSON.parse(readFileSync(
            new URL('../src/koDictionary.generated.json', import.meta.url),
            'utf8',
        )) as { entries: Record<string, { word: string; answerEligible: boolean }> };
        const recognition = JSON.parse(readFileSync(
            new URL('../src/koWordRecognition.generated.json', import.meta.url),
            'utf8',
        )) as { words: Record<string, KoreanNearbyCandidate['level']> };
        const acceptedWords = new Set<string>(Object.keys(dictionary.entries));
        const candidates = Object.values(dictionary.entries).map((entry) => candidate(
            entry.word,
            recognition.words[entry.word] ?? 'ungraded',
            entry.answerEligible === true,
        ));

        expect(classifyKoreanGuess('기품', acceptedWords, recognition.words)).toBe('recognized-unaccepted');
        expect(classifyKoreanGuess('학일', acceptedWords, recognition.words)).toBe('unrecognized');

        const initial = rankNearbyKoreanWords('기품', candidates);
        expect(initial).toHaveLength(3);
        const hiddenWord = initial[0].word;
        const filtered = rankNearbyKoreanWords('기품', candidates, { excludedWords: [hiddenWord] });
        expect(filtered.map((suggestion) => suggestion.word)).not.toContain(hiddenWord);
    });
});
