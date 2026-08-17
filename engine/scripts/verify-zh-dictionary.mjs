import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCanonicalPinyinMetadata } from './generate-zh-pinyin-catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(engineRoot, 'src');
const supportedLengths = [4, 5, 6, 7, 8, 9];
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const canonicalKey = (value) => String(value ?? '')
  .normalize('NFC').toLowerCase().replace(/u:/gu, 'v').replace(/\u00fc/gu, 'v')
  .normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/\s+/gu, '');
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const dictionaryManifest = readJson(path.join(sourceDir, 'zhDictionary.generated.json'));
const pinyinManifest = readJson(path.join(sourceDir, 'zhPinyinIndex.generated.json'));
const hintClues = readJson(path.join(sourceDir, 'zhHintClues.seed.json'));
const seed = fs.readFileSync(path.join(sourceDir, 'zhAnswerWords.seed.txt'), 'utf8')
  .split(/\r?\n/u).map((word) => word.trim()).filter(Boolean);
const { CHINESE_PINYIN_PUZZLE_ANSWERS, PINYIN_PUZZLE_VARIANT } = await import(new URL('../dist/chineseLexicon.js', import.meta.url));
const { ZH_PINYIN_GUESS_KEYS_BY_LENGTH } = await import(new URL('../dist/zhPinyinGuessKeys.generated.js', import.meta.url));
const { ZH_PINYIN_SYLLABLES } = await import(new URL('../dist/zhPinyinSyllables.generated.js', import.meta.url));

assert.equal(seed.length, 64, 'Chinese answer seed must contain exactly 64 words');
assert.equal(new Set(seed).size, seed.length, 'Chinese answer seed contains duplicates');
assert.equal(PINYIN_PUZZLE_VARIANT, 'pinyin-latin-v2', 'Chinese Pinyin puzzle variant drifted');
assert.equal(dictionaryManifest.metadata?.license, 'Creative Commons Attribution-ShareAlike 4.0 International');
assert.match(dictionaryManifest.metadata?.sourceSha256 ?? '', /^[0-9a-f]{64}$/u);
assert.equal(pinyinManifest.metadata?.sourceSha256, dictionaryManifest.metadata.sourceSha256);
assert.deepEqual(Object.keys(hintClues).sort(compare), [...seed].sort(compare), 'Chinese broad-meaning clues diverged from the answer seed');

const entries = Object.assign({}, ...dictionaryManifest.shards.map((id) => (
  readJson(path.join(sourceDir, 'zhDictionaryShards', `${id}.json`)).entries ?? {}
)));
const candidatesByKey = Object.assign({}, ...pinyinManifest.shards.map((id) => (
  readJson(path.join(sourceDir, 'zhPinyinShards', `${id}.json`)).candidates ?? {}
)));
assert.equal(Object.keys(entries).length, dictionaryManifest.entryCount, 'Chinese dictionary shard count diverged');
assert.equal(Object.keys(candidatesByKey).length, pinyinManifest.keyCount, 'Chinese pinyin shard count diverged');

for (const [word, entry] of Object.entries(entries)) {
  assert.equal(Array.from(word).length, 2, `Chinese guess is not two characters: ${word}`);
  assert(Array.from(word).every((unit) => /^\p{Script=Han}$/u.test(unit)), `Chinese guess contains non-Han unit: ${word}`);
  assert.equal(entry.guessEligible, true, `Chinese entry is not guess eligible: ${word}`);
  assert(entry.pronunciations.length > 0, `Chinese entry lacks pinyin: ${word}`);
  for (const pronunciation of entry.pronunciations) {
    assert.equal(pronunciation.tones.length, 2, `Chinese pronunciation lacks two tones: ${word}`);
    const key = canonicalKey(pronunciation.pinyinPlain);
    assert(candidatesByKey[key]?.some((candidate) => candidate.word === word && candidate.pinyinNumeric === pronunciation.pinyinNumeric), `Chinese pinyin candidate missing: ${word}`);
  }
}

