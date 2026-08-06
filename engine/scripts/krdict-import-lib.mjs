import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { romanize } from 'koroman';

export const KRDICT_SOURCE_NAME = 'National Institute of Korean Language Korean Basic Dictionary';
export const KRDICT_LICENSE = 'CC BY-SA 2.0 KR';
export const KRDICT_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/2.0/kr/';
export const KRDICT_DICTIONARY_URL = 'https://krdict.korean.go.kr/eng';

const HANGUL_TWO_SYLLABLES = /^[\uAC00-\uD7A3]{2}$/u;

const PARTS_OF_SPEECH = Object.freeze({
  '명사': 'noun',
  '대명사': 'pronoun',
  '수사': 'numeral',
  '조사': 'particle',
  '동사': 'verb',
  '형용사': 'adjective',
  '관형사': 'determiner',
  '부사': 'adverb',
  '감탄사': 'interjection',
  '접사': 'affix',
  '의존 명사': 'dependent noun',
  '보조 동사': 'auxiliary verb',
  '보조 형용사': 'auxiliary adjective',
  '어미': 'ending',
  '품사 없음': 'unspecified',
});

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function featureValue(features, attribute) {
  return asArray(features).find((feature) => feature?.att === attribute)?.val;
}

export function isEligibleKoreanWord(word) {
  return typeof word === 'string' && HANGUL_TWO_SYLLABLES.test(word.normalize('NFC'));
}

export function sanitizeProviderError(message) {
  return String(message ?? '')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b[0-9a-f]{32}\b/gi, '[REDACTED]');
}

function splitTranslations(value) {
  return String(value ?? '')
    .split(';')
    .map((translation) => translation.trim())
    .filter(Boolean);
}

function getPronunciation(wordForm) {
  for (const form of asArray(wordForm)) {
    const pronunciation = featureValue(form?.feat, 'pronunciation');
    if (pronunciation) return String(pronunciation).normalize('NFC');
  }
  return undefined;
}

function isProperNoun(partOfSpeech, wordType) {
  const combined = `${partOfSpeech ?? ''} ${wordType ?? ''}`.toLowerCase();
  return combined.includes('고유 명사') || combined.includes('proper noun');
}

function sourceUrl(targetCode) {
  return `https://krdict.korean.go.kr/eng/dicSearch/SearchView?ParaWordNo=${targetCode}`;
}

function normalizeSense({
  partOfSpeech,
  translation,
  definition,
  targetCode,
  homonymOrder = 0,
  senseOrder = 0,
}) {
  const translations = splitTranslations(translation);
  const normalizedDefinition = String(definition ?? '').trim();
  if (translations.length === 0 || !normalizedDefinition) return null;

  return {
    partOfSpeech: PARTS_OF_SPEECH[partOfSpeech] ?? String(partOfSpeech || 'unspecified'),
    translations,
    definition: normalizedDefinition,
    sourceTargetCode: Number(targetCode),
    sourceUrl: sourceUrl(targetCode),
    homonymOrder: Number(homonymOrder) || 0,
    senseOrder: Number(senseOrder) || 0,
  };
}

export function parseBulkLexicalEntry(entry, candidateWords) {
  const word = String(featureValue(entry?.Lemma?.feat, 'writtenForm') ?? '').normalize('NFC');
  if (!isEligibleKoreanWord(word) || !candidateWords.has(word)) return null;

  const lexicalUnit = featureValue(entry?.feat, 'lexicalUnit');
  const partOfSpeech = featureValue(entry?.feat, 'partOfSpeech');
  const wordType = featureValue(entry?.feat, 'wordType');
  if (lexicalUnit !== '단어' || isProperNoun(partOfSpeech, wordType)) return null;

  const targetCode = Number(entry?.val);
  if (!Number.isInteger(targetCode)) return null;
  const homonymOrder = Number(featureValue(entry?.feat, 'homonym_number')) || 0;

  const senses = [];
  for (const sense of asArray(entry?.Sense)) {
    const english = asArray(sense?.Equivalent).find(
      (equivalent) => featureValue(equivalent?.feat, 'language') === '영어',
    );
    if (!english) continue;

    const normalizedSense = normalizeSense({
      partOfSpeech,
      translation: featureValue(english.feat, 'lemma'),
      definition: featureValue(english.feat, 'definition'),
      targetCode,
      homonymOrder,
      senseOrder: sense?.val,
    });
    if (normalizedSense) senses.push(normalizedSense);
  }

  if (senses.length === 0) return null;
  return {
    word,
    pronunciation: getPronunciation(entry?.WordForm),
    senses,
  };
}

