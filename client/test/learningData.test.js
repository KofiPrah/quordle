import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLearningEvent,
  createOneTimeEventTracker,
  createStableLearningEventId,
  createLearningEventQueue,
  getOptimisticSavedWordToggle,
  getSavedWordButtonState,
  getSavedDictionarySupplementalWords,
  LOCAL_SAVED_WORDS_KEY,
  getSavedWordsForResults,
  readLocalSavedWords,
  removeLocalSavedWord,
  upsertLocalSavedWord,
} from '../src/learningData.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('learning event queue is bounded, idempotent, persistent, and retry-safe', async () => {
  const storage = memoryStorage();
  let fail = true;
  const queue = createLearningEventQueue({
    storage,
    maxSize: 20,
    batchSize: 2,
    send: async (events) => {
      if (fail) throw new Error('offline');
      return { acceptedIds: events.map((event) => event.eventId) };
    },
  });
  const context = { dateKey: '2026-08-06', language: 'ko', mode: 'practice', roundId: 'round' };
  const event = buildLearningEvent('round_started', context, { eventId: 'start' });
  assert.equal(queue.enqueue(event), true);
  assert.equal(queue.enqueue(event), false);
  await assert.rejects(queue.flush(), /offline/);
  assert.equal(queue.getPending().length, 1);
  fail = false;
  assert.deepEqual(await queue.flush(), { sent: 1, pending: 0 });
  assert.deepEqual(queue.getPending(), []);
});

test('stable learning event IDs are deterministic UUIDs', () => {
  const first = createStableLearningEventId('practice:round:review-word');
  assert.equal(first, createStableLearningEventId('practice:round:review-word'));
  assert.notEqual(first, createStableLearningEventId('practice:round:another-word'));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('one-time view tracking rejects rerender duplicates', () => {
  const tracker = createOneTimeEventTracker();
  assert.equal(tracker.claim('review:기관'), true);
  assert.equal(tracker.claim('review:기관'), false);
  assert.equal(tracker.claim('review:기차'), true);
});

test('local Saved Words are idempotent, newest-first, and removable', () => {
  const storage = memoryStorage();
  upsertLocalSavedWord(storage, '기관', 'dictionary', 10);
  upsertLocalSavedWord(storage, '기차', 'post-game', 20);
  upsertLocalSavedWord(storage, '기관', 'nearby', 30);
  assert.deepEqual(readLocalSavedWords(storage).map((entry) => entry.word), ['기차', '기관']);
  assert.deepEqual(removeLocalSavedWord(storage, '기차').map((entry) => entry.word), ['기관']);
});

test('legacy Korean Saved Words migrate once and remain isolated from Chinese', () => {
  const storage = memoryStorage();
  storage.setItem(LOCAL_SAVED_WORDS_KEY, JSON.stringify([
    { word: '기관', savedAt: 10, source: 'dictionary' },
  ]));
  assert.deepEqual(readLocalSavedWords(storage, 'ko').map((entry) => entry.word), ['기관']);
  upsertLocalSavedWord(storage, '学生', 'dictionary', 20, 'zh');
  assert.deepEqual(readLocalSavedWords(storage, 'zh').map((entry) => entry.word), ['学生']);
  assert.deepEqual(readLocalSavedWords(storage, 'ko').map((entry) => entry.word), ['기관']);
  removeLocalSavedWord(storage, '기관', 'ko');
  assert.deepEqual(readLocalSavedWords(storage, 'ko'), []);
});

test('complete Saved Words collection is results-only', () => {
  const words = [{ word: '기관', savedAt: 1 }];
  const entries = { 기관: { word: '기관' } };
  assert.deepEqual(getSavedWordsForResults({ gameOver: false, language: 'ko' }, words, entries), []);
  assert.deepEqual(getSavedWordsForResults({ gameOver: true, language: 'ko' }, words, entries), words);
  assert.deepEqual(getSavedWordsForResults({ gameOver: true, language: 'zh' }, words, entries), []);
  assert.deepEqual(getSavedDictionarySupplementalWords({ gameOver: false }, words), []);
  assert.deepEqual(getSavedDictionarySupplementalWords({ gameOver: true }, words), ['기관']);
});

test('optimistic Saved Words state can be rolled back without mutation', () => {
  const original = [{ word: '기관', savedAt: 1, source: 'dictionary' }];
  const removal = getOptimisticSavedWordToggle(original, '기관');
  assert.deepEqual(removal.next, []);
  assert.deepEqual(removal.previous, original);
  const addition = getOptimisticSavedWordToggle(original, '기차', 'post-game', 2);
  assert.deepEqual(addition.next.map((entry) => entry.word), ['기차', '기관']);
  assert.deepEqual(original.map((entry) => entry.word), ['기관']);
});

test('Saved Words toggle state exposes accessible pressed labels', () => {
  const saved = getSavedWordButtonState([{ word: '기관' }], '기관');
  assert.deepEqual(saved, {
    saved: true,
    ariaPressed: 'true',
    ariaLabel: 'Remove 기관 from Saved Words',
    text: 'Saved',
  });
  const unsaved = getSavedWordButtonState([], '기관');
  assert.equal(unsaved.ariaPressed, 'false');
  assert.equal(unsaved.ariaLabel, 'Save 기관');
});
