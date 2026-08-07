import { getChineseDictionaryShardId } from '../../engine/src/chineseDictionary.ts';
import { findChinesePinyinCandidates, normalizePinyin } from '../../engine/src/pinyin.ts';
import dictionaryManifest from '../../engine/src/zhDictionary.generated.json';

const dictionaryModules = import.meta.glob('../../engine/src/zhDictionaryShards/*.json');
const pinyinModules = import.meta.glob('../../engine/src/zhPinyinShards/*.json');
const dictionaryShardPromises = new Map();
const pinyinShardPromises = new Map();
const loadedEntries = new Map();

export const chineseDictionaryMetadata = dictionaryManifest.metadata;

function getModuleLoader(modules, suffix) {
  return Object.entries(modules).find(([path]) => path.endsWith(suffix))?.[1] ?? null;
}

async function loadDictionaryShard(id) {
  if (!dictionaryShardPromises.has(id)) {
    const loader = getModuleLoader(dictionaryModules, `/zhDictionaryShards/${id}.json`);
    if (!loader) throw new Error(`Chinese dictionary shard is unavailable: ${id}`);
    dictionaryShardPromises.set(id, loader().then((module) => module.default ?? module));
  }
  const shard = await dictionaryShardPromises.get(id);
  Object.entries(shard.entries ?? {}).forEach(([word, entry]) => loadedEntries.set(word, entry));
  return shard;
}

export async function loadChineseDictionaryEntry(word) {
  const normalized = String(word ?? '').normalize('NFC');
  if (!normalized) return null;
  if (loadedEntries.has(normalized)) return loadedEntries.get(normalized);
  const shard = await loadDictionaryShard(getChineseDictionaryShardId(normalized));
  return shard.entries?.[normalized] ?? null;
}

export async function loadChineseDictionaryEntries(words) {
  const normalized = [...new Set((words ?? []).map((word) => String(word ?? '').normalize('NFC')).filter(Boolean))];
  await Promise.all([...new Set(normalized.map((word) => getChineseDictionaryShardId(word)))].map(loadDictionaryShard));
  return Object.fromEntries(normalized.map((word) => [word, loadedEntries.get(word)]).filter(([, entry]) => entry));
}

export function getLoadedChineseDictionaryEntry(word) {
  return loadedEntries.get(String(word ?? '').normalize('NFC')) ?? null;
}

export async function loadChinesePinyinCandidates(input) {
  const key = normalizePinyin(input);
  if (!key) return [];
  const id = /^[a-z]/u.test(key) ? key[0] : '_';
  if (!pinyinShardPromises.has(id)) {
    const loader = getModuleLoader(pinyinModules, `/zhPinyinShards/${id}.json`);
    if (!loader) throw new Error(`Chinese pinyin shard is unavailable: ${id}`);
    pinyinShardPromises.set(id, loader().then((module) => module.default ?? module));
  }
  const shard = await pinyinShardPromises.get(id);
  return findChinesePinyinCandidates(input, shard);
}

export function getPrimaryChinesePronunciation(entry) {
  return entry?.pronunciations?.[0] ?? null;
}
