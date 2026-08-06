import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import {
  KRDICT_DICTIONARY_URL,
  KRDICT_LICENSE,
  KRDICT_LICENSE_URL,
  KRDICT_SOURCE_NAME,
  createDictionaryCollector,
  isEligibleKoreanWord,
  parseApiSearchXml,
  parseBulkLexicalEntry,
  parseBulkRecognitionEntry,
  sanitizeProviderError,
} from './krdict-import-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(scriptDir, '..');
const srcDir = path.join(engineDir, 'src');
const BULK_DOWNLOAD_PAGE = 'https://krdict.korean.go.kr/download/downloadPopup';
const dictionaryPath = path.join(srcDir, 'koDictionary.generated.json');
const recognitionPath = path.join(srcDir, 'koWordRecognition.generated.json');
const hintMetadataPath = path.join(srcDir, 'koHintMetadata.generated.ts');
const LEVEL_RANK = Object.freeze({
  ungraded: 0,
  advanced: 1,
  intermediate: 2,
  beginner: 3,
});

function parseArgs(argv) {
  const args = { bulkArchive: null, downloadBulk: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--bulk-archive') {
      args.bulkArchive = argv[index + 1];
      index += 1;
    } else if (argument === '--download-bulk') {
      args.downloadBulk = true;
    } else if (!argument.startsWith('-') && !args.bulkArchive) {
      // npm may consume the named flag and forward only its value on Windows.
      args.bulkArchive = argument;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return args;
}

function readWordLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((word) => word.trim().normalize('NFC'))
    .filter(isEligibleKoreanWord);
}

function readQuotedWords(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  return [...source.matchAll(/'([^']+)'/gu)]
    .map((match) => match[1].normalize('NFC'))
    .filter(isEligibleKoreanWord);
}

export function loadCandidateMembership() {
  const engineAnswers = readWordLines(path.join(srcDir, 'koWords.txt'));
  const engineGuesses = readWordLines(path.join(srcDir, 'koGuessWords.txt'));
  const serverDailyAnswers = readQuotedWords(path.join(scriptDir, 'server_ko_list.txt'));
  const answerWords = new Set([...engineAnswers, ...serverDailyAnswers]);
  const guessWords = new Set([...engineGuesses, ...answerWords]);
  const membership = new Map();

  for (const word of guessWords) {
    membership.set(word, {
      answerEligible: answerWords.has(word),
      guessEligible: true,
    });
  }
  return membership;
}

