import crypto from 'node:crypto';

export const LEARNING_EVENT_VERSION = 1;
export const LEARNING_EVENT_TYPES = Object.freeze([
  'round_started',
  'round_completed',
  'valid_guess_submitted',
  'invalid_guess_submitted',
  'board_solved',
  'board_failed',
  'dictionary_opened',
  'definition_viewed',
  'nearby_suggestion_selected',
  'hint_used',
  'word_saved',
  'word_unsaved',
  'saved_word_later_guessed',
  'post_game_review_opened',
  'review_word_viewed',
]);

const EVENT_TYPES = new Set(LEARNING_EVENT_TYPES);
const CLIENT_UI_EVENTS = new Set([
  'dictionary_opened',
  'definition_viewed',
  'nearby_suggestion_selected',
  'post_game_review_opened',
  'review_word_viewed',
]);
const CLIENT_PRACTICE_EVENTS = new Set([
  'round_started',
  'round_completed',
  'valid_guess_submitted',
  'invalid_guess_submitted',
  'board_solved',
  'board_failed',
  'hint_used',
]);
const KOREAN_HINT_TYPES = new Set([
  'part-of-speech',
  'semantic-category',
  'batchim-count',
  'reveal-first-syllable',
]);
const LEGACY_CHINESE_HINT_TYPES = new Set([
  'tone-pattern',
  'pinyin-initials',
  'broad-meaning',
  'reveal-first-character',
]);
const PINYIN_CHINESE_HINT_TYPES = new Set([
  'syllable-boundary',
  'reveal-letter',
  'broad-meaning',
]);
const HINT_TYPES = new Set([...KOREAN_HINT_TYPES, ...LEGACY_CHINESE_HINT_TYPES, ...PINYIN_CHINESE_HINT_TYPES]);
const PINYIN_PUZZLE_VARIANT = 'pinyin-latin-v2';
const HANZI_PUZZLE_VARIANT = 'hanzi-v1';
const CLASSIFICATIONS = new Set(['recognized-unaccepted', 'unrecognized', 'not-in-list']);
const SOURCES = new Set(['dictionary', 'nearby', 'post-game']);
const AGGREGATE_TTL_SECONDS = 60 * 60 * 24 * 180;
const DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 30;
const FIRST_SEEN_TTL_SECONDS = AGGREGATE_TTL_SECONDS;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KOREAN_WORD_RE = /^[\uAC00-\uD7A3]{2}$/u;
const CHINESE_WORD_RE = /^\p{Script=Han}{2}$/u;
const ENGLISH_WORD_RE = /^[a-z]{5}$/;
const PINYIN_GUESS_KEY_RE = /^[a-z]{4,9}$/;

function finiteInteger(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback;
}

function isValidDateKey(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function chicagoDateKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function enumerateDates(from, to) {
  const dates = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.valueOf() + 86_400_000);
  }
  return dates;
}

function shiftDate(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  return new Date(date.valueOf() + (days * 86_400_000)).toISOString().slice(0, 10);
}

function normalizeWord(word, language) {
  if (typeof word !== 'string') return null;
  const normalized = language === 'en' ? word.toLowerCase() : word.normalize('NFC');
  const pattern = language === 'ko' ? KOREAN_WORD_RE : language === 'zh' ? CHINESE_WORD_RE : ENGLISH_WORD_RE;
  return pattern.test(normalized) ? normalized : null;
}

function isAcceptedLearningWord(word, language, options) {
  if (language === 'ko') return options.isAcceptedKoreanWord?.(word) === true;
  if (language === 'zh') return options.isAcceptedChineseWord?.(word) === true;
  return true;
}

function normalizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return undefined;
  return {
    won: metrics.won === true,
    assisted: metrics.assisted === true,
    guessCount: finiteInteger(metrics.guessCount),
    score: finiteInteger(metrics.score),
    solvedCount: Math.min(4, finiteInteger(metrics.solvedCount)),
    failedCount: Math.min(4, finiteInteger(metrics.failedCount)),
  };
}

