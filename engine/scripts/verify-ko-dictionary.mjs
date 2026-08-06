import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dictionaryPath = path.join(engineDir, 'src', 'koDictionary.generated.json');
const dictionary = JSON.parse(fs.readFileSync(dictionaryPath, 'utf8'));
const recognition = JSON.parse(fs.readFileSync(
  path.join(engineDir, 'src', 'koWordRecognition.generated.json'),
  'utf8',
));
const unresolved = JSON.parse(fs.readFileSync(
  path.join(engineDir, 'src', 'koDictionary.unresolved.json'),
  'utf8',
));
const lexicon = await import(pathToFileURL(path.join(engineDir, 'dist', 'koLexicon.generated.js')));
const entries = dictionary.entries ?? {};
const answers = lexicon.KO_ANSWER_WORDS;
const guesses = lexicon.KO_GUESS_WORDS_LIST;
const guessSet = new Set(guesses);
const recognizedWords = recognition.words ?? {};
const recognizedLevels = new Set(['beginner', 'intermediate', 'advanced', 'ungraded']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(Array.isArray(answers) && answers.length >= 4, 'Korean answer list must contain at least four words');
assert(Array.isArray(guesses) && guesses.length >= answers.length, 'Korean guess list is invalid');
assert(new Set(answers).size === answers.length, 'Korean answer list contains duplicates');
assert(new Set(guesses).size === guesses.length, 'Korean guess list contains duplicates');
assert(Object.keys(entries).length === guesses.length, 'Dictionary and canonical guess list diverged');
assert(recognition.metadata?.source === dictionary.metadata?.source, 'Dictionary and recognition sources diverged');
assert(/^https:\/\/krdict\.korean\.go\.kr\//u.test(recognition.metadata?.dictionaryUrl ?? ''), 'Recognition source URL is invalid');
assert(recognition.metadata?.license === dictionary.metadata?.license, 'Recognition license metadata diverged');
assert(/^https:\/\//u.test(recognition.metadata?.licenseUrl ?? ''), 'Recognition license URL is invalid');
assert(
  Object.keys(recognizedWords).length > guesses.length,
  'Recognition snapshot must be broader than the accepted guess list',
);

let previousRecognizedWord = null;
for (const [word, level] of Object.entries(recognizedWords)) {
  assert(/^[\uAC00-\uD7A3]{2}$/u.test(word), `Malformed recognized Korean word: ${word}`);
  assert(recognizedLevels.has(level), `Malformed Korean vocabulary level for ${word}: ${level}`);
  if (previousRecognizedWord !== null) {
    assert(previousRecognizedWord.localeCompare(word, 'ko') < 0, 'Recognition snapshot is not sorted or contains duplicates');
  }
  previousRecognizedWord = word;
}

for (const word of guesses) {
  assert(/^[\uAC00-\uD7A3]{2}$/u.test(word), `Malformed Korean guess: ${word}`);
  assert(entries[word], `Missing dictionary metadata for accepted guess: ${word}`);
  assert(entries[word].guessEligible === true, `Guess eligibility mismatch: ${word}`);
  assert(recognizedWords[word], `Accepted guess missing from recognition snapshot: ${word}`);
  assert(entries[word].romanization, `Missing romanization: ${word}`);
  assert(Array.isArray(entries[word].senses) && entries[word].senses.length > 0, `Missing senses: ${word}`);
  for (const sense of entries[word].senses) {
    assert(sense.partOfSpeech, `Missing part of speech: ${word}`);
    assert(Array.isArray(sense.translations) && sense.translations.length > 0, `Missing translation: ${word}`);
    assert(sense.definition, `Missing definition: ${word}`);
    assert(Number.isInteger(sense.sourceTargetCode), `Malformed KRDICT target code: ${word}`);
    assert(/^https:\/\/krdict\.korean\.go\.kr\//u.test(sense.sourceUrl), `Malformed KRDICT source URL: ${word}`);
  }
}

for (const word of answers) {
  assert(guessSet.has(word), `Answer missing from guess list: ${word}`);
  assert(entries[word]?.answerEligible === true, `Answer eligibility mismatch: ${word}`);
}

for (const word of unresolved.unresolvedGuesses ?? []) {
  assert(!guessSet.has(word), `Unresolved word leaked into accepted guesses: ${word}`);
}
for (const word of unresolved.unresolvedAnswers ?? []) {
  assert(!answers.includes(word), `Unresolved word leaked into answers: ${word}`);
}

process.stdout.write(
  `Verified ${answers.length} Korean answers, ${guesses.length} accepted guesses, and ${Object.keys(recognizedWords).length} recognized words.\n`,
);
