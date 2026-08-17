import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const serverDirectory = fileURLToPath(new URL('..', import.meta.url));

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited early\n${logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server health check timed out\n${logs()}`);
}

async function connectSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const waitFor = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket response timed out')), 5000);
    const listener = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
  return { socket, waitFor };
}

test('learning APIs authenticate, persist Saved Words, ingest practice events, and protect summaries', { timeout: 20_000 }, async (t) => {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      REDIS_URL: '',
      LEARNING_ANALYTICS_ENABLED: 'true',
      APP_SESSION_SECRET: 'test-app-secret',
      ANALYTICS_HMAC_SECRET: 'test-analytics-secret',
      ANALYTICS_ADMIN_TOKEN: 'test-admin-token',
      ALLOW_DEV_SESSION: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const request = (path, options = {}) => fetch(`${baseUrl}${path}`, options);

  try {
    const health = await waitForHealth(baseUrl, child, () => output);
    assert.deepEqual(health.capabilities, {
      learningDataEnabled: true,
      learningDataAvailable: true,
      learningDataRedisBacked: false,
    });
    const sessionResponse = await request('/api/session/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'learning-player' }),
    });
    const session = await sessionResponse.json();
    const authHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${session.app_session_token}`,
    };

    await t.test('authenticated practice analytics rejects a nonexistent regex-shaped Pinyin guess key', async () => {
      const eventId = randomUUID();
      const validEventId = randomUUID();
      const occurredAt = Date.now();
      const response = await request('/api/analytics/events', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ events: [{
          version: 1,
          eventId,
          type: 'valid_guess_submitted',
          occurredAt,
          roundStartedAt: occurredAt - 1,
          dateKey: '2026-08-17',
          language: 'zh',
          puzzleVariant: 'pinyin-latin-v2',
          mode: 'practice',
          roundId: 'practice:pinyin-invalid-key',
          guessKey: 'zzzz',
        }, {
          version: 1,
          eventId: validEventId,
          type: 'valid_guess_submitted',
          occurredAt,
          roundStartedAt: occurredAt - 1,
          dateKey: '2026-08-17',
          language: 'zh',
          puzzleVariant: 'pinyin-latin-v2',
          mode: 'practice',
          roundId: 'practice:pinyin-valid-key',
          guessKey: 'xuesheng',
        }] }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        version: 1,
        acceptedIds: [validEventId],
        duplicateIds: [],
        rejected: [{ eventId, code: 'INVALID_GUESS_KEY' }],
      });
    });

    assert.equal((await request('/api/learning/saved-words')).status, 401);

    for (const word of ['太阳', '态样']) {
      const saved = await request(`/api/learning/saved-words/${encodeURIComponent(word)}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          language: 'zh',
          puzzleVariant: 'pinyin-latin-v2',
          source: 'dictionary',
          dateKey: '2025-12-31',
          mode: 'daily',
          roundId: 'saved-before-pinyin-round',
        }),
      });
      assert.equal(saved.status, 201);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const pinyinJoin = await request('/api/game/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'pinyin-recall',
        userId: 'learning-player',
        dateKey: '2026-01-01',
        language: 'zh',
        puzzleVariant: 'pinyin-latin-v2',
      }),
    });
    const pinyinState = await pinyinJoin.json();
    const canonicalBoard = pinyinState.gameState.boards.find((board) => board.targetId === '太阳');
    assert.equal(canonicalBoard.targetWord, 'taiyang');
    const pinyinGuess = await request('/api/game/guess', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'pinyin-recall',
        userId: 'learning-player',
        dateKey: '2026-01-01',
        language: 'zh',
        puzzleVariant: 'pinyin-latin-v2',
        guess: 'tai yang',
      }),
    });
    assert.equal(pinyinGuess.status, 200);
    const chineseSavedWords = await (
      await request('/api/learning/saved-words?language=zh', { headers: authHeaders })
    ).json();
    assert.ok(chineseSavedWords.words.find((record) => record.word === '太阳').recalledAt);
    assert.equal(chineseSavedWords.words.find((record) => record.word === '态样').recalledAt, null);

    const join = await request('/api/game/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'learning-room', userId: 'learning-player', dateKey: '2026-08-06', language: 'ko' }),
    });
    const joined = await join.json();
    const word = joined.gameState.boards[0].targetWord;
    const invalidAttemptId = randomUUID();
    const invalidAttemptBody = JSON.stringify({
      roomId: 'learning-room', userId: 'learning-player', dateKey: '2026-08-06', language: 'ko',
      guess: '힣힣', attemptId: invalidAttemptId,
    });
    assert.equal((await request('/api/game/invalid-guess', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: invalidAttemptBody,
    })).status, 202);
    assert.equal((await request('/api/game/invalid-guess', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: invalidAttemptBody,
    })).status, 202);
    const hinted = await request('/api/game/hint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'learning-room', userId: 'learning-player', dateKey: '2026-08-06', language: 'ko',
        boardIndex: 0, hintType: 'part-of-speech',
      }),
    });
    assert.equal(hinted.status, 200);
    const duplicateHint = await request('/api/game/hint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'learning-room', userId: 'learning-player', dateKey: '2026-08-06', language: 'ko',
        boardIndex: 0, hintType: 'part-of-speech',
      }),
    });
    assert.equal(duplicateHint.status, 200);
    const savedResponse = await request(`/api/learning/saved-words/${encodeURIComponent(word)}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ source: 'post-game', dateKey: '2026-08-06', mode: 'practice', roundId: 'practice:test' }),
    });
    assert.equal(savedResponse.status, 201);
    const savedPayload = await savedResponse.json();
    assert.equal(savedPayload.version, 2);
    assert.equal(savedPayload.language, 'ko');

    const occurredAt = Date.now() + 10;
    const practiceStartId = randomUUID();
    const practiceGuessId = randomUUID();
    const practiceSolvedId = randomUUID();
    const analyticsResponse = await request('/api/analytics/events', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ events: [
        {
          version: 1,
          eventId: practiceStartId,
          type: 'round_started',
          occurredAt: occurredAt - 1,
          roundStartedAt: occurredAt - 1,
          dateKey: '2026-08-06',
          language: 'ko',
          mode: 'practice',
          roundId: 'practice:test',
        },
        {
          version: 1,
          eventId: practiceGuessId,
          type: 'valid_guess_submitted',
          occurredAt,
          roundStartedAt: occurredAt - 1,
          dateKey: '2026-08-06',
          language: 'ko',
          mode: 'practice',
          roundId: 'practice:test',
          word,
        },
        {
          version: 1,
          eventId: practiceSolvedId,
          type: 'board_solved',
          occurredAt: occurredAt + 1,
          roundStartedAt: occurredAt - 1,
          dateKey: '2026-08-06',
          language: 'ko',
          mode: 'practice',
          roundId: 'practice:test',
          boardIndex: 0,
          word,
        },
      ] }),
    });
    assert.equal(analyticsResponse.status, 200);
    assert.deepEqual((await analyticsResponse.json()).acceptedIds, [practiceStartId, practiceGuessId, practiceSolvedId]);

    const savedWords = await (await request('/api/learning/saved-words?language=ko', { headers: authHeaders })).json();
    assert.equal(savedWords.version, 2);
    assert.equal(savedWords.language, 'ko');
    assert.equal(savedWords.words[0].word, word);
    assert.ok(savedWords.words[0].recalledAt);

    const secondSession = await (await request('/api/session/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'learning-player' }),
    })).json();
    const restoredWords = await (await request('/api/learning/saved-words?language=ko', {
      headers: { authorization: `Bearer ${secondSession.app_session_token}` },
    })).json();
    assert.equal(restoredWords.words[0].word, word);

    let finished;
    do {
      finished = await (await request('/api/game/guess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: 'learning-room', userId: 'learning-player', dateKey: '2026-08-06', language: 'ko', guess: word,
        }),
      })).json();
    } while (!finished.gameState.gameOver);

    const wsClient = await connectSocket(`ws://127.0.0.1:${port}/ws`);
    const wsState = wsClient.waitFor((message) => message.type === 'STATE');
    wsClient.socket.send(JSON.stringify({
      type: 'JOIN', roomId: 'learning-ws', dateKey: '2026-08-06', visibleUserId: 'ws-learning-player', language: 'ko',
    }));
    await wsState;
    const wsInvalidAttemptId = randomUUID();
    const invalidAck = wsClient.waitFor(
      (message) => message.type === 'ANALYTICS_ACK' && message.attemptId === wsInvalidAttemptId,
    );
    wsClient.socket.send(JSON.stringify({
      type: 'INVALID_GUESS_ATTEMPT', roomId: 'learning-ws', dateKey: '2026-08-06',
      visibleUserId: 'ws-learning-player', language: 'ko', guess: '힣힣', attemptId: wsInvalidAttemptId,
    }));
    await invalidAck;
    const wsHintState = wsClient.waitFor(
      (message) => message.type === 'STATE' && message.playerState.gameState.assistance.hints.length === 1,
    );
    wsClient.socket.send(JSON.stringify({
      type: 'HINT', roomId: 'learning-ws', dateKey: '2026-08-06', visibleUserId: 'ws-learning-player', language: 'ko',
      boardIndex: 1, hintType: 'batchim-count',
    }));
    await wsHintState;
    wsClient.socket.close();

    assert.equal((await request('/api/admin/analytics/summary?from=2026-08-06&to=2026-08-06')).status, 401);
    const summaryResponse = await request('/api/admin/analytics/summary?from=2026-08-06&to=2026-08-06&language=ko', {
      headers: { authorization: 'Bearer test-admin-token' },
    });
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.totals.round_started, 3);
    assert.equal(summary.totals.valid_guess_submitted, 10);
    assert.equal(summary.totals.invalid_guess_submitted, 2);
    assert.equal(summary.totals.hint_used, 2);
    assert.equal(summary.totals.round_completed, 1);
    assert.equal(summary.assistance.assisted.completions, 1);
    assert.equal(summary.totals.word_saved, 1);
    assert.equal(summary.totals.saved_word_later_guessed, 1);
    assert.equal((await request('/api/admin/analytics/summary?language=invalid', {
      headers: { authorization: 'Bearer test-admin-token' },
    })).status, 400);

    let savedWordsRateLimited = false;
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response = await request('/api/learning/saved-words?language=ko', { headers: authHeaders });
      if (response.status === 429) {
        savedWordsRateLimited = true;
        break;
      }
    }
    assert.equal(savedWordsRateLimited, true);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)).then(() => child.kill('SIGKILL')),
    ]);
  }
});

test('production learning data fails closed without Redis while gameplay stays available', { timeout: 15_000 }, async () => {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      REDIS_URL: '',
      LEARNING_ANALYTICS_ENABLED: 'true',
      APP_SESSION_SECRET: 'test-app-secret',
      ANALYTICS_HMAC_SECRET: 'test-analytics-secret',
      ANALYTICS_ADMIN_TOKEN: 'test-admin-token',
      ALLOW_DEV_SESSION: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const health = await waitForHealth(baseUrl, child, () => output);
    assert.deepEqual(health.capabilities, {
      learningDataEnabled: true,
      learningDataAvailable: false,
      learningDataRedisBacked: false,
    });
    assert.equal((await fetch(`${baseUrl}/api/session/dev`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    })).status, 503);
    assert.equal((await fetch(`${baseUrl}/api/learning/saved-words`)).status, 503);
    assert.equal((await fetch(`${baseUrl}/api/game/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'no-redis-room', userId: 'no-redis-player', dateKey: '2026-08-06', language: 'en',
      }),
    })).status, 200);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)).then(() => child.kill('SIGKILL')),
    ]);
  }
});
