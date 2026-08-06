import { describe, expect, it } from 'vitest';
import {
  createDictionaryCollector,
  normalizeVocabularyLevel,
  parseApiSearchXml,
  parseBulkLexicalEntry,
  parseBulkRecognitionEntry,
  sanitizeProviderError,
} from '../scripts/krdict-import-lib.mjs';

function equivalent(language, lemma, definition) {
  return { feat: [
    { att: 'language', val: language },
    { att: 'lemma', val: lemma },
    { att: 'definition', val: definition },
  ] };
}

function bulkEntry({
  word = '기관',
  code = 10,
  homonym = 1,
  partOfSpeech = '명사',
  english = true,
  pronunciation = word,
  sense = 1,
  lexicalUnit = '단어',
  wordType,
  vocabularyLevel = '중급',
} = {}) {
  return {
    Lemma: { feat: { att: 'writtenForm', val: word } },
    Sense: {
      Equivalent: english ? [equivalent('영어', 'institution; organization', 'An established organization.')] : [],
      val: String(sense),
    },
    WordForm: { feat: [
      { att: 'type', val: '발음' },
      { att: 'pronunciation', val: pronunciation },
    ] },
    feat: [
      { att: 'lexicalUnit', val: lexicalUnit },
      { att: 'homonym_number', val: String(homonym) },
      { att: 'partOfSpeech', val: partOfSpeech },
      ...(wordType ? [{ att: 'wordType', val: wordType }] : []),
      { att: 'vocabularyLevel', val: vocabularyLevel },
    ],
    val: String(code),
  };
}

describe('KRDICT bulk parsing', () => {
  const candidates = new Map([['기관', { answerEligible: true, guessEligible: true }]]);

  it('parses exact English senses and maps parts of speech', () => {
    const result = parseBulkLexicalEntry(bulkEntry(), candidates);
    expect(result.word).toBe('기관');
    expect(result.senses[0]).toMatchObject({
      partOfSpeech: 'noun',
      translations: ['institution', 'organization'],
      definition: 'An established organization.',
      sourceTargetCode: 10,
    });
  });

  it('rejects missing English translations and proper nouns', () => {
    expect(parseBulkLexicalEntry(bulkEntry({ english: false }), candidates)).toBeNull();
    expect(parseBulkLexicalEntry(bulkEntry({ partOfSpeech: '고유 명사' }), candidates)).toBeNull();
  });

  it('aggregates homonyms deterministically and generates romanization', () => {
    const collector = createDictionaryCollector(candidates);
    collector.add(parseBulkLexicalEntry(bulkEntry({ code: 10, homonym: 2, sense: 1 }), candidates));
    collector.add(parseBulkLexicalEntry(bulkEntry({ code: 20, homonym: 1, sense: 2 }), candidates));
    const entry = collector.finalize().get('기관');
    expect(entry.romanization).toBe('gigwan');
    expect(entry.units).toEqual(['기', '관']);
    expect(entry.senses.map((sense) => sense.sourceTargetCode)).toEqual([20, 10]);
  });

  it('romanizes the published pronunciation before falling back to the headword', () => {
    const pronunciationCandidates = new Map([
      ['의논', { answerEligible: false, guessEligible: true }],
    ]);
    const collector = createDictionaryCollector(pronunciationCandidates);
    collector.add(parseBulkLexicalEntry(
      bulkEntry({ word: '의논', pronunciation: '이논' }),
      pronunciationCandidates,
    ));
    expect(collector.finalize().get('의논').romanization).toBe('inon');
  });

  it('extracts compact recognition metadata without requiring an English sense', () => {
    expect(parseBulkRecognitionEntry(bulkEntry({ english: false, vocabularyLevel: '초급' }))).toEqual({
      word: '기관',
      level: 'beginner',
    });
    expect(normalizeVocabularyLevel('중급')).toBe('intermediate');
    expect(normalizeVocabularyLevel('고급')).toBe('advanced');
    expect(normalizeVocabularyLevel('없음')).toBe('ungraded');
    expect(parseBulkRecognitionEntry(bulkEntry({ word: '기관'.normalize('NFD') })).word).toBe('기관');
  });

  it('filters malformed, non-word, and proper-noun recognition entries', () => {
    expect(parseBulkRecognitionEntry(bulkEntry({ word: '가나다' }))).toBeNull();
    expect(parseBulkRecognitionEntry(bulkEntry({ lexicalUnit: '구' }))).toBeNull();
    expect(parseBulkRecognitionEntry(bulkEntry({ wordType: '고유 명사' }))).toBeNull();
  });
});

describe('KRDICT API parsing and failures', () => {
  it('parses an exact translated API result', () => {
    const xml = `<?xml version="1.0"?><channel><item><target_code>10</target_code><word>기관</word><pronunciation>기관</pronunciation><pos>명사</pos><sense><sense_order>1</sense_order><translation><trans_word>institution</trans_word><trans_dfn>An organization.</trans_dfn></translation></sense></item></channel>`;
    expect(parseApiSearchXml(xml, '기관')).toHaveLength(1);
  });

  it('throws on malformed XML and redacts provider keys', () => {
    expect(() => parseApiSearchXml('<channel><item>', '기관')).toThrow(/Malformed KRDICT XML/);
    expect(sanitizeProviderError('https://example.test?key=0123456789abcdef0123456789abcdef&q=x'))
      .toBe('https://example.test?key=[REDACTED]&q=x');
  });

  it('surfaces provider errors without exposing credentials', () => {
    const xml = '<error><error_code>020</error_code><message>Unregistered key 0123456789abcdef0123456789abcdef</message></error>';
    expect(() => parseApiSearchXml(xml, '기관')).toThrow(/\[REDACTED\]/);
  });
});
