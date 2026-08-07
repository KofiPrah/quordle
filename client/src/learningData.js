export const LEARNING_EVENT_VERSION = 1;
export const ANALYTICS_QUEUE_STORAGE_KEY = 'quordle_learning_events_v1';
export const LOCAL_SAVED_WORDS_KEY = 'quordle_saved_words_ko_v1';
export const LOCAL_SAVED_WORDS_MIGRATION_KEY = 'quordle_saved_words_ko_v1_imported';
export const LOCAL_SAVED_WORDS_KEYS = Object.freeze({
  ko: 'quordle_saved_words_ko_v2',
  zh: 'quordle_saved_words_zh_v2',
});

function hash32(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Create a deterministic RFC 9562 UUIDv8 for reconnect-safe UI event identity. */
export function createStableLearningEventId(value) {
  const input = String(value);
  const words = [
    hash32(input, 0x811c9dc5),
    hash32(input, 0x9e3779b9),
    hash32(input, 0x85ebca6b),
    hash32(input, 0xc2b2ae35),
  ];
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word));
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createOneTimeEventTracker() {
  const claimed = new Set();
  return {
    claim(key) {
      if (!key || claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
}

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function buildLearningEvent(type, context, details = {}) {
  return {
    version: LEARNING_EVENT_VERSION,
    eventId: details.eventId || crypto.randomUUID(),
    type,
    occurredAt: Number.isFinite(details.occurredAt) ? details.occurredAt : Date.now(),
    dateKey: context.dateKey,
    language: context.language,
    mode: context.mode,
    roundId: context.roundId,
    ...(Number.isFinite(context.roundStartedAt) ? { roundStartedAt: context.roundStartedAt } : {}),
    ...Object.fromEntries(Object.entries(details).filter(([key, value]) => (
      !['eventId', 'occurredAt'].includes(key) && value !== undefined
    ))),
  };
}

export function createLearningEventQueue(options) {
  const storage = options.storage;
  const storageKey = options.storageKey || ANALYTICS_QUEUE_STORAGE_KEY;
  const maxSize = Math.max(20, options.maxSize || 100);
  const batchSize = Math.min(20, Math.max(1, options.batchSize || 20));
  const send = options.send;
  let pending = [];
  let inFlight = null;

  try {
    const restored = safeParse(storage?.getItem(storageKey), []);
    if (Array.isArray(restored)) pending = restored.filter((event) => event?.eventId).slice(-maxSize);
  } catch {
    pending = [];
  }

  const persist = () => {
    try { storage?.setItem(storageKey, JSON.stringify(pending)); } catch { /* best effort */ }
  };

  const enqueue = (event) => {
    if (!event?.eventId || pending.some((candidate) => candidate.eventId === event.eventId)) return false;
    pending.push(event);
    if (pending.length > maxSize) pending = pending.slice(-maxSize);
    persist();
    return true;
  };

  const flush = async (flushOptions = {}) => {
    if (inFlight) return inFlight;
    if (pending.length === 0) return { sent: 0, pending: 0 };
    const batch = pending.slice(0, batchSize);
    inFlight = Promise.resolve(send(batch, flushOptions))
      .then((response = {}) => {
        const completed = new Set([
          ...(response.acceptedIds || []),
          ...(response.duplicateIds || []),
          ...(response.rejected || []).map((entry) => entry?.eventId).filter(Boolean),
        ]);
        pending = pending.filter((event) => !completed.has(event.eventId));
        persist();
        return { sent: completed.size, pending: pending.length };
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    enqueue,
    flush,
    getPending: () => [...pending],
    clear: () => { pending = []; persist(); },
  };
}

function normalizeSavedWordLanguage(language) {
  return language === 'zh' ? 'zh' : 'ko';
}

export function getLocalSavedWordsKey(language = 'ko') {
  return LOCAL_SAVED_WORDS_KEYS[normalizeSavedWordLanguage(language)];
}

function normalizeSavedWordRecords(records, language) {
  return [...new Map(records
    .filter((entry) => entry && typeof entry.word === 'string' && Number.isFinite(entry.savedAt))
    .map((entry) => [entry.word.normalize('NFC'), {
      ...entry,
      word: entry.word.normalize('NFC'),
      language,
    }])).values()]
    .sort((left, right) => right.savedAt - left.savedAt || left.word.localeCompare(right.word, language));
}

export function readLocalSavedWords(storage, language = 'ko') {
  const normalizedLanguage = normalizeSavedWordLanguage(language);
  const key = getLocalSavedWordsKey(normalizedLanguage);
  try {
    const currentValue = safeParse(storage?.getItem(key), []);
    const current = Array.isArray(currentValue) ? currentValue : [];
    if (normalizedLanguage !== 'ko' || storage?.getItem(LOCAL_SAVED_WORDS_MIGRATION_KEY)) {
      return normalizeSavedWordRecords(current, normalizedLanguage);
    }

    const legacyValue = safeParse(storage?.getItem(LOCAL_SAVED_WORDS_KEY), []);
    const legacy = Array.isArray(legacyValue) ? legacyValue : [];
    const migrated = normalizeSavedWordRecords([...current, ...legacy], 'ko');
    storage?.setItem(key, JSON.stringify(migrated));
    storage?.setItem(LOCAL_SAVED_WORDS_MIGRATION_KEY, '1');
    return migrated;
  } catch {
    return [];
  }
}

export function writeLocalSavedWords(storage, words, language = 'ko') {
  const normalizedLanguage = normalizeSavedWordLanguage(language);
  const normalized = normalizeSavedWordRecords(words, normalizedLanguage);
  const key = getLocalSavedWordsKey(normalizedLanguage);
  storage?.setItem(key, JSON.stringify(normalized));
  return normalized;
}

export function upsertLocalSavedWord(storage, word, source = 'dictionary', now = Date.now(), language = 'ko') {
  const normalizedLanguage = normalizeSavedWordLanguage(language);
  const normalized = word.normalize('NFC');
  const existing = readLocalSavedWords(storage, normalizedLanguage);
  if (existing.some((entry) => entry.word === normalized)) return existing;
  return writeLocalSavedWords(storage, [
    { word: normalized, language: normalizedLanguage, savedAt: now, source, recalledAt: null },
    ...existing,
  ], normalizedLanguage);
}

export function removeLocalSavedWord(storage, word, language = 'ko') {
  const normalizedLanguage = normalizeSavedWordLanguage(language);
  const normalized = word.normalize('NFC');
  return writeLocalSavedWords(
    storage,
    readLocalSavedWords(storage, normalizedLanguage).filter((entry) => entry.word !== normalized),
    normalizedLanguage,
  );
}

export function getSavedWordsForResults(gameState, savedWords, dictionaryEntries) {
  const language = gameState?.language;
  if (!gameState?.gameOver || !['ko', 'zh'].includes(language) || !dictionaryEntries) return [];
  return savedWords.filter((record) => (
    (record.language || 'ko') === language && dictionaryEntries[record.word]
  ));
}

export function getSavedDictionarySupplementalWords(gameState, savedWords) {
  if (!gameState?.gameOver) return [];
  return savedWords.map((entry) => entry.word);
}

export function getOptimisticSavedWordToggle(savedWords, word, source = 'dictionary', now = Date.now(), language = 'ko') {
  const normalizedLanguage = normalizeSavedWordLanguage(language);
  const normalized = word.normalize('NFC');
  const existing = savedWords.find((entry) => entry.word === normalized) ?? null;
  return {
    existing,
    previous: [...savedWords],
    next: existing
      ? savedWords.filter((entry) => entry.word !== normalized)
      : [{ word: normalized, language: normalizedLanguage, savedAt: now, source, recalledAt: null }, ...savedWords],
  };
}

export function getSavedWordButtonState(savedWords, word, pending = false) {
  const normalized = word.normalize('NFC');
  const saved = savedWords.some((entry) => entry.word === normalized);
  return {
    saved,
    ariaPressed: String(saved),
    ariaLabel: saved ? `Remove ${normalized} from Saved Words` : `Save ${normalized}`,
    text: pending ? 'Saving…' : (saved ? 'Saved' : 'Save word'),
  };
}