export function normalizeLearningEvent(value, options = {}) {
  if (!value || typeof value !== 'object') return { ok: false, code: 'INVALID_EVENT' };
  const type = value.type;
  const language = ['en', 'ko', 'zh'].includes(value.language) ? value.language : null;
  const mode = value.mode === 'practice' ? 'practice' : value.mode === 'daily' ? 'daily' : null;
  const eventId = typeof value.eventId === 'string' ? value.eventId.trim() : '';
  const roundId = typeof value.roundId === 'string' ? value.roundId.trim() : '';
  const dateKey = isValidDateKey(value.dateKey) ? value.dateKey : null;
  const occurredAt = Number(value.occurredAt);
  const puzzleVariant = value.puzzleVariant === PINYIN_PUZZLE_VARIANT
    ? PINYIN_PUZZLE_VARIANT
    : value.puzzleVariant === HANZI_PUZZLE_VARIANT
      ? HANZI_PUZZLE_VARIANT
      : undefined;
  if (
    value.version !== LEARNING_EVENT_VERSION
    || !EVENT_TYPES.has(type)
    || !language
    || !mode
    || !dateKey
    || !eventId
    || eventId.length > 160
    || !roundId
    || roundId.length > 160
    || !Number.isFinite(occurredAt)
    || (value.puzzleVariant !== undefined && !puzzleVariant)
    || (language !== 'zh' && puzzleVariant !== undefined)
  ) return { ok: false, code: 'INVALID_EVENT' };

  if (options.client === true) {
    const allowed = CLIENT_UI_EVENTS.has(type) || (mode === 'practice' && CLIENT_PRACTICE_EVENTS.has(type));
    if (!allowed) return { ok: false, code: 'SERVER_AUTHORITATIVE_EVENT' };
    if (!UUID_RE.test(eventId)) return { ok: false, code: 'INVALID_EVENT_ID' };
  }

  let word = normalizeWord(value.word, language);
  const guessKey = typeof value.guessKey === 'string' && PINYIN_GUESS_KEY_RE.test(value.guessKey)
    ? value.guessKey
    : undefined;
  const classification = CLASSIFICATIONS.has(value.classification) ? value.classification : undefined;
  if (type === 'invalid_guess_submitted') {
    const canRetainRecognizedKorean = language === 'ko'
      && classification === 'recognized-unaccepted'
      && word
      && options.isRecognizedKoreanWord?.(word) === true;
    if (!canRetainRecognizedKorean) word = null;
  }
  if (type === 'valid_guess_submitted' && puzzleVariant === PINYIN_PUZZLE_VARIANT) {
    if (!guessKey || options.isAcceptedPinyinGuessKey?.(guessKey) !== true) {
      return { ok: false, code: 'INVALID_GUESS_KEY' };
    }
    word = null;
  } else if (
    ['valid_guess_submitted', 'board_solved', 'board_failed'].includes(type)
    && (!word || !isAcceptedLearningWord(word, language, options))
  ) return { ok: false, code: 'INVALID_WORD' };
  if (
    ['definition_viewed', 'nearby_suggestion_selected', 'word_saved', 'word_unsaved', 'saved_word_later_guessed', 'review_word_viewed'].includes(type)
    && (!word || !['ko', 'zh'].includes(language) || !isAcceptedLearningWord(word, language, options))
  ) return { ok: false, code: 'INVALID_WORD' };
  if (type === 'nearby_suggestion_selected' && language !== 'ko') return { ok: false, code: 'INVALID_WORD' };

  const hintType = HINT_TYPES.has(value.hintType) ? value.hintType : undefined;
  const hintMatchesLanguage = language === 'ko'
    ? KOREAN_HINT_TYPES.has(hintType)
    : language === 'zh' && (puzzleVariant === PINYIN_PUZZLE_VARIANT
      ? PINYIN_CHINESE_HINT_TYPES.has(hintType)
      : LEGACY_CHINESE_HINT_TYPES.has(hintType));
  if (type === 'hint_used' && (!hintType || !hintMatchesLanguage)) return { ok: false, code: 'INVALID_HINT' };
  if (type === 'round_completed' && (!value.metrics || typeof value.metrics !== 'object')) {
    return { ok: false, code: 'INVALID_METRICS' };
  }
  const boardIndex = Number.isInteger(value.boardIndex) && value.boardIndex >= 0 && value.boardIndex < 4
    ? value.boardIndex
    : undefined;
  if (['board_solved', 'board_failed', 'hint_used'].includes(type) && boardIndex === undefined) {
    return { ok: false, code: 'INVALID_BOARD' };
  }

  return {
    ok: true,
    event: {
      version: LEARNING_EVENT_VERSION,
      eventId,
      type,
      occurredAt,
      dateKey,
      language,
      ...(puzzleVariant ? { puzzleVariant } : {}),
      mode,
      roundId,
      ...(word ? { word } : {}),
      ...(guessKey ? { guessKey } : {}),
      ...(classification ? { classification } : {}),
      ...(hintType ? { hintType } : {}),
      ...(boardIndex !== undefined ? { boardIndex } : {}),
      ...(typeof value.surface === 'string' ? { surface: value.surface.slice(0, 40) } : {}),
      ...(value.metrics ? { metrics: normalizeMetrics(value.metrics) } : {}),
      ...(Number.isFinite(Number(value.roundStartedAt)) ? { roundStartedAt: Number(value.roundStartedAt) } : {}),
    },
  };
}

