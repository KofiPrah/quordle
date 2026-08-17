import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const defaultEngineRoot = path.resolve(path.dirname(modulePath), '..');
const SUPPORTED_LENGTHS = [4, 5, 6, 7, 8, 9];

const json = (value) => JSON.stringify(value, null, 2);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const canonicalKey = (value) => String(value ?? '')
  .normalize('NFC')
  .toLowerCase()
  .replace(/u:/gu, 'v')
  .replace(/\u00fc/gu, 'v')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/gu, '')
  .replace(/\s+/gu, '');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readDictionaryEntries(sourceDir) {
  const manifest = readJson(path.join(sourceDir, 'zhDictionary.generated.json'));
  return Object.assign({}, ...manifest.shards.map((id) => (
    readJson(path.join(sourceDir, 'zhDictionaryShards', `${id}.json`)).entries ?? {}
  )));
}

function readPinyinCandidates(sourceDir) {
  const manifest = readJson(path.join(sourceDir, 'zhPinyinIndex.generated.json'));
  return Object.assign({}, ...manifest.shards.map((id) => (
    readJson(path.join(sourceDir, 'zhPinyinShards', `${id}.json`)).candidates ?? {}
  )));
}

function pinyinSyllables(pronunciation, word) {
  const numeric = String(pronunciation?.pinyinNumeric ?? '').trim().split(/\s+/u);
  const marked = String(pronunciation?.pinyinMarked ?? '').trim().split(/\s+/u);
  const plain = String(pronunciation?.pinyinPlain ?? '').trim().split(/\s+/u);
  const tones = pronunciation?.tones;
  if (numeric.length !== 2 || marked.length !== 2 || plain.length !== 2
    || !Array.isArray(tones) || tones.length !== 2
    || !tones.every((tone) => Number.isInteger(tone) && tone >= 1 && tone <= 5)) {
    throw new Error(`Chinese answer is missing a canonical two-syllable pronunciation: ${word}`);
  }
  const first = canonicalKey(plain[0]);
  const second = canonicalKey(plain[1]);
  if (!/^[a-z]+$/u.test(first) || !/^[a-z]+$/u.test(second)) {
    throw new Error(`Chinese answer has malformed Pinyin syllables: ${word}`);
  }
  return { numeric: numeric.join(' '), marked: marked.join(' '), first, second, tones: [tones[0], tones[1]] };
}