async function downloadBulkArchive() {
  const pageResponse = await fetch(BULK_DOWNLOAD_PAGE);
  if (!pageResponse.ok) {
    throw new Error(`Unable to discover KRDICT bulk download: HTTP ${pageResponse.status}`);
  }
  const html = await pageResponse.text();
  const jsonButton = [...html.matchAll(
    /<button\b[^>]*onclick="batchDownload\('([^']+)'\)"[^>]*>([\s\S]*?)<\/button>/gu,
  )].find((match) => /Json/iu.test(match[2]));
  if (!jsonButton) throw new Error('Unable to locate KRDICT JSON bulk download');

  const archiveUrl = new URL(`/dicBatchDownload?seq=${encodeURIComponent(jsonButton[1])}`, BULK_DOWNLOAD_PAGE);
  const archiveResponse = await fetch(archiveUrl);
  if (!archiveResponse.ok) {
    throw new Error(`Unable to download KRDICT JSON archive: HTTP ${archiveResponse.status}`);
  }

  const archivePath = path.join(os.tmpdir(), `krdict-${jsonButton[1]}.zip`);
  fs.writeFileSync(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
  return archivePath;
}

function sourceDateFromDocument(document) {
  const features = document?.LexicalResource?.GlobalInformation?.feat;
  const creation = (Array.isArray(features) ? features : [features])
    .find((feature) => feature?.att === 'creationDate')?.val;
  return creation ? String(creation) : undefined;
}

function collectBulkArchive(archivePath, membership, collector, recognitionWords) {
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries()
    .filter((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith('.json'))
    .sort((left, right) => left.entryName.localeCompare(right.entryName, 'en', { numeric: true }));
  if (entries.length === 0) throw new Error('KRDICT bulk archive contains no JSON files');

  let sourceUpdatedAt;
  for (const [index, archiveEntry] of entries.entries()) {
    const document = JSON.parse(archiveEntry.getData().toString('utf8'));
    sourceUpdatedAt ||= sourceDateFromDocument(document);
    const lexicalEntries = document?.LexicalResource?.Lexicon?.LexicalEntry;
    if (!Array.isArray(lexicalEntries)) {
      throw new Error(`Missing LexicalEntry array in ${archiveEntry.entryName}`);
    }
    for (const entry of lexicalEntries) {
      const recognition = parseBulkRecognitionEntry(entry);
      if (recognition) {
        const existingLevel = recognitionWords.get(recognition.word) ?? 'ungraded';
        if (LEVEL_RANK[recognition.level] > LEVEL_RANK[existingLevel] || !recognitionWords.has(recognition.word)) {
          recognitionWords.set(recognition.word, recognition.level);
        }
      }
      collector.add(parseBulkLexicalEntry(entry, membership));
    }
    process.stdout.write(`Processed KRDICT bulk file ${index + 1}/${entries.length}\n`);
  }
  return { mode: 'bulk-json', sourceUpdatedAt };
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error(sanitizeProviderError(lastError?.message || 'KRDICT request failed'));
}

async function collectApi(membership, collector) {
  const apiKey = process.env.KRDICT_API_KEY;
  if (!apiKey) throw new Error('KRDICT_API_KEY is required unless a bulk archive is supplied');
  const words = [...membership.keys()].sort();

  for (const [index, word] of words.entries()) {
    const url = new URL('https://krdict.korean.go.kr/api/search');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('q', word);
    url.searchParams.set('method', 'exact');
    url.searchParams.set('part', 'word');
    url.searchParams.set('translated', 'y');
    url.searchParams.set('trans_lang', '1');
    url.searchParams.set('num', '100');
    const xml = await fetchWithRetry(url);
    for (const record of parseApiSearchXml(xml, word)) collector.add(record);
    if ((index + 1) % 50 === 0 || index === words.length - 1) {
      process.stdout.write(`Processed KRDICT API word ${index + 1}/${words.length}\n`);
    }
  }
  return { mode: 'search-api' };
}

function renderLexiconModule(answerWords, guessWords, source) {
  return `/* This file is generated by scripts/generate-ko-dictionary.mjs. Do not edit manually. */\n` +
    `export const KOREAN_LEXICON_SOURCE = ${JSON.stringify(source, null, 2)} as const;\n\n` +
    `export const KO_ANSWER_WORDS: readonly string[] = ${JSON.stringify(answerWords, null, 2)};\n\n` +
    `export const KO_GUESS_WORDS_LIST: readonly string[] = ${JSON.stringify(guessWords, null, 2)};\n`;
}

function renderHintMetadataModule(dictionary) {
  const hintMetadata = Object.fromEntries([...dictionary.entries()]
    .filter(([, entry]) => entry.answerEligible)
    .map(([word, entry]) => [word, {
      partsOfSpeech: [...new Set(entry.senses.map((sense) => sense.partOfSpeech))].sort(),
      semanticCategories: entry.semanticCategories,
    }]));
  return '/* This file is generated by scripts/generate-ko-dictionary.mjs. Do not edit manually. */\n' +
    `export const KO_HINT_METADATA = ${JSON.stringify(hintMetadata, null, 2)} as const;\n`;
}

function loadExistingRecognitionSnapshot() {
  if (!fs.existsSync(recognitionPath)) {
    throw new Error('Korean recognition snapshot is missing; refresh with an official KRDICT bulk archive');
  }
  const snapshot = JSON.parse(fs.readFileSync(recognitionPath, 'utf8'));
  if (!snapshot?.metadata || !snapshot?.words || typeof snapshot.words !== 'object') {
    throw new Error('Korean recognition snapshot is malformed; refresh it from the KRDICT bulk archive');
  }
  return snapshot;
}

function retainExistingSemanticCategories(dictionary) {
  if (!fs.existsSync(dictionaryPath)) return dictionary;
  const snapshot = JSON.parse(fs.readFileSync(dictionaryPath, 'utf8'));
  for (const [word, entry] of dictionary) {
    if (entry.semanticCategories.length > 0) continue;
    const existing = snapshot?.entries?.[word]?.semanticCategories;
    if (Array.isArray(existing)) entry.semanticCategories = existing;
  }
  return dictionary;
}

function writeArtifacts(dictionary, membership, source, recognitionWords = null) {
  const entries = Object.fromEntries(dictionary);
  const resolvedWords = new Set(dictionary.keys());
  const answerWords = [...dictionary.values()]
    .filter((entry) => entry.answerEligible)
    .map((entry) => entry.word);
  const guessWords = [...dictionary.values()]
    .filter((entry) => entry.guessEligible)
    .map((entry) => entry.word);
  const unresolvedAnswers = [];
  const unresolvedGuesses = [];

  for (const [word, flags] of membership) {
    if (resolvedWords.has(word)) continue;
    if (flags.answerEligible) unresolvedAnswers.push(word);
    if (flags.guessEligible) unresolvedGuesses.push(word);
  }
  unresolvedAnswers.sort();
  unresolvedGuesses.sort();

  if (answerWords.length < 4) throw new Error('Fewer than four metadata-backed Korean answers remain');
  const metadata = {
    source: KRDICT_SOURCE_NAME,
    notice: `Dictionary text derived from ${KRDICT_SOURCE_NAME}; attribution and share-alike license apply.`,
    dictionaryUrl: KRDICT_DICTIONARY_URL,
    license: KRDICT_LICENSE,
    licenseUrl: KRDICT_LICENSE_URL,
    sourceMode: source.mode,
    ...(source.sourceUpdatedAt ? { sourceUpdatedAt: source.sourceUpdatedAt } : {}),
  };

  const recognitionSnapshot = recognitionWords
    ? {
        metadata,
        words: Object.fromEntries([...recognitionWords.entries()]
          .sort(([left], [right]) => left.localeCompare(right, 'ko'))),
      }
    : loadExistingRecognitionSnapshot();

  for (const word of guessWords) {
    if (!recognitionSnapshot.words[word]) {
      throw new Error(`Accepted guess missing from Korean recognition snapshot: ${word}. Refresh from the bulk archive.`);
    }
  }

  fs.writeFileSync(
    path.join(srcDir, 'koLexicon.generated.ts'),
    renderLexiconModule(answerWords, guessWords, metadata),
  );
  fs.writeFileSync(
    dictionaryPath,
    `${JSON.stringify({ metadata, entries }, null, 2)}\n`,
  );
  fs.writeFileSync(hintMetadataPath, renderHintMetadataModule(dictionary));
  fs.writeFileSync(
    path.join(srcDir, 'koDictionary.unresolved.json'),
    `${JSON.stringify({ metadata, unresolvedAnswers, unresolvedGuesses }, null, 2)}\n`,
  );
  if (recognitionWords) {
    fs.writeFileSync(
      recognitionPath,
      `${JSON.stringify(recognitionSnapshot, null, 2)}\n`,
    );
  }

  return {
    answers: answerWords.length,
    guesses: guessWords.length,
    entries: dictionary.size,
    recognizedWords: Object.keys(recognitionSnapshot.words).length,
    recognitionSourceMode: recognitionSnapshot.metadata.sourceMode,
    unresolvedAnswers: unresolvedAnswers.length,
    unresolvedGuesses: unresolvedGuesses.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const membership = loadCandidateMembership();
  const collector = createDictionaryCollector(membership);
  const recognitionWords = new Map();
  let archivePath = args.bulkArchive ? path.resolve(args.bulkArchive) : null;

  if (args.downloadBulk) archivePath = await downloadBulkArchive();
  if (archivePath && !fs.existsSync(archivePath)) {
    throw new Error(`Bulk archive not found: ${archivePath}`);
  }

  const source = archivePath
    ? collectBulkArchive(archivePath, membership, collector, recognitionWords)
    : await collectApi(membership, collector);
  const dictionary = collector.finalize();
  if (!archivePath) retainExistingSemanticCategories(dictionary);
  const summary = writeArtifacts(
    dictionary,
    membership,
    source,
    archivePath ? recognitionWords : null,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${sanitizeProviderError(error?.stack || error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
