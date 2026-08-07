import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(__dirname, '..');
const pinyinKey = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/u:/gu, 'v')
  .replace(/ü/gu, 'v')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/gu, '')
  .replace(/[^a-zv]/gu, '');
const pinyinInitial = (value) => {
  const syllable = pinyinKey(value);
  const digraph = ['zh', 'ch', 'sh'].find((initial) => syllable.startsWith(initial));
  if (digraph) return digraph;
  return /^[bpmfdtnlgkhjqxrzcsyw]/u.test(syllable) ? syllable[0] : '∅';
};
const dictionaryManifest = JSON.parse(fs.readFileSync(path.join(engineRoot, 'src', 'zhDictionary.generated.json'), 'utf8'));
const pinyinManifest = JSON.parse(fs.readFileSync(path.join(engineRoot, 'src', 'zhPinyinIndex.generated.json'), 'utf8'));
const hintClues = JSON.parse(fs.readFileSync(path.join(engineRoot, 'src', 'zhHintClues.seed.json'), 'utf8'));
const { ZH_HINT_METADATA } = await import(new URL('../dist/zhHintMetadata.generated.js', import.meta.url));
const seed = fs.readFileSync(path.join(engineRoot, 'src', 'zhAnswerWords.seed.txt'), 'utf8')
  .split(/\r?\n/u).map((word) => word.trim()).filter(Boolean);

assert.equal(seed.length, 64, 'Chinese answer seed must contain exactly 64 words');
assert.equal(new Set(seed).size, seed.length, 'Chinese answer seed contains duplicates');
assert.equal(dictionaryManifest.metadata?.license, 'Creative Commons Attribution-ShareAlike 4.0 International');
assert.match(dictionaryManifest.metadata?.sourceSha256 ?? '', /^[0-9a-f]{64}$/u);
assert.equal(pinyinManifest.metadata?.sourceSha256, dictionaryManifest.metadata.sourceSha256);
assert.deepEqual(Object.keys(hintClues).sort(), [...seed].sort(), 'Chinese hint clues diverged from the answer seed');
assert.deepEqual(Object.keys(ZH_HINT_METADATA).sort(), [...seed].sort(), 'Generated Chinese hint metadata diverged from the answer seed');

const entries = Object.assign({}, ...dictionaryManifest.shards.map((id) => (
  JSON.parse(fs.readFileSync(path.join(engineRoot, 'src', 'zhDictionaryShards', `${id}.json`), 'utf8')).entries ?? {}
)));
const candidatesByKey = Object.assign({}, ...pinyinManifest.shards.map((id) => (
  JSON.parse(fs.readFileSync(path.join(engineRoot, 'src', 'zhPinyinShards', `${id}.json`), 'utf8')).candidates ?? {}
)));
assert.equal(Object.keys(entries).length, dictionaryManifest.entryCount, 'Chinese dictionary shard count diverged');
assert.equal(Object.keys(candidatesByKey).length, pinyinManifest.keyCount, 'Chinese pinyin shard count diverged');
for (const word of seed) {
  assert(entries[word], `Chinese answer missing dictionary entry: ${word}`);
  assert.equal(entries[word].answerEligible, true, `Chinese answer not marked eligible: ${word}`);
  const hint = ZH_HINT_METADATA[word];
  const pronunciation = entries[word].pronunciations[0];
  assert(hint, `Chinese answer missing hint metadata: ${word}`);
  assert.deepEqual(
    [...hint.pinyinInitials],
    pronunciation.pinyinPlain.trim().split(/\s+/u).map(pinyinInitial),
    `Chinese hint pinyin initials are not canonical: ${word}`,
  );
  assert(!candidatesByKey[pinyinKey(hint.pinyinInitials.join(' '))], `Chinese pinyin initials form an enterable candidate key: ${word}`);
  assert.deepEqual([...hint.tones], pronunciation.tones, `Chinese hint tones are not canonical: ${word}`);
  assert.equal(hint.meaning, hintClues[word].trim(), `Chinese broad-meaning clue diverged: ${word}`);
  assert.equal(hint.firstCharacter, Array.from(word)[0], `Chinese first-character hint diverged: ${word}`);
  assert(!/\p{Script=Han}/u.test(hint.meaning), `Chinese broad-meaning clue exposes Hanzi: ${word}`);
  assert(!pinyinKey(hint.meaning).includes(pinyinKey(pronunciation.pinyinMarked)), `Chinese broad-meaning clue exposes pinyin: ${word}`);
  assert(hint.tones.every((tone) => Number.isInteger(tone) && tone >= 1 && tone <= 5), `Chinese hint has malformed tones: ${word}`);
}

for (const [word, entry] of Object.entries(entries)) {
  assert.equal(Array.from(word).length, 2, `Chinese guess is not two characters: ${word}`);
  assert(Array.from(word).every((unit) => /^\p{Script=Han}$/u.test(unit)), `Chinese guess contains non-Han unit: ${word}`);
  assert.deepEqual(entry.units, Array.from(word), `Chinese units diverge: ${word}`);
  assert(entry.guessEligible, `Chinese entry is not guess eligible: ${word}`);
  assert(entry.pronunciations.length > 0, `Chinese entry lacks pinyin: ${word}`);
  assert(entry.translations.length > 0, `Chinese entry lacks translations: ${word}`);
  for (const pronunciation of entry.pronunciations) {
    assert.equal(pronunciation.tones.length, 2, `Chinese pronunciation lacks two tones: ${word}`);
    assert(pronunciation.pinyinMarked && pronunciation.pinyinPlain && pronunciation.pinyinNumeric, `Chinese pronunciation incomplete: ${word}`);
    const key = pronunciation.pinyinPlain.replace(/\s+/gu, '').replace(/ü/gu, 'v');
    assert(candidatesByKey[key]?.some((candidate) => candidate.word === word && candidate.pinyinNumeric === pronunciation.pinyinNumeric), `Chinese pinyin candidate missing: ${word}`);
  }
}

process.stdout.write(`Verified Chinese dictionary: ${Object.keys(entries).length} accepted guesses, ${seed.length} answers, ${Object.keys(candidatesByKey).length} pinyin keys\n`);