export function generateChinesePinyinCatalog({ engineRoot = defaultEngineRoot, quiet = false } = {}) {
  const sourceDir = path.join(engineRoot, 'src');
  const seedWords = fs.readFileSync(path.join(sourceDir, 'zhAnswerWords.seed.txt'), 'utf8')
    .split(/\r?\n/u).map((word) => word.trim()).filter(Boolean);
  const clues = readJson(path.join(sourceDir, 'zhHintClues.seed.json'));
  const entries = readDictionaryEntries(sourceDir);
  const candidatesByKey = readPinyinCandidates(sourceDir);
  if (seedWords.length !== 64 || new Set(seedWords).size !== seedWords.length) {
    throw new Error('Chinese answer seed must contain exactly 64 unique words');
  }
  const clueWords = Object.keys(clues);
  if (seedWords.some((word) => typeof clues[word] !== 'string') || clueWords.some((word) => !seedWords.includes(word))) {
    throw new Error('Chinese broad-meaning clues diverge from the answer seed');
  }

  const keysByLength = Object.fromEntries(SUPPORTED_LENGTHS.map((length) => [length, []]));
  const syllables = new Set();
  for (const [candidateKey, candidates] of Object.entries(candidatesByKey)) {
    const key = canonicalKey(candidateKey);
    if (!/^[a-z]+$/u.test(key)) throw new Error(`Chinese pinyin index has an invalid playable key: ${candidateKey}`);
    for (const candidate of candidates) {
      const parts = String(candidate.pinyinPlain ?? '').trim().split(/\s+/u).map(canonicalKey);
      if (parts.length === 2 && parts.every((part) => /^[a-z]+$/u.test(part))) parts.forEach((part) => syllables.add(part));
    }
    if (SUPPORTED_LENGTHS.includes(key.length)) keysByLength[key.length].push(key);
  }
  for (const length of SUPPORTED_LENGTHS) {
    keysByLength[length] = [...new Set(keysByLength[length])].sort(compare);
  }

  const answers = [];
  const answerKeys = new Set();
  for (const word of seedWords) {
    const entry = entries[word];
    if (!entry?.answerEligible || !entry.guessEligible) {
      throw new Error(`Chinese answer missing from accepted dictionary entries: ${word}`);
    }
    const pronunciation = pinyinSyllables(entry.pronunciations?.[0], word);
    const key = `${pronunciation.first}${pronunciation.second}`;
    const length = key.length;
    if (!SUPPORTED_LENGTHS.includes(length)) throw new Error(`Chinese answer has unsupported Pinyin length: ${word} (${length})`);
    const syllableBoundary = pronunciation.first.length;
    if (!Number.isInteger(syllableBoundary) || syllableBoundary <= 0 || syllableBoundary >= length) {
      throw new Error(`Chinese answer has an invalid syllable boundary: ${word}`);
    }
    if (answerKeys.has(key)) throw new Error(`Chinese answers have a duplicate playable Pinyin key: ${key}`);
    if (!keysByLength[length].includes(key)) throw new Error(`Chinese answer is missing from accepted Pinyin guess keys: ${word}`);
    const broadMeaning = clues[word].trim();
    if (!broadMeaning || /\p{Script=Han}/u.test(broadMeaning)) throw new Error(`Chinese answer has an invalid broad meaning: ${word}`);
    answerKeys.add(key);
    answers.push({
      id: word,
      hanzi: word,
      key,
      pinyinMarked: pronunciation.marked,
      pinyinNumeric: pronunciation.numeric,
      tones: pronunciation.tones,
      syllableBoundary,
      broadMeaning,
      length,
      answerEligible: true,
    });
  }

  const answerOutput = `// Generated by scripts/generate-zh-pinyin-catalog.mjs. Do not edit by hand.\n`
    + `export const ZH_PINYIN_PUZZLE_ANSWERS = ${json(answers)} as const;\n`;
  fs.writeFileSync(path.join(sourceDir, 'zhPinyinPuzzleCatalog.generated.ts'), answerOutput);

  const shardDir = path.join(sourceDir, 'zhPinyinGuessKeyShards');
  fs.mkdirSync(shardDir, { recursive: true });
  for (const length of SUPPORTED_LENGTHS) {
    const shardOutput = `// Generated by scripts/generate-zh-pinyin-catalog.mjs. Do not edit by hand.\n`
      + `export const ZH_PINYIN_GUESS_KEYS_${length}: readonly string[] = ${json(keysByLength[length])};\n`;
    fs.writeFileSync(path.join(shardDir, `${length}.generated.ts`), shardOutput);
  }
  const aggregateImports = SUPPORTED_LENGTHS.map((length) => (
    `import { ZH_PINYIN_GUESS_KEYS_${length} } from './zhPinyinGuessKeyShards/${length}.generated.js';`
  )).join('\n');
  const aggregateOutput = `// Generated by scripts/generate-zh-pinyin-catalog.mjs. Do not edit by hand.\n${aggregateImports}\n\n`
    + `export const ZH_PINYIN_GUESS_KEYS_BY_LENGTH: Readonly<Record<number, readonly string[]>> = {\n`
    + SUPPORTED_LENGTHS.map((length) => `  ${length}: ZH_PINYIN_GUESS_KEYS_${length},`).join('\n')
    + `\n};\n\n`
    + `export function isValidChinesePinyinGuessKey(key: string, length = key.length): boolean {\n`
    + `  return ZH_PINYIN_GUESS_KEYS_BY_LENGTH[length]?.includes(key) ?? false;\n}\n`;
  fs.writeFileSync(path.join(sourceDir, 'zhPinyinGuessKeys.generated.ts'), aggregateOutput);
  const syllableOutput = `// Generated by scripts/generate-zh-pinyin-catalog.mjs. Do not edit by hand.\n`
    + `export const ZH_PINYIN_SYLLABLES: readonly string[] = ${json([...syllables].sort(compare))};\n`;
  fs.writeFileSync(path.join(sourceDir, 'zhPinyinSyllables.generated.ts'), syllableOutput);
  if (!quiet) process.stdout.write(`Generated Chinese Pinyin catalog: ${answers.length} answers and ${Object.values(keysByLength).reduce((total, keys) => total + keys.length, 0)} guess keys\n`);
  return { answers, keysByLength, syllables: [...syllables].sort(compare) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) generateChinesePinyinCatalog();