const expectedKeysByLength = Object.fromEntries(supportedLengths.map((length) => [
  length,
  [...new Set(Object.keys(candidatesByKey).map(canonicalKey).filter((key) => key.length === length))].sort(compare),
]));
for (const length of supportedLengths) {
  const keys = ZH_PINYIN_GUESS_KEYS_BY_LENGTH[length];
  assert(keys, `Chinese Pinyin key shard missing for length ${length}`);
  assert.deepEqual([...keys], expectedKeysByLength[length], `Chinese Pinyin key shard diverged for length ${length}`);
  assert.equal(new Set(keys).size, keys.length, `Chinese Pinyin key shard contains duplicates for length ${length}`);
}
assert(candidatesByKey.aiyou?.length > 1, 'Expected checked-in homophone fixture for aiyou is missing');
assert.deepEqual(ZH_PINYIN_GUESS_KEYS_BY_LENGTH[5].filter((key) => key === 'aiyou'), ['aiyou'], 'Homophonous dictionary entries must produce one playable key');
assert(ZH_PINYIN_SYLLABLES.includes('nv'), 'Generated syllable grammar must preserve v for umlaut-u');

assert.equal(CHINESE_PINYIN_PUZZLE_ANSWERS.length, 64, 'Chinese Pinyin answer catalog must contain exactly 64 answers');
assert.equal(new Set(CHINESE_PINYIN_PUZZLE_ANSWERS.map((answer) => answer.key)).size, 64, 'Chinese Pinyin answer keys must be unique');
assert.deepEqual(CHINESE_PINYIN_PUZZLE_ANSWERS.reduce((distribution, answer) => {
  distribution[answer.length] = (distribution[answer.length] ?? 0) + 1;
  return distribution;
}, {}), { 4: 6, 5: 15, 6: 14, 7: 20, 8: 7, 9: 2 }, 'Chinese Pinyin answer length distribution drifted');
for (const answer of CHINESE_PINYIN_PUZZLE_ANSWERS) {
  const entry = entries[answer.id];
  assert(entry, `Chinese answer missing dictionary entry: ${answer.id}`);
  assert.equal(answer.id, answer.hanzi, `Chinese answer ID must remain canonical Hanzi: ${answer.id}`);
  assert.equal(answer.answerEligible, true, `Chinese answer is not marked eligible: ${answer.id}`);
  const pronunciation = entry.pronunciations[0];
  assert(pronunciation, `Chinese answer lacks pronunciation: ${answer.id}`);
  assertCanonicalPinyinMetadata({
    numeric: pronunciation.pinyinNumeric.trim().split(/\s+/u),
    marked: pronunciation.pinyinMarked.trim().split(/\s+/u),
    plain: pronunciation.pinyinPlain.trim().split(/\s+/u).map(canonicalKey),
    tones: pronunciation.tones,
    word: answer.id,
  });
  assert.equal(answer.pinyinNumeric, pronunciation.pinyinNumeric, `Chinese numeric Pinyin drifted: ${answer.id}`);
  assert.equal(answer.pinyinMarked, pronunciation.pinyinMarked, `Chinese marked Pinyin drifted: ${answer.id}`);
  assert.deepEqual([...answer.tones], pronunciation.tones, `Chinese tones drifted: ${answer.id}`);
  assert.equal(answer.key, canonicalKey(pronunciation.pinyinPlain), `Chinese playable key drifted: ${answer.id}`);
  assert.equal(answer.length, answer.key.length, `Chinese Pinyin length drifted: ${answer.id}`);
  assert(answer.syllableBoundary > 0 && answer.syllableBoundary < answer.length, `Chinese Pinyin boundary is invalid: ${answer.id}`);
  assert.equal(answer.syllableBoundary, canonicalKey(pronunciation.pinyinPlain.split(/\s+/u)[0]).length, `Chinese Pinyin boundary drifted: ${answer.id}`);
  assert.equal(answer.broadMeaning, hintClues[answer.id].trim(), `Chinese broad meaning drifted: ${answer.id}`);
  assert(ZH_PINYIN_GUESS_KEYS_BY_LENGTH[answer.length].includes(answer.key), `Chinese answer missing accepted Pinyin guess key: ${answer.id}`);
}

process.stdout.write(`Verified Chinese dictionary and Pinyin catalog: ${Object.keys(entries).length} accepted guesses, ${CHINESE_PINYIN_PUZZLE_ANSWERS.length} answers, ${Object.keys(candidatesByKey).length} Pinyin keys\n`);
