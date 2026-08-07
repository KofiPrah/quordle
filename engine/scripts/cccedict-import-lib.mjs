const HAN_RE = /^\p{Script=Han}$/u;
const PINYIN_SYLLABLE_RE = /^[a-z]+(?::)?[1-5]$/u;
const REFERENCE_ONLY_RE = /^(?:(?:old |archaic )?variant of|old form of|archaic form of|see(?: also)? |surname |given name|proper name|name of |classifier(?: for)?|CL:)/iu;

const TONE_MARKS = {
  a: ['a', 'ā', 'á', 'ǎ', 'à'],
  e: ['e', 'ē', 'é', 'ě', 'è'],
  i: ['i', 'ī', 'í', 'ǐ', 'ì'],
  o: ['o', 'ō', 'ó', 'ǒ', 'ò'],
  u: ['u', 'ū', 'ú', 'ǔ', 'ù'],
  v: ['ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

function normalizeUmlaut(value) {
  return value.toLowerCase().replace(/u:/gu, 'v').replace(/ü/gu, 'v');
}

export function numericSyllableToMarked(input) {
  const match = /^([a-z]+(?::)?)([1-5])$/u.exec(String(input ?? '').trim().toLowerCase());
  if (!match) return '';
  const tone = Number(match[2]);
  const syllable = normalizeUmlaut(match[1]);
  if (tone === 5) return syllable.replace(/v/gu, 'ü');
  const vowels = [...syllable]
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => ['a', 'e', 'i', 'o', 'u', 'v'].includes(character));
  if (vowels.length === 0) return syllable;
  let markIndex = vowels[vowels.length - 1].index;
  const a = vowels.find(({ character }) => character === 'a');
  const e = vowels.find(({ character }) => character === 'e');
  const ou = syllable.indexOf('ou');
  if (a) markIndex = a.index;
  else if (e) markIndex = e.index;
  else if (ou >= 0) markIndex = ou;
  const chars = [...syllable];
  chars[markIndex] = TONE_MARKS[chars[markIndex]]?.[tone] ?? chars[markIndex];
  return chars.join('').replace(/v/gu, 'ü');
}

function syllableToPlain(input) {
  return normalizeUmlaut(input.replace(/[1-5]$/u, '')).replace(/v/gu, 'ü');
}

function parseTone(input) {
  const match = /([1-5])$/u.exec(input);
  return Number(match?.[1] ?? 5);
}

export function parseCedictLine(line) {
  const match = /^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.*)\/$/u.exec(String(line ?? '').trim());
  if (!match) return null;
  const [, traditional, simplified, pinyin, meanings] = match;
  const syllables = pinyin.trim().split(/\s+/u);
  const senses = meanings
    .split('/')
    .map((sense) => sense.trim())
    .filter(Boolean)
    .map((sense) => sense.split(';').map((gloss) => gloss.trim()).filter(Boolean))
    .filter((glosses) => glosses.length > 0);
  return { traditional, simplified, pinyin, syllables, senses };
}

export function isAcceptedCedictEntry(entry) {
  if (!entry) return false;
  const units = Array.from(entry.simplified.normalize('NFC'));
  if (units.length !== 2 || !units.every((unit) => HAN_RE.test(unit))) return false;
  if (entry.syllables.length !== 2 || !entry.syllables.every((syllable) => PINYIN_SYLLABLE_RE.test(syllable))) return false;
  if (entry.pinyin !== entry.pinyin.toLowerCase()) return false;
  const flattened = entry.senses.flat().filter(Boolean);
  if (flattened.length === 0) return false;
  if (flattened.every((gloss) => REFERENCE_ONLY_RE.test(gloss) || /\((?:archaic|old)\)/iu.test(gloss))) return false;
  return true;
}

function uniqueSorted(values, locale = 'en') {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, locale));
}

export function buildChineseSnapshots(text, answerWords, sourceSha256) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const sourceUpdatedAt = lines
    .find((line) => line.startsWith('#! date='))
    ?.slice('#! date='.length)
    .trim();
  if (!sourceUpdatedAt) throw new Error('CC-CEDICT source date metadata is missing');

  const entries = new Map();
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const parsed = parseCedictLine(line);
    if (!isAcceptedCedictEntry(parsed)) continue;
    const word = parsed.simplified.normalize('NFC');
    const current = entries.get(word) ?? {
      word,
      normalized: word,
      display: word,
      simplified: word,
      traditional: new Set(),
      units: Array.from(word),
      pronunciations: new Map(),
      senses: new Map(),
      translations: new Set(),
      answerEligible: false,
      guessEligible: true,
    };
    current.traditional.add(parsed.traditional.normalize('NFC'));
    const pinyinNumeric = parsed.syllables.join(' ');
    current.pronunciations.set(pinyinNumeric, {
      pinyinNumeric,
      pinyinMarked: parsed.syllables.map(numericSyllableToMarked).join(' '),
      pinyinPlain: parsed.syllables.map(syllableToPlain).join(' '),
      tones: parsed.syllables.map(parseTone),
    });
    for (const glosses of parsed.senses) {
      const key = glosses.join('\u0000');
      current.senses.set(key, { glosses });
      glosses.forEach((gloss) => current.translations.add(gloss));
    }
    entries.set(word, current);
  }

  const answerRank = new Map(answerWords.map((word, index) => [word, index]));
  for (const word of answerWords) {
    const entry = entries.get(word);
    if (!entry) throw new Error(`Chinese answer seed missing from accepted CC-CEDICT entries: ${word}`);
    entry.answerEligible = true;
  }

  const metadata = {
    source: 'CC-CEDICT',
    notice: 'Chinese dictionary text derived from CC-CEDICT; attribution and share-alike license apply.',
    dictionaryUrl: 'https://www.mdbg.net/chinese/dictionary?page=cc-cedict',
    license: 'Creative Commons Attribution-ShareAlike 4.0 International',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceMode: 'official-editor-v1-export',
    sourceUpdatedAt,
    sourceSha256,
  };

  const dictionaryEntries = {};
  const guessWords = [...entries.keys()].sort((left, right) => left.localeCompare(right, 'zh-Hans'));
  const candidateIndex = {};
  for (const word of guessWords) {
    const entry = entries.get(word);
    const pronunciations = [...entry.pronunciations.values()]
      .sort((left, right) => left.pinyinNumeric.localeCompare(right.pinyinNumeric, 'en'));
    dictionaryEntries[word] = {
      ...entry,
      traditional: uniqueSorted(entry.traditional, 'zh-Hant'),
      pronunciations,
      senses: [...entry.senses.values()],
      translations: [...entry.translations],
    };
    for (const pronunciation of pronunciations) {
      const key = pronunciation.pinyinPlain.replace(/\s+/gu, '').replace(/ü/gu, 'v');
      candidateIndex[key] ??= [];
      candidateIndex[key].push({
        word,
        pinyinNumeric: pronunciation.pinyinNumeric,
        pinyinMarked: pronunciation.pinyinMarked,
        pinyinPlain: pronunciation.pinyinPlain,
        answerRank: answerRank.get(word) ?? null,
      });
    }
  }

  for (const candidates of Object.values(candidateIndex)) {
    candidates.sort((left, right) => {
      const leftRank = left.answerRank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.answerRank ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank
        || left.word.localeCompare(right.word, 'zh-Hans')
        || left.pinyinNumeric.localeCompare(right.pinyinNumeric, 'en');
    });
  }

  return {
    metadata,
    dictionary: { metadata, entries: dictionaryEntries },
    pinyinIndex: { metadata, candidates: candidateIndex },
    answerWords: [...answerWords],
    guessWords,
  };
}
