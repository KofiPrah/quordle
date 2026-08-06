import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createLearningDataService,
  normalizeLearningEvent,
} from '../learningData.js';
import { createAppSessionToken, verifyAppSessionToken } from '../sessionAuth.js';

const accepted = new Set(['기관', '기차']);
const recognized = new Set(['기관', '기차', '학일']);
const validators = {
  isAcceptedKoreanWord: (word) => accepted.has(word),
  isRecognizedKoreanWord: (word) => recognized.has(word),
};
const eventIds = new Map();

function event(type, overrides = {}) {
  const eventKey = `${type}:${overrides.suffix || '1'}`;
  if (!eventIds.has(eventKey)) eventIds.set(eventKey, randomUUID());
  return {
    version: 1,
    eventId: eventIds.get(eventKey),
    type,
    occurredAt: Date.parse('2026-08-06T12:00:00Z'),
    dateKey: '2026-08-06',
    language: 'ko',
    mode: 'practice',
    roundId: overrides.roundId || 'practice:one',
    ...overrides,
  };
}

test('app session tokens authenticate, expire, and reject tampering', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');
  const created = createAppSessionToken('discord-user', 'secret', { now, ttlSeconds: 60 });
  assert.equal(verifyAppSessionToken(created.token, 'secret', { now: now + 30_000 }).sub, 'discord-user');
  assert.equal(verifyAppSessionToken(created.token, 'secret', { now: now + 61_000 }), null);
  assert.equal(verifyAppSessionToken(`${created.token}x`, 'secret', { now }), null);
});

test('client event validation redacts unknown guesses and blocks authoritative daily events', () => {
  const retained = normalizeLearningEvent(event('invalid_guess_submitted', {
    word: '학일',
    classification: 'recognized-unaccepted',
  }), { client: true, ...validators });
  assert.equal(retained.event.word, '학일');

  const redacted = normalizeLearningEvent(event('invalid_guess_submitted', {
    suffix: '2',
    word: '가가',
    classification: 'unrecognized',
  }), { client: true, ...validators });
  assert.equal('word' in redacted.event, false);

  const rejected = normalizeLearningEvent(event('round_completed', {
    mode: 'daily',
    metrics: { won: true },
  }), { client: true, ...validators });
  assert.deepEqual(rejected, { ok: false, code: 'SERVER_AUTHORITATIVE_EVENT' });

  const dailyInvalid = normalizeLearningEvent(event('invalid_guess_submitted', {
    suffix: 'daily-invalid',
    mode: 'daily',
    classification: 'unrecognized',
  }), { client: true, ...validators });
  assert.deepEqual(dailyInvalid, { ok: false, code: 'SERVER_AUTHORITATIVE_EVENT' });

  const invalidId = normalizeLearningEvent({
    ...event('dictionary_opened', { suffix: 'invalid-id' }),
    eventId: 'not-a-uuid',
  }, { client: true, ...validators });
  assert.deepEqual(invalidId, { ok: false, code: 'INVALID_EVENT_ID' });

  const missingMetrics = normalizeLearningEvent(event('round_completed', {
    suffix: 'missing-metrics', mode: 'practice', metrics: undefined,
  }), { client: true, ...validators });
  assert.deepEqual(missingMetrics, { ok: false, code: 'INVALID_METRICS' });
});

test('memory analytics aggregate idempotently, segment assistance, and calculate retention', async () => {
  let clock = Date.parse('2026-08-06T12:00:00Z');
  const service = createLearningDataService({
    enabled: true,
    hmacSecret: 'analytics-secret',
    allowMemoryFallback: true,
    now: () => clock,
    ...validators,
  });
  await service.recordEvent(event('round_started'), 'user');
  await service.recordEvent(event('round_started'), 'user');
  await service.recordEvent(event('round_completed', {
    metrics: { won: true, assisted: true, guessCount: 7, score: 71, solvedCount: 4, failedCount: 0 },
  }), 'user');
  await service.recordEvent(event('invalid_guess_submitted', {
    suffix: 'recognized-rejected', word: '학일', classification: 'recognized-unaccepted',
  }), 'user');
  await service.recordEvent(event('definition_viewed', { suffix: 'definition', word: '기관' }), 'user');
  await service.recordEvent(event('hint_used', {
    suffix: 'hint', hintType: 'part-of-speech', boardIndex: 0,
  }), 'user');
  clock = Date.parse('2026-08-07T12:00:00Z');
  await service.recordEvent(event('round_started', {
    suffix: 'day-two',
    dateKey: '2026-08-07',
    occurredAt: clock,
    roundId: 'practice:two',
  }), 'user');

  const summary = await service.getSummary({ from: '2026-08-06', to: '2026-08-07', language: 'ko', mode: 'practice' });
  assert.equal(summary.totals.round_started, 2);
  assert.equal(summary.totals.round_completed, 1);
  assert.equal(summary.assistance.assisted.averageScore, 71);
  assert.equal(summary.rates.invalidGuessesPerRound, 0.5);
  assert.equal(summary.hintsByType['part-of-speech'], 1);
  assert.deepEqual(summary.topWords.lookedUp, [{ word: '기관', count: 1 }]);
  assert.deepEqual(summary.topWords.recognizedButRejected, [{ word: '학일', count: 1 }]);
  assert.deepEqual(summary.retention.d1, { cohortSize: 1, returned: 1, rate: 1 });
});

test('saved words are idempotent and recall only in a later round', async () => {
  let clock = Date.parse('2026-08-06T12:00:00Z');
  const service = createLearningDataService({
    enabled: true,
    hmacSecret: 'analytics-secret',
    allowMemoryFallback: true,
    now: () => clock,
    ...validators,
  });
  const first = await service.saveWord('user', '기관', { dateKey: '2026-08-06', mode: 'practice', roundId: 'one' });
  const duplicate = await service.saveWord('user', '기관', { dateKey: '2026-08-06', mode: 'practice', roundId: 'one' });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(await service.markSavedWordLaterGuessed('user', '기관', {
    dateKey: '2026-08-06', mode: 'practice', roundId: 'one', roundStartedAt: clock - 1,
  }), false);

  clock += 86_400_000;
  assert.equal(await service.markSavedWordLaterGuessed('user', '기관', {
    dateKey: '2026-08-07', mode: 'practice', roundId: 'two', roundStartedAt: clock - 1,
  }), true);
  assert.equal(await service.markSavedWordLaterGuessed('user', '기관', {
    dateKey: '2026-08-07', mode: 'practice', roundId: 'two', roundStartedAt: clock - 1,
  }), false);
  assert.ok((await service.getSavedWords('user'))[0].recalledAt);
});

test('production-style service fails closed without Redis', () => {
  const service = createLearningDataService({
    enabled: true,
    hmacSecret: 'analytics-secret',
    allowMemoryFallback: false,
    redisProvider: () => null,
    ...validators,
  });
  assert.equal(service.available(), false);
});

test('learning API rate limits are actor-scoped', async () => {
  const service = createLearningDataService({
    enabled: true,
    hmacSecret: 'analytics-secret',
    allowMemoryFallback: true,
    ...validators,
  });
  assert.equal(await service.checkRateLimit('one', 'events', 2), true);
  assert.equal(await service.checkRateLimit('one', 'events', 2), true);
  assert.equal(await service.checkRateLimit('one', 'events', 2), false);
  assert.equal(await service.checkRateLimit('two', 'events', 2), true);
});