function emptyCounters() {
  return {
    round_started: 0,
    round_completed: 0,
    round_won: 0,
    valid_guess_submitted: 0,
    invalid_guess_submitted: 0,
    board_solved: 0,
    board_failed: 0,
    dictionary_opened: 0,
    definition_viewed: 0,
    nearby_suggestion_selected: 0,
    hint_used: 0,
    word_saved: 0,
    word_unsaved: 0,
    saved_word_later_guessed: 0,
    post_game_review_opened: 0,
    review_word_viewed: 0,
    completed_guess_total: 0,
    completed_score_total: 0,
    completed_assisted: 0,
    completed_unassisted: 0,
    won_assisted: 0,
    won_unassisted: 0,
    score_assisted_total: 0,
    score_unassisted_total: 0,
    guesses_assisted_total: 0,
    guesses_unassisted_total: 0,
  };
}

function incrementsForEvent(event) {
  const increments = { [event.type]: 1 };
  if (event.type === 'round_completed') {
    const metrics = event.metrics ?? normalizeMetrics({});
    increments.completed_guess_total = metrics.guessCount;
    increments.completed_score_total = metrics.score;
    if (metrics.won) increments.round_won = 1;
    const segment = metrics.assisted ? 'assisted' : 'unassisted';
    increments[`completed_${segment}`] = 1;
    increments[`score_${segment}_total`] = metrics.score;
    increments[`guesses_${segment}_total`] = metrics.guessCount;
    if (metrics.won) increments[`won_${segment}`] = 1;
  }
  if (event.type === 'hint_used' && event.hintType) increments[`hint_${event.hintType}`] = 1;
  return increments;
}

