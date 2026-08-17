import test from 'node:test';
import assert from 'node:assert/strict';
import * as chineseInput from '../src/chineseInput.js';

const guessKeys = new Set(['xuesheng', 'nver', 'lvse', 'jiejie']);

const parsedKeys = new Map([
  ['xué shēng', 'xuesheng'],
  ['xue\u0301 she\u0304ng', 'xuesheng'],
  ['xue2 sheng1', 'xuesheng'],
  ['nǚ ér', 'nver'],
  ['nu:3 er2', 'nver'],
  ['nv3 er2', 'nver'],
  ['lǜ sè', 'lvse'],
  ['mi miao', 'mimiao'],
  ['jie3 jie3', 'jiejie'],
]);

const parseInput = (sourceText) => {
  const key = parsedKeys.get(sourceText);
  return key ? { key, syllables: [{}, {}] } : null;
};

const normalizeInput = (sourceText) => parsedKeys.get(sourceText) ?? '';

const submissionIdFactory = (...ids) => () => ids.shift();

function update(sourceText, wordLength, keys = guessKeys) {
  return chineseInput.updateChineseInput(
    chineseInput.createChineseInputState(),
    sourceText,
    { wordLength, guessKeys: keys, parseInput, normalizeInput },
  );
}

function createMemoryStorage(entries = []) {
  const values = new Map(entries);
  const reads = [];
  return {
    reads,
    getItem(key) {
      reads.push(key);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    value(key) {
      return values.get(key);
    },
  };
}

test('Chinese draft keeps exact source text and a normalized Latin tile value', () => {
  const state = update('xué shēng', 8);

  assert.equal(state.sourceText, 'xué shēng');
  assert.equal(state.normalizedText, 'xuesheng');
  assert.equal(state.validationStatus, 'valid');
  assert.equal(state.validationCode, null);
  assert.equal(state.pendingSubmission, false);
  assert.equal(chineseInput.getChineseInputValue(state), 'xué shēng');
});

test('marked, numbered, decomposed, umlaut, u-colon, and v drafts share the engine normalization', () => {
  const cases = [
    ['xue\u0301 she\u0304ng', 8, 'xuesheng'],
    ['xue2 sheng1', 8, 'xuesheng'],
    ['nǚ ér', 4, 'nver'],
    ['nu:3 er2', 4, 'nver'],
    ['nv3 er2', 4, 'nver'],
    ['lǜ sè', 4, 'lvse'],
  ];

  for (const [sourceText, wordLength, normalizedText] of cases) {
    const state = update(sourceText, wordLength);
    assert.equal(state.sourceText, sourceText);
    assert.equal(state.normalizedText, normalizedText);
    assert.equal(state.validationStatus, 'valid');
  }
});

test('active-length key loading requests only that generated shard and caches it', async () => {
  const requestedLengths = [];
  const loadKeys = chineseInput.createChineseGuessKeyLoader?.(async (wordLength) => {
    requestedLengths.push(wordLength);
    return wordLength === 5 ? ['fuqin', 'kafei'] : ['qunian'];
  });

  assert.deepEqual([...await loadKeys?.(5) ?? []], ['fuqin', 'kafei']);
  assert.deepEqual([...await loadKeys?.(5) ?? []], ['fuqin', 'kafei']);
  assert.deepEqual(requestedLengths, [5]);
});

test('known local rejection never creates a submission and preserves the exact source draft', () => {
  const state = update('mi miao', 6, new Set(['jiejie']));
  const attempt = chineseInput.beginChineseSubmission?.(state, 0);

  assert.equal(state.validationStatus, 'invalid');
  assert.equal(state.validationCode, 'NOT_IN_LIST');
  assert.equal(attempt?.submission, null);
  assert.equal(attempt?.state.sourceText, 'mi miao');
  assert.equal(attempt?.state.normalizedText, 'mimiao');
  assert.equal(attempt?.state.pendingSubmission, false);
  assert.match(attempt?.state.error ?? '', /Pinyin word list/);
});

test('server and network rejection release pending state without changing either draft representation', () => {
  const initial = update('xué shēng', 8);
  const createSubmissionId = submissionIdFactory('submission-1');
  const started = chineseInput.beginChineseSubmission?.(initial, 2, { createSubmissionId });

  assert.deepEqual(started?.submission, {
    sourceText: 'xué shēng',
    normalizedText: 'xuesheng',
    submissionId: 'submission-1',
  });
  assert.equal(started?.state.pendingSubmission, true);

  for (const message of ['Not in the Pinyin word list.', 'Network unavailable.']) {
    const rejected = chineseInput.rejectChineseSubmission?.(started.state, message);
    assert.equal(rejected?.sourceText, 'xué shēng');
    assert.equal(rejected?.normalizedText, 'xuesheng');
    assert.equal(rejected?.pendingSubmission, false);
    assert.equal(rejected?.error, message);
  }
});

test('transport failure retains a correlated receipt through stale state until late confirmation', () => {
  const createSubmissionId = submissionIdFactory('submission-1');
  const started = chineseInput.beginChineseSubmission?.(
    update('jie3 jie3', 6),
    2,
    { createSubmissionId },
  );
  const disconnected = chineseInput.rejectChineseSubmission?.(
    started.state,
    'Network unavailable.',
    { retainSubmissionFingerprint: true },
  );

  assert.equal(disconnected?.pendingSubmission, false);
  assert.equal(disconnected?.sourceText, 'jie3 jie3');
  assert.equal(disconnected?.normalizedText, 'jiejie');
  assert.deepEqual(disconnected?.submissionFingerprint, {
    submissionId: 'submission-1',
    normalizedText: 'jiejie',
    guessCount: 2,
  });

  const staleState = {
    pinyinSubmissionReceipt: {
      submissionId: 'older-submission',
      normalizedGuess: 'gongsi',
      guessIndex: 1,
    },
    gameState: {
      guessCount: 2,
      boards: [{ guesses: ['laoshi', 'gongsi'] }],
    },
  };
  const unresolved = chineseInput.reconcileChineseSubmissionAgainstState?.(disconnected, staleState);
  assert.equal(unresolved?.status, 'unconfirmed');
  assert.deepEqual(unresolved?.state.submissionFingerprint, disconnected.submissionFingerprint);

  const acceptedLate = {
    pinyinSubmissionReceipt: {
      submissionId: 'submission-1',
      normalizedGuess: 'jiejie',
      guessIndex: 2,
    },
    gameState: {
      guessCount: 3,
      boards: [{ guesses: ['laoshi', 'gongsi', 'jiejie'] }],
    },
  };
  const confirmed = chineseInput.reconcileChineseSubmissionAgainstState?.(unresolved.state, acceptedLate);
  assert.equal(confirmed?.status, 'confirmed');
  assert.equal(confirmed?.state.sourceText, '');
});

test('same-draft retry reuses its submission ID and a different draft stays blocked while unresolved', () => {
  const createSubmissionId = submissionIdFactory('submission-1');
  const started = chineseInput.beginChineseSubmission?.(
    update('jie3 jie3', 6),
    2,
    { createSubmissionId },
  );
  const disconnected = chineseInput.rejectChineseSubmission?.(
    started.state,
    'Network unavailable.',
    { retainSubmissionFingerprint: true },
  );

  const retry = chineseInput.beginChineseSubmission?.(disconnected, 2, { createSubmissionId });
  assert.equal(retry?.state.pendingSubmission, true);
  assert.equal(retry?.submission.submissionId, 'submission-1');

  const released = chineseInput.rejectChineseSubmission?.(
    retry.state,
    'Network unavailable.',
    { retainSubmissionFingerprint: true },
  );
  const differentDraft = chineseInput.updateChineseInput?.(released, 'mi miao', {
    wordLength: 6,
    guessKeys,
    parseInput,
    normalizeInput,
  });
  const blocked = chineseInput.beginChineseSubmission?.(differentDraft, 2, { createSubmissionId });
  assert.equal(differentDraft?.sourceText, 'mi miao');
  assert.deepEqual(differentDraft?.submissionFingerprint, released.submissionFingerprint);
  assert.equal(blocked?.submission, null);
  assert.match(blocked?.state.error ?? '', /previous guess/i);
});

test('known authoritative rejection discards late-confirmation metadata', () => {
  const createSubmissionId = submissionIdFactory('submission-1');
  const started = chineseInput.beginChineseSubmission?.(
    update('jie3 jie3', 6),
    2,
    { createSubmissionId },
  );
  const disconnected = chineseInput.rejectChineseSubmission?.(
    started.state,
    'Network unavailable.',
    { retainSubmissionFingerprint: true },
  );
  const rejected = chineseInput.rejectChineseSubmission?.(disconnected, 'Not accepted.');

  assert.equal(rejected?.sourceText, 'jie3 jie3');
  assert.equal(rejected?.pendingSubmission, false);
  assert.equal(rejected?.submissionFingerprint, null);
});

test('only a correlated authoritative server error releases retained submission metadata', () => {
  const createSubmissionId = submissionIdFactory('submission-1', 'submission-2');
  const started = chineseInput.beginChineseSubmission?.(
    update('jie3 jie3', 6),
    2,
    { createSubmissionId },
  );
  const disconnected = chineseInput.rejectChineseSubmission?.(
    started.state,
    'Network unavailable.',
    { retainSubmissionFingerprint: true },
  );
  const unrelated = chineseInput.rejectChineseSubmissionFromAuthoritativeError?.(
    disconnected,
    'Unrelated JOIN error.',
    'unrelated-submission',
  );
  const rejected = chineseInput.rejectChineseSubmissionFromAuthoritativeError?.(
    unrelated,
    'Not accepted.',
    'submission-1',
  );

  assert.equal(disconnected.pendingSubmission, false);
  assert.equal(unrelated, disconnected);
  assert.equal(rejected?.sourceText, 'jie3 jie3');
  assert.equal(rejected?.submissionFingerprint, null);

  const retry = chineseInput.beginChineseSubmission?.(rejected, 2, { createSubmissionId });
  assert.equal(retry?.submission.submissionId, 'submission-2');
});

test('REST failures distinguish correlated rejection from ambiguous server failure', () => {
  assert.deepEqual(chineseInput.getChineseSubmissionFailureOptions?.({
    status: 400,
    code: 'NOT_IN_LIST',
    requestSubmissionId: 'submission-1',
  }), {
    authoritative: true,
    submissionId: 'submission-1',
  });
  assert.deepEqual(chineseInput.getChineseSubmissionFailureOptions?.({
    status: 500,
    code: 'INTERNAL_ERROR',
    requestSubmissionId: 'submission-1',
  }), { retainSubmissionFingerprint: true });
  assert.deepEqual(chineseInput.getChineseSubmissionFailureOptions?.({
    code: 'NETWORK_ERROR',
    requestSubmissionId: 'submission-1',
  }), { retainSubmissionFingerprint: true });
});

test('versioned unresolved draft survives reload, reuses its ID, and clears after matching receipt', () => {
  const roundId = 'daily:2026-08-17:zh:pinyin-latin-v2';
  const key = chineseInput.getChineseDraftStorageKey(roundId);
  const legacyKey = 'quordle_draft_zh:daily:2026-08-17:zh';
  const storage = createMemoryStorage([[legacyKey, '不应读取']]);
  const createSubmissionId = submissionIdFactory('submission-1');
  const started = chineseInput.beginChineseSubmission(
    update('jie3 jie3', 6),
    2,
    { createSubmissionId },
  );
  const unresolved = chineseInput.rejectChineseSubmission(
    started.state,
    'Network unavailable.',
    { retainSubmissionFingerprint: true },
  );

  chineseInput.persistChineseDraftState?.(storage, roundId, unresolved);
  const persisted = JSON.parse(storage.value(key));
  assert.deepEqual(persisted, {
    schemaVersion: 1,
    puzzleVariant: 'pinyin-latin-v2',
    sourceText: 'jie3 jie3',
    submissionFingerprint: {
      submissionId: 'submission-1',
      normalizedText: 'jiejie',
      guessCount: 2,
    },
  });

  const restored = chineseInput.loadChineseDraftState?.(storage, roundId, {
    wordLength: 6,
    guessKeys,
    parseInput,
    normalizeInput,
  });
  assert.equal(restored.sourceText, 'jie3 jie3');
  assert.equal(restored.pendingSubmission, false);
  assert.deepEqual(restored.submissionFingerprint, unresolved.submissionFingerprint);

  const retry = chineseInput.beginChineseSubmission(restored, 2, {
    createSubmissionId: submissionIdFactory('must-not-be-used'),
  });
  assert.equal(retry.submission.submissionId, 'submission-1');
  const releasedRetry = chineseInput.rejectChineseSubmission(
    retry.state,
    'Network unavailable.',
    { retainSubmissionFingerprint: true },
  );
  const confirmed = chineseInput.reconcileChineseSubmissionAgainstState(releasedRetry, {
    pinyinSubmissionReceipt: {
      submissionId: 'submission-1',
      normalizedGuess: 'jiejie',
      guessIndex: 2,
    },
    gameState: {
      guessCount: 3,
      boards: [{ guesses: ['laoshi', 'gongsi', 'jiejie'] }],
    },
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.state.sourceText, '');
  chineseInput.persistChineseDraftState?.(storage, roundId, confirmed.state);
  assert.equal(storage.value(key), undefined);
  assert.equal(storage.value(legacyKey), '不应读取');
  assert.deepEqual(storage.reads, [key]);
});

test('versioned plain-string drafts remain readable while corrupt or stale fingerprints fail closed', () => {
  const roundId = 'daily:2026-08-17:zh:pinyin-latin-v2';
  const key = chineseInput.getChineseDraftStorageKey(roundId);
  const legacyKey = 'quordle_draft_zh:daily:2026-08-17:zh';
  const options = { wordLength: 6, guessKeys, parseInput, normalizeInput };
  const plainStorage = createMemoryStorage([[key, 'jie3 jie3'], [legacyKey, '旧草稿']]);
  const plain = chineseInput.loadChineseDraftState?.(plainStorage, roundId, options);
  assert.equal(plain.sourceText, 'jie3 jie3');
  assert.equal(plain.submissionFingerprint, null);
  assert.equal(plain.submissionRecoveryBlocked, false);
  assert.deepEqual(plainStorage.reads, [key]);
  assert.equal(plainStorage.value(legacyKey), '旧草稿');

  const staleStorage = createMemoryStorage([[key, JSON.stringify({
    schemaVersion: 1,
    puzzleVariant: 'pinyin-latin-v2',
    sourceText: 'jie3 jie3',
    submissionFingerprint: {
      submissionId: 'submission-1',
      normalizedText: 'gongsi',
      guessCount: 2,
    },
  })], [legacyKey, '旧草稿']]);
  const stale = chineseInput.loadChineseDraftState?.(staleStorage, roundId, options);
  assert.equal(stale.sourceText, 'jie3 jie3');
  assert.equal(stale.submissionFingerprint, null);
  assert.equal(stale.submissionRecoveryBlocked, true);
  assert.equal(chineseInput.beginChineseSubmission(stale, 2).submission, null);
  assert.equal(staleStorage.value(legacyKey), '旧草稿');

  const corruptStorage = createMemoryStorage([[key, '{"schemaVersion":'], [legacyKey, '旧草稿']]);
  const corrupt = chineseInput.loadChineseDraftState?.(corruptStorage, roundId, options);
  assert.equal(corrupt.sourceText, '');
  assert.equal(corrupt.submissionRecoveryBlocked, true);
  assert.equal(chineseInput.beginChineseSubmission(corrupt, 0).submission, null);
  assert.equal(corruptStorage.value(key), '{"schemaVersion":');
  assert.equal(corruptStorage.value(legacyKey), '旧草稿');
});

test('a duplicate Enter while pending is ignored and confirmation is the only path that clears the draft', () => {
  const initial = update('jie3 jie3', 6);
  const started = chineseInput.beginChineseSubmission?.(initial, 0);
  const duplicate = chineseInput.beginChineseSubmission?.(started.state, 0);

  assert.equal(duplicate?.submission, null);
  assert.equal(duplicate?.state, started.state);
  assert.equal(chineseInput.confirmChineseSubmission?.(started.state).sourceText, '');
});

test('authoritative confirmation matches the submitted normalized guess and later guess count', () => {
  const createSubmissionId = submissionIdFactory('submission-1');
  const started = chineseInput.beginChineseSubmission?.(
    update('jie3 jie3', 6),
    0,
    { createSubmissionId },
  ).state;
  const confirmedState = {
    pinyinSubmissionReceipt: {
      submissionId: 'submission-1',
      normalizedGuess: 'jiejie',
      guessIndex: 0,
    },
    gameState: {
      guessCount: 1,
      boards: [{ guesses: ['jiejie'] }, { guesses: ['jiejie'] }, { guesses: ['jiejie'] }, { guesses: ['jiejie'] }],
    },
  };

  assert.equal(chineseInput.isChineseSubmissionConfirmed?.(started, confirmedState), true);
  assert.equal(chineseInput.isChineseSubmissionConfirmed?.(started, {
    ...confirmedState,
    gameState: { ...confirmedState.gameState, guessCount: 0 },
  }), false);
  assert.equal(chineseInput.isChineseSubmissionConfirmed?.(started, {
    ...confirmedState,
    gameState: {
      ...confirmedState.gameState,
      boards: confirmedState.gameState.boards.map(() => ({ guesses: ['gongsi'] })),
    },
  }), false);
  assert.equal(chineseInput.isChineseSubmissionConfirmed?.(started, {
    ...confirmedState,
    pinyinSubmissionReceipt: {
      ...confirmedState.pinyinSubmissionReceipt,
      submissionId: 'unrelated-submission',
    },
  }), false);
});

test('Chinese gameplay payloads carry the exact variant while English and Korean remain unchanged', () => {
  for (const type of ['JOIN', 'GUESS', 'INVALID_GUESS_ATTEMPT', 'HINT']) {
    const payload = { type, language: 'zh' };
    assert.deepEqual(chineseInput.withChinesePuzzleVariant?.('zh', payload), {
      type,
      language: 'zh',
      puzzleVariant: 'pinyin-latin-v2',
    });
  }

  const korean = { type: 'JOIN', language: 'ko' };
  assert.deepEqual(chineseInput.withChinesePuzzleVariant?.('ko', korean), korean);
});

test('Chinese game, round, completion, and draft identities are versioned without changing other languages', () => {
  assert.equal(chineseInput.getClientGameStorageKey?.('daily', 'zh'), 'quordle_daily_zh_pinyin-latin-v2');
  assert.equal(chineseInput.getClientGameStorageKey?.('practice', 'zh'), 'quordle_practice_zh_pinyin-latin-v2');
  assert.equal(chineseInput.getClientGameStorageKey?.('daily', 'ko'), 'quordle_daily_ko');

  const dailyRound = chineseInput.getClientRoundId?.({
    mode: 'daily', language: 'zh', dateKey: '2026-08-17', instanceId: 'ignored',
  });
  const practiceRound = chineseInput.getClientRoundId?.({
    mode: 'practice', language: 'zh', dateKey: 'ignored', instanceId: 'round-123',
  });
  assert.equal(dailyRound, 'daily:2026-08-17:zh:pinyin-latin-v2');
  assert.equal(practiceRound, 'practice:round-123:zh:pinyin-latin-v2');
  assert.equal(
    chineseInput.getChineseDraftStorageKey?.(dailyRound),
    'quordle_draft_zh_pinyin-latin-v2:daily:2026-08-17:zh:pinyin-latin-v2',
  );
  assert.equal(
    chineseInput.getClientCompletionId?.(dailyRound),
    'client:daily:2026-08-17:zh:pinyin-latin-v2:round-completed',
  );
});