function parseApiSense(item, sense) {
  const translation = asArray(sense?.translation)[0] ?? sense?.translation;
  return normalizeSense({
    partOfSpeech: item?.pos,
    translation: translation?.trans_word,
    definition: translation?.trans_dfn,
    targetCode: item?.target_code,
    homonymOrder: item?.sup_no,
    senseOrder: sense?.sense_order,
  });
}

export function parseApiSearchXml(xml, expectedWord) {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`Malformed KRDICT XML: ${sanitizeProviderError(validation.err?.msg || 'invalid XML')}`);
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: true,
  });

  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw new Error(`Malformed KRDICT XML: ${sanitizeProviderError(error?.message)}`);
  }

  if (parsed?.error) {
    const code = parsed.error.error_code ?? 'unknown';
    const message = parsed.error.message ?? 'KRDICT request failed';
    throw new Error(`KRDICT ${code}: ${sanitizeProviderError(message)}`);
  }

  const normalizedExpected = String(expectedWord).normalize('NFC');
  const records = [];
  for (const item of asArray(parsed?.channel?.item)) {
    const word = String(item?.word ?? '').normalize('NFC');
    if (word !== normalizedExpected || !isEligibleKoreanWord(word)) continue;
    if (isProperNoun(item?.pos, item?.word_type)) continue;

    const senses = asArray(item?.sense)
      .map((sense) => parseApiSense(item, sense))
      .filter(Boolean);
    if (senses.length === 0) continue;

    records.push({
      word,
      pronunciation: item?.pronunciation ? String(item.pronunciation).normalize('NFC') : undefined,
      senses,
    });
  }
  return records;
}

export function createDictionaryCollector(candidateMembership) {
  const records = new Map();

  return {
    add(record) {
      if (!record) return;
      const membership = candidateMembership.get(record.word);
      if (!membership) return;

      const existing = records.get(record.word) ?? {
        word: record.word,
        normalized: record.word,
        units: [...record.word],
        pronunciation: undefined,
        romanization: '',
        senses: [],
        answerEligible: membership.answerEligible,
        guessEligible: membership.guessEligible,
      };

      if (!existing.pronunciation && record.pronunciation) {
        existing.pronunciation = record.pronunciation;
      }
      existing.senses.push(...record.senses);
      records.set(record.word, existing);
    },

    finalize() {
      const entries = [...records.values()]
        .map((entry) => {
          const uniqueSenses = new Map();
          for (const sense of entry.senses) {
            const key = `${sense.sourceTargetCode}:${sense.senseOrder}:${sense.definition}`;
            uniqueSenses.set(key, sense);
          }

          const senses = [...uniqueSenses.values()]
            .sort((left, right) => (
              left.homonymOrder - right.homonymOrder
              || left.senseOrder - right.senseOrder
              || left.sourceTargetCode - right.sourceTargetCode
            ))
            .map(({ homonymOrder: _homonymOrder, senseOrder: _senseOrder, ...sense }) => sense);

          return {
            ...entry,
            romanization: romanize(entry.pronunciation || entry.word, {
              casingOption: 'lowercase',
              usePronunciationRules: true,
              useHyphen: false,
            }),
            senses,
          };
        })
        .filter((entry) => entry.senses.length > 0)
        .sort((left, right) => left.word < right.word ? -1 : left.word > right.word ? 1 : 0);

      return new Map(entries.map((entry) => [entry.word, entry]));
    },
  };
}