function addToMap(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function topRows(map, limit = 10) {
  return [...map.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((left, right) => right.count - left.count || left.word.localeCompare(right.word, 'ko'))
    .slice(0, limit);
}

const RECORD_EVENT_SCRIPT = `
  if not redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX') then
    return 0
  end
  local increments = cjson.decode(ARGV[5])
  for field, amount in pairs(increments) do
    redis.call('HINCRBY', KEYS[2], field, amount)
  end
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  if ARGV[6] == '1' then
    redis.call('ZINCRBY', KEYS[3], 1, ARGV[7])
    redis.call('EXPIRE', KEYS[3], ARGV[2])
  end
  if ARGV[8] == '1' then
    local first = redis.call('SET', KEYS[6], ARGV[9], 'EX', ARGV[3], 'NX')
    local firstAll = redis.call('SET', KEYS[8], ARGV[9], 'EX', ARGV[3], 'NX')
    redis.call('SADD', KEYS[4], ARGV[4])
    redis.call('EXPIRE', KEYS[4], ARGV[2])
    redis.call('SADD', KEYS[5], ARGV[4])
    redis.call('EXPIRE', KEYS[5], ARGV[2])
    if first then
      redis.call('SADD', KEYS[7], ARGV[4])
      redis.call('EXPIRE', KEYS[7], ARGV[2])
    end
    if firstAll then
      redis.call('SADD', KEYS[9], ARGV[4])
      redis.call('EXPIRE', KEYS[9], ARGV[2])
    end
  end
  return 1
`;

function getWordMetric(event) {
  if (event.type === 'definition_viewed' && event.word) return 'looked-up';
  if (event.type === 'invalid_guess_submitted' && event.word) return 'recognized-rejected';
  if (event.type === 'board_solved' && event.word) return 'answer-solved';
  if (event.type === 'board_failed' && event.word) return 'answer-failed';
  return null;
}

export function createLearningDataService(options = {}) {
  const enabled = options.enabled === true;
  const hmacSecret = options.hmacSecret ?? '';
  const allowMemoryFallback = options.allowMemoryFallback === true;
  const redisProvider = options.redisProvider ?? (() => null);
  const now = options.now ?? (() => Date.now());
  const isAcceptedKoreanWord = options.isAcceptedKoreanWord ?? (() => false);
  const isAcceptedChineseWord = options.isAcceptedChineseWord ?? (() => false);
  const isAcceptedPinyinGuessKey = options.isAcceptedPinyinGuessKey ?? (() => false);
  const isRecognizedKoreanWord = options.isRecognizedKoreanWord ?? (() => false);
  const memory = {
    dedupe: new Map(),
    counters: new Map(),
    words: new Map(),
    cohorts: new Map(),
    active: new Map(),
    firstKo: new Map(),
    saved: new Map(),
    rateLimits: new Map(),
  };

  const actorHash = (userId) => crypto.createHmac('sha256', hmacSecret)
    .update(`analytics:v1:${userId}`)
    .digest('hex');
  const redis = () => redisProvider?.() ?? null;
  const available = () => enabled && Boolean(hmacSecret) && (Boolean(redis()) || allowMemoryFallback);
  const analyticsLanguage = (language, puzzleVariant) => language === 'zh' && puzzleVariant === PINYIN_PUZZLE_VARIANT
    ? `${language}:${PINYIN_PUZZLE_VARIANT}`
    : language;
  const aggregateKey = (dateKey, language, mode, puzzleVariant) => (
    `analytics:v1:daily:${dateKey}:${analyticsLanguage(language, puzzleVariant)}:${mode}`
  );
  const wordKey = (metric, dateKey, language, mode, puzzleVariant) => (
    `analytics:v1:words:${metric}:${dateKey}:${analyticsLanguage(language, puzzleVariant)}:${mode}`
  );
  const analyticsDedupeKey = (hashedActor, eventId, language, puzzleVariant) => (
    `analytics:v1:dedupe:${hashedActor}:${analyticsLanguage(language, puzzleVariant)}:${eventId}`
  );
  const retentionKey = (kind, dateKey, language, mode, puzzleVariant) => (
    `analytics:v1:${kind}:${dateKey}:${analyticsLanguage(language, puzzleVariant)}:${mode}`
  );
  const firstSeenKey = (language, mode, hashedActor, puzzleVariant) => (
    `analytics:v1:first-${analyticsLanguage(language, puzzleVariant)}:${mode}:${hashedActor}`
  );
  const savedKey = (userId) => `learning:v1:saved:${actorHash(userId)}`;

  async function claimEvent(event, hashedActor) {
    const client = redis();
    const key = analyticsDedupeKey(hashedActor, event.eventId, event.language, event.puzzleVariant);
    if (client) {
      return (await client.set(key, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')) === 'OK';
    }
    const expiresAt = memory.dedupe.get(key);
    if (expiresAt && expiresAt > now()) return false;
    memory.dedupe.set(key, now() + (DEDUPE_TTL_SECONDS * 1000));
    return true;
  }

  async function recordRetention(event, hashedActor) {
    if (event.type !== 'round_started' || !['ko', 'zh'].includes(event.language)) return;
    const language = event.language;
    const client = redis();
    const activeKey = retentionKey('active', event.dateKey, language, event.mode, event.puzzleVariant);
    const activeAllKey = retentionKey('active', event.dateKey, language, 'all', event.puzzleVariant);
    const cohortKey = retentionKey('cohort', event.dateKey, language, event.mode, event.puzzleVariant);
    const cohortAllKey = retentionKey('cohort', event.dateKey, language, 'all', event.puzzleVariant);
    const firstKey = firstSeenKey(language, event.mode, hashedActor, event.puzzleVariant);
    const firstAllKey = firstSeenKey(language, 'all', hashedActor, event.puzzleVariant);
    if (client) {
      const first = await client.set(firstKey, event.dateKey, 'EX', FIRST_SEEN_TTL_SECONDS, 'NX');
      const firstAll = await client.set(firstAllKey, event.dateKey, 'EX', FIRST_SEEN_TTL_SECONDS, 'NX');
      const pipeline = client.pipeline();
      pipeline.sadd(activeKey, hashedActor).expire(activeKey, AGGREGATE_TTL_SECONDS);
      pipeline.sadd(activeAllKey, hashedActor).expire(activeAllKey, AGGREGATE_TTL_SECONDS);
      if (first === 'OK') pipeline.sadd(cohortKey, hashedActor).expire(cohortKey, AGGREGATE_TTL_SECONDS);
      if (firstAll === 'OK') pipeline.sadd(cohortAllKey, hashedActor).expire(cohortAllKey, AGGREGATE_TTL_SECONDS);
      await pipeline.exec();
      return;
    }
    const active = memory.active.get(activeKey) ?? new Set();
    active.add(hashedActor);
    memory.active.set(activeKey, active);
    const activeAll = memory.active.get(activeAllKey) ?? new Set();
    activeAll.add(hashedActor);
    memory.active.set(activeAllKey, activeAll);
    if (!memory.firstKo.has(firstKey)) {
      memory.firstKo.set(firstKey, event.dateKey);
      const cohort = memory.cohorts.get(cohortKey) ?? new Set();
      cohort.add(hashedActor);
      memory.cohorts.set(cohortKey, cohort);
    }
    if (!memory.firstKo.has(firstAllKey)) {
      memory.firstKo.set(firstAllKey, event.dateKey);
      const cohortAll = memory.cohorts.get(cohortAllKey) ?? new Set();
      cohortAll.add(hashedActor);
      memory.cohorts.set(cohortAllKey, cohortAll);
    }
  }

  async function recordEvent(rawEvent, userId, optionsForEvent = {}) {
    if (!available()) return { accepted: false, code: 'LEARNING_DATA_UNAVAILABLE' };
    const normalized = normalizeLearningEvent(rawEvent, {
      client: optionsForEvent.client === true,
      isAcceptedKoreanWord,
      isAcceptedChineseWord,
      isAcceptedPinyinGuessKey,
      isRecognizedKoreanWord,
    });
    if (!normalized.ok) return { accepted: false, code: normalized.code };
    const event = normalized.event;
    const hashedActor = actorHash(userId);
    const increments = incrementsForEvent(event);
    const client = redis();
    const aggregate = aggregateKey(event.dateKey, event.language, event.mode, event.puzzleVariant);
    const wordMetric = getWordMetric(event);
    if (client) {
      const retentionEvent = event.type === 'round_started' && ['ko', 'zh'].includes(event.language);
      const retentionLanguage = retentionEvent ? event.language : 'ko';
      const activeKey = retentionKey('active', event.dateKey, retentionLanguage, event.mode, event.puzzleVariant);
      const activeAllKey = retentionKey('active', event.dateKey, retentionLanguage, 'all', event.puzzleVariant);
      const firstKey = firstSeenKey(retentionLanguage, event.mode, hashedActor, event.puzzleVariant);
      const cohortKey = retentionKey('cohort', event.dateKey, retentionLanguage, event.mode, event.puzzleVariant);
      const firstAllKey = firstSeenKey(retentionLanguage, 'all', hashedActor, event.puzzleVariant);
      const cohortAllKey = retentionKey('cohort', event.dateKey, retentionLanguage, 'all', event.puzzleVariant);
      const recorded = await client.eval(
        RECORD_EVENT_SCRIPT,
        9,
        analyticsDedupeKey(hashedActor, event.eventId, event.language, event.puzzleVariant),
        aggregate,
        wordMetric ? wordKey(wordMetric, event.dateKey, event.language, event.mode, event.puzzleVariant) : aggregate,
        activeKey,
        activeAllKey,
        firstKey,
        cohortKey,
        firstAllKey,
        cohortAllKey,
        String(DEDUPE_TTL_SECONDS),
        String(AGGREGATE_TTL_SECONDS),
        String(FIRST_SEEN_TTL_SECONDS),
        hashedActor,
        JSON.stringify(increments),
        wordMetric ? '1' : '0',
        event.word ?? '',
        retentionEvent ? '1' : '0',
        event.dateKey,
      );
      if (Number(recorded) === 0) return { accepted: true, duplicate: true, event };
    } else {
      if (!(await claimEvent(event, hashedActor))) {
        return { accepted: true, duplicate: true, event };
      }
      const counters = memory.counters.get(aggregate) ?? new Map();
      for (const [field, amount] of Object.entries(increments)) addToMap(counters, field, amount);
      memory.counters.set(aggregate, counters);
      const addWordMetric = (metric) => {
        const key = wordKey(metric, event.dateKey, event.language, event.mode, event.puzzleVariant);
        const words = memory.words.get(key) ?? new Map();
        addToMap(words, event.word, 1);
        memory.words.set(key, words);
      };
      if (wordMetric) addWordMetric(wordMetric);
      await recordRetention(event, hashedActor);
    }
    return { accepted: true, duplicate: false, event };
  }

  async function checkRateLimit(userId, bucket, limit) {
    if (!available()) return false;
    const minute = Math.floor(now() / 60_000);
    const key = `learning:v1:rate:${bucket}:${actorHash(userId)}:${minute}`;
    const client = redis();
    if (client) {
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, 120);
      return count <= limit;
    }
    const count = (memory.rateLimits.get(key) ?? 0) + 1;
    memory.rateLimits.set(key, count);
    return count <= limit;
  }

  const normalizeSavedLanguage = (language) => language === 'zh' ? 'zh' : 'ko';
  const acceptedSavedWord = (word, language) => language === 'zh'
    ? isAcceptedChineseWord(word)
    : isAcceptedKoreanWord(word);
  const savedField = (language, word) => `${language}:${word}`;

  async function getSavedWords(userId, requestedLanguage = 'ko') {
    if (!available()) throw new Error('LEARNING_DATA_UNAVAILABLE');
    const language = normalizeSavedLanguage(requestedLanguage);
    const client = redis();
    let values;
    if (client) values = await client.hgetall(savedKey(userId));
    else values = Object.fromEntries(memory.saved.get(savedKey(userId)) ?? []);
    const records = new Map();
    for (const [field, value] of Object.entries(values)) {
      const separator = field.indexOf(':');
      const fieldLanguage = separator > 0 && ['ko', 'zh'].includes(field.slice(0, separator))
        ? field.slice(0, separator)
        : 'ko';
      if (fieldLanguage !== language) continue;
      let record;
      try { record = typeof value === 'string' ? JSON.parse(value) : value; } catch { record = null; }
      if (!record?.word) continue;
      const normalized = normalizeWord(record.word, language);
      if (!normalized) continue;
      const qualified = separator > 0;
      if (!records.has(normalized) || qualified) {
        records.set(normalized, { ...record, word: normalized, language });
      }
    }
    return [...records.values()]
      .sort((left, right) => right.savedAt - left.savedAt || left.word.localeCompare(right.word, language));
  }

  async function saveWord(userId, word, context = {}) {
    if (!available()) throw new Error('LEARNING_DATA_UNAVAILABLE');
    const language = normalizeSavedLanguage(context.language);
    const normalized = normalizeWord(word, language);
    if (!normalized || !acceptedSavedWord(normalized, language)) throw new Error('INVALID_WORD');
    const source = SOURCES.has(context.source) ? context.source : 'dictionary';
    const existing = (await getSavedWords(userId, language)).find((entry) => entry.word === normalized) ?? null;
    const record = existing ?? { word: normalized, language, savedAt: now(), source, recalledAt: null };
    const serialized = JSON.stringify({ ...record, language });
    const client = redis();
    const field = savedField(language, normalized);
    const created = !existing;
    if (client) {
      await client.hsetnx(savedKey(userId), field, serialized);
    } else {
      const saved = memory.saved.get(savedKey(userId)) ?? new Map();
      if (!saved.has(field)) saved.set(field, serialized);
      memory.saved.set(savedKey(userId), saved);
    }
    const current = (await getSavedWords(userId, language)).find((entry) => entry.word === normalized) ?? record;
    if (current) {
      await recordEvent({
        version: 1,
        eventId: `save:${normalized}:${current.savedAt}`,
        type: 'word_saved',
        occurredAt: current.savedAt,
        dateKey: isValidDateKey(context.dateKey) ? context.dateKey : chicagoDateKey(current.savedAt),
        language,
        ...(language === 'zh' && context.puzzleVariant === PINYIN_PUZZLE_VARIANT
          ? { puzzleVariant: PINYIN_PUZZLE_VARIANT }
          : {}),
        mode: context.mode === 'practice' ? 'practice' : 'daily',
        roundId: typeof context.roundId === 'string' && context.roundId ? context.roundId : 'saved-words',
        word: normalized,
      }, userId).catch(() => null);
    }
    return { created, record: current };
  }

  async function unsaveWord(userId, word, context = {}) {
    if (!available()) throw new Error('LEARNING_DATA_UNAVAILABLE');
    const language = normalizeSavedLanguage(context.language);
    const normalized = normalizeWord(word, language);
    if (!normalized) throw new Error('INVALID_WORD');
    const client = redis();
    let removed;
    const fields = [savedField(language, normalized), ...(language === 'ko' ? [normalized] : [])];
    if (client) removed = (await client.hdel(savedKey(userId), ...fields)) > 0;
    else {
      const saved = memory.saved.get(savedKey(userId)) ?? new Map();
      removed = false;
      fields.forEach((field) => { removed = saved.delete(field) || removed; });
      memory.saved.set(savedKey(userId), saved);
    }
    if (removed && acceptedSavedWord(normalized, language)) {
      await recordEvent({
        version: 1,
        eventId: `unsave:${crypto.randomUUID()}`,
        type: 'word_unsaved',
        occurredAt: now(),
        dateKey: isValidDateKey(context.dateKey) ? context.dateKey : chicagoDateKey(now()),
        language,
        ...(language === 'zh' && context.puzzleVariant === PINYIN_PUZZLE_VARIANT
          ? { puzzleVariant: PINYIN_PUZZLE_VARIANT }
          : {}),
        mode: context.mode === 'practice' ? 'practice' : 'daily',
        roundId: typeof context.roundId === 'string' && context.roundId ? context.roundId : 'saved-words',
        word: normalized,
      }, userId).catch(() => null);
    }
    return { removed };
  }

  async function markSavedWordLaterGuessed(userId, word, context = {}) {
    if (!available()) return false;
    const language = normalizeSavedLanguage(context.language);
    const normalized = normalizeWord(word, language);
    if (!normalized || !acceptedSavedWord(normalized, language)) return false;
    const client = redis();
    const key = savedKey(userId);
    const qualifiedField = savedField(language, normalized);
    const legacyField = language === 'ko' ? normalized : null;
    let field = qualifiedField;
    let raw = client ? await client.hget(key, qualifiedField) : memory.saved.get(key)?.get(qualifiedField);
    if (!raw && legacyField) {
      field = legacyField;
      raw = client ? await client.hget(key, legacyField) : memory.saved.get(key)?.get(legacyField);
    }
    if (!raw) return false;
    let record;
    try { record = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return false; }
    const roundStartedAt = Number(context.roundStartedAt);
    if (record.recalledAt || !Number.isFinite(roundStartedAt) || record.savedAt >= roundStartedAt) return false;
    record.recalledAt = now();
    record.language = language;
    if (client) await client.hset(key, field, JSON.stringify(record));
    else memory.saved.get(key)?.set(field, JSON.stringify(record));
    await recordEvent({
      version: 1,
      eventId: `recall:${normalized}:${record.savedAt}`,
      type: 'saved_word_later_guessed',
      occurredAt: record.recalledAt,
      dateKey: isValidDateKey(context.dateKey) ? context.dateKey : chicagoDateKey(record.recalledAt),
      language,
      ...(language === 'zh' && context.puzzleVariant === PINYIN_PUZZLE_VARIANT
        ? { puzzleVariant: PINYIN_PUZZLE_VARIANT }
        : {}),
      mode: context.mode === 'practice' ? 'practice' : 'daily',
      roundId: typeof context.roundId === 'string' && context.roundId ? context.roundId : 'unknown-round',
      word: normalized,
    }, userId).catch(() => null);
    return true;
  }

  async function readCounterKey(key) {
    const client = redis();
    if (client) {
      const raw = await client.hgetall(key);
      return new Map(Object.entries(raw).map(([field, value]) => [field, Number(value)]));
    }
    return memory.counters.get(key) ?? new Map();
  }

  async function readWordKey(key) {
    const client = redis();
    if (client) {
      const raw = await client.zrange(key, 0, -1, 'WITHSCORES');
      const result = new Map();
      for (let index = 0; index < raw.length; index += 2) result.set(raw[index], Number(raw[index + 1]));
      return result;
    }
    return memory.words.get(key) ?? new Map();
  }

  async function readSet(key, source) {
    const client = redis();
    if (client) return new Set(await client.smembers(key));
    return source.get(key) ?? new Set();
  }

  async function getSummary(query = {}) {
    if (!available()) throw new Error('LEARNING_DATA_UNAVAILABLE');
    if ((query.from !== undefined && !isValidDateKey(query.from))
      || (query.to !== undefined && !isValidDateKey(query.to))) {
      throw new Error('INVALID_DATE_RANGE');
    }
    if (query.language !== undefined && !['en', 'ko', 'zh', 'all'].includes(query.language)) {
      throw new Error('INVALID_FILTER');
    }
    if (query.mode !== undefined && !['daily', 'practice', 'all'].includes(query.mode)) {
      throw new Error('INVALID_FILTER');
    }
    if (query.puzzleVariant !== undefined
      && ![PINYIN_PUZZLE_VARIANT, HANZI_PUZZLE_VARIANT].includes(query.puzzleVariant)) {
      throw new Error('INVALID_FILTER');
    }
    if (query.puzzleVariant !== undefined && query.language !== 'zh') throw new Error('INVALID_FILTER');
    const to = isValidDateKey(query.to) ? query.to : chicagoDateKey(now());
    const defaultFrom = shiftDate(to, -29);
    const from = isValidDateKey(query.from) ? query.from : defaultFrom;
    const dates = enumerateDates(from, to);
    if (dates.length < 1 || dates.length > 90) throw new Error('INVALID_DATE_RANGE');
    const languages = ['en', 'ko', 'zh'].includes(query.language) ? [query.language] : ['en', 'ko', 'zh'];
    const modes = query.mode === 'daily' || query.mode === 'practice' ? [query.mode] : ['daily', 'practice'];
    const chinesePuzzleVariant = query.language === 'zh'
      ? (query.puzzleVariant || PINYIN_PUZZLE_VARIANT)
      : PINYIN_PUZZLE_VARIANT;
    const totals = emptyCounters();
    const lookedUp = new Map();
    const rejected = new Map();
    const solved = new Map();
    const failed = new Map();

    for (const dateKey of dates) {
      for (const language of languages) {
        const puzzleVariant = language === 'zh' ? chinesePuzzleVariant : undefined;
        for (const mode of modes) {
          const counters = await readCounterKey(aggregateKey(dateKey, language, mode, puzzleVariant));
          for (const [field, amount] of counters) totals[field] = (totals[field] ?? 0) + amount;
          for (const [metric, destination] of [
            ['looked-up', lookedUp],
            ['recognized-rejected', rejected],
            ...(mode === 'daily' ? [['answer-solved', solved], ['answer-failed', failed]] : []),
          ]) {
            const words = await readWordKey(wordKey(metric, dateKey, language, mode, puzzleVariant));
            for (const [word, count] of words) addToMap(destination, word, count);
          }
        }
      }
    }

    const retention = {};
    for (const offset of [1, 7]) {
      let cohortSize = 0;
      let returned = 0;
      for (const language of languages.filter((candidate) => ['ko', 'zh'].includes(candidate))) {
        const puzzleVariant = language === 'zh' ? chinesePuzzleVariant : undefined;
        const retentionModes = modes.length === 1 ? modes : ['all'];
        for (const mode of retentionModes) {
          for (const cohortDate of dates) {
            const activeDate = shiftDate(cohortDate, offset);
            if (activeDate > to) continue;
            const cohort = await readSet(retentionKey('cohort', cohortDate, language, mode, puzzleVariant), memory.cohorts);
            const active = await readSet(retentionKey('active', activeDate, language, mode, puzzleVariant), memory.active);
            cohortSize += cohort.size;
            for (const actor of cohort) if (active.has(actor)) returned += 1;
          }
        }
      }
      retention[`d${offset}`] = {
        cohortSize,
        returned,
        rate: cohortSize ? returned / cohortSize : null,
      };
    }

    const difficultAnswers = [...new Set([...solved.keys(), ...failed.keys()])]
      .map((word) => {
        const solvedCount = solved.get(word) ?? 0;
        const failedCount = failed.get(word) ?? 0;
        const attempts = solvedCount + failedCount;
        return { word, attempts, solved: solvedCount, failed: failedCount, missRate: attempts ? failedCount / attempts : 0 };
      })
      .filter((entry) => entry.attempts >= 3)
      .sort((left, right) => right.missRate - left.missRate || right.attempts - left.attempts || left.word.localeCompare(right.word, 'ko'))
      .slice(0, 10);
    const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
    const segment = (name) => ({
      completions: totals[`completed_${name}`] ?? 0,
      wins: totals[`won_${name}`] ?? 0,
      winRate: ratio(totals[`won_${name}`] ?? 0, totals[`completed_${name}`] ?? 0),
      averageScore: ratio(totals[`score_${name}_total`] ?? 0, totals[`completed_${name}`] ?? 0),
      averageGuesses: ratio(totals[`guesses_${name}_total`] ?? 0, totals[`completed_${name}`] ?? 0),
    });

    return {
      version: 1,
      period: { from, to },
      filters: {
        language: languages.length === 1 ? languages[0] : 'all',
        mode: modes.length === 1 ? modes[0] : 'all',
        ...(languages.includes('zh') ? { puzzleVariant: chinesePuzzleVariant } : {}),
      },
      totals,
      rates: {
        solveRate: ratio(totals.round_won, totals.round_completed),
        averageGuesses: ratio(totals.completed_guess_total, totals.round_completed),
        invalidGuessesPerRound: ratio(totals.invalid_guess_submitted, totals.round_started),
        dictionaryOpensPerRound: ratio(totals.dictionary_opened, totals.round_started),
        savedWordRecall: ratio(totals.saved_word_later_guessed, totals.word_saved),
      },
      hintsByType: Object.fromEntries([...HINT_TYPES].map((type) => [type, totals[`hint_${type}`] ?? 0])),
      assistance: { assisted: segment('assisted'), unassisted: segment('unassisted') },
      retention,
      topWords: {
        lookedUp: topRows(lookedUp),
        recognizedButRejected: topRows(rejected),
        difficultDailyAnswers: difficultAnswers,
      },
    };
  }

  return {
    available,
    actorHash,
    checkRateLimit,
    getSavedWords,
    getSummary,
    markSavedWordLaterGuessed,
    normalizeClientEvent: (value) => normalizeLearningEvent(value, {
      client: true,
      isAcceptedKoreanWord,
      isAcceptedChineseWord,
      isAcceptedPinyinGuessKey,
      isRecognizedKoreanWord,
    }),
    recordEvent,
    saveWord,
    unsaveWord,
    _memory: memory,
  };
}
